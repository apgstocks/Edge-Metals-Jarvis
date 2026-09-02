// ── helpers/expenses.js — yard expense tracker ──────────────────────────────
// Per Apsara 2026-08-19: "for admin access in mobile app, i want expense
// tracker. At the end of the day, along with a create - a new google sheet
// should be created for this, similarly per day basis - i want new sheet
// with tabs as 31/30 days as per month."
//
// So this mirrors the loads side exactly: a live "Expenses-Overall" Google
// Sheet plus an "Expenses-<YYYY-MM>.xlsx" workbook with one tab per day of
// that month (30 or 31 as the month dictates). Same sync machinery
// (helpers/sheetSync.js), same rebuilt-not-patched rule, so a deleted or
// edited expense is reflected with no reconciliation logic.
//
// Deliberately a much simpler shape than a load: an expense is a date, a
// category, a description, an amount and who recorded it. No items, no
// weights, no photo/PDF/Drive pipeline.

const { mutateJson, loadJson } = require('./json');
const cfg = require('../config');

// A fixed starter list, not an enum: `category` is stored as free text and
// anything is accepted, so the app can offer these as quick picks while
// still letting someone type a category nobody anticipated. Mirrors how
// item descriptions work on the load form (a dropdown plus "Others…"),
// which is the pattern already established in this app.
const EXPENSE_CATEGORIES = [
    'Fuel', 'Freight', 'Equipment', 'Repairs & maintenance', 'Labour',
    'Rent', 'Utilities', 'Supplies', 'Permits & fees', 'Insurance', 'Other',
];

function loadExpenses() {
    return loadJson(cfg.EXPENSES_FILE, []);
}

