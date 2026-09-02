// ── tests/expense-sheets.js ────────────────────────────────────────────────
// Apsara, 2026-09-02: "when expense daily is 0, don't create a new sheet.
// ignore."
//
// helpers/sheetSync.js's runSync uploads one Expenses-<month>.xlsx per month
// in `months` — and `months` is derived from LOAD activity, not expense
// activity. So a busy month with no expenses in it still got a workbook
// uploaded whose entire content is one sheet reading "No expenses recorded for
// YYYY-MM yet." One per month, in her Drive folder, listed in the report links.
//
// The fix is not a plain skip. A month that HAD expenses and has since had
// them all deleted must still be refreshed, or its file freezes at the last
// non-empty state and keeps showing money that is no longer recorded. So the
// rule is: update if it exists, never create if it does not.
//
// This path had NO tests before today, which is how an empty-file-per-month
// upload ran unnoticed. Drive is faked at the module boundary — nothing here
// touches the network (helpers/drive.js's getDrive() also refuses outright
// under JARVIS_TEST=1, after a test once uploaded fixture data to her real
// Drive).

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');

console.log('\n─ monthly expense workbooks ─────────────────────────────────');

// ── a fake Drive, recording what would have been written ──────────────────
// Stands in for the real helpers/drive.js. `existing` is the set of file names
// already sitting in the Drive folder, so "update" and "create" can be told
// apart — which is the whole distinction under test.
function fakeDrive(existing = []) {
    const have = new Set(existing);
    const calls = [];
    return {
        calls,
        upsertReportFile: async (name, buffer, opts = {}) => {
            const exists = have.has(name);
            calls.push({ name, updateOnly: !!opts.updateOnly, action: exists ? 'update' : (opts.updateOnly ? 'skipped' : 'create') });
            if (!exists && opts.updateOnly) return null;      // the new behaviour
            have.add(name);
            return { id: 'file-' + name, name, webViewLink: 'https://drive.example/' + name };
        },
    };
}

// Runs the REAL runSync with Drive, the loads store and the expenses store
// faked at the require boundary. Nothing in sheetSync.js itself is stubbed.
async function runSyncWith({ months, expenses, loads = [], existingFiles = [] }) {
    const drive = fakeDrive(existingFiles);
    const M = require('module');
    const orig = M.prototype.require;
    // Cache-bust so each run gets a clean module.
    delete require.cache[require.resolve(path.join(ROOT, 'helpers/sheetSync.js'))];
    M.prototype.require = function (id) {
        if (id === './drive') return drive;
        // Spread the REAL modules and override only the reader. helpers/
        // inventoryExcel.js also requires './loads' — for getInventoryReport —
        // so returning a bare { loadLoads } stub broke it, which is why this
        // passes everything else through.
        if (id === './expenses') return Object.assign({}, orig.call(this, id), { loadExpenses: () => expenses });
        if (id === './loads') return Object.assign({}, orig.call(this, id), { loadLoads: () => loads });
        return orig.apply(this, arguments);
    };
    try {
        const { runSync } = require(path.join(ROOT, 'helpers/sheetSync.js'));
        const results = await runSync(months);
        return { results, calls: drive.calls };
    } finally {
        M.prototype.require = orig;
        delete require.cache[require.resolve(path.join(ROOT, 'helpers/sheetSync.js'))];
    }
}

const exp = (date, amount = 100) => ({ id: 'E1', date, amount, category: 'Fuel', note: '' });

