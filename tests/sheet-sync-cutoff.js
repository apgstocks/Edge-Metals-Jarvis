// ── tests/sheet-sync-cutoff.js ────────────────────────────────────────────
// Apsara, 2026-10-12: "i dont want 2025 row bills and shipments in sweep into
// jarvis from sheet on every day".
//
// WHAT IS HELD
//   A  diff() is UNCHANGED without `since` (fill-money-blanks.js and
//      why-one-sided.js call it and were not asked to change).
//   B  With `since`, a 2025 row is not queued as new; it is reported.
//      Bills and sales both. Rows on/after the cutoff still go through.
//   C  Only the INSERT path: a row already in Jarvis is still compared.
//   D  An odd date is never silently dropped.
//   E  The nightly job turns the cut-off on by default (2026-01-01), the env
//      var overrides it, and an empty value turns it off.
//   F  END TO END through runNightly with writing armed: the stores receive
//      the 2026 rows and NONE of the 2025 rows — and a second night adds
//      nothing (no row is re-queued every day).

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sinc-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const sync = require(path.join(ROOT, 'helpers/metalsSheetSync'));
const job = require(path.join(ROOT, 'helpers/metalsSheetSyncJob'));

const bill = (date, c, extra = {}) => ({ date, booking_no: 'BK' + c, container_no: c, supplier: 'Sup', description: 'Alternator', supplier_price: 1, ...extra });
const sale = (date, c, extra = {}) => ({ date, invoice_no: 'INV' + c, container_no: c, customer: 'Cust', item: 'Alternator', invoice_price: 2, ...extra });

const sheetBills = [bill('2025-06-10', 'OLDB0000001'), bill('2025-12-31', 'EDGB0000002'), bill('2026-01-01', 'NEWB0000003'), bill('2026-08-04', 'NEWB0000004')];
const sheetSales = [sale('2025-03-03', 'OLDS0000001'), sale('2026-01-02', 'NEWS0000002')];

// ══════════════════════════════════════════════════════════════════════════
section('A — without `since`, diff() behaves exactly as before');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = sync.diff({ sheetBills, sheetSales });
    ck('all four bills are queued', r.newBills.length === 4, String(r.newBills.length));
    ck('both sales are queued', r.newSales.length === 2);
    ck('nothing is held back', r.beforeCutoff.length === 0 && r.since === null);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — with `since`, 2025 is left out and reported');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = sync.diff({ sheetBills, sheetSales, since: '2026-01-01' });
    ck('only the two 2026 bills are queued', r.newBills.map((b) => b.container_no).join() === 'NEWB0000003,NEWB0000004', r.newBills.map((b) => b.container_no).join());
    ck('  2025-12-31 is out, 2026-01-01 is in (the boundary)', !r.newBills.some((b) => b.container_no === 'EDGB0000002'));
    ck('only the 2026 sale is queued', r.newSales.length === 1 && r.newSales[0].container_no === 'NEWS0000002');
    ck('three rows are listed as left out', r.beforeCutoff.length === 3, String(r.beforeCutoff.length));
    ck('  with their kind', r.beforeCutoff.filter((x) => x.kind === 'bill').length === 2 && r.beforeCutoff.filter((x) => x.kind === 'sale').length === 1);
    ck('the summary line says so', /3 older than 2026-01-01 left out/.test(sync.summarise(r)), sync.summarise(r));
    ck('the summary is unchanged when nothing was left out', !/left out/.test(sync.summarise(sync.diff({ sheetBills: [bill('2026-02-02', 'ZZZB0000009')], since: '2026-01-01' }))));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — rows already in Jarvis are still compared');
