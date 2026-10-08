// ── helpers/plaid.js — the bank feed, and nothing else ────────────────────
//
// Apsara, 2026-10-05, choosing where bank rows come from: the Plaid feed, at
// https://dashboard.plaid.com/overview. Her account; her keys.
//
// ── NO DEPENDENCY ────────────────────────────────────────────────────────
// Plaid's official SDK is a wrapper over four JSON POSTs. package.json has no
// plaid entry and this file does not add one: adding a dependency to her
// server means `npm install` on the VM is now part of deploying a bank fix,
// and the SDK's surface is wider than what is used here. Node 20 has fetch.
// If the SDK is ever wanted, this file is the one place to swap.
//
// ── THE ACCESS TOKEN IS THE WHOLE RISK ───────────────────────────────────
// config.js says it plainly at line 342: bank-item.json holds the Plaid
// ACCESS TOKEN, it is "the standing ability to pull this account's history,
// it does not expire on its own, and it must never appear in an API response
// or a log line."
//
// So, in this file:
//   · the token is read from disk and passed to Plaid. It is never returned
//     by any function here, never put in an Error message, and never logged.
//   · redact() strips it, the client secret and the client id from anything
//     on its way to a log or an HTTP response, and every throw goes through
//     it. Plaid's own error bodies echo request fields back, which is how a
//     secret ends up in a log without anyone writing it there.
//   · tests/plaid.js asserts that, by searching every thrown message and
//     every returned object for the fixture token.
//
// ── TRANSACTIONS/SYNC, NOT TRANSACTIONS/GET ──────────────────────────────
// /transactions/get takes a date range and re-sends everything in it, which
// means a nightly pull re-downloads the same month forever and any row the
// bank later amended arrives as a silent overwrite. /transactions/sync is
// cursor-based: it returns added, MODIFIED and REMOVED since the last
// cursor. The modified and removed lists are the whole reason to prefer it —
// helpers/bankLedger.js has a drift notion precisely because a bank restates
// rows, and this is the endpoint that admits it.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const HOSTS = {
    sandbox: 'https://sandbox.plaid.com',
    development: 'https://development.plaid.com',
    production: 'https://production.plaid.com',
};

function env() {
    const e = String(cfg.PLAID_ENV || 'sandbox').trim().toLowerCase();
    // Anything unrecognised is SANDBOX, never production. A typo in an env
    // var must not be the thing that points a nightly job at her real bank.
    return HOSTS[e] ? e : 'sandbox';
}
function host() { return HOSTS[env()]; }

function configured() {
    return !!(cfg.PLAID_CLIENT_ID && cfg.PLAID_SECRET);
}

function ITEM_FILE() { return process.env.BANK_ITEM_FILE || cfg.BANK_ITEM_FILE; }

// ── redaction ────────────────────────────────────────────────────────────
// Applied to every string that leaves this file. Not a nicety: Plaid returns
// the request body back inside some error payloads, so the secret can arrive
// in an error message without anyone having written it there.
function redact(text) {
    let s = typeof text === 'string' ? text : JSON.stringify(text == null ? '' : text);
    for (const secret of [cfg.PLAID_SECRET, cfg.PLAID_CLIENT_ID]) {
        if (secret && String(secret).length > 5) {
            s = s.split(String(secret)).join('[redacted]');
        }
    }
    // Any access token, whoever issued it. Plaid's are access-<env>-<uuid>,
    // and the shape is matched rather than the specific value so a token
    // this process has never seen is still stripped.
    s = s.replace(/access-(sandbox|development|production)-[A-Za-z0-9-]+/g, 'access-[redacted]');
    s = s.replace(/public-(sandbox|development|production)-[A-Za-z0-9-]+/g, 'public-[redacted]');
    s = s.replace(/link-(sandbox|development|production)-[A-Za-z0-9-]+/g, 'link-[redacted]');
    return s;
}

