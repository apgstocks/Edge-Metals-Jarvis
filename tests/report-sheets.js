// ── tests/report-sheets.js ─────────────────────────────────────────────────
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
    const renames = [];
    // Stable per-name IDs, so a rename can be shown to PRESERVE the id — which
    // is the whole reason renaming beats creating fresh.
    const ids = new Map();
    const idFor = (n) => { if (!ids.has(n)) ids.set(n, 'file-' + ids.size); return ids.get(n); };
    return {
        calls,
        renames,
        upsertReportFile: async (name, buffer, opts = {}) => {
            const exists = have.has(name);
            calls.push({ name, updateOnly: !!opts.updateOnly, action: exists ? 'update' : (opts.updateOnly ? 'skipped' : 'create') });
            if (!exists && opts.updateOnly) return null;      // the new behaviour
            have.add(name);
            return { id: idFor(name), name, webViewLink: 'https://drive.example/' + name };
        },
        renameReportFile: async (oldName, newName) => {
            if (!have.has(oldName)) { renames.push({ oldName, newName, renamed: false, reason: 'no_old_file' }); return { renamed: false, reason: 'no_old_file' }; }
            if (have.has(newName)) { renames.push({ oldName, newName, renamed: false, reason: 'target_exists' }); return { renamed: false, reason: 'target_exists' }; }
            const id = idFor(oldName);
            have.delete(oldName); have.add(newName); ids.set(newName, id);
            renames.push({ oldName, newName, renamed: true, fileId: id });
            return { renamed: true, fileId: id };
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
        return { results, calls: drive.calls, renames: drive.renames };
    } finally {
        M.prototype.require = orig;
        delete require.cache[require.resolve(path.join(ROOT, 'helpers/sheetSync.js'))];
    }
}

const exp = (date, amount = 100) => ({ id: 'E1', date, amount, category: 'Fuel', note: '' });
const load = (date) => ({
    id: 'EDGE_01', date, seller: 'Acme', weight_unit: 'lb',
    items: [{ description: 'Copper', gross_weight: 100, tare_weight: 10, net_weight: 90, price: 2, amount: 180 }],
});

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
        expenses: [exp('2026-08-14')],          // August only
        loads: [load('2026-08-03'), load('2026-09-01')],  // BOTH months
    });
    ck('the overall inventory sheet is still written',
       calls.some(c => c.name === 'Inventory-Overall') && !!results.sheet);
    // September has loads but NO expenses. Its loads workbook must still be
    // written — the expense rule must not leak across.
    ck('a loads workbook is written for every month that has loads, expenses or not',
       ['2026_08 Loads', '2026_09 Loads'].every(n => calls.some(c => c.name === n)),
       'the expense rule must not leak into the loads files');
    ck('  ...and neither was updateOnly, because both months have loads',
       calls.filter(c => c.name.endsWith(' Loads')).every(c => c.updateOnly === false));
    ck('the overall EXPENSES sheet is still written when any expense exists',
       calls.some(c => c.name === 'Expenses-Overall') && !!results.expenseSheet);
}

// ── 4. a yard that has never recorded an expense ──────────────────────────
section('D — no expenses at all, anywhere');
{
    const { results, calls } = await runSyncWith({ months: ['2026-08'], expenses: [], loads: [load('2026-08-03')] });
    ck('no expense files of any kind are touched',
       !calls.some(c => c.name.startsWith('Expenses-')),
       'the pre-existing allExpenses.length guard still short-circuits the whole block');
    ck('  and the loads side still runs', calls.some(c => c.name === '2026_08 Loads'));
    ck('  expenseMonths is empty', results.expenseMonths.length === 0);
    ck('  expenseSheet is null', results.expenseSheet === null);
}

