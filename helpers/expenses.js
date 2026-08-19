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
        payment_method: (entry.payment_method && String(entry.payment_method).trim()) || null,
        amount: round2(amount),
        notes: (entry.notes && String(entry.notes).trim()) || null,
    };
    await mutateJson(cfg.EXPENSES_FILE, [], (list) => {
        rec.id = nextExpenseId(list);
        list.unshift(rec);
        if (list.length > 20000) list.length = 20000;
        return list;
    });
    return rec;
}

async function editExpense(id, entry) {
    const amount = validateExpense(entry);
    let updated = null;
    await mutateJson(cfg.EXPENSES_FILE, [], (list) => {
        const e = list.find(x => x.id === id);
        if (!e) return list;
        Object.assign(e, {
            date: entry.date,
            category: (entry.category && String(entry.category).trim()) || 'Other',
            description: String(entry.description).trim(),
            vendor: (entry.vendor && String(entry.vendor).trim()) || null,
            payment_method: (entry.payment_method && String(entry.payment_method).trim()) || null,
            amount: round2(amount),
            notes: (entry.notes && String(entry.notes).trim()) || null,
            updated_at: new Date().toISOString(),
        });
        updated = e;
        return list;
    });
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
    EXPENSE_CATEGORIES,
    loadExpenses, addExpense, editExpense, deleteExpense, getExpense, getExpenseReport,
};