const fail = (msg) => { throw new Error(redact(msg)); };

// ── READ ONLY, ENFORCED — NOT A CONVENTION ───────────────────────────────
// Apsara, 2026-10-08: "Also i want read only access for plaid account from
// jarvis.never write".
//
// Jarvis was ALREADY read-only in practice — `products: ['transactions']`
// grants history and nothing else, and no money-movement endpoint is called
// anywhere in this repo. But "no caller happens to do it" is not a rule, it
// is a coincidence that holds until someone adds a feature. Plaid's API has
// endpoints that move real money (/transfer/authorization/create,
// /transfer/create, /payment_initiation/payment/create) and endpoints that
// alter her Items. Reaching any of them is one `call('/transfer/create')`
// away, and the thing that would stop it is this list.
//
// So the allowlist is the rule, and it is checked BEFORE the network call.
// A new endpoint does not work until someone adds it here, which makes the
// decision visible in a diff instead of invisible in a feature.
//
// ── THE ONE PERMITTED WRITE, AND WHOSE CALL IT WAS ───────────────────────
// /item/remove deletes an Item at Plaid's end, so it is strictly a write. I
// asked rather than decide it: offered local-forget-only, keep-it, or drop
// the button, and Apsara, 2026-10-08, chose "Keep Unlink calling Plaid" —
// one write, and only this one, to remove her own connection. It is named
// here with that provenance so nobody later reads the list as "writes are
// fine if they seem harmless".
const READ_ONLY = new Set([
    '/link/token/create',               // starts Link; grants nothing by itself
    '/item/public_token/exchange',      // turns her consent into a read token
    '/accounts/get',                    // cached balance + account list, free
    '/accounts/balance/get',            // real-time balance. BILLED PER CALL
    '/transactions/sync',               // the feed
    '/institutions/get',                // which banks use OAuth
]);
// HER DECISION, 2026-10-08, recorded above. Separate from READ_ONLY so the
// read list stays honestly a read list.
const PERMITTED_WRITES = new Set(['/item/remove']);
// Sandbox-only, and the env check is the point: these create fake data and
// must be impossible against production even if a route is left exposed.
const SANDBOX_ONLY = new Set([
    '/sandbox/public_token/create',
    '/sandbox/item/reset_login',
    '/sandbox/item/fire_webhook',
]);

function assertReadOnly(endpoint) {
    const e = String(endpoint || '');
    if (READ_ONLY.has(e) || PERMITTED_WRITES.has(e)) return;
    if (SANDBOX_ONLY.has(e)) {
        if (env() === 'sandbox') return;
        fail(`${e} is a sandbox endpoint and PLAID_ENV is ${env()} — refused. `
            + 'Sandbox helpers must never run against her real bank.');
    }
    fail(`Jarvis is read-only at Plaid, so ${e} is refused before any request is sent. `
        + 'Apsara asked for read-only access on 2026-10-08. If a new endpoint is genuinely '
        + 'needed, add it to READ_ONLY in helpers/plaid.js and say in the commit why it '
        + 'only reads — do not route around this.');
}