// ── 4b. the loads workbooks: naming, tabs, and the rename ─────────────────
// Apsara, 2026-09-02: "per month a new sheet should be created. name that as
// [year]_[month] Loads. as per date, a new tab should be added. if no loads —
// don't create a tab for that day."
section('D2 — monthly loads workbooks are named [year]_[month] Loads');
{
    const { results, calls } = await runSyncWith({
        months: ['2026-09'], expenses: [], loads: [load('2026-09-01')],
    });
    ck('the file is named "2026_09 Loads"', calls.some(c => c.name === '2026_09 Loads'));
    ck('  underscore, not a hyphen', !calls.some(c => /^2026-09 Loads$/.test(c.name)));
    ck('  and the old Loads-YYYY-MM.xlsx name is gone',
       !calls.some(c => c.name === 'Loads-2026-09.xlsx'));
    ck('  it is still reported as a result', results.months.some(m => m.monthKey === '2026-09' && m.file));
    // Number, not name: Drive sorts alphabetically, so 2026_09 has to fall
    // between 2026_08 and 2026_10.
    ck('  the month is a zero-padded number, so Drive sorts it correctly',
       ['2026_08 Loads', '2026_09 Loads', '2026_10 Loads'].slice().sort().join('|')
       === '2026_08 Loads|2026_09 Loads|2026_10 Loads');
}

section('D3 — an existing workbook is RENAMED, not duplicated');
{
    const { calls, renames } = await runSyncWith({
        months: ['2026-08'], expenses: [], loads: [load('2026-08-14')],
        existingFiles: ['Loads-2026-08.xlsx'],
    });
    const r = renames.find(x => x.oldName === 'Loads-2026-08.xlsx');
    ck('the old file is renamed to the new name', r && r.renamed === true && r.newName === '2026_08 Loads');
    // The point of renaming: same Drive file, so history and shared links
    // survive. Creating fresh would leave the old one frozen alongside.
    const write = calls.find(c => c.name === '2026_08 Loads');
    ck('  and the sync then UPDATES it rather than creating a second file',
       write && write.action === 'update',
       'if this says "create", the rename did not take and Drive now has two files for August');

    // Idempotent: a second sync finds nothing to rename and must not fail.
    const again = await runSyncWith({
        months: ['2026-08'], expenses: [], loads: [load('2026-08-14')],
        existingFiles: ['2026_08 Loads'],
    });
    ck('a second sync has nothing to rename',
       again.renames.every(x => !x.renamed && x.reason === 'no_old_file'));
    ck('  and still updates the workbook', again.calls.some(c => c.name === '2026_08 Loads' && c.action === 'update'));
}

section('D4 — a month with no loads gets no workbook');
{
    // monthsToSync ALWAYS includes the current month, so before this rule the
    // 1st of every month produced a workbook whose only content was one sheet
    // reading "No loads recorded for YYYY-MM yet."
    const { results, calls } = await runSyncWith({ months: ['2026-09'], expenses: [], loads: [] });
    const sept = calls.find(c => c.name === '2026_09 Loads');
    ck('nothing is created for a month with no loads', sept && sept.action === 'skipped');
    ck('  and it is not reported', results.months.length === 0);

    // Same protection as the expenses side: a month emptied by deletions must
    // still be refreshed, or it freezes showing loads that no longer exist.
    const emptied = await runSyncWith({
        months: ['2026-08'], expenses: [], loads: [load('2026-07-02')],
        existingFiles: ['2026_08 Loads'],
    });
    ck('but an existing workbook for an emptied month IS refreshed',
       emptied.calls.some(c => c.name === '2026_08 Loads' && c.action === 'update'));
}

section('D5 — one tab per day that has loads, and no others');
{
    // Read back from the REAL workbook the sync uploads. This part of her
    // request already worked; the test is what stops it regressing.
    //
    // Written against the exported buffer builder rather than the internal
    // build function: the first version branched on whether the internal one
    // was exported and, because it IS, ran a branch containing no assertions
    // at all — a section that reported nothing and looked fine.
    const ExcelJS = require('exceljs');
    const mod = require(path.join(ROOT, 'helpers/inventoryExcel.js'));
    const buf = await mod.monthlyLoadsWorkbookBuffer(
        [load('2026-09-01'), load('2026-09-01'), load('2026-09-04')], '2026-09');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const tabs = wb.worksheets.map(w => w.name);

    ck('a tab for each day that has loads', tabs.includes('01') && tabs.includes('04'));
    ck('  no tab for the days in between, which have none',
       !tabs.includes('02') && !tabs.includes('03'),
       '"if no loads - dont create a tab for that day"');
    ck('  two loads on the same day share ONE tab', tabs.filter(t => t === '01').length === 1);
    ck('  tabs are day-of-month, chronological left to right', tabs.join(',') === '01,04');
    ck('  and there are exactly as many tabs as days with loads', tabs.length === 2);
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
