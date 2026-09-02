// ── helpers/pettyCash.js — the cash box, as a ledger ───────────────────────
//
// Per Apsara 2026-09-02: "I want to introduce a new tab called Petty cash.
// Date and cash amount needs to be entered here. So it is like cash reserve.
// If i click pay in load and select cash, the invoice amount should be
// adjusted against this. If cash is low while invoice amount is high --> Make
// it as partial payment and notify user."
//
// A LEDGER, NOT A BALANCE FIELD
// -----------------------------
// Every top-up and every cash payment is its own row; the balance is their
// sum. A stored `balance` number would be one crashed write away from being
// wrong with no way to reconstruct what it should have been — and cash is
// precisely the payment mode with no bank statement behind it, so this file is
// the only record there is. Summing rows also means "why is it $340?" always
// has an answer you can point at.
//
// STARTS AT ZERO, on purpose
// --------------------------
// Cash payments recorded before this file existed are NOT deducted — her
// choice, and the right one: that cash came out of a box nobody was tracking
// here, so charging it against a reserve that starts empty would open the
// ledger deeply negative and mean nothing.
//
// EVERY WRITE GOES THROUGH mutateJson
// -----------------------------------
// which takes a lock on the file. That matters more here than anywhere else in
// this codebase: the balance is read, checked and written in one place, so two
// payments raced against $500 cannot both see $500 and both succeed. Any
// version of this that reads the balance, decides, and then writes in a
// separate step can overdraw, and would do it silently.

const cfg = require('../config');
const { loadJson, mutateJson: mutateJsonRaw } = require('./json');

// ── EVERY write here is strict ────────────────────────────────────────────
// helpers/json.js's mutateJson defaults to strict:false, which LOGS a failure
// and returns the file's previous contents. For most stores that is the right
// call — a missed write self-heals on the next change. For a cash ledger it is
// not: the caller would be told the money moved when it did not, and there is
// no bank statement to catch it later.
//
// It matters twice over here, because the overdraft and "only top-ups can be
// deleted" rules are enforced by THROWING from inside the mutator. Without
// strict those throws are swallowed, the write is skipped, and the function
// returns as though nothing was wrong — a refusal that looks like a success.
//
// Wrapped once rather than passing the option at four call sites, so a fifth
// cannot be added without it.
const mutateJson = (file, dflt, fn) => mutateJsonRaw(file, dflt, fn, { strict: true });

// Cash is counted to the cent, same tolerance as helpers/payments.js. Kept
// local rather than imported so a change there cannot silently loosen this.
const CENT = 0.005;

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const toNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
};

// What a row can be. Stored on every entry so the tab can label it and so a
// future kind cannot be mistaken for one of these.
//   topup    — cash put INTO the box. Positive.
//   payment  — cash taken OUT to pay a load. Negative. Carries payment_id.
//   expense  — cash taken OUT for an expense. Negative. Carries expense_id.
//              Unlike a payment this is allowed to overdraw — see
//              withdrawForExpense for why the two differ.
//   reversal — money put BACK when a payment or expense is undone. Positive,
//              carries reverses_entry_id (and the payment/expense id).
const ENTRY_KINDS = ['topup', 'payment', 'expense', 'reversal'];

