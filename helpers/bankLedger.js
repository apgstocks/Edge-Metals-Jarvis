// ── helpers/bankLedger.js — the bank row, QuickBooks' shape and then some ──
//
// Apsara, 2026-10-05: "plaid records should mimic quickbook bank transactions
// but better than it."
//
// ── THE SHAPE IS QUICKBOOKS', DELIBERATELY AND EXACTLY ───────────────────
// scripts/qb-bank-match.js already reads the CSV her QuickBooks Banking
// screen exports, and normalises it to:
//
//     date  desc  party  category  spent  received  amount  direction
//
// Those are the field names used here, unchanged. Not for sentiment: it
// means one matcher serves both the Plaid feed and the CSV export, the CSV
// path she uses today keeps working, and the two can never drift into
// disagreeing about what a bank row is. "Mimic QuickBooks" is therefore
// literal — a Plaid row and a QuickBooks CSV row are the same record type.
//
// ── AND THEN THE PARTS QUICKBOOKS CANNOT HOLD ────────────────────────────
// Each of these is a thing that has actually gone wrong in a QuickBooks
// banking workflow, not a feature for its own sake:
//
//   raw        The untouched Plaid payload. QuickBooks overwrites the
//              original once a row is categorised, so the evidence of what
//              the bank actually said is gone by the time anyone asks.
//              Immutable here: a re-parse can never destroy it.
//
//   company    Edge Metals or Edge Trading, derived from the account. These
//              are DIFFERENT COMPANIES and a deposit into one must never be
//              offered against the other's invoices. QuickBooks can only
//              separate them by being two subscriptions.
//
//   history    Every state change, with who, when and why. QuickBooks keeps
//              one status and no trail, so "why is this row excluded" has no
//              answer in March when it matters.
//
//   excluded   QuickBooks' Exclude makes a row VANISH. Here it leaves the
//              worklist and stays counted, with a running total, and can be
//              un-excluded. Her own instruction, and the same doctrine as
//              the QuickBooks agent's answered findings: silenced is never
//              hidden, because a rule quietly hiding a growing pile is its
//              own problem.
//
//   pending    Recorded, but held out of matching. A pending amount still
//              changes and the row can vanish; QuickBooks shows them and
//              they churn.
//
//   drift      If the bank restates a row she has already acted on, that is
//              said LOUDLY rather than silently applied. This is the one
//              QuickBooks gets most dangerously wrong: a re-download can
//              move a figure under a decision already made.

const path = require('path');
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const day = (d) => String(d || '').slice(0, 10);

function FILE() { return process.env.BANK_TX_FILE || cfg.BANK_TX_FILE; }

// ── which company owns an account ────────────────────────────────────────
// qb-settings/bank-accounts.json is the one place account numbers live, and
// it already carries the company. Read from there rather than inventing a
// second mapping that can disagree — Edge Metals and Edge Trading being
// different companies is most of what this app is for.
// ── the short bank label the receipts store accepts ──────────────────────
// bank-accounts.json names the institution ("Bank of America, N.A.");
// helpers/banks.js owns the names addReceipt accepts ("BofA"). Those never
// match as strings and banks.canonical() returns null for both of hers, so
// the SWIFT code is the discriminator — the one field that identifies an
// institution without ambiguity.
//
// Resolved HERE, at ingest, beside company, and stored on the row. It used
// to be looked up again at request time in bankMatchRoutes, which meant two
// independent mappings for the same fact: company came from the stored row
// and the bank label from a fresh lookup, so they could disagree and one
// could work while the other silently returned nothing.
const SWIFT_TO_BANK = {
    BOFA: 'BofA',           // BOFAUS3N — Edge Metals
    CHAS: 'Chase Bank',     // CHASUS33 — Edge Trading
};