function round2(n) {
    return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function toNum(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
}

// Sequential, human-readable ids (EXP_01, EXP_02...) matching the load
// convention (EDGE_01) — easier to say out loud or read off a sheet than a
// random string. MUST be computed inside the mutateJson callback (under the
// file lock) for the same reason nextLoadId is: computing it earlier lets
// two concurrent saves mint the same id.
function nextExpenseId(expenses) {
    let max = 0;
    for (const e of expenses) {
        const m = /^EXP_(\d+)$/.exec(e.id || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `EXP_${String(max + 1).padStart(2, '0')}`;
}

// Amount and date are the two fields that make an expense meaningful at
// all — an entry without them can't appear correctly on either the daily
// tab or any total, so both are hard-required rather than silently
// defaulted. Same choke-point approach as validateLoadForSave: enforced
// here, so any caller (current or future) is covered, not just the UI.
// ── how an expense was paid ───────────────────────────────────────────────
// Per Apsara 2026-09-02: a report of "monthly spent of cash/zelle/wire" needs
// a field it can group by, and this was free text ("e.g. Card, Cash") until
// today. "cash", "Cash" and "cash app" are three different strings, and any
// grouping of them is a guess about money.
//
// The four load modes plus Card and Other, so one vocabulary spans both sides
// of the report — a load payment and an expense paid the same way land in the
// same column.
const EXPENSE_METHODS = ['Cash', 'Zelle', 'Wire', 'Cheque', 'Card', 'Other'];

// Matches case-insensitively and returns the CANONICAL spelling, or null.
// Null rather than 'Other' on purpose: an unrecognised legacy value is
// unclassified, and calling it "Other" would assert a fact about how that
// money moved that nobody actually recorded.
function normalizeMethod(v) {
    const q = String(v || '').trim().toLowerCase();
    if (!q) return null;
    return EXPENSE_METHODS.find((m) => m.toLowerCase() === q) || null;
}

// EXISTING ENTRIES ARE NOT MIGRATED — her choice ("fixed dropdown, leave old
// entries blank"). Their stored payment_method string is left exactly as it
// is; nothing rewrites or deletes it. It simply does not match the list, so
// the report counts it as unclassified and the edit form shows the box empty.
// Keeping the original text costs nothing and means the information is still
// there if she ever wants it back.

function validateExpense(entry) {
    const amount = toNum(entry.amount);
    if (amount === null) throw new Error('Validation: amount is required.');
    if (amount < 0) throw new Error('Validation: amount cannot be negative.');
    if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) {
        throw new Error('Validation: a valid date (YYYY-MM-DD) is required.');
    }
    if (!entry.description || !String(entry.description).trim()) {
        throw new Error('Validation: description is required.');
    }
    return amount;
}

async function addExpense(entry) {
    const amount = validateExpense(entry);
    const rec = {
        id: null, // assigned under the lock below
        created_at: new Date().toISOString(),
        created_by: entry.created_by || 'unknown',
        date: entry.date,
        category: (entry.category && String(entry.category).trim()) || 'Other',
        description: String(entry.description).trim(),
        vendor: (entry.vendor && String(entry.vendor).trim()) || null,
        payment_method: normalizeMethod(entry.payment_method),
        amount: round2(amount),
        notes: (entry.notes && String(entry.notes).trim()) || null,
    };
    await mutateJson(cfg.EXPENSES_FILE, [], (list) => {
        rec.id = nextExpenseId(list);
        list.unshift(rec);
        if (list.length > 20000) list.length = 20000;
        return list;
    });

    // ── a CASH expense comes out of the box ───────────────────────────────
    // Apsara 2026-09-02: "if expense is added -> expense amount must be
    // adjusted in petty cash as well." Only Cash: an expense paid by card or
    // transfer never touched the drawer, and deducting it would make the
    // balance stop matching the notes in it — the one thing petty cash has to
    // get right.
    //
    // ORDER IS THE OPPOSITE OF A PAYMENT, deliberately. A payment reserves
    // cash first because it is about to hand money over and must not promise
    // what it does not have. An expense is a RECEIPT for money already spent,
    // so the record is what matters: it is written first and always survives,
    // and the ledger follows. A failed withdrawal here leaves the expense
    // recorded and the box reading high, which is visible in the report as a
    // cash expense with no matching withdrawal — and far better than losing
    // the receipt.
    //
    // It is also never refused, even when the box does not cover it. See
    // withdrawForExpense: refusing would not un-spend the money, it would just
    // stop the record being made. `cash_shortfall` is returned so the screen
    // can say so, which is what she asked for ("If expense is more but petty
    // cash is less, notify user").
    rec.cash_shortfall = 0;
    if (rec.payment_method === 'Cash') {
        try {
            const res = await require('./pettyCash').withdrawForExpense({
                amount: rec.amount, expenseId: rec.id, date: rec.date,
                createdBy: rec.created_by,
            });
            rec.cash_shortfall = res.shortfall;
        } catch (e) {
            console.error(`[EXPENSES] ${rec.id} recorded but petty cash was NOT adjusted:`, e.message);
            rec.cash_error = e.message;
        }
    }
    return rec;
}

async function editExpense(id, entry) {
    const amount = validateExpense(entry);
    const before = getExpense(id);
    let updated = null;
    await mutateJson(cfg.EXPENSES_FILE, [], (list) => {
        const e = list.find(x => x.id === id);
        if (!e) return list;
        Object.assign(e, {
            date: entry.date,
            category: (entry.category && String(entry.category).trim()) || 'Other',
            description: String(entry.description).trim(),
            vendor: (entry.vendor && String(entry.vendor).trim()) || null,
            payment_method: normalizeMethod(entry.payment_method),
            amount: round2(amount),
            notes: (entry.notes && String(entry.notes).trim()) || null,
            updated_at: new Date().toISOString(),
        });
        updated = e;
        return list;
    });
    if (!updated) return updated;

    // ── keep the cash ledger in step with the edit ────────────────────────
    // Four transitions matter, and only two of them are obvious:
    //   Cash -> Cash, amount changed   : reverse the old, take the new
    //   Cash -> Card/Zelle/...         : reverse. The money never left the box.
    //   Card/... -> Cash               : take it now. It did.
    //   anything else                  : nothing to do.
    //
    // Done as REVERSE-THEN-RETAKE rather than by adjusting the existing row.
    // Editing a ledger row in place destroys the history of what it used to
    // say, and the whole reason this is a ledger is that cash has no bank
    // statement to reconstruct it from. Two rows tell the true story: money
    // out, money back, money out again.
    //
    // A same-amount Cash -> Cash edit (fixing a typo in the description) is
    // skipped entirely, so routine edits do not litter the ledger.
    const wasCash = !!before && before.payment_method === 'Cash';
    const isCash = updated.payment_method === 'Cash';
    const amountChanged = !before || round2(before.amount) !== round2(updated.amount);
    updated.cash_shortfall = 0;
    try {
        const petty = require('./pettyCash');
        if (wasCash && (!isCash || amountChanged)) {
            await petty.reverseForExpense(id, { note: 'expense edited' });
        }
        if (isCash && (!wasCash || amountChanged)) {
            const res = await petty.withdrawForExpense({
                amount: updated.amount, expenseId: id, date: updated.date,
                createdBy: updated.created_by,
            });
            updated.cash_shortfall = res.shortfall;
        }
    } catch (e) {
        console.error(`[EXPENSES] ${id} edited but petty cash was NOT adjusted:`, e.message);
        updated.cash_error = e.message;
    }
    return updated;
}

// Returns the deleted record (not just a boolean) so the caller knows which
// MONTH to rebuild — the same problem the load delete route had. Detected
// with a captured variable rather than by throwing inside the mutator,
// because mutateJson swallows a thrown error and returns the unmodified
// data, which would look like success (see helpers/loads.js's renumberLoad
// comment for the full reasoning).
async function deleteExpense(id) {
    let removed = null;
    await mutateJson(cfg.EXPENSES_FILE, [], (list) => {
        const idx = list.findIndex(x => x.id === id);
        if (idx === -1) return list;
        removed = list[idx];
        list.splice(idx, 1);
        return list;
    });
    // Deleting a cash expense puts the money back — the expense was the only
    // reason it left. Reversal row, idempotent, same as everywhere else.
    if (removed && removed.payment_method === 'Cash') {
        try {
            await require('./pettyCash').reverseForExpense(id, { note: 'expense deleted' });
        } catch (e) {
            console.error(`[EXPENSES] deleted ${id} but could NOT return ${removed.amount} to petty cash:`, e.message);
        }
    }
    return removed;
}

function getExpense(id) {
    return loadExpenses().find(e => e.id === id) || null;
}

// Rollup for the app's summary line and the Overall sheet. Computed fresh
// from the current file on every call — never an accumulated counter — so a
// delete or edit is reflected immediately with no separate bookkeeping,
// exactly like getInventoryReport does for loads.
// from/to are optional inclusive 'YYYY-MM-DD' strings.
function getExpenseReport(allExpenses, { from, to } = {}) {
    const filtered = (from || to)
        ? (allExpenses || []).filter(e => e.date && (!from || e.date >= from) && (!to || e.date <= to))
        : (allExpenses || []);

    const total = round2(filtered.reduce((s, e) => s + (e.amount || 0), 0)) || 0;

    const catMap = new Map();
    for (const e of filtered) {
        const key = e.category || 'Other';
        if (!catMap.has(key)) catMap.set(key, { category: key, count: 0, amount: 0 });
        const c = catMap.get(key);
        c.count += 1;
        c.amount += e.amount || 0;
    }
    const byCategory = Array.from(catMap.values())
        .map(c => ({ ...c, amount: round2(c.amount) }))
        .sort((a, b) => (b.amount || 0) - (a.amount || 0));

    const dayMap = new Map();
    for (const e of filtered) {
        const key = e.date || 'Unknown date';
        if (!dayMap.has(key)) dayMap.set(key, { date: key, count: 0, amount: 0 });
        const d = dayMap.get(key);
        d.count += 1;
        d.amount += e.amount || 0;
    }
    const byDay = Array.from(dayMap.values())
        .map(d => ({ ...d, amount: round2(d.amount) }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));

    return { count: filtered.length, total, byCategory, byDay };
}

module.exports = {
    EXPENSE_CATEGORIES, EXPENSE_METHODS, normalizeMethod,
    loadExpenses, addExpense, editExpense, deleteExpense, getExpense, getExpenseReport,
};
