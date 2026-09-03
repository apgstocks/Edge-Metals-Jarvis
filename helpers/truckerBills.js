// ── helpers/truckerBills.js — what the yard owes its haulers ──────────────
//
// Apsara, 2026-09-03: "now include a tab called trucker for everyone ... it
// contains date, company name, load ticket number (optional), amount. edit,
// delete, pay option should be there. when i click pay - option should be as
// zelle/wire. once paid, hide delete option for staff and admin. Need to
// incorporate this in report as well."
//
// NOT THE TRUCKER ROSTER
// ----------------------
// The website already has a "Truckers" tab, and it is a different thing: a
// directory of hauliers with their WhatsApp groups, used to route booking
// messages. This is a PAYABLES LEDGER — individual bills owed, and what has
// been paid against them. They share a word and nothing else, which is worth
// stating here because the next person to read "truckers" in this codebase
// will find two of them.
//
// PAYMENTS LIVE IN payments.json, NOT HERE
// ----------------------------------------
// A bill records what is owed; helpers/payments.js records what was paid, with
// load_kind: 'trucker' and load_id set to the bill id. That is deliberate
// reuse rather than convenience:
//
//   - paymentSummary already derives paid/pending/overpaid from summed rows,
//     so a bill can be settled across two payments without new arithmetic.
//   - deletePaymentsForLoad already cascades, so deleting a bill cannot leave
//     orphaned receipts summing against nothing.
//   - the spend report already reads payments.json, so trucker spend appears
//     there by construction rather than by a second code path someone has to
//     remember to keep in step.
//
// A separate trucker_payments store would have meant reimplementing all three,
// and the third is exactly the kind of thing that gets forgotten and then
// quietly understates a month.
//
// ZELLE AND WIRE ONLY
// -------------------
// Her instruction, and it has a useful consequence: no Cash means this ledger
// never touches petty cash, so none of the reserve-then-write ordering that
// load payments need applies here. TRUCKER_PAYMENT_MODES is exported so the
// API and both clients read one list.
//
// AN OPTIONAL LOAD TICKET, KEPT AS FREE TEXT
// ------------------------------------------
// She said optional, so it is not validated against loads.json. A hauler's
// invoice may name a ticket that was voided, renumbered, or never entered —
// refusing the bill in that case would mean the yard cannot record a debt it
// actually owes because of a bookkeeping mismatch. It is stored as typed and
// used for cross-reference, not as a foreign key.

const cfg = require('../config');
const { loadJson, mutateJson: mutateJsonRaw } = require('./json');

// STRICT. mutateJson defaults to strict:false and SWALLOWS errors, returning
// the unmodified data — indistinguishable from success at the call site. For a
// ledger of money owed, a silent write failure is the worst available bug.
const mutateJson = (file, dflt, fn) => mutateJsonRaw(file, dflt, fn, { strict: true });

// No Cash, per Apsara. See the header.
const TRUCKER_PAYMENT_MODES = ['Zelle', 'Wire'];

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const toNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
};
const clean = (v) => {
    const s = String(v == null ? '' : v).trim();
    return s || null;
};

function listBills() {
    const rows = loadJson(cfg.TRUCKER_BILLS_FILE, []);
    return Array.isArray(rows) ? rows : [];
}