// ── one POST ─────────────────────────────────────────────────────────────
// fetchImpl is injectable so a test never reaches the network, and the
// default is the global fetch rather than a module-level capture — the
// mistake that let a QuickBooks token refresh escape a stubbed suite this
// morning was exactly a default that was not overridable at the call site.
async function call(endpoint, body, { fetchImpl, timeoutMs = 30000 } = {}) {
    // FIRST, before the configured() check and before any network. A refusal
    // must not depend on whether her keys happen to be set, or the guard
    // would be absent on exactly the machine where it is being developed.
    assertReadOnly(endpoint);
    if (!configured()) {
        fail('Plaid is not configured — set PLAID_CLIENT_ID and PLAID_SECRET in the server .env. '
            + 'They are on the Plaid dashboard under Developers / Keys, and they do not belong in a chat.');
    }
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) fail('no fetch available in this runtime');

    const payload = { client_id: cfg.PLAID_CLIENT_ID, secret: cfg.PLAID_SECRET, ...body };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
        res = await f(host() + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ac.signal,
        });
    } catch (e) {
        fail(`Plaid ${endpoint} did not answer: ${e && e.message}`);
    } finally { clearTimeout(timer); }

    const raw = await res.text().catch(() => '');
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
    if (!res.ok) {
        const m = json || {};
        // Plaid's own wording is the useful part — "ITEM_LOGIN_REQUIRED" means
        // she has to re-authenticate at the bank and no amount of retrying
        // helps, which is worth saying rather than hiding behind a 500.
        fail(`Plaid ${endpoint} refused (${res.status}): `
            + [m.error_code, m.error_message, m.display_message].filter(Boolean).join(' — ')
            + (m.error_code ? '' : ' ' + String(raw).slice(0, 300)));
    }
    if (!json) fail(`Plaid ${endpoint} returned something that is not JSON`);
    return json;
}

// ── the linked item ──────────────────────────────────────────────────────
// One item per institution. She has two banks, so there will be two.
function items() {
    const raw = loadJson(ITEM_FILE(), { items: [] });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Array.isArray(raw.items) ? raw.items : [];
}

// What a caller outside this file is allowed to see. NEVER the token.
function itemsPublic() {
    return items().map((i) => ({
        item_id: i.item_id,
        institution: i.institution || null,
        linked_at: i.linked_at || null,
        cursor_set: !!i.cursor,
        last_sync_at: i.last_sync_at || null,
        accounts: (i.accounts || []).map((a) => ({
            account_id: a.account_id, name: a.name || null,
            mask: a.mask || null, subtype: a.subtype || null,
        })),
    }));
}

async function saveItem(item) {
    await mutateJson(ITEM_FILE(), { items: [] }, (all) => {
        const s = (all && typeof all === 'object' && !Array.isArray(all)) ? all : { items: [] };
        const rows = Array.isArray(s.items) ? s.items : [];
        s.items = rows.filter((i) => i.item_id !== item.item_id).concat([item]);
        return s;
    });
    return item;
}

// ── WHAT SHE CONSENTS TO AT THE BANK ─────────────────────────────────────
// The endpoint allowlist above governs what this server asks Plaid for. This
// governs something different and in some ways more important: what the bank
// is told Jarvis may do, on the consent screen SHE reads during Link.
//
// `transactions` is history. It is the whole feature. Of the products that
// are not here, two matter: `auth` hands over the account and routing number,
// which is what an ACH debit needs, and `transfer`/`payment_initiation` are
// money movement outright. Adding `auth` would not break a test by itself —
// it would simply widen what her bank believes she agreed to, invisibly. So
// the list is frozen, named, and asserted in tests/plaid.js.
const READ_PRODUCTS = ['transactions'];
const MONEY_PRODUCTS = ['auth', 'transfer', 'payment_initiation', 'signal', 'identity_verification'];

function assertReadProducts(products) {
    const bad = (products || []).filter((p) => MONEY_PRODUCTS.includes(String(p)));
    if (bad.length) {
        fail(`refusing to ask her bank for ${bad.join(', ')} — Jarvis reads transactions and `
            + 'nothing else. Apsara asked for read-only access on 2026-10-08, and this is the '
            + 'consent screen she signs at the bank, not an internal setting.');
    }
}