function bankOf(accountId, accounts) {
    const hit = (Array.isArray(accounts) ? accounts : [])
        .find((a) => a && (a.id === accountId || a.plaid_account_id === accountId));
    if (!hit) return null;
    const swift = String(hit.swift || '').trim().toUpperCase();
    const guess = swift ? SWIFT_TO_BANK[swift.slice(0, 4)] : null;
    if (!guess) return null;
    // Checked against the live list, so a rename in banks.js returns null
    // rather than a value addReceipt would reject.
    try {
        const opts = require('./banks').options() || [];
        return opts.includes(guess) ? guess : null;
    } catch (e) { return guess; }
}

function companyOf(accountId, accounts) {
    const list = Array.isArray(accounts) ? accounts : [];
    const hit = list.find((a) => a && (a.id === accountId || a.plaid_account_id === accountId));
    return hit ? (hit.company || null) : null;
}

// ── WHERE THE ACCOUNT FILE IS, AND WHY IT IS OVERRIDABLE ────────────────
// Under cfg.ROOT, not DATA_DIR, because it is in git deliberately —
// bankDocs.js:7 records that so "changing an account number is one edit in
// one file that travels", rather than a hunt through saved PDFs.
//
// That also means it is NOT isolated by a test's DATA_DIR. It was read-only
// until 2026-10-08, when exchange() started WRITING plaid_account_id into
// it on link; the moment anything writes here, a test that exercises that
// path edits her real banking file in the repo. So the path is overridable
// the same way BANK_ITEM_FILE is, and tests point it at a temp copy.
function accountsFile() {
    return process.env.BANK_ACCOUNTS_FILE || path.join(cfg.ROOT, 'qb-settings', 'bank-accounts.json');
}

function readAccounts() {
    try {
        const d = loadJson(accountsFile(), { accounts: [] });
        return Array.isArray(d && d.accounts) ? d.accounts : [];
    } catch (e) { return []; }
}

// ── JOINING A LINKED PLAID ACCOUNT TO HER OWN RECORD OF IT ───────────────
// Apsara, 2026-10-08: "i dont want human intervention between jarvis and
// plaid." This removes the one manual step that was left after linking, and
// it removes a silent failure at the same time.
//
// companyOf and bankOf above match a Plaid row's account_id against `a.id`
// OR `a.plaid_account_id`. Today `id` is a local slug ("edge-metals-bofa")
// and plaid_account_id is null on both accounts — so the moment a bank is
// linked, EVERY transaction arrives with company:null and bank:null.
//
// Nothing throws. The feed fills, and helpers/bankReconcile.js — which
// filters rows by bank — finds none for either account and reports zeroes
// against a full ledger. That reads as "Plaid sent nothing", which is the
// wrong thing to spend an afternoon debugging.
//
// ── MATCHED ON THE LAST FOUR DIGITS, WHICH IS EXACT ─────────────────────
// Plaid returns `mask`: the last four digits of the account. She already
// stores the full accountNumber. So this is a lookup, not a guess — and
// that matters, because the wrong join would file Edge Metals' deposits
// into Edge Trading's books, which is most of what entities.js exists to
// prevent.
//
// Names are NOT used. "Bank of America, N.A." versus Plaid's "Plaid
// Checking" would need fuzzy matching, and nameMatch.js already records
// what a near-miss costs when money is on the other side of it.
//
// AMBIGUITY IS REFUSED, NOT RESOLVED. Two accounts ending in the same four
// digits is rare and real; picking one would be the single most expensive
// thing this function could do, so it reports and changes nothing.
function joinPlaidAccounts(accounts, plaidAccounts) {
    const mine = Array.isArray(accounts) ? accounts : [];
    const theirs = Array.isArray(plaidAccounts) ? plaidAccounts : [];
    const last4 = (v) => String(v || '').replace(/\D/g, '').slice(-4);

    const joined = [];
    const ambiguous = [];
    const unmatched = [];

    for (const p of theirs) {
        const mask = last4(p && p.mask);
        if (!mask || mask.length < 4) { unmatched.push({ account_id: p && p.account_id, why: 'Plaid gave no mask' }); continue; }
        const hits = mine.filter((a) => a && last4(a.accountNumber) === mask);
        if (hits.length === 1) {
            joined.push({ id: hits[0].id, account_id: p.account_id, mask, company: hits[0].company || null });
        } else if (hits.length > 1) {
            ambiguous.push({ account_id: p.account_id, mask, candidates: hits.map((h) => h.id) });
        } else {
            unmatched.push({ account_id: p.account_id, mask,
                why: `no account in bank-accounts.json ends ${mask}` });
        }
    }

    // Returns the NEW array rather than writing. Same doctrine as the rest
    // of this file: a function that both decides and persists cannot be run
    // to see what it would do.
    const next = mine.map((a) => {
        const hit = joined.find((j) => j.id === a.id);
        if (!hit) return a;
        if (a.plaid_account_id === hit.account_id) return a;
        return { ...a, plaid_account_id: hit.account_id };
    });
    const changed = next.filter((a, i) => a !== mine[i]).length;
    return { accounts: next, joined, ambiguous, unmatched, changed };
}

