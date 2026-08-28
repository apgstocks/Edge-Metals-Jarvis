// ── helpers/payments.js — payments recorded against a load ─────────────────
//
// Per Apsara 2026-08-28: a Pay button beside Edit/Delete opening a form with
// payment mode (Zelle / Wire / Cash / Cheque) and an amount; anything short of
// the load total is a PARTIAL payment with a pending balance, and the result
// has to show up on the invoice.
//
// A LEDGER, not a flag. "Partial, with a pending amount" only means anything
// if a load can be settled across several payments — pay half on collection
// and the rest on Friday — so this stores each payment as its own row and
// derives paid/pending by summing them. A single paid_amount field on the load
// would lose the history the moment a second payment arrived, and the history
// is the part anyone actually argues about later.
//
// ITS OWN STORE, and here that is about money rather than tidiness. Loads are
// re-saved WHOLESALE on every edit — editLoad in helpers/loads.js rebuilds the
// record from the fields it knows about — so a payments array hanging off the
// load would be one dropped field away from erasing a receipt. That exact
// class of bug has already happened in this repo once (pdf_link was silently
// discarded by editOutboundLoad, which is why patchOutboundLoad exists).
// Keeping payments outside the load write path means correcting a weight
// cannot touch what was paid.
//
// Nothing here deletes or edits a payment's amount in place: a wrong payment
// is deleted whole and re-entered, so there is no half-edited row.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// Fixed set, per Apsara. Kept as a constant and exported so the API, both
// clients and the PDF all read the same list rather than three drifting
// copies of a dropdown.
const PAYMENT_MODES = ['Zelle', 'Wire', 'Cash', 'Cheque'];

// Money is compared to the cent. Floating point makes 4010 * 2.2 come out as
// 8822.000000000001, so a load paid exactly to the penny would otherwise
// report a pending balance of -0.000000000001 and never read as settled.
const CENT = 0.005;

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const toNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
};

const listPayments = () => {
    const raw = loadJson(cfg.PAYMENTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

// Advances are excluded by the load_id test itself — they carry none until
// they are applied, at which point the application is its own row with a real
// load_id. So an unapplied advance can never make a load look part-paid.
const paymentsForLoad = (loadId) => listPayments()
    .filter((p) => p.load_id === loadId)
    .sort((a, b) => String(a.paid_on || a.created_at || '').localeCompare(String(b.paid_on || b.created_at || '')));

function newPaymentId() {
    return `PAY_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Advances were REMOVED 2026-08-29, per Apsara: "remove that advance
// concept." ────────────────────────────────────────────────────────────────
//
// What used to be here: a payment scoped to a seller instead of a load, held
// as credit and applied to loads later. Gone — no addAdvance, no applyAdvance,
// no /api/advances, no UI.
//
// LEGACY ROWS ARE STILL SAFE. Any is_advance record already written to
// payments.json carries load_id: null, so paymentsForLoad's load_id filter
// simply never matches it. It cannot corrupt a balance and cannot make a load
// look part-paid — it just sits in the file, inert and invisible. Rows created
// by APPLYING an advance are ordinary payment rows with a real load_id and
// keep working exactly as before; they are indistinguishable from any other
// payment apart from an applied_from field nothing reads any more.
//
// If an unapplied advance ever needs to be recovered, it is in payments.json
// with is_advance: true — the money was never lost, only the feature.

async function addPayment(input = {}) {
    const loadId = String(input.load_id || '').trim();
    if (!loadId) throw new Error('load_id is required');
    const amount = round2(toNum(input.amount));
    // Rejected rather than stored as null: a payment with no amount cannot be
    // summed, so it would sit on the ledger looking like a receipt while
    // contributing nothing to the balance — worse than not being there.
    if (amount == null) throw new Error('a payment amount is required');
    if (amount <= 0) throw new Error('a payment amount must be greater than zero');
    const mode = PAYMENT_MODES.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    if (!mode) throw new Error(`payment mode must be one of: ${PAYMENT_MODES.join(', ')}`);

    const record = {
        id: newPaymentId(),
        load_id: loadId,
        // Which store the load lives in. Ids are unique per store but not
        // across them, so without this a purchase and a sale could collide.
        load_kind: input.load_kind === 'sale' ? 'sale' : 'purchase',
        mode,
        amount,
        paid_on: input.paid_on || new Date().toISOString().slice(0, 10),
        reference: String(input.reference || '').trim() || null,
        note: String(input.note || '').trim() || null,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        list.push(record);
        return list;
    });
    return record;
}

async function deletePayment(id) {
    let removed = false;
    await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const next = list.filter((p) => p.id !== id);
        removed = next.length !== list.length;
        return next;
    });
    return removed;
}

// Removes every payment for a load. Called when a load is deleted, so a
// deleted load cannot leave orphan receipts summing against nothing.
async function deletePaymentsForLoad(loadId) {
    let removed = 0;
    await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const next = list.filter((p) => p.load_id !== loadId);
        removed = list.length - next.length;
        return next;
    });
    return removed;
}

// The figure every screen and the invoice quote. Derived, never stored, so it
// cannot drift from the payments it is supposed to summarise — and so that
// editing a load's price recalculates the balance instead of leaving a stale
// "paid in full" behind.
function paymentSummary(loadId, loadAmount) {
    const rows = paymentsForLoad(loadId);
    const paid = round2(rows.reduce((a, p) => a + (toNum(p.amount) || 0), 0)) || 0;
    const total = round2(toNum(loadAmount));

    // A load with no priced items has no total to settle against. Report what
    // was paid and say the balance is unknown rather than inventing one —
    // claiming "fully paid" because the total happens to be null would be a
    // lie with money attached.
    if (total == null) {
        return { paid, total: null, pending: null, status: paid > 0 ? 'paid_amount_unknown' : 'unpaid', payments: rows };
    }

    const pending = round2(total - paid);
    let status;
    if (paid <= CENT) status = 'unpaid';
    else if (pending > CENT) status = 'partial';
    else if (pending < -CENT) status = 'overpaid';
    else status = 'paid';
    return {
        paid,
        total,
        // Never negative on an overpayment — the overage is reported through
        // `status` and `over`, so a UI showing "pending" cannot show a
        // negative balance as though something were still owed.
        pending: pending > CENT ? pending : 0,
        over: pending < -CENT ? round2(-pending) : 0,
        status,
        payments: rows,
    };
}

module.exports = {
    PAYMENT_MODES, listPayments, paymentsForLoad, addPayment,
    deletePayment, deletePaymentsForLoad, paymentSummary,
};