// Sequential and human-readable, matching EDGE_01 and EXP_01. MUST be computed
// inside the mutateJson callback, under the file lock — computed earlier, two
// concurrent saves mint the same id, and then a payment against one bill shows
// up on the other.
function nextBillId(rows) {
    let max = 0;
    for (const b of rows) {
        const m = /^TRK_(\d+)$/.exec((b && b.id) || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `TRK_${String(max + 1).padStart(3, '0')}`;
}

// Date, company and amount are what make a bill mean anything. A row missing
// any of them cannot appear correctly on the tab or in any total, so all three
// are hard-required here rather than defaulted — the same choke-point approach
// as validateExpense, enforced in the helper so every caller is covered and
// not just the form.
function validateBill(entry) {
    const amount = toNum(entry && entry.amount);
    if (amount == null) throw new Error('Validation: amount is required.');
    if (amount <= 0) throw new Error('Validation: amount must be greater than zero.');
    if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) {
        throw new Error('Validation: a valid date (YYYY-MM-DD) is required.');
    }
    if (!clean(entry.company)) throw new Error('Validation: company name is required.');
    return round2(amount);
}

async function addBill(entry = {}) {
    const amount = validateBill(entry);
    const rec = {
        id: null,                     // assigned under the lock below
        created_at: new Date().toISOString(),
        created_by: entry.created_by || 'unknown',
        date: entry.date,
        company: clean(entry.company),
        load_ticket: clean(entry.load_ticket),   // optional — see the header
        amount,
        notes: clean(entry.notes),
    };
    await mutateJson(cfg.TRUCKER_BILLS_FILE, [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        rec.id = nextBillId(list);
        list.unshift(rec);
        return list;
    });
    return rec;
}

// Editing does NOT touch payments. A bill whose amount is corrected downward
// below what has already been paid becomes overpaid rather than being refused:
// the money genuinely moved, and refusing the correction would leave the wrong
// figure standing. paymentSummary reports `overpaid` and the tab shows it, so
// the discrepancy is visible instead of prevented into invisibility.
async function editBill(id, entry = {}) {
    const amount = validateBill(entry);
    let updated = null;
    await mutateJson(cfg.TRUCKER_BILLS_FILE, [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const b = list.find((x) => x && x.id === id);
        if (!b) return list;
        Object.assign(b, {
            date: entry.date,
            company: clean(entry.company),
            load_ticket: clean(entry.load_ticket),
            amount,
            notes: clean(entry.notes),
            updated_at: new Date().toISOString(),
        });
        updated = b;
        return list;
    });
    return updated;
}

// Returns the removed record rather than a boolean, so the caller can log what
// it was — the audit row needs the company and the amount, and a moment later
// neither exists. Detected with a captured variable rather than by throwing
// inside the mutator, because a throw in there is swallowed and looks like
// success (see helpers/loads.js's renumberLoad comment).
//
// The PAYMENT CASCADE is the caller's job, not this function's, exactly as it
// is for loads: api.js calls deletePaymentsForLoad after this returns. Keeping
// it there means one place decides what deleting a payable does, rather than
// two helpers each doing half.
async function deleteBill(id) {
    let removed = null;
    await mutateJson(cfg.TRUCKER_BILLS_FILE, [], (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const i = list.findIndex((x) => x && x.id === id);
        if (i === -1) return list;
        removed = list[i];
        list.splice(i, 1);
        return list;
    });
    return removed;
}

function getBill(id) {
    return listBills().find((b) => b && b.id === id) || null;
}

// Every bill with its payment state attached, newest first. Computed fresh on
// each call from payments.json — never stored on the bill — so deleting a
// payment is reflected immediately, and correcting a bill's amount recalculates
// the balance instead of leaving a stale "paid in full" behind.
function listBillsWithPayments({ from, to, company } = {}) {
    const { paymentSummary } = require('./payments');
    const q = String(company || '').trim().toLowerCase();
    return listBills()
        .filter((b) => b && (!from || String(b.date) >= from) && (!to || String(b.date) <= to))
        .filter((b) => !q || String(b.company || '').toLowerCase().includes(q))
        .map((b) => ({ ...b, payment: paymentSummary(b.id, b.amount) }))
        .sort((a, z) => String(z.date || '').localeCompare(String(a.date || ''))
                     || String(z.id || '').localeCompare(String(a.id || '')));
}

// What the tab shows at the top: owed, paid, outstanding. Derived, like
// everything else here.
function billsReport(rows) {
    const list = rows || listBillsWithPayments();
    let billed = 0, paid = 0, outstanding = 0, overpaid = 0;
    for (const b of list) {
        const amount = Number(b.amount) || 0;
        const p = Number(b.payment && b.payment.paid) || 0;
        billed += amount;
        paid += p;
        // ── PER BILL, NOT billed MINUS paid ───────────────────────────────
        // The first version of this computed `max(0, billed - paid)` across
        // the whole list, and a test caught what that means: bill A owes 600,
        // bill B was overpaid by 400, and the header reported 200 outstanding.
        //
        // That is money that does not exist. The 400 sitting with the second
        // hauler cannot settle a debt to the first one — someone has to ring
        // them and ask for it back. Netting them makes the yard look 400 less
        // in debt than it is, using an error as though it were a credit.
        //
        // So each bill contributes only what IT still owes, and an overpayment
        // contributes nothing here and is reported separately, because an
        // overpayment is a thing to chase, not a thing to subtract.
        outstanding += Math.max(0, amount - p);
        overpaid += Math.max(0, p - amount);
    }
    return {
        count: list.length,
        billed: round2(billed) || 0,
        paid: round2(paid) || 0,
        outstanding: round2(outstanding) || 0,
        // Money paid out beyond what was billed, across every bill. Shown on
        // the tab so it is chased rather than quietly offsetting the total.
        overpaid: round2(overpaid) || 0,
    };
}

module.exports = {
    TRUCKER_PAYMENT_MODES,
    listBills, listBillsWithPayments, billsReport,
    addBill, editBill, deleteBill, getBill,
};