// ── one Plaid transaction → one bank row ─────────────────────────────────
// Plaid's convention, recorded in helpers/reconcile.js: a POSITIVE amount is
// money LEAVING the account. Flipped exactly once, here, into QuickBooks'
// spent/received pair so no caller has to remember it. Get this backwards and
// every deposit reads as a withdrawal.
function fromPlaid(tx, accounts) {
    if (!tx) return null;
    const id = tx.transaction_id || tx.id;
    if (!id) return null;
    const a = num0(tx.amount);
    const spent = a > 0 ? round2(a) : 0;
    const received = a < 0 ? round2(-a) : 0;
    if (!spent && !received) return null;
    const accountId = tx.account_id || null;
    return {
        // ── QuickBooks' columns ──────────────────────────────────────────
        id,
        date: day(tx.date || tx.authorized_date),
        desc: String(tx.name || tx.original_description || '').trim(),
        // QuickBooks' own From/To guess is the best signal in its export.
        // Plaid's equivalent is merchant_name plus counterparties.
        party: String(tx.merchant_name
            || ((tx.counterparties || [])[0] || {}).name || '').trim(),
        // Left blank on arrival. QuickBooks' category column is what the
        // accountant has ALREADY set, and inventing one from Plaid's own
        // taxonomy would put a guess in the column she reads as a decision.
        category: '',
        spent, received,
        amount: round2(spent || received),
        direction: spent ? 'out' : 'in',

        // ── and the rest ─────────────────────────────────────────────────
        account_id: accountId,
        company: companyOf(accountId, accounts),
        bank: bankOf(accountId, accounts),
        pending: !!tx.pending,
        excluded: false,
        excluded_reason: null,
        // Immutable. Nothing in this file ever rewrites it after insert.
        raw: tx,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        history: [],
        drift: null,
    };
}

// ── the fields the BANK owns, versus the fields SHE owns ─────────────────
// This split is the whole of upsert. A re-sync refreshes what the bank says
// and must never touch what she decided.
const BANK_FIELDS = ['date', 'desc', 'party', 'spent', 'received', 'amount', 'direction', 'pending'];
// ── `matched` ADDED 2026-10-08, AND WHY IT LIVES HERE ────────────────────
// Apsara: "...whether payment received or sent ever again." Ticking a
// withdrawal off against the payment Jarvis already recorded needs somewhere
// to remember the tick. A new store was the obvious shape and is worse in
// three ways, each of which this file already solved:
//
//   · the tick survives a re-sync for free, because HERS is exactly the list
//     upsert() preserves when the bank restates a row;
//   · it inherits the DRIFT case — if the bank changes the amount of a row
//     she has ticked, that is recorded rather than quietly applied;
//   · bank-transactions.json is already excluded from the nightly Drive
//     backup by filename, and a tick carries the same information as the row
//     it sits on. A second file would have needed that decision made again.
//
// It holds { keys, at, by, how } — `how` being 'auto' or 'her', so the
// morning list can name what Jarvis ticked by itself.
const HERS = ['category', 'excluded', 'excluded_reason', 'history', 'matched'];