(async () => {

// ── 1. the reported problem ───────────────────────────────────────────────
section('A — a month with no expenses gets no file');
{
    // August had expenses, September has none. Both months are in `months`
    // because both had loads.
    const { results, calls } = await runSyncWith({
        months: ['2026-08', '2026-09'],
        expenses: [exp('2026-08-14')],
    });
    const sept = calls.find(c => c.name === 'Expenses-2026-09.xlsx');
    const aug = calls.find(c => c.name === 'Expenses-2026-08.xlsx');

    ck('September is not created', sept && sept.action === 'skipped',
       'this is the empty "No expenses recorded for 2026-09 yet." workbook she asked to stop');
    ck('  and it is not reported as a result',
       !results.expenseMonths.some(m => m.monthKey === '2026-09'));
    ck('August, which has an expense, IS written', aug && aug.action === 'create');
    ck('  and it is reported', results.expenseMonths.some(m => m.monthKey === '2026-08' && m.file));
}

// ── 2. the case a plain skip would break ──────────────────────────────────
section('B — a month emptied by deletions is still corrected');
{
    // The one expense that used to be in August has been deleted. Its file is
    // already on Drive. A naive "skip when zero" would leave that file frozen,
    // still showing money that is no longer recorded anywhere.
    const { results, calls } = await runSyncWith({
        months: ['2026-08'],
        expenses: [exp('2026-07-02')],           // something exists, just not in August
        existingFiles: ['Expenses-2026-08.xlsx'],
    });
    const aug = calls.find(c => c.name === 'Expenses-2026-08.xlsx');
    ck('an existing file for an emptied month is UPDATED, not skipped',
       aug && aug.action === 'update',
       'skipping would freeze it at its last non-empty state — money shown that no longer exists');
    ck('  and it is still reported', results.expenseMonths.some(m => m.monthKey === '2026-08'));
    ck('  updateOnly was the flag that made that safe', aug && aug.updateOnly === true);
}

// ── 3. nothing else changed ───────────────────────────────────────────────
section('C — the rest of the sync is untouched');
{
    const { results, calls } = await runSyncWith({
        months: ['2026-08', '2026-09'],
        expenses: [exp('2026-08-14')],
    });
    ck('the overall inventory sheet is still written',
       calls.some(c => c.name === 'Inventory-Overall') && !!results.sheet);
    ck('a loads workbook is still written for EVERY month, expenses or not',
       ['2026-08', '2026-09'].every(m => calls.some(c => c.name === `Loads-${m}.xlsx`)),
       'the expense rule must not leak into the loads files');
    ck('  ...and none of them were updateOnly',
       calls.filter(c => c.name.startsWith('Loads-')).every(c => c.updateOnly === false));
    ck('the overall EXPENSES sheet is still written when any expense exists',
       calls.some(c => c.name === 'Expenses-Overall') && !!results.expenseSheet);
}

// ── 4. a yard that has never recorded an expense ──────────────────────────
section('D — no expenses at all, anywhere');
{
    const { results, calls } = await runSyncWith({ months: ['2026-08'], expenses: [] });
    ck('no expense files of any kind are touched',
       !calls.some(c => c.name.startsWith('Expenses-')),
       'the pre-existing allExpenses.length guard still short-circuits the whole block');
    ck('  and the loads side still runs', calls.some(c => c.name === 'Loads-2026-08.xlsx'));
    ck('  expenseMonths is empty', results.expenseMonths.length === 0);
    ck('  expenseSheet is null', results.expenseSheet === null);
}

// ── 5. the option itself, in the real drive helper ────────────────────────
section('E — upsertReportFile actually honours updateOnly');
{
    // Asserted from source: calling it for real needs Drive, and getDrive()
    // deliberately throws under JARVIS_TEST=1.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/drive.js'), 'utf8');
    const fn = (() => {
        const i = src.indexOf('async function upsertReportFile(');
        // Start brace-counting at the BODY, not at the first '{' after the
        // name. This function's parameters are destructured —
        // ({ asGoogleSheet = false, updateOnly = false } = {}) — so the naive
        // src.indexOf('{', i) landed on the parameter object and the extractor
        // returned that instead of the function, failing three assertions
        // against perfectly correct code. Found while verifying this file.
        const bodyStart = src.indexOf(') {', src.indexOf('(', i)) + 2;
        let d = 0;
        for (let k = bodyStart; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
    })();
    ck('the extracted function is the body, not the parameter list',
       /files\.update/.test(fn) && /files\.create/.test(fn));
    ck('it accepts the option', /updateOnly = false/.test(fn));
    ck('it returns null instead of creating', /if \(updateOnly\) return null;/.test(fn));
    // Order matters: the early return has to sit AFTER the update branch, or
    // it would stop existing files being refreshed too.
    const body = fn.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    ck('  and it does so only after the update branch',
       body.indexOf('files.update') < body.indexOf('if (updateOnly) return null;'),
       'placed earlier it would also stop existing files being refreshed');
    ck('  before the create branch',
       body.indexOf('if (updateOnly) return null;') < body.indexOf('files.create'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
})();