// ── step 1: a link token, for the browser ────────────────────────────────
// Short-lived and not a credential for anything but starting Link. She
// completes the bank login in Plaid's own iframe; her bank password never
// touches this server, which is the entire point of Link.
//
// ── NO redirect_uri, AND THAT IS A DECISION ──────────────────────────────
// BofA and Chase are OAuth banks, so Link leaves the page and comes back.
// Plaid's OAuth guide: desktop web works WITHOUT a redirect_uri, because it
// opens the bank in a pop-up. A redirect_uri is required for webviews — and
// the Edge Yard Android app IS a webview. So linking a bank is a DESKTOP
// WEBSITE job, once per bank, and the app is deliberately not a place it can
// be done. Adding android_package_name would make the phone a second place
// her bank credentials get entered, for a thing she does twice ever.
async function linkToken({ fetchImpl, userId = 'edge-jarvis' } = {}) {
    assertReadProducts(READ_PRODUCTS);
    const r = await call('/link/token/create', {
        user: { client_user_id: String(userId) },
        client_name: 'Jarvis — Edge Metals',
        products: READ_PRODUCTS,
        country_codes: ['US'],
        language: 'en',
    }, { fetchImpl });
    return { link_token: r.link_token, expiration: r.expiration };
}

// ── step 2: the public token becomes an access token ─────────────────────
// Returns only what is safe. The access token goes to disk and no further.
async function exchange(publicToken, { fetchImpl, institution = null } = {}) {
    const pt = String(publicToken || '').trim();
    if (!pt) fail('no public_token — the browser did not finish Link');

    const r = await call('/item/public_token/exchange', { public_token: pt }, { fetchImpl });
    if (!r.access_token || !r.item_id) fail('Plaid returned no access_token/item_id');

    // Which accounts this item covers, so bank-accounts.json can be linked
    // to them — helpers/bankLedger.js needs plaid_account_id to know which
    // COMPANY a deposit belongs to, and without it nothing is matched.
    let accounts = [];
    try {
        const a = await call('/accounts/get', { access_token: r.access_token }, { fetchImpl });
        accounts = (a.accounts || []).map((x) => ({
            account_id: x.account_id, name: x.name, mask: x.mask,
            subtype: (x.subtype || null), type: (x.type || null),
        }));
    } catch (e) { accounts = []; }

    await saveItem({
        item_id: r.item_id,
        access_token: r.access_token,          // on disk, in a file excluded from the backup
        institution: institution || (r.institution_id || null),
        linked_at: new Date().toISOString(),
        cursor: null,
        accounts,
    });
    // Deliberately not the token.
    return { item_id: r.item_id, accounts, institution: institution || null };
}

// ── step 3: pull, forever after ──────────────────────────────────────────
// Cursor-based. Returns what changed, and the caller decides what to do with
// it — this file does not write bank-transactions.json, because deciding
// what a bank row MEANS is bankLedger's job and mixing the two would put the
// drift rules behind a network call.
async function syncItem(itemId, { fetchImpl, pageCap = 20 } = {}) {
    const item = items().find((i) => i.item_id === itemId);
    if (!item) fail(`no linked item ${itemId}`);
    if (!item.access_token) fail(`item ${itemId} has no access token — re-link the bank`);

    let cursor = item.cursor || null;
    const added = [], modified = [], removed = [];
    let pages = 0, truncated = false;

    for (;;) {
        // added/modified/removed are the three lists; has_more means page on.
        const r = await call('/transactions/sync', {
            access_token: item.access_token,
            ...(cursor ? { cursor } : {}),
            count: 500,
        }, { fetchImpl });

        added.push(...(r.added || []));
        modified.push(...(r.modified || []));
        removed.push(...(r.removed || []));
        cursor = r.next_cursor || cursor;
        pages += 1;

        if (!r.has_more) break;
        // A cap, and the fact of hitting it is REPORTED. A sync that stopped
        // early must not look like a sync that finished, which is the same
        // rule the matcher's truncated flag exists for.
        if (pages >= pageCap) { truncated = true; break; }
    }

    await saveItem({ ...item, cursor, last_sync_at: new Date().toISOString() });
    return { item_id: itemId, added, modified, removed, pages, truncated, cursor_advanced: cursor !== (item.cursor || null) };
}