// A row she has acted on. Used only to decide whether a restated figure is
// merely new information or a problem. A MATCHED row counts: a bank that
// restates the amount of a withdrawal already ticked off against a recorded
// payment is precisely the case drift exists to surface.
const actedOn = (row) => !!(row && (row.excluded || (row.history || []).length
    || row.category || row.matched));

// ── upsert, keyed on transaction_id ──────────────────────────────────────
// config.js:346 already says why: "keyed by Plaid's transaction_id so a
// re-sync corrects a row rather than duplicating it". QuickBooks' bank feed
// is notorious for re-downloading the same week twice.
//
// THE DRIFT CASE IS THE IMPORTANT ONE. If the bank restates the amount or
// date of a row she has already excluded or categorised, applying it quietly
// moves a figure under a decision already made — and at tax time nobody can
// tell that happened. So the new values ARE taken (the bank is the authority
// on what the bank did) and the change is recorded in `drift` and in history,
// where the screen and the nightly sweep can both see it.
function upsert(existingRows, incoming) {
    const rows = Array.isArray(existingRows) ? existingRows.slice() : [];
    const byId = new Map(rows.map((r, i) => [r.id, i]));
    const report = { added: 0, refreshed: 0, unchanged: 0, drifted: [], skipped: 0 };

    for (const fresh of (incoming || [])) {
        // ── LOUD, NOT SILENT ─────────────────────────────────────────────
        // This takes NORMALISED rows, not raw Plaid ones. A raw Plaid
        // transaction has transaction_id and no id, so the original `continue`
        // here dropped every single one and returned an empty list with no
        // error — a caller who forgot fromPlaid() would see a clean sync of
        // nothing. Found by my own smoke test making exactly that mistake.
        //
        // The money stores in this repo fail loudly for the same reason, so
        // this throws rather than quietly agreeing.
        if (!fresh || typeof fresh !== 'object') { report.skipped += 1; continue; }
        if (!fresh.id) {
            throw new Error(fresh.transaction_id
                ? 'upsert takes normalised rows — call fromPlaid() on the Plaid transaction first'
                : 'a bank row with no id cannot be keyed, and an unkeyed row duplicates on every sync');
        }
        if (!byId.has(fresh.id)) {
            rows.push(fresh);
            byId.set(fresh.id, rows.length - 1);
            report.added += 1;
            continue;
        }
        const old = rows[byId.get(fresh.id)];
        const changed = BANK_FIELDS.filter((k) => JSON.stringify(old[k]) !== JSON.stringify(fresh[k]));
        // A pending row becoming posted is the normal, expected change and is
        // not drift — it is the whole reason pending rows are held back.
        const onlyClearing = changed.length === 1 && changed[0] === 'pending' && old.pending && !fresh.pending;

        const merged = { ...old };
        for (const k of BANK_FIELDS) merged[k] = fresh[k];
        for (const k of HERS) merged[k] = old[k];
        merged.raw = old.raw;                   // immutable: the first thing the bank said
        merged.first_seen = old.first_seen;
        merged.last_seen = new Date().toISOString();
        merged.history = (old.history || []).slice();

        if (changed.length && actedOn(old) && !onlyClearing) {
            const was = {}; const now = {};
            for (const k of changed) { was[k] = old[k]; now[k] = fresh[k]; }
            merged.drift = { at: merged.last_seen, fields: changed, was, now };
            merged.history.push({ at: merged.last_seen, what: 'bank restated this row after it was acted on',
                by: 'plaid sync', fields: changed, was, now });
            report.drifted.push({ id: fresh.id, fields: changed, was, now });
        } else if (changed.length) {
            merged.drift = old.drift || null;
        }

        rows[byId.get(fresh.id)] = merged;
        if (changed.length) report.refreshed += 1; else report.unchanged += 1;
    }
    return { rows, report };
}

