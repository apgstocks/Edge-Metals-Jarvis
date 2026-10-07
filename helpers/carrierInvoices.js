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

module.exports = { CARRIERS, STATUSES, list, upsertMany, summary, statusOf, validate };
