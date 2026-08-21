// ── helpers/sheetSync.js — live Google Sheet + monthly workbook sync ─────────
// Per Apsara 2026-08-19: "create a google sheet for overall inventory
// maintenance and update on daily basis as per load creation / if load
// deleted, modify accordingly. for daily basis, i want a new excel to track
// the daily loads... that excel should be used for monthly basis - august
// month 31 days - 31 tabs if loaded today."
//
// Two artefacts, both living in the Drive "Reports" folder and both keyed by
// a STABLE NAME so their links never change:
//   1. "Inventory-Overall" — a native Google Sheet, rebuilt from loads.json
//      on every change. This is the "overall inventory maintenance" sheet.
//   2. "Loads-<YYYY-MM>.xlsx" — one workbook per calendar month, one tab per
//      day, one row per line item.
//
// WHY THIS IS A DRIVE UPLOAD AND NOT A SHEETS API WRITE: helpers/sheets.js
// authenticates with 'spreadsheets.readonly' (it only ever reads the price
// list), so it cannot write. helpers/drive.js already holds the full 'drive'
// scope, and uploading an .xlsx while asking Drive to store it as
// application/vnd.google-apps.spreadsheet produces a real, native Google
// Sheet. Updating that file later with new .xlsx media replaces its contents
// in place, keeping the same id/URL. So this needed no credential or scope
// change at all — worth knowing before anyone "fixes" it to use the Sheets
// API and has to re-do the service-account setup.
//
// REBUILT, NOT PATCHED: every sync regenerates the whole file from current
// loads.json rather than appending a delta. That is what makes deletes and
// edits work correctly ("if load deleted, modify accordingly") with no
// reconciliation logic — the same reasoning getInventoryReport() already
// uses (see helpers/loads.js). A deleted load simply isn't in the next
// rebuild.

const cfg = require('../config');

// Coalescing + serialisation. Saving a load can fire several changes in
// quick succession (create, then a photo-upload patch), and a yard doing
// bulk entry can fire many. Without this, each would race a separate
// multi-second Drive upload of the same data — wasteful, and concurrent
// updates to one file can interleave badly. Instead: a short debounce
// window collects a burst into one rebuild, and `running` guarantees only
// one sync is ever in flight, with `pending` remembering that another was
// requested while it ran.
const DEBOUNCE_MS = Number(process.env.SHEET_SYNC_DEBOUNCE_MS) || 4000;
let timer = null;
let running = false;
let pending = false;
// Months touched since the last completed sync. Declared here, above its
// first use, rather than after scheduleSync — `let` is hoisted but sits in
// the temporal dead zone until initialised, so a call that somehow landed
// during module evaluation would have thrown a ReferenceError.
let pendingMonths = new Set();
// Last sync outcome, read by the health endpoint so a silently failing
// background sync is visible somewhere a human actually looks.
let lastSyncError = null;
let lastSyncOk = null;

