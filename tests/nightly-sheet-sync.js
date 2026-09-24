// tests/nightly-sheet-sync.js — the 11:15pm sheet sync actually writes.
// It ran live for days and wrote nothing: it handed commit() a bare
// { bills, sales }, commit() wants a PLAN (it is what carries the batch id),
// so every night threw "nothing planned to commit" — and the scheduler logged
// that sentence as though it were a summary.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-'));
process.env.BILLS_FILE = path.join(dir, 'bills.json');
process.env.SALES_FILE = path.join(dir, 'sales.json');
process.env.DATA_DIR = dir;
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(extra).slice(0, 180)); } };

const siw = require('../helpers/sheetImportWrite');
const bills = require('../helpers/bills');

(async () => {
    const row = { container_no: 'FSCU8671703', booking_no: 'DALA88150200', date: '2026-09-21',
        supplier: 'Mazariegos', invoice_no: '260921_BAT_26MK74', supplier_invoice_amount: 20327.8,
        supplier_price: 0.41, description: 'BATTERY', gross: 79780, truck: 29300, boxes: 900 };

    // the bug, pinned: rows without a plan are refused
    let threw = null;
    try { await siw.commit({ bills: [row], sales: [] }, { force: true }); } catch (e) { threw = e.message; }
    ck('commit() refuses bare rows — this is what happened every night', /nothing planned to commit/.test(threw || ''), threw);
    ck('...and nothing was written by that attempt', bills.list().length === 0);

    // the fix: plan, then commit
    const source = 'nightly-sheet-sync 2026-09-25';
    const planned = siw.plan({ bills: [row], sales: [] }, { source, actor: 'nightly sheet sync' });
    ck('plan() carries a batch id', !!planned.batch, planned.batch);
    const out = await siw.commit(planned, { source, force: true });
    ck('commit() writes the bill', out.bills === 1, JSON.stringify(out));
    const saved = bills.list();
    ck('the row is in the ledger with its amount', saved.length === 1 && Number(bills.withTotals(saved[0]).amount) === 20327.8, saved[0] && bills.withTotals(saved[0]).amount);
    ck('...stamped with the batch, so it can be undone', saved[0].imported_batch === planned.batch && saved[0].imported_source === source, saved[0].imported_batch);
    ck('...and says it came from the night job', /nightly/i.test(String(saved[0].created_by || '')), saved[0].created_by);

    const undone = await siw.undo(planned.batch);
    ck('the batch undoes cleanly', bills.list().length === 0, JSON.stringify(undone));

    // and the job itself must plan before it commits
    const job = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'metalsSheetSyncJob.js'), 'utf8');
    ck('the night job calls plan() before commit()', job.indexOf('siw.plan(') > -1 && job.indexOf('siw.plan(') < job.indexOf('siw.commit('), 'plan missing or after commit');
    ck('...and keeps the rows it could not prepare', /out\.refused/.test(job));

    // the log line that hid it for days
    const sched = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
    const block = sched.slice(sched.indexOf('metals-sheet-sync'), sched.indexOf('metals-sheet-sync') + 1400);
    ck('a failed night is logged as FAILED, not as a summary', /FAILED — NOTHING WAS WRITTEN/.test(block));
    ck('a successful night says what it wrote, with the batch id', /wrote \$\{result\.committed\.bills\}|wrote \${result.committed.bills}/.test(block) || /batch \$\{result\.committed\.batch\}|batch \${result.committed.batch}/.test(block), block.slice(0, 200));
    ck('refused rows are shouted about too', /could not be prepared and were NOT written/.test(block));

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nnightly-sheet-sync: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