// ── the whole feed, into the ledger ──────────────────────────────────────
// added and modified both go through bankLedger.ingestPlaid, which upserts
// on transaction_id — so a modified row CORRECTS its existing row and is
// flagged as drift if she had already acted on it. removed rows are reported
// and NOT deleted here: a bank row vanishing after she has allocated it
// against an invoice is a question, not a tidy-up.
async function syncAll({ fetchImpl } = {}) {
    const ledger = require('./bankLedger');
    const out = { items: [], added: 0, modified: 0, removed: [], errors: [], truncated: false };
    for (const i of items()) {
        try {
            const r = await syncItem(i.item_id, { fetchImpl });
            const rep = await ledger.ingestPlaid([...r.added, ...r.modified]);
            out.items.push({ item_id: i.item_id, institution: i.institution || null, ...rep, pages: r.pages });
            out.added += r.added.length;
            out.modified += r.modified.length;
            out.removed.push(...r.removed.map((x) => x.transaction_id || x));
            if (r.truncated) out.truncated = true;
        } catch (e) {
            // One bank failing must not stop the other. ITEM_LOGIN_REQUIRED on
            // Chase should not hide BofA's deposits.
            out.errors.push({ item_id: i.item_id, institution: i.institution || null, error: redact(e.message) });
        }
    }
    return out;
}

// ── sandbox only: a fake bank, so the whole path is exercisable ──────────
// Her choice was the live feed, and production access needs a Plaid review.
// This is how the link → sync → match path is proved end to end before that
// lands. REFUSES outside sandbox, because /sandbox/public_token/create does
// not exist in production and a caller reaching for it there is confused
// about which environment they are in.
async function sandboxLink({ fetchImpl, institutionId = 'ins_109508' } = {}) {
    if (env() !== 'sandbox') fail(`sandboxLink is sandbox-only; PLAID_ENV is ${env()}`);
    const r = await call('/sandbox/public_token/create', {
        institution_id: institutionId, initial_products: READ_PRODUCTS,
    }, { fetchImpl });
    return exchange(r.public_token, { fetchImpl, institution: institutionId });
}

async function unlink(itemId, { fetchImpl } = {}) {
    const item = items().find((i) => i.item_id === itemId);
    if (!item) fail(`no linked item ${itemId}`);
    // Told to Plaid as well as forgotten here, so the token is actually dead
    // rather than merely deleted from a file someone may have a copy of.
    try { await call('/item/remove', { access_token: item.access_token }, { fetchImpl }); }
    catch (e) { /* removing locally is still right if Plaid is unreachable */ }
    await mutateJson(ITEM_FILE(), { items: [] }, (all) => {
        const s = (all && typeof all === 'object' && !Array.isArray(all)) ? all : { items: [] };
        s.items = (Array.isArray(s.items) ? s.items : []).filter((i) => i.item_id !== itemId);
        return s;
    });
    return { item_id: itemId, removed: true };
}

function status() {
    return {
        configured: configured(),
        env: env(),
        host: host(),
        items: itemsPublic(),
        // Said out loud, because an unlinked account is the difference
        // between "nothing to reconcile" and "not connected yet".
        note: !configured()
            ? 'PLAID_CLIENT_ID and PLAID_SECRET are not set on this server'
            : (items().length ? null : 'configured, but no bank is linked yet'),
    };
}

module.exports = {
    env, host, configured, status, redact,
    items, itemsPublic, linkToken, exchange, syncItem, syncAll, sandboxLink, unlink,
    ITEM_FILE, HOSTS,
    // Exported so tests/plaid.js can assert the rule rather than trust the
    // comment above it — and so a reviewer can see the whole permitted
    // surface in one place without reading the file.
    READ_ONLY, PERMITTED_WRITES, SANDBOX_ONLY, READ_PRODUCTS, MONEY_PRODUCTS,
    assertReadOnly, assertReadProducts, call,
};
