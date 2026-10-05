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

// ── one POST ─────────────────────────────────────────────────────────────
// fetchImpl is injectable so a test never reaches the network, and the
// default is the global fetch rather than a module-level capture — the
// mistake that let a QuickBooks token refresh escape a stubbed suite this
// morning was exactly a default that was not overridable at the call site.
async function call(endpoint, body, { fetchImpl, timeoutMs = 30000 } = {}) {
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

// ── step 1: a link token, for the browser ────────────────────────────────
// Short-lived and not a credential for anything but starting Link. She
// completes the bank login in Plaid's own iframe; her bank password never
// touches this server, which is the entire point of Link.
async function linkToken({ fetchImpl, userId = 'edge-jarvis' } = {}) {
    const r = await call('/link/token/create', {
        user: { client_user_id: String(userId) },
        client_name: 'Jarvis — Edge Metals',
        products: ['transactions'],
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
        institution_id: institutionId, initial_products: ['transactions'],
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
};
