// ── helpers/salesReceipts.js — money coming IN from customers ────────────
// Apsara, 2026-09-10: "In outgoing-give the option as mark as paid..sometimes
// there might be a deduction in received amount because of wire deduction by
// bank".
//
// ── WHY "MARK AS PAID" IS NOT A FLAG ─────────────────────────────────────
// The obvious build is a `paid: true` column on the container. It takes ten
// minutes and it is wrong, because of the second half of her sentence: the
// customer wires $12,340 and $12,315 lands, the intermediary bank having
// taken $25 in transit. A boolean says settled; the bank statement says
// $12,315; and nothing anywhere says where the $25 went. That gap is
// unexplainable a month later, and an unexplainable gap in a receivable is
// how a real short payment gets mistaken for a bank charge and written off.
//
// So marking paid RECORDS A RECEIPT, and the shortfall is classified rather
// than absorbed. Three ways a balance can close, and they are not the same:
//
//   · the money arrived                    → allocation
//   · the bank took a cut in transit       → deduction, reason 'bank_charge'.
//                                            A COST to Edge Metals. Revenue
//                                            stays at the invoice figure,
//                                            because the customer did pay it.
//   · she agreed to take less              → deduction, reason 'discount'.
//                                            A reduction in what was earned,
//                                            NOT a cost. Different line, and
//                                            conflating the two flatters the
//                                            margin on every short payment.
//
// And the fourth case is the one with no deduction at all: they simply have
// not paid it yet. That is a balance, and it stays a balance.
//
// ── THE SHAPE IS helpers/billPayments.js, MIRRORED ───────────────────────
// One receipt is a HEADER (the transfer that really happened) plus
// ALLOCATIONS (how much of it went to which container), because a customer
// settles three containers with one TT and settles one container in two
// instalments, and neither fits a column. Deliberately the same shape as the
// purchase side: two stores that answer the same question in two different
// ways is how the two ends of a trade stop reconciling.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
// It writes NO row to helpers/payments.js. That store is money Edge Metals
// PAID OUT — the spend report, petty cash and the bank matcher all read it as
// outflow. Putting an inflow there would subtract a customer's payment from
// her spend, which is worse than not recording it at all. Bank charges are
// surfaced here and folded into the spend report by its own branch, not by
// pretending a receipt was a payment.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};
const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const CENT = 0.005;

// The ways money actually arrives. Cash is here because it does — a customer
// paying cash for a container is not a yard petty-cash movement, exactly as
// on the purchase side, so it touches no cash box.
const RECEIPT_MODES = ['Wire', 'Zelle', 'Cash', 'Cheque'];

// A shortfall is one of these or it is not a shortfall, it is a balance.
const DEDUCTION_REASONS = ['bank_charge', 'discount'];

