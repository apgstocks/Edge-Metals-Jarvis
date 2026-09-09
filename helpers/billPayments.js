// ── helpers/billPayments.js — paying for containers ──────────────────────
// Apsara, 2026-09-10: "We need pay option.in payment,there is a possible of
// giving advance deduction and multiple container paynebt at once.how should
// we handle this?"
//
// Two things the existing ledger cannot say, and one it must keep saying.
//
// ── WHAT helpers/payments.js CANNOT EXPRESS ──────────────────────────────
// It ties ONE payment to ONE thing (`load_id`, required). That is right for a
// yard load, where a payment is for that load. It cannot express either of
// the two shapes she described:
//
//   1. ONE WIRE, THREE CONTAINERS. A single transfer paying three bills.
//      Splitting it into three payment rows loses the fact that one payment
//      happened, and a supplier chasing "did you send the 20th's wire" is
//      then answered from three half-answers.
//
//   2. AN ADVANCE. Money sent to a supplier BEFORE any container is billed.
//      There is no bill to attach it to at the moment it is sent, which is
//      exactly what addPayment refuses.
//
// So a payment here is a HEADER plus ALLOCATIONS: one record for the transfer
// that really happened, and a list of how much of it went to which container.
// An advance is simply a payment whose allocations do not yet add up to its
// amount — the remainder is credit sitting against that supplier.
//
// ── AND WHAT MUST KEEP WORKING ───────────────────────────────────────────
// The spend report, petty cash and the audit log all read helpers/payments.js.
// A second money store invisible to them would mean her report quietly stops
// matching her bank. So every payment here ALSO writes one row to that ledger
// — one row per TRANSFER, not per allocation, carrying load_kind:'bill'.
// helpers/spendReport.js already branches on load_kind for 'sale' and
// 'trucker'; 'bill' is the third.
//
// ── WHEN IT COUNTS AS SPENT ──────────────────────────────────────────────
// On the day the money leaves the bank, not the day it is allocated. Her
// choice, asked directly, and it is the opposite of what the advance feature
// removed on 2026-08-29 used to do: that one recognised spend at APPLICATION
// time, so a $10,000 wire showed as $0 spent until it was attached to
// something. Defensible for cost attribution and wrong for cash flow, and the
// failure is silent — a month with a big unapplied advance simply looks
// cheaper than it was.
//
// Because the ledger row is written once, at transfer time, applying an
// advance later adds an ALLOCATION and no money. That is what stops the same
// dollar being counted twice.
//
// ── EDGE METALS ONLY ─────────────────────────────────────────────────────
// She removed supplier advances from the yard on 2026-08-29 ("remove that
// advance concept") and that removal stands: nothing here touches loads,
// sellers or the yard's payment forms. Freight is a different business, which
// is the same reason bills and sales are not yard loads. Raised with her
// before building, because rebuilding something someone deleted is worth
// asking about rather than assuming.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const CENT = 0.005;

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
}

// Zelle and Wire only, matching helpers/truckerBills.js. Deliberately NOT
// Cash: a cash payment draws down petty cash, and entangling a supplier's
// container invoice with the yard's cash box is a knot nobody wants to untie
// later. If she pays a supplier in cash it can be added — as one entry, on
// purpose, not by accident.
const BILL_PAYMENT_MODES = ['Zelle', 'Wire'];

