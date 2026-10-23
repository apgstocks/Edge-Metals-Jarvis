// ── helpers/unrecordedPayments.js — money left the bank, nobody wrote it down ─
//
// Apsara, 2026-10-23: "They are forgetting to record the payment in jarvis."
// Asked whether to rely on reminders or have Jarvis catch it, she chose
// catching it. Told that it needed Plaid, she said: "You have pliad na.
// leverage that."
//
// She was right, and I was being lazy. helpers/bankOut.js already answers
// this question exactly — matchWithdrawal() returns outcome 'not_recorded'
// with the sentence "<amount> left the bank on <date> and Jarvis has no
// payment ...". That machinery is built and carries 1,200+ assertions across
// the bank-* suites. NOTHING HERE RE-MATCHES ANYTHING. It calls sweep(),
// takes the rows already labelled not_recorded, and chases one person about
// them. Writing a second matcher for money going out would be the worst kind
// of duplication: two answers to "was this paid", drifting apart.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//   · It never messages when there is nothing to say. A chase that arrives
//     every morning saying "all clear" is a chase that gets muted, and then
//     the one that matters is muted too.
//   · It never chases the SAME withdrawal twice. Without that this becomes a
//     daily repeat of the same five rows until somebody acts, which is how
//     she ends up ignoring it. Same shape as PAYMENT_EMAILS_PROCESSED_FILE.
//   · It never names a supplier it is not sure of. The bank description is
//     a raw string; the point of the message is "go and look", not an
//     accusation about a specific payee.
const path = require('path');
const cfg = require('../config');
const { loadJson, saveJson } = require('./json');

// NOTE: cfg.BANK_TX_FILE is deliberately NOT read here. It exists, but the
// review screen reads bankLedger.list() and this must agree with the screen
// she looks at, not with a second source. See find().
//
// Its own seen-store, beside the other watcher stores. Not shared with the
// bank matcher's own state: this file only records who has been TOLD about
// a row, which is a different fact from whether the row has been matched.
const FILE = () => cfg.UNRECORDED_CHASED_FILE
    || path.join(cfg.DATA_DIR, 'unrecorded-payments-chased.json');

function seen() {
    const raw = loadJson(FILE(), { ids: [] });
    return new Set(Array.isArray(raw && raw.ids) ? raw.ids : []);
}

async function remember(ids) {
    const all = [...seen(), ...ids];
    // Capped and trimmed oldest-first. This is a "have I mentioned it" log,
    // not an audit trail — the audit trail is the bank feed itself.
    const keep = all.slice(-2000);
    await saveJson(FILE(), { ids: keep });
    return keep.length;
}

// A stable id for a bank row, so the same withdrawal is recognised tomorrow.
// Prefers the bank's own id; falls back to date+amount+description, which is
// what a statement row is uniquely made of.
function rowId(r) {
    if (!r) return '';
    if (r.id) return String(r.id);
    return [r.date || '', r.amount != null ? r.amount : (r.spent || ''), r.desc || r.memo || '']
        .join('|').slice(0, 200);
}