// ══════════════════════════════════════════════════════════════════════════
{
    const mine = [{ id: 'B1', date: '2025-06-10', booking_no: 'BKOLDB0000001', container_no: 'OLDB0000001', supplier: 'Sup', description: 'Alternator', supplier_price: 99 }];
    const r = sync.diff({ sheetBills, bills: mine, since: '2026-01-01' });
    ck('a 2025 row Jarvis already holds is not "new" and not "left out"',
       !r.newBills.some((b) => b.container_no === 'OLDB0000001') && !r.beforeCutoff.some((x) => x.row.container_no === 'OLDB0000001'));
    ck('  and its disagreement is still reported', r.changedBills.some((c) => c.container_no === 'OLDB0000001'), JSON.stringify(r.changedBills));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — a date that is not YYYY-MM-DD is never silently dropped');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = sync.diff({ sheetBills: [bill('sept 3', 'ODDB0000001'), bill('09/03/2025', 'ODDB0000002')], since: '2026-01-01' });
    ck('both odd-dated rows are still queued, where she can see them', r.newBills.length === 2, String(r.newBills.length));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the job: default on, env overrides, empty turns it off');
// ══════════════════════════════════════════════════════════════════════════
const SRC = fs.readFileSync(path.join(ROOT, 'helpers/metalsSheetSyncJob.js'), 'utf8');
ck('the nightly job passes `since` to diff()', /since:\s*opts\.since/.test(SRC));
ck('scripts that call diff() directly do not (they were not asked to change)',
   !/since/.test(fs.readFileSync(path.join(ROOT, 'scripts/fill-money-blanks.js'), 'utf8'))
   && !/since/.test(fs.readFileSync(path.join(ROOT, 'scripts/why-one-sided.js'), 'utf8')));

// ══════════════════════════════════════════════════════════════════════════
section('F — end to end through runNightly, writing armed');
// ══════════════════════════════════════════════════════════════════════════
(async () => {
    const sheetImport = require(path.join(ROOT, 'helpers/sheetImport'));
    const realRead = sheetImport.readWorkbook;
    sheetImport.readWorkbook = async () => ({ bills: sheetBills, sales: sheetSales });
    process.env.SHEET_SYNC_WRITE = '1';
    delete process.env.SHEET_SYNC_SINCE;
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const sales = require(path.join(ROOT, 'helpers/sales'));

    const r1 = await job.runNightly({ write: true, buffer: Buffer.from('x') });
    ck('night one ran without error', r1.ok && !r1.error, JSON.stringify(r1.error));
    const bc = bills.list().map((b) => b.container_no).sort();
    const sc = sales.list().map((s) => s.container_no).sort();
    ck('the bills store holds the two 2026 bills and no 2025 bill', bc.join() === 'NEWB0000003,NEWB0000004', bc.join());
    ck('the sales store holds the 2026 invoice and no 2025 invoice', sc.join() === 'NEWS0000002', sc.join());
    ck('the report text names what was left out', /LEFT OUT/.test(job.reportText(r1.report, r1)), '');

    const r2 = await job.runNightly({ write: true, buffer: Buffer.from('x') });
    ck('night two adds nothing — no 2025 row is re-queued every day',
       r2.report.newBills.length === 0 && r2.report.newSales.length === 0, `${r2.report.newBills.length}/${r2.report.newSales.length}`);
    ck('  and the stores are unchanged', bills.list().length === 2 && sales.list().length === 1);

    // The env override: an empty value switches the cut-off off.
    process.env.SHEET_SYNC_SINCE = '';
    const r3 = await job.runNightly({ write: false, buffer: Buffer.from('x') });
    ck('SHEET_SYNC_SINCE="" turns the cut-off off (2025 rows are queued again)', r3.report.newBills.length === 2 && r3.report.newSales.length === 1, `${r3.report.newBills.length}/${r3.report.newSales.length}`);
    process.env.SHEET_SYNC_SINCE = '2025-06-01';
    const r4 = await job.runNightly({ write: false, buffer: Buffer.from('x') });
    ck('SHEET_SYNC_SINCE=2025-06-01 moves the line', r4.report.newBills.length === 2 && r4.report.newSales.length === 0 && r4.report.beforeCutoff.length === 1, JSON.stringify([r4.report.newBills.length, r4.report.newSales.length, r4.report.beforeCutoff.length]));

    sheetImport.readWorkbook = realRead;
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