const list = () => {
    const raw = loadJson(cfg.BILL_PAYMENTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const newId = () => `BPAY_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// Every allocation across every payment, flattened. The one place that knows
// how much a given container has been paid.
function allocationsFor(billId) {
    const id = String(billId || '');
    const out = [];
    for (const p of list()) {
        for (const a of (p.allocations || [])) {
            if (String(a.bill_id) === id) {
                out.push({ payment_id: p.id, date: p.date, mode: p.mode, bank: p.bank,
                           ref: p.ref, kind: p.kind, amount: num(a.amount) || 0 });
            }
        }
    }
    return out.sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
}

const paidFor = (billId) => round2(allocationsFor(billId).reduce((s, a) => s + a.amount, 0)) || 0;

// paid-per-bill for EVERY bill in one pass. listWithTotals calls this once
// rather than calling paidFor per row — with a few hundred bills and a few
// hundred payments the per-row version is quadratic, and it is the kind of
// slow that only shows up months in.
function paidByBill() {
    const out = {};
    for (const p of list()) {
        for (const a of (p.allocations || [])) {
            const k = String(a.bill_id);
            out[k] = round2((out[k] || 0) + (num(a.amount) || 0));
        }
    }
    return out;
}

// ── WHAT IS LEFT OF AN ADVANCE ───────────────────────────────────────────
// An advance's unallocated remainder is credit against that supplier. Summed
// per supplier so the Bills tab can say "Eccomelt has $4,200 sitting" without
// her going to look for it.
function advancesFor(supplier) {
    const want = String(supplier || '').trim().toLowerCase();
    return list()
        .filter((p) => p.kind === 'advance')
        .filter((p) => !want || String(p.supplier || '').trim().toLowerCase() === want)
        .map((p) => {
            const used = round2((p.allocations || []).reduce((s, a) => s + (num(a.amount) || 0), 0)) || 0;
            return { ...p, used, available: round2((num(p.amount) || 0) - used) };
        });
}

function advanceCredit(supplier) {
    return round2(advancesFor(supplier).reduce((s, a) => s + Math.max(0, a.available || 0), 0)) || 0;
}

// Every supplier holding credit, for the panel.
function creditBySupplier() {
    const out = {};
    for (const a of advancesFor(null)) {
        const s = String(a.supplier || '').trim();
        if (!s || !(a.available > CENT)) continue;
        out[s] = round2((out[s] || 0) + a.available);
    }
    return out;
}

// Allocations are checked BEFORE anything is written: an allocation naming a
// bill that does not exist, or adding up to more than the payment, is a
// mistake worth refusing rather than storing and reporting oddly forever.
function cleanAllocations(input, amount, { allowUnallocated = false } = {}) {
    const bills = require('./bills');
    const known = new Set(bills.list().map((b) => b.id));
    const out = [];
    for (const a of (input || [])) {
        const billId = String((a && a.bill_id) || '').trim();
        const amt = num(a && a.amount);
        if (!billId) continue;
        if (amt === null || amt <= 0) continue;
        if (!known.has(billId)) throw new Error(`no bill ${billId}`);
        const already = out.find((x) => x.bill_id === billId);
        if (already) already.amount = round2(already.amount + amt);
        else out.push({ bill_id: billId, amount: round2(amt) });
    }
    const total = round2(out.reduce((s, a) => s + a.amount, 0)) || 0;
    if (total - amount > CENT) {
        throw new Error(`allocations come to $${total.toFixed(2)} but the payment is $${amount.toFixed(2)}`);
    }
    // A plain payment must be fully allocated — otherwise it is an advance,
    // and calling it a payment hides credit she would never find again.
    if (!allowUnallocated && amount - total > CENT) {
        throw new Error(`$${round2(amount - total).toFixed(2)} of this payment is not allocated to any container — record it as an advance instead`);
    }
    return out;
}

// Writes the money-out row that helpers/spendReport.js reads. ONE per
// transfer, so a wire covering three containers is one line in her report and
// one line on her bank statement.
async function mirrorToLedger(rec) {
    const { addPayment } = require('./payments');
    return addPayment({
        // The payment's own id, NOT a bill id. paymentsForLoad(billId) must
        // never match it — a bill's paid figure comes from allocations, and a
        // yard load must never see this row at all.
        load_id: rec.id,
        load_kind: 'bill',
        amount: rec.amount,
        mode: rec.mode,
        bank: rec.bank || null,
        // ── THE LEDGER'S DATE FORMAT, NOT HERS ───────────────────────────
        // She types MM/DD/YYYY; helpers/payments.js stores YYYY-MM-DD (its
        // default is time.todayLocal()). Passing hers straight through put a
        // date the spend report's range filter could not read, so the payment
        // existed and appeared in no report at all — money spent and
        // invisible, which is the worst of the three ways this could fail.
        paid_on: require('./bills').sortableDate(rec.date) || rec.date,
        note: rec.kind === 'advance'
            ? `Advance to ${rec.supplier || 'supplier'}${rec.ref ? ` (${rec.ref})` : ''}`
            : `Bill payment${rec.supplier ? ` to ${rec.supplier}` : ''}${rec.ref ? ` (${rec.ref})` : ''}`,
        require_bank: true,
        recorded_by: rec.created_by || null,
    });
}

async function addPaymentRecord(input = {}, { advance = false } = {}) {
    const amount = round2(num(input.amount));
    if (amount === null || amount <= 0) throw new Error('a payment amount is required');
    const mode = BILL_PAYMENT_MODES.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    if (!mode) throw new Error(`payment mode must be one of: ${BILL_PAYMENT_MODES.join(', ')}`);
    if (!String(input.bank || '').trim()) throw new Error('a bank is required for Zelle and Wire');
    if (!String(input.date || '').trim()) throw new Error('a payment needs a date');
    if (advance && !String(input.supplier || '').trim()) {
        throw new Error('an advance needs a supplier — it is credit against them until you apply it');
    }

    const allocations = cleanAllocations(input.allocations, amount, { allowUnallocated: advance });

    const rec = {
        id: newId(),
        kind: advance ? 'advance' : 'payment',
        date: String(input.date).trim(),
        amount,
        mode,
        bank: String(input.bank).trim(),
        ref: String(input.ref || '').trim() || null,
        supplier: String(input.supplier || '').trim() || null,
        note: String(input.note || '').trim() || null,
        allocations,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };

    // ── THE LEDGER ROW FIRST ─────────────────────────────────────────────
    // If the ledger write fails, nothing is stored here either — better a
    // payment she has to enter again than one that exists in the Bills tab
    // and is missing from her spend report, which is the shape of error
    // nobody finds until the month is closed.
    const mirrored = await mirrorToLedger(rec);
    rec.ledger_payment_id = mirrored && mirrored.id ? mirrored.id : null;

    await mutateJson(cfg.BILL_PAYMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(rec);
        return rows;
    });
    return rec;
}

const addBillPayment = (input) => addPaymentRecord(input, { advance: false });
const addAdvance = (input) => addPaymentRecord(input, { advance: true });

// ── APPLYING AN ADVANCE MOVES NO MONEY ───────────────────────────────────
// It adds an allocation to a payment that already happened. No second ledger
// row, because the money already left the bank and was already counted on the
// day it did. This is the join that stops a dollar being spent twice.
async function applyAdvance(paymentId, allocations = []) {
    let out = null, problem = null;
    await mutateJson(cfg.BILL_PAYMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === paymentId);
        if (i === -1) { problem = `no payment ${paymentId}`; return rows; }
        if (rows[i].kind !== 'advance') { problem = 'only an advance can be applied'; return rows; }
        const amount = num(rows[i].amount) || 0;
        let merged;
        try {
            merged = cleanAllocations([...(rows[i].allocations || []), ...allocations], amount,
                                      { allowUnallocated: true });
        } catch (e) { problem = e.message; return rows; }
        rows[i] = { ...rows[i], allocations: merged, updated_at: new Date().toISOString() };
        out = rows[i];
        return rows;
    });
    if (problem) throw new Error(problem);
    return out;
}

// Deleting a payment removes its ledger row too, or her report keeps counting
// money that is no longer recorded as paid. Same rule loads already follow.
async function deleteBillPayment(id) {
    const doomed = list().find((p) => p.id === id);
    if (!doomed) throw new Error(`no payment ${id}`);
    await mutateJson(cfg.BILL_PAYMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i !== -1) rows.splice(i, 1);
        return rows;
    });
    try {
        const { deletePaymentsForLoad } = require('./payments');
        await deletePaymentsForLoad(doomed.id);
    } catch (e) {
        console.error('[BILL-PAY] removed the payment but could not remove its ledger row:', e.message);
    }
    return true;
}

// What the tab shows at the top.
function summary() {
    const rows = list();
    const sum = (f) => round2(rows.filter(f).reduce((s, p) => s + (num(p.amount) || 0), 0)) || 0;
    return {
        count: rows.length,
        paid: sum((p) => p.kind === 'payment'),
        advanced: sum((p) => p.kind === 'advance'),
        credit_available: round2(Object.values(creditBySupplier()).reduce((s, v) => s + v, 0)) || 0,
    };
}

module.exports = {
    BILL_PAYMENT_MODES,
    list, allocationsFor, paidFor, paidByBill,
    advancesFor, advanceCredit, creditBySupplier,
    addBillPayment, addAdvance, applyAdvance, deleteBillPayment, summary,
    cleanAllocations,
};
