// ── helpers/carrierInvoices.js — EDGE METALS local-delivery carriers ─────────
// Apsara, 2026-10-07: NTG, TQL and Schneider bill Edge Metals, and they get "a
// new carrier-invoices list". Own store (carrier_invoices.json) because the
// existing ones do not fit: bills/metals_trucking are keyed on a container,
// these are domestic loads with none. NOT trucker_bills.json — that is Edge Yard.
//
// One row per carrier + key: TQL PO, NTG invoice no., Schneider order id.
// Status is derived from evidence (email remittances), never typed in:
//   open     billed, no payment mail seen
//   paid     a payment mail covers it in full
//   part     a payment mail covers part
// Nothing here is read by bills, sales, trucking or reports, so adding it
// changes no existing screen. Writes are strict (a lost write must throw).
//
// ── AND SINCE 2026-10-08, ROWS SHE ADDS BY HAND ──────────────────────────
// Apsara, looking at the Transport tab with no way to record a payment:
// "If source is manual ,pay button can be there na".
//
// That resolves the conflict the read-only design existed to avoid. An
// IMPORTED row's truth is the carrier's own remittance mail, and nothing here
// may overwrite it — pay it in Jarvis and the next import would disagree with
// her. A MANUAL row has no mail behind it and never will, so there is no
// second opinion to contradict: she is the only source it has ever had.
//
// So the line above — "Status is derived from evidence, never typed in" —
// still holds for every row the importer owns, and only for those.
// addManual() and payManual() below are the hand path, and payManual REFUSES
// an imported row by id rather than silently doing nothing.
const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const CARRIERS = ['tql', 'ntg', 'schneider'];
const STATUSES = ['open', 'part', 'paid'];
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const list = () => { const r = loadJson(cfg.CARRIER_INVOICES_FILE, []); return Array.isArray(r) ? r : []; };
const keyOf = (c, k) => `${c}:${String(k).trim()}`;

function statusOf(amount, paid) {
    if (!(paid > 0)) return 'open';
    return paid + 0.005 >= amount ? 'paid' : 'part';
}

function validate(i) {
    if (!i || !CARRIERS.includes(i.carrier)) return 'carrier must be one of ' + CARRIERS.join(', ');
    if (!i.ref || !String(i.ref).trim()) return 'ref (TQL PO / NTG invoice / Schneider order) is required';
    if (!(Number(i.amount) > 0)) return 'amount must be greater than 0';
    return null;
}