// ── exclude: out of the worklist, never out of the books ─────────────────
// Her instruction, 2026-10-05: hidden from the worklist, still counted, and
// reversible. Every call leaves a history line, because "why is this
// excluded" is a question asked months later by someone else.
function setExcluded(rows, id, excluded, { reason = null, by = null } = {}) {
    const out = (rows || []).map((r) => {
        if (r.id !== id) return r;
        const at = new Date().toISOString();
        return {
            ...r,
            excluded: !!excluded,
            excluded_reason: excluded ? (reason || null) : null,
            history: (r.history || []).concat([{
                at, by: by || null,
                what: excluded ? 'excluded from the worklist' : 'put back in the worklist',
                why: excluded ? (reason || null) : null,
            }]),
        };
    });
    const hit = out.find((r) => r.id === id) || null;
    return { rows: out, row: hit };
}

// What she actually works through. Pending is held back because the amount
// can still move; excluded is held back because she said so.
function worklist(rows) {
    return (rows || []).filter((r) => r && !r.pending && !r.excluded);
}

// ── the numbers at the top of the screen ─────────────────────────────────
// Excluded and pending get their OWN totals rather than being quietly left
// out of a single figure. A screen that shows one number has to be trusted;
// a screen that shows what it set aside can be checked.
function summary(rows) {
    const all = (rows || []).filter(Boolean);
    const sum = (list, k) => round2(list.reduce((t, r) => t + num0(r[k]), 0)) || 0;
    const work = worklist(all);
    const excluded = all.filter((r) => r.excluded);
    const pending = all.filter((r) => r.pending);
    return {
        rows: all.length,
        worklist: work.length,
        in: { count: work.filter((r) => r.direction === 'in').length, money: sum(work.filter((r) => r.direction === 'in'), 'received') },
        out: { count: work.filter((r) => r.direction === 'out').length, money: sum(work.filter((r) => r.direction === 'out'), 'spent') },
        // STILL COUNTED. The point of the whole exclusion design.
        excluded: { count: excluded.length, money: sum(excluded, 'amount') },
        pending: { count: pending.length, money: sum(pending, 'amount') },
        drifted: all.filter((r) => r.drift).length,
        companies: [...new Set(all.map((r) => r.company).filter(Boolean))],
        no_company: all.filter((r) => !r.company).length,
    };
}

// ── disk ─────────────────────────────────────────────────────────────────
// BANK_TX_FILE is in SECRET_PATTERNS, excluded from the nightly Drive
// backup, so nothing here logs a row of it.
function list() {
    const raw = loadJson(FILE(), []);
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.transactions)) return raw.transactions;
    return [];
}

async function ingestPlaid(txs, { accounts = null } = {}) {
    const acc = accounts || readAccounts();
    const fresh = (txs || []).map((t) => fromPlaid(t, acc)).filter(Boolean);
    let report = null;
    await mutateJson(FILE(), [], (all) => {
        const current = Array.isArray(all) ? all
            : (all && Array.isArray(all.transactions) ? all.transactions : []);
        const r = upsert(current, fresh);
        report = r.report;
        return r.rows;
    });
    return report;
}

async function exclude(id, reason, by) {
    let row = null;
    await mutateJson(FILE(), [], (all) => {
        const current = Array.isArray(all) ? all : [];
        const r = setExcluded(current, id, true, { reason, by });
        row = r.row;
        return r.rows;
    });
    return row;
}

async function include(id, by) {
    let row = null;
    await mutateJson(FILE(), [], (all) => {
        const current = Array.isArray(all) ? all : [];
        const r = setExcluded(current, id, false, { by });
        row = r.row;
        return r.rows;
    });
    return row;
}

module.exports = {
    FILE, fromPlaid, upsert, setExcluded, worklist, summary,
    list, ingestPlaid, exclude, include,
    companyOf, bankOf, SWIFT_TO_BANK, readAccounts, accountsFile, joinPlaidAccounts, BANK_FIELDS, HERS, actedOn,
};