const list = () => {
    const raw = loadJson(cfg.SALES_RECEIPTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const newId = () => `RCPT_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const sameCustomer = (a, b) =>
    String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ── ONE PASS, NOT ONE PER ROW ────────────────────────────────────────────
// The sales table calls this once and indexes it. Calling it per row turned
// the bills table into an O(n²) read before anyone noticed.
function receivedBySale() {
    const out = {};
    for (const r of list()) {
        for (const a of (r.allocations || [])) {
            out[a.sale_id] = round2((out[a.sale_id] || 0) + (num(a.amount) || 0));
        }
    }
    return out;
}

// Deductions kept separate from receipts on purpose: a container settled by
// $12,315 arriving and $25 of bank charge is NOT the same row as one settled
// by $12,340 arriving, and the sales table has to be able to say which.
function deductedBySale() {
    const out = {};
    for (const r of list()) {
        for (const a of (r.allocations || [])) {
            const d = num(a.deduction_amount) || 0;
            if (!d) continue;
            const cur = out[a.sale_id] || { total: 0, bank_charge: 0, discount: 0 };
            cur.total = round2(cur.total + d);
            cur[a.deduction_reason] = round2((cur[a.deduction_reason] || 0) + d);
            out[a.sale_id] = cur;
        }
    }
    return out;
}

function bankChargesTotal() {
    let t = 0;
    for (const r of list()) {
        for (const a of (r.allocations || [])) {
            if (a.deduction_reason === 'bank_charge') t += (num(a.deduction_amount) || 0);
        }
    }
    return round2(t) || 0;
}

// ── ALLOCATIONS ──────────────────────────────────────────────────────────
// Same rule as the purchase side: one receipt, one customer. A TT from
// Daekwang settling a container invoiced to someone else is a false statement
// about who paid, and it would show the wrong customer as square.
function cleanAllocations(input, amount, { customer = null } = {}) {
    const sales = require('./sales');
    const all = sales.list();
    const byId = new Map(all.map((s) => [s.id, s]));
    const out = [];

    for (const a of (input || [])) {
        const saleId = String((a && a.sale_id) || '').trim();
        if (!saleId) continue;
        const amt = round2(num(a && a.amount)) || 0;
        const ded = round2(num(a && a.deduction_amount)) || 0;
        if (amt <= 0 && ded <= 0) continue;
        if (!byId.has(saleId)) throw new Error(`no sale ${saleId}`);

        const row = byId.get(saleId);
        if (customer && !sameCustomer(row.customer, customer)) {
            throw new Error(`container ${row.container_no || saleId} was invoiced to ${row.customer || 'nobody'}, not ${customer}`);
        }

        let reason = null;
        if (ded > 0) {
            reason = DEDUCTION_REASONS.includes(String(a.deduction_reason || '').trim())
                ? String(a.deduction_reason).trim()
                : null;
            // Unclassified, this is exactly the vanishing $25 the whole file
            // exists to prevent.
            if (!reason) {
                throw new Error(`a ${ded.toFixed(2)} shortfall has to say what it was — a bank charge or a discount. If they simply have not paid it, leave it outstanding instead.`);
            }
        }

        const existing = out.find((x) => x.sale_id === saleId);
        if (existing) {
            existing.amount = round2(existing.amount + amt);
            existing.deduction_amount = round2(existing.deduction_amount + ded);
            if (ded > 0) existing.deduction_reason = reason;
        } else {
            out.push({
                sale_id: saleId,
                amount: amt,
                deduction_amount: ded,
                deduction_reason: reason,
                deduction_note: String((a && a.deduction_note) || '').trim() || null,
            });
        }
    }

    // Only the MONEY has to add up to the transfer. A deduction is money that
    // never arrived, so counting it here would demand she type a figure her
    // bank statement does not show.
    const received = round2(out.reduce((s, a) => s + a.amount, 0)) || 0;
    if (received - amount > CENT) {
        throw new Error(`allocations come to $${received.toFixed(2)} but only $${amount.toFixed(2)} arrived`);
    }
    if (amount - received > CENT) {
        throw new Error(`$${round2(amount - received).toFixed(2)} of this receipt is not against any container`);
    }
    return out;
}

async function addReceipt(input = {}) {
    const amount = round2(num(input.amount));
    if (amount === null || amount <= 0) throw new Error('how much arrived?');
    const mode = RECEIPT_MODES.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    if (!mode) throw new Error(`how it arrived must be one of: ${RECEIPT_MODES.join(', ')}`);
    if (!String(input.date || '').trim()) throw new Error('a receipt needs a date');
    if (!String(input.customer || '').trim()) throw new Error('a receipt needs a customer — who paid?');
    // Cash and cheque have no account until they are banked; a wire always
    // landed somewhere, and that is the figure the bank matcher will need.
    if ((mode === 'Wire' || mode === 'Zelle') && !String(input.bank || '').trim()) {
        throw new Error('which account did it land in?');
    }

    const allocations = cleanAllocations(input.allocations, amount,
        { customer: String(input.customer).trim() });

    const rec = {
        id: newId(),
        date: String(input.date).trim(),
        amount,
        mode,
        bank: (mode === 'Wire' || mode === 'Zelle') ? String(input.bank).trim() : null,
        ref: String(input.ref || '').trim() || null,
        customer: String(input.customer).trim(),
        note: String(input.note || '').trim() || null,
        allocations,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };

    await mutateJson(cfg.SALES_RECEIPTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(rec);
        return rows;
    });
    return rec;
}

async function deleteReceipt(id) {
    const doomed = list().find((r) => r.id === id);
    if (!doomed) throw new Error(`no receipt ${id}`);
    await mutateJson(cfg.SALES_RECEIPTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i !== -1) rows.splice(i, 1);
        return rows;
    });
    return doomed;
}

function summary() {
    const rows = list();
    return {
        count: rows.length,
        received: round2(rows.reduce((s, r) => s + (num(r.amount) || 0), 0)) || 0,
        bank_charges: bankChargesTotal(),
        discounts: round2(rows.reduce((s, r) => s + (r.allocations || [])
            .filter((a) => a.deduction_reason === 'discount')
            .reduce((t, a) => t + (num(a.deduction_amount) || 0), 0), 0)) || 0,
    };
}

module.exports = {
    RECEIPT_MODES, DEDUCTION_REASONS,
    list, addReceipt, deleteReceipt, summary,
    receivedBySale, deductedBySale, bankChargesTotal,
    cleanAllocations, sameCustomer,
};