// ── FIND ────────────────────────────────────────────────────────────────────
// Everything bankOut already labelled as money out with no record. `opts` is
// handed straight through so a caller can narrow by company code or dates
// exactly as the review screen does.
function find({ rows = null, lines = null, includeAlreadyChased = false, from = null, to = null, ...opts } = {}) {
    const bankOut = require('./bankOut');

    // ── THE SAME SOURCES THE REVIEW SCREEN USES ─────────────────────────
    // My first version read cfg.BANK_TX_FILE and a helpers/ledger.js that
    // does not exist. Three guesses, three wrong. These are the real ones,
    // copied from /api/bank/review so this and the screen can never disagree
    // about what counts as paid:
    //
    //   · bankLedger.list()              — the bank rows
    //   · booksBuild.build().lines       — the JOURNAL, not the six payment
    //     stores, because booksBuild already enumerates every store that
    //     moves money and a new store is matched the day it is posted
    //   · bankReconcile.bankAccounts()   — the sweep runs PER ACCOUNT
    let bankRows, recorded, accounts;
    try {
        bankRows = rows || require('./bankLedger').list();
        recorded = lines || require('./booksBuild').build({ from, to }).lines;
        accounts = require('./bankReconcile').bankAccounts();
    } catch (e) {
        console.error('[UNRECORDED] could not read the books:', e.message);
        return { ok: false, error: e.message, rows: [], total: 0 };
    }

    // ── MONEY BETWEEN HER OWN COMPANIES IS NOT AN UNRECORDED PAYMENT ────
    // Edge Metals paying AAA Investment is a transfer, and the review screen
    // drops those before sweeping. Without this the very first chase would
    // have been a list of her own internal moves — noise, and wrong, on the
    // one message whose whole job is to be believed.
    let sweepRows = bankRows;
    try {
        const IC = require('./interCompany');
        const f = IC.detect(bankRows);
        const tIds = new Set((bankRows || []).filter((r) => IC.linked(r)).map((r) => r.id));
        for (const p of [...f.pairs, ...f.oneSided]) {
            if (p.out_row) tIds.add(p.out_row.id);
            if (p.in_row) tIds.add(p.in_row.id);
        }
        sweepRows = bankRows.filter((r) => !tIds.has(r.id));
    } catch (e) {
        // Transfer detection unavailable: say so and carry on rather than
        // chasing her about every internal move as if it were a supplier.
        console.warn('[UNRECORDED] inter-company detection unavailable —', e.message);
    }

    let out = [];
    try {
        for (const a of (accounts.length ? accounts : [{ code: null }])) {
            const swept = bankOut.sweep({ rows: sweepRows, lines: recorded, code: a.code, from, to, ...opts });
            out.push(...(swept.results || []).filter((r) => r.outcome === 'not_recorded'));
        }
    } catch (e) {
        // A sweep that cannot run must not look like a clean bill of health.
        console.error('[UNRECORDED] sweep failed:', e.message);
        return { ok: false, error: e.message, rows: [], total: 0 };
    }

    const already = includeAlreadyChased ? new Set() : seen();
    const fresh = out.filter((r) => !already.has(rowId(r.row)));
    return {
        ok: true,
        rows: fresh.map((r) => ({
            id: rowId(r.row),
            date: (r.row || {}).date || null,
            amount: Number((r.row || {}).amount || (r.row || {}).spent || 0),
            description: (r.row || {}).desc || (r.row || {}).memo || '',
            bank: (r.row || {}).bank || '',
            note: r.note || '',
        })),
        total: Math.round(fresh.reduce((t, r) => t + Number((r.row || {}).amount || 0), 0) * 100) / 100,
        suppressed: out.length - fresh.length,
    };
}

// ── CHASE ───────────────────────────────────────────────────────────────────
// One message, to the accounts contact in Settings, on WhatsApp and email.
// Returns what it did rather than throwing: this runs unattended, and a
// failed chase must leave a legible trail without taking a nightly job down.
async function chase({ dryRun = false, notify: notifyMod = null, ...opts } = {}) {
    const found = find(opts);
    if (!found.ok) return { sent: false, reason: 'sweep failed: ' + found.error, found };
    if (!found.rows.length) {
        // Deliberately silent. See the header: an all-clear every morning is
        // how the real one gets ignored.
        return { sent: false, reason: 'nothing unrecorded', found };
    }

    const n = found.rows.length;
    const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const subject = `${n} payment${n === 1 ? '' : 's'} not recorded in Jarvis`;
    const body = [
        `${n} payment${n === 1 ? ' has' : 's have'} left the bank with no matching entry in Jarvis`
            + ` — ${money(found.total)} in total.`,
        '',
        ...found.rows.slice(0, 20).map((r) => `· ${r.date}  ${money(r.amount)}  ${r.description}`.trim()),
        ...(found.rows.length > 20 ? [`· …and ${found.rows.length - 20} more`] : []),
        '',
        'Please record these in Jarvis today. Until they are in, the supplier still',
        'shows as unpaid, which overstates what we owe and risks paying twice.',
    ].join('\n');

    if (dryRun) return { sent: false, reason: 'dry run', subject, body, found };

    const notify = notifyMod || require('./notify');
    const res = await notify.messageAccounts(subject, body);
    // Only remember rows she was actually told about. Recording them after a
    // failed send would bury them for good — the one thing worse than
    // chasing twice is never chasing at all.
    if (res.sent) await remember(found.rows.map((r) => r.id));
    return { sent: !!res.sent, delivery: res, subject, body, found };
}

module.exports = { find, chase, rowId, seen, remember, FILE };