function newEntryId() {
    return `PC_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function listEntries() {
    const raw = loadJson(cfg.PETTY_CASH_FILE, []);
    return Array.isArray(raw) ? raw : [];
}

// Sum of every row. Signed amounts, so this is one reduce and there is no
// branch that could count a withdrawal the wrong way.
function balanceOf(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return round2(list.reduce((a, e) => a + (toNum(e && e.amount) || 0), 0)) || 0;
}

function balance() {
    return balanceOf(listEntries());
}

// Newest first — the tab shows recent movement, and "what happened today" is
// the question being asked. created_at breaks ties within a day, so two
// entries on the same date still read in the order they were made.
function history(limit = 200) {
    return listEntries()
        .slice()
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
            || String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, Math.max(0, Number(limit) || 0) || undefined);
}

// ── put cash in ───────────────────────────────────────────────────────────
async function addTopUp(input = {}) {
    const amount = round2(toNum(input.amount));
    if (amount == null) throw new Error('a cash amount is required');
    if (amount <= 0) throw new Error('a cash amount must be greater than zero');

    // Defaults to the yard's local day, not UTC — an evening top-up must not
    // be stamped with tomorrow. Same reasoning as a payment's paid_on.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || ''))
        ? input.date
        : require('./time').todayLocal();

    const record = {
        id: newEntryId(),
        kind: 'topup',
        date,
        amount,                                   // positive
        note: String(input.note || '').trim() || null,
        load_id: null,
        payment_id: null,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        list.push(record);
        return list;
    });
    return record;
}

// ── take cash out, for a cash payment ─────────────────────────────────────
//
// Returns { entry, taken, available, capped }.
//
// THE CHECK AND THE WRITE HAPPEN INSIDE ONE mutateJson, under its lock. Two
// people paying at the same moment therefore serialise: the second sees the
// balance the first left behind. Reading the balance first and writing after
// would let both see $500 and both take it.
//
// `allowPartial` is the acknowledgement gate. Asked for more than there is:
//   allowPartial false -> throws, carrying `available` so the client can show
//                         "only $400 in the box" and ask
//   allowPartial true  -> takes what there is and reports capped: true
// The default is to REFUSE. A partial payment against a supplier's load is a
// decision, not a rounding — it leaves them owed money and the ticket says so.
async function withdrawForPayment({ amount, loadId, paymentId, date, createdBy, allowPartial = false } = {}) {
    const want = round2(toNum(amount));
    if (want == null || want <= 0) throw new Error('a cash amount must be greater than zero');

    let result = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const available = balanceOf(list);

        if (available <= CENT) {
            const err = new Error('There is no petty cash to pay from. Add cash on the Petty cash tab first.');
            err.code = 'PETTY_CASH_EMPTY';
            err.available = available > 0 ? available : 0;
            throw err;
        }
        if (want - available > CENT && !allowPartial) {
            const err = new Error(`Only ${available.toFixed(2)} in petty cash — not enough for ${want.toFixed(2)}.`);
            err.code = 'PETTY_CASH_SHORT';
            err.available = available;
            err.requested = want;
            throw err;
        }

        const taken = (want - available > CENT) ? available : want;
        const entry = {
            id: newEntryId(),
            kind: 'payment',
            date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : require('./time').todayLocal(),
            amount: round2(-taken),               // negative
            note: null,
            load_id: loadId || null,
            payment_id: paymentId || null,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(entry);
        result = { entry, taken: round2(taken), available, capped: taken < want - CENT };
        return list;
    });
    return result;
}

// ── take cash out, for an EXPENSE ─────────────────────────────────────────
//
// Returns { entry, taken, available, shortfall }.
//
// THIS ONE IS ALLOWED TO OVERDRAW, and a load payment is not. That asymmetry
// is deliberate, and it is about what the two records mean:
//
//   a load payment is money about to be handed over. You cannot hand over
//   cash you do not have, so the box refuses and the operator tops it up.
//
//   an expense is a receipt for money ALREADY SPENT — a fuel stop last week,
//   a part bought yesterday. Refusing it would not un-spend the money; it
//   would just stop the record being made. So it always goes in, and if the
//   box does not cover it the balance goes negative.
//
// A negative balance is therefore INFORMATION, not corruption: it means cash
// left the drawer that was never entered here. `shortfall` is returned so the
// screen can say exactly that — Apsara, 2026-09-02: "If expense is more but
// petty cash is less, notify user."
async function withdrawForExpense({ amount, expenseId, date, createdBy } = {}) {
    const want = round2(toNum(amount));
    if (want == null || want <= 0) throw new Error('an expense amount must be greater than zero');

    let result = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const available = balanceOf(list);
        const entry = {
            id: newEntryId(),
            kind: 'expense',
            date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : require('./time').todayLocal(),
            amount: round2(-want),               // the FULL amount, never capped
            note: null,
            load_id: null,
            payment_id: null,
            expense_id: expenseId || null,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(entry);
        result = {
            entry,
            taken: want,
            available,
            // How much of this the box could not cover. Zero when it could.
            shortfall: want - available > CENT ? round2(want - available) : 0,
        };
        return list;
    });
    return result;
}

// Undoes an expense withdrawal — on delete, and on an edit that changes the
// amount or the method. Same reversal-row approach as a payment, and
// idempotent for the same reason.
async function reverseForExpense(expenseId, { createdBy, note } = {}) {
    if (expenseId == null) return null;
    const key = String(expenseId);
    let record = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const taken = list.filter((e) => e && e.kind === 'expense' && String(e.expense_id) === key);
        if (!taken.length) return list;
        const reversedIds = new Set(list.filter((e) => e && e.kind === 'reversal').map((e) => e.reverses_entry_id));
        const outstanding = taken.filter((e) => !reversedIds.has(e.id));
        if (!outstanding.length) return list;                       // already refunded
        const total = round2(outstanding.reduce((a, e) => a + (toNum(e.amount) || 0), 0)) || 0;   // negative
        record = {
            id: newEntryId(),
            kind: 'reversal',
            date: require('./time').todayLocal(),
            amount: round2(-total),               // positive
            note: note || 'expense removed',
            load_id: null,
            payment_id: null,
            expense_id: key,
            reverses_entry_id: outstanding[0].id,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(record);
        return list;
    });
    return record;
}

// Links a withdrawal to the payment it turned out to belong to.
//
// The withdrawal has to be written BEFORE the payment exists (the money is
// reserved first — see helpers/payments.js), so at that moment there is no
// payment id to record. This fills it in afterwards.
//
// Not fatal if it fails: the cash has already moved correctly and the entry
// still carries load_id, so what is lost is a cross-reference, not a cent.
// reverseForPayment accepts either id for exactly this reason.
async function stampPaymentId(entryId, paymentId) {
    if (!entryId || !paymentId) return null;
    let updated = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const row = list.find((e) => e && e.id === entryId);
        if (row) { row.payment_id = paymentId; updated = row; }
        return list;
    });
    return updated;
}

// ── put it back ───────────────────────────────────────────────────────────
// Deleting a cash payment returns the money to the box. As a REVERSAL row
// rather than by removing the withdrawal: the ledger is a history, and a
// history you can delete rows from is one nobody can trust. The pair stays
// visible — money out on the 2nd, money back on the 3rd.
//
// Idempotent, so a double-delete cannot refund twice.
//
// Accepts EITHER a payment id or the withdrawal entry's own id. Both are
// needed: an ordinary delete knows the payment id, but the rollback in
// addPayment fires when the payment write failed — so no payment id was ever
// stamped, and the entry id is all there is. Matching on both means the
// rollback path is not a special case with its own code.
async function reverseForPayment(idOrEntryId, { createdBy } = {}) {
    const key = idOrEntryId;
    if (!key) return null;
    let record = null;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        // kind === 'payment' only. An expense withdrawal can carry the same
        // shape but is undone by reverseForExpense — mixing them would let
        // deleting a payment refund an unrelated expense.
        const matches = (e) => e && (e.payment_id === key || e.id === key);
        const taken = list.filter((e) => matches(e) && e.kind === 'payment');
        if (!taken.length) return list;                                   // never drew on cash
        const takenIds = new Set(taken.map((e) => e.id));
        // Already refunded — by payment id, or by the entry id the rollback
        // would have used. Both are checked, or a delete after a failed
        // rollback could refund the same withdrawal twice.
        if (list.some((e) => e && e.kind === 'reversal'
            && (e.payment_id === key || takenIds.has(e.reverses_entry_id)))) return list;
        const total = round2(taken.reduce((a, e) => a + (toNum(e.amount) || 0), 0)) || 0;  // negative
        record = {
            id: newEntryId(),
            kind: 'reversal',
            date: require('./time').todayLocal(),
            amount: round2(-total),               // positive
            note: 'cash payment deleted',
            load_id: taken[0].load_id || null,
            payment_id: taken[0].payment_id || null,
            // Which withdrawal(s) this undoes. Recorded explicitly because the
            // payment_id may be null (the rollback case), and without it a
            // second refund attempt would have nothing to recognise.
            reverses_entry_id: taken[0].id,
            created_at: new Date().toISOString(),
            created_by: createdBy || null,
        };
        list.push(record);
        return list;
    });
    return record;
}

// Removes a row outright. Only ever offered for top-ups — a mistyped top-up is
// a data-entry error with nothing else attached to it. A 'payment' row belongs
// to a payment and is undone by deleting THAT, which reverses it properly; and
// a 'reversal' is itself a correction. Refusing here rather than in the route
// means the rule holds however the function is reached.
async function deleteEntry(id) {
    let removed = false;
    await mutateJson(cfg.PETTY_CASH_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const row = list.find((e) => e && e.id === id);
        if (!row) return list;
        if (row.kind !== 'topup') {
            const err = new Error('Only a cash top-up can be deleted here. To undo a cash payment, delete the payment on the load.');
            err.code = 'PETTY_CASH_NOT_A_TOPUP';
            throw err;
        }
        const next = list.filter((e) => e.id !== id);
        removed = next.length !== list.length;
        return next;
    });
    return removed;
}

module.exports = {
    ENTRY_KINDS, listEntries, balance, balanceOf, history,
    addTopUp, withdrawForPayment, stampPaymentId, reverseForPayment,
    withdrawForExpense, reverseForExpense, deleteEntry,
};