function monthKeyFor(date) {
    // 'YYYY-MM-DD' -> 'YYYY-MM'. Falls back to today's month for a load with
    // no date, which is also how such a load is treated everywhere else.
    const s = String(date || '');
    if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Which months need rebuilding. Normally just the current one, but an edit
// can move a load ACROSS months (someone corrects a date from 08-01 to
// 07-31), which leaves the old month's workbook stale unless it's rebuilt
// too. Callers pass any months they touched; the current month is always
// included so a plain create is covered with no argument.
function monthsToSync(extraMonths = []) {
    const set = new Set(extraMonths.filter(Boolean));
    set.add(monthKeyFor(null));
    return Array.from(set);
}

async function runSync(months) {
    const { loadLoads } = require('./loads');
    const { loadExpenses } = require('./expenses');
    const {
        monthlyLoadsWorkbookBuffer, inventoryWorkbookBuffer,
        monthlyExpensesWorkbookBuffer, expensesOverallWorkbookBuffer,
    } = require('./inventoryExcel');
    const { upsertReportFile } = require('./drive');

    const allLoads = loadLoads();
    const allExpenses = loadExpenses();
    const results = { sheet: null, months: [], expenseSheet: null, expenseMonths: [] };

    // 1. Overall inventory, as a native Google Sheet.
    const overallBuf = await inventoryWorkbookBuffer(allLoads);
    results.sheet = await upsertReportFile('Inventory-Overall', Buffer.from(overallBuf), { asGoogleSheet: true });

    // 2. One loads workbook per affected month.
    for (const monthKey of months) {
        const buf = await monthlyLoadsWorkbookBuffer(allLoads, monthKey);
        const file = await upsertReportFile(`Loads-${monthKey}.xlsx`, Buffer.from(buf));
        results.months.push({ monthKey, file });
    }

    // 3+4. The same pair for expenses (Apsara 2026-08-19). Skipped entirely
    // when no expense has ever been recorded, so a yard that doesn't use the
    // tracker doesn't accumulate empty files in its Drive folder — but once
    // the first expense exists these are maintained on every sync, including
    // after the last one is deleted (so a delete is correctly reflected
    // rather than freezing the sheet at its last non-empty state).
    if (allExpenses.length) {
        const expOverall = await expensesOverallWorkbookBuffer(allExpenses);
        results.expenseSheet = await upsertReportFile('Expenses-Overall', Buffer.from(expOverall), { asGoogleSheet: true });
        for (const monthKey of months) {
            const buf = await monthlyExpensesWorkbookBuffer(allExpenses, monthKey);
            const file = await upsertReportFile(`Expenses-${monthKey}.xlsx`, Buffer.from(buf));
            results.expenseMonths.push({ monthKey, file });
        }
    }
    return results;
}

// Fire-and-forget. NEVER throws to the caller and never blocks a load save:
// a Drive outage must not make saving a load fail. Failures are logged and
// the next change re-syncs from scratch anyway (see REBUILT, NOT PATCHED),
// so a missed sync is self-healing rather than leaving permanent drift.
function scheduleSync(extraMonths = []) {
    if (!cfg.GDRIVE_KEYFILE) return; // Drive not configured — nothing to sync to
    const months = monthsToSync(extraMonths);
    for (const m of months) pendingMonths.add(m);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
        timer = null;
        if (running) { pending = true; return; }
        running = true;
        const batch = Array.from(pendingMonths);
        pendingMonths.clear();
        try {
            const res = await runSync(batch);
            console.log(`[SHEETSYNC] Updated Inventory-Overall + ${res.months.map(m => m.monthKey).join(', ') || 'no months'}`);
            lastSyncOk = new Date().toISOString();
            lastSyncError = null;
        } catch (err) {
            console.error('[SHEETSYNC] sync failed (non-fatal, will retry on next change):', err.message);
            // Surfaced on the health endpoint (api.js /api/health) rather
            // than on a load: a sync covers every load at once, so pinning
            // the failure to whichever one happened to trigger it would be
            // arbitrary and misleading.
            lastSyncError = { message: err.message, at: new Date().toISOString() };
        } finally {
            running = false;
            if (pending) { pending = false; scheduleSync(batch); }
        }
    }, DEBOUNCE_MS);
    if (timer.unref) timer.unref(); // never hold the process open just for this
}

// Awaitable variant for the nightly report, which wants the links in the
// email it's about to send and therefore cannot fire-and-forget. Returns
// the upserted file records, or null on failure (the caller decides whether
// that's fatal — for the email it isn't, it just omits the links).
async function syncNow(extraMonths = []) {
    try {
        return await runSync(monthsToSync(extraMonths));
    } catch (err) {
        console.error('[SHEETSYNC] syncNow failed:', err.message);
        return null;
    }
}

function syncStatus() { return { lastSyncOk, lastSyncError }; }

module.exports = { scheduleSync, syncNow, monthKeyFor, syncStatus };
