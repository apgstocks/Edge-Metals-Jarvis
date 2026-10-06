// ── tests/books-readiness.js ──────────────────────────────────────────────
// Apsara's actual goal: "it should be in a way that we wont ever need
// quickbook at all", and a year-end pack her CPA can work from.
//
// Every other piece of the books stack answers a narrow question. This one
// answers hers — is the P&L complete enough to file, and if not, what is
// missing and what is it worth?
//
// ── WHY IT CANNOT JUST READ THE STATEMENTS ───────────────────────────────
// A trial balance balances whether or not rows are missing. All three ways
// a P&L goes wrong leave it balancing:
//   · a row posts nowhere            — the figure is simply absent
//   · revenue with no cost behind it — profit, and tax, OVERSTATED
//   · cost with no revenue yet       — profit understated, or uncounted stock
// Section C is the one that matters: the books must balance AND still be
// reported as not ready.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ready-'));
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/books-readiness.js');

const W = (name, rows) => fs.writeFileSync(path.join(TMP, name), JSON.stringify(rows, null, 2));

function run(args = []) {
    try {
        return { out: execFileSync(process.execPath, [SCRIPT, ...args], {
            env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' }, encoding: 'utf8' }), code: 0 };
    } catch (e) {
        return { out: String(e.stdout || ''), code: e.status === undefined ? -1 : e.status };
    }
}

// ── THE FIXTURE ───────────────────────────────────────────────────────────
// One container complete. One sold with no bill. One bought and not sold.
// One expense in a category the chart does not have.
const SOLD_NO_BILL = 66000;        // 40,000 lb @ 1.65
const BOUGHT_NOT_SOLD = 25000;

function fixture() {
    W('bills.json', [
        { id: 'B1', container_no: 'DONE1', booking_no: 'BK1', date: '2026-03-01',
          supplier: 'DRM', supplier_invoice_amount: 30000, trucking_amount: 1000 },
        { id: 'B2', container_no: 'STOCK1', booking_no: 'BK2', date: '2026-03-05',
          supplier: 'DRM', supplier_invoice_amount: BOUGHT_NOT_SOLD },
    ]);
    W('sales.json', [
        { id: 'SALE_1790000000000_a', container_no: 'DONE1', booking_no: 'BK1', date: '2026-03-20',
          customer: 'ACME', item: 'Cu', weight: 30000, weight_unit: 'lb',
          invoice_price: 1.5, price_unit: 'lb' },
        { id: 'SALE_1790000000001_b', container_no: 'ORPHAN1', booking_no: 'BK9', date: '2026-04-02',
          customer: 'ACME', item: 'Al', weight: 40000, weight_unit: 'lb',
          invoice_price: 1.65, price_unit: 'lb' },
    ]);
    W('expenses.json', [
        { id: 'X1', date: '2026-03-10', amount: 200, category: 'Fuel', method: 'Cash' },
        { id: 'X2', date: '2026-03-11', amount: 75, category: 'Kryptonite', method: 'Cash' },
    ]);
}
fixture();

// ── A — IT RUNS AND READS HER STORES ──────────────────────────────────────
{
    section('A — the whole stack, against real stores');

    const r = run();
    ck('it runs', /BOOKS READINESS/.test(r.out), r.out.slice(0, 200));
    ck('  and reports how many transactions it read',
       /TRANSACTIONS READ:\s+\d+/.test(r.out), r.out.slice(0, 300));
    ck('  and how many journal lines came out',
       /JOURNAL LINES:\s+\d+/.test(r.out), r.out.slice(0, 300));
}

// ── B — REVENUE WITH NO COST IS THE DANGEROUS ONE ─────────────────────────
{
    section('B — half-finished containers, in money');

    const r = run();
    ck('a container sold with no bill is counted',
       /sold with no bill behind them :\s+1 containers/.test(r.out), r.out.slice(0, 900));
    ck('  with its revenue, from sales.js\'s own arithmetic',
       new RegExp(`\\$${SOLD_NO_BILL.toLocaleString('en-US')}\\.00`).test(r.out),
       `expected ${SOLD_NO_BILL} — reading the raw row gives 0, sales.json has no amount field`);
    ck('  and it says profit and tax are overstated',
       /profit — and therefore tax — is OVERSTATED/.test(r.out), r.out.slice(0, 900));

    ck('a container bought and not sold is counted separately',
       /bought and not yet sold\s+:\s+1 containers/.test(r.out), r.out.slice(0, 900));
    ck('  with its cost',
       new RegExp(`\\$${BOUGHT_NOT_SOLD.toLocaleString('en-US')}\\.00`).test(r.out),
       String(BOUGHT_NOT_SOLD));
    ck('  and it offers both explanations rather than one',
       /stock still on hand, or a sale that was never recorded/.test(r.out), r.out.slice(0, 900));

    // The completed container must NOT appear in either list.
    ck('a container with both halves is in neither list',
       /sold with no bill behind them :\s+1 /.test(r.out) && /bought and not yet sold\s+:\s+1 /.test(r.out),
       'DONE1 has a bill and a sale, so it is finished');
}

// ── C — IT BALANCES AND IS STILL NOT READY ────────────────────────────────
// The reason this report exists at all.
{
    section('C — balancing is not the same as being complete');

    const r = run();
    ck('the trial balance balances', /trial balance balances/.test(r.out), r.out.slice(0, 1400));
    ck('  and the balance sheet does too', /balance sheet balances/.test(r.out), r.out.slice(0, 1400));
    ck('  and it STILL says not ready to file',
       /NOT READY TO FILE/.test(r.out), r.out.slice(-600));
    ck('  saying why that is the point',
       /balance whether or not rows are missing/.test(r.out), r.out.slice(-500));
    ck('  and exiting non-zero', r.code === 1, String(r.code));
}

// ── D — UNPOSTABLE ROWS ARE GROUPED, NOT LISTED 25 TIMES ──────────────────
// 25 rows saying "needs weights, price" is ONE problem. A wall of 25 lines
// is how a report stops being read.
{
    section('D — one problem, not twenty-five lines');

    const r = run();
    ck('rows that could not be posted are counted',
       /ROWS THAT COULD NOT BE POSTED/.test(r.out), r.out.slice(0, 900));
    ck('  and grouped by reason',
       /an expense category the chart does not have/.test(r.out), r.out.slice(0, 900));
    ck('  naming the category she would add',
       /categories to add: Kryptonite/.test(r.out),
       'a category she can add in a minute is a different job from weighing 25 containers');

    // And the Fuel one still posted.
    ck('  while the expense that DID post is not reported as a problem',
       !/categories to add:.*Fuel/.test(r.out), r.out.slice(0, 900));
}

// ── E — PER COMPANY, AND FILABLE IS ITS OWN QUESTION ──────────────────────
{
    section('E — three companies, three verdicts');

    const r = run();
    ck('Edge Metals is reported', /Edge Metals INC/.test(r.out), r.out.slice(0, 1600));
    ck('  the yard too, by both its names',
       /Edge Yard\s+\(EDGE TRADING INC\)/.test(r.out), r.out.slice(0, 1600));
    ck('  and AAA Investment, even with nothing posted',
       /AAA Investment/.test(r.out) && /nothing posted to this company/.test(r.out), r.out.slice(0, 1800));
    ck('  the yard is marked NOT FILABLE for want of a tax ID',
       /NOT FILABLE — missing tax ID/.test(r.out), r.out.slice(0, 1800));
    ck('  which is listed as a blocker in the verdict',
       /no tax ID or address on file/.test(r.out), r.out.slice(-600));
}

// ── F — A PERIOD, AND A CLEAN RUN ─────────────────────────────────────────
{
    section('F — a period, and what "ready" looks like');

    const q = run(['--from', '2026-03-01', '--to', '2026-03-31']);
    ck('a period is honoured', /period: 2026-03-01 to 2026-03-31/.test(q.out), q.out.slice(0, 200));
    ck('  and the April sale falls outside it',
       /sold with no bill behind them :\s+0 containers/.test(q.out), q.out.slice(0, 900));

    // Everything complete, and both companies filable, is the only state
    // that exits 0 — so this cannot pass by accident.
    W('expenses.json', [{ id: 'X1', date: '2026-03-10', amount: 200, category: 'Fuel', method: 'Cash' }]);
    W('sales.json', [{ id: 'SALE_1790000000000_a', container_no: 'DONE1', booking_no: 'BK1',
        date: '2026-03-20', customer: 'ACME', item: 'Cu', weight: 30000, weight_unit: 'lb',
        invoice_price: 1.5, price_unit: 'lb' }]);
    W('bills.json', [{ id: 'B1', container_no: 'DONE1', booking_no: 'BK1', date: '2026-03-01',
        supplier: 'DRM', supplier_invoice_amount: 30000, trucking_amount: 1000 }]);
    const clean = run();
    ck('with nothing half-finished it still blocks on the missing tax IDs',
       /NOT READY TO FILE/.test(clean.out) && clean.code === 1,
       'Edge Trading and AAA genuinely have no tax ID, so this must not go green');
    ck('  and the half-finished counts really went to zero',
       /sold with no bill behind them :\s+0 containers/.test(clean.out)
       && /bought and not yet sold\s+:\s+0 containers/.test(clean.out), clean.out.slice(0, 900));
    fixture();
}

// ── G — IT CHANGES NOTHING ────────────────────────────────────────────────
{
    section('G — read-only');

    const before = fs.readFileSync(path.join(TMP, 'bills.json'), 'utf8');
    run();
    ck('the stores are untouched', fs.readFileSync(path.join(TMP, 'bills.json'), 'utf8') === before);
    const code = fs.readFileSync(SCRIPT, 'utf8').split('\n')
        .filter((l) => !l.trim().startsWith('//')).join('\n');
    ck('  and it has no way to write', !/mutateJson|writeFile|editBill|editSale/.test(code));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