// Insert or update by carrier+ref. Returns { added, updated, rows }.
// A manual edit is never overwritten: rows with `locked` keep their amount/date.
async function upsertMany(items) {
    const bad = (items || []).map(validate).find(Boolean);
    if (bad) throw new Error(bad);
    let added = 0, updated = 0;
    const rows = await mutateJson(cfg.CARRIER_INVOICES_FILE, [], (cur) => {
        const arr = Array.isArray(cur) ? cur : [];
        for (const i of items) {
            const key = keyOf(i.carrier, i.ref);
            const amount = round2(i.amount), paid = round2(i.paid || 0);
            const at = arr.findIndex((r) => r.key === key);
            const base = { company: 'Edge Metals', key, carrier: i.carrier, ref: String(i.ref).trim(), amount, paid,
                status: statusOf(amount, paid), invoice_date: i.invoice_date || null, lane: i.lane || null,
                paid_dates: i.paid_dates || [], evidence: i.evidence || null, updatedAt: new Date().toISOString() };
            if (at === -1) { arr.push({ id: `CI_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...base, createdAt: base.updatedAt }); added++; }
            else if (arr[at].locked) { /* hers — leave */ }
            else { arr[at] = { ...arr[at], ...base }; updated++; }
        }
        return arr;
    }, { strict: true });
    return { added, updated, rows };
}

function summary(rows = list()) {
    const out = {};
    for (const c of CARRIERS) {
        const r = rows.filter((x) => x.carrier === c);
        out[c] = { count: r.length, billed: round2(r.reduce((a, x) => a + x.amount, 0)),
            outstanding: round2(r.reduce((a, x) => a + Math.max(0, x.amount - x.paid), 0)) };
    }
    return out;
}

// ── A ROW SHE TYPED ──────────────────────────────────────────────────────
// Marked `source: 'manual'` AND `locked: true`. The lock is what stops the
// next import overwriting her figures (upsertMany already honours it); the
// source is what the screen and payManual read to decide whether a Pay button
// belongs on the row. Two flags because they answer two questions, and a
// future import that learns to set `locked` on something it owns must not
// thereby make it payable by hand.
async function addManual(input = {}, { actor = null } = {}) {
    const bad = validate(input);
    if (bad) throw new Error(bad);
    const ref = String(input.ref).trim();
    const key = keyOf(input.carrier, ref);
    const amount = round2(input.amount);
    let saved = null;
    await mutateJson(cfg.CARRIER_INVOICES_FILE, [], (cur) => {
        const arr = Array.isArray(cur) ? cur : [];
        // ── A COLLISION IS REFUSED, NOT MERGED ───────────────────────────
        // upsertMany merges by carrier+ref because re-running the importer
        // must be safe. Typing a ref that already exists is the opposite: it
        // is either a duplicate she did not mean or an imported invoice she
        // is about to overwrite by hand, and both deserve a sentence.
        if (arr.some((r) => r && r.key === key)) {
            throw new Error(`${input.carrier.toUpperCase()} ${ref} is already here `
                + '— open that row instead of adding it again');
        }
        saved = {
            id: `CI_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            company: 'Edge Metals', key, carrier: input.carrier, ref,
            amount, paid: 0, status: 'open',
            invoice_date: input.invoice_date || null, lane: input.lane || null,
            paid_dates: [], evidence: 'added by hand',
            source: 'manual', locked: true, added_by: actor || null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        arr.push(saved);
        return arr;
    }, { strict: true });
    return saved;
}

// ── PAYING ONE, AND ONLY A MANUAL ONE ────────────────────────────────────
// The refusal is the feature. An imported row says what the carrier's
// remittance says; recording a payment against it here would create a second
// answer to "is this paid", and the two would disagree the first time a
// remittance arrived late.
async function payManual(id, input = {}, { actor = null } = {}) {
    const amount = Number(input.amount);
    if (!(amount > 0)) throw new Error('a payment needs an amount greater than 0');
    const date = String(input.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('a payment needs a date, as YYYY-MM-DD');
    let saved = null;
    await mutateJson(cfg.CARRIER_INVOICES_FILE, [], (cur) => {
        const arr = Array.isArray(cur) ? cur : [];
        const at = arr.findIndex((r) => r && r.id === id);
        if (at === -1) throw new Error(`no carrier invoice ${id}`);
        const row = arr[at];
        if (row.source !== 'manual') {
            throw new Error(`${String(row.carrier || '').toUpperCase()} ${row.ref} came from the `
                + 'carrier\'s own email, so what it says is paid comes from their remittance. '
                + 'Record this payment where the money left instead.');
        }
        const paid = round2((Number(row.paid) || 0) + amount);
        if (paid > round2(row.amount) + 0.005) {
            throw new Error(`that would pay ${paid.toFixed(2)} against an invoice of `
                + `${round2(row.amount).toFixed(2)}`);
        }
        arr[at] = { ...row, paid, status: statusOf(round2(row.amount), paid),
            // APPENDED. A carrier can be paid in parts, and the Paid on column
            // already shows the latest with a count — overwriting would make a
            // part-paid invoice look settled on the wrong day.
            paid_dates: [...(Array.isArray(row.paid_dates) ? row.paid_dates : []), date],
            payments: [...(Array.isArray(row.payments) ? row.payments : []),
                { amount: round2(amount), date, mode: input.mode || null, bank: input.bank || null,
                  ref: input.ref || null, by: actor || null, at: new Date().toISOString() }],
            updatedAt: new Date().toISOString() };
        saved = arr[at];
        return arr;
    }, { strict: true });
    return saved;
}

module.exports = { CARRIERS, STATUSES, list, upsertMany, summary, statusOf, validate,
                   addManual, payManual };
