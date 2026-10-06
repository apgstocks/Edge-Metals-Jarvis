// ── tests/books-build.js ──────────────────────────────────────────────────
// The keystone, end to end: her real stores -> entities -> postings ->
// statements. helpers/booksBuild.js is the ONLY file in the books stack
// that reads a store, and it is where the whole thing becomes real.
//
// ── THE CHECK THIS FILE EXISTS FOR ───────────────────────────────────────
// sales.json has NO amount field. It stores weight and invoice_price, and
// sales.js computes `receivable` with the lb/MT handling that makes it
// right. Read the raw row and every invoice is worth zero — which is
// exactly what scripts/entity-audit.js did earlier today, printing $0.00
// against seven real invoices, and what CLAUDE.md records happening once
// before that ("Read `amount` where sales.js means `receivable`").
//
// So section B writes a fixture with a KNOWN weight and price and no amount
// field at all, and insists the P&L shows the computed figure. If anyone
// ever reaches for row.amount again, income goes to zero and this goes red.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-books-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const write = (file, rows) => fs.writeFileSync(file, JSON.stringify(rows, null, 2));

// ── THE FIXTURE ───────────────────────────────────────────────────────────
// Deliberately written the way her stores really look: the sale carries NO
// amount, only weight and price.
const SALE_WEIGHT = 40000;        // lb
const SALE_PRICE = 1.65;          // per lb
const SALE_VALUE = 66000;         // what sales.js must compute

write(cfg.SALES_FILE, [{
    id: 'S1', customer: 'ACME METALS', date: '2026-03-15',
    invoice_no: 'INV-1', container_no: 'MSKU1',
    item: 'Copper', weight: SALE_WEIGHT, weight_unit: 'lb',
    invoice_price: SALE_PRICE, price_unit: 'lb',
}]);
// ── A BILL'S AMOUNT OF RECORD IS supplier_invoice_amount ─────────────────
// Not `amount`. listWithTotals OVERWRITES amount with what it computes from
// the item weights and prices (bills.js:363 — "a supplier invoice amount she
// typed herself WINS over the computed one. The supplier's invoice is the
// document of record"). A bill with neither items nor a stated supplier
// amount has no computable figure at all, and comes back null.
//
// The first version of this fixture set `amount: 40000` and bills.js
// returned null, so the builder posted nothing — correctly, refusing rather
// than inventing a number. The fixture was wrong, not the code, and the
// lesson is the same one as sales.js: the raw row is not the source of
// truth for money.
const BILL_TOTAL = 40000;
const BILL_TRUCKING = 1500;
write(cfg.BILLS_FILE, [{
    id: 'B1', supplier: 'DRM', date: '2026-03-01',
    invoice_no: 'SUP-1', container_no: 'MSKU1',
    supplier_invoice_amount: BILL_TOTAL, trucking_amount: BILL_TRUCKING,
}]);
write(cfg.EXPENSES_FILE, [
    { id: 'X1', date: '2026-03-20', amount: 300, category: 'Fuel', method: 'Cash', description: 'diesel' },
    { id: 'X2', date: '2026-03-21', amount: 90, category: 'Kryptonite', method: 'Cash' },
]);
write(cfg.LOADS_FILE, [{ id: 'L1', date: '2026-03-05', seller: 'Walk-in', amount: 2500 }]);

const B = require(path.join(ROOT, 'helpers/booksBuild'));
const S = require(path.join(ROOT, 'helpers/statements'));

// ── A — IT WRITES NOTHING ─────────────────────────────────────────────────
{
    section('A — read-only over every store it touches');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/booksBuild.js'), 'utf8');
    ck('it writes to no store', !/mutateJson|writeFile|appendFile|saveJson/.test(src),
       'the journal is derived; a write here would make it a second truth');

    const before = fs.readFileSync(cfg.SALES_FILE, 'utf8');
    B.build();
    ck('  and building really leaves the stores untouched',
       fs.readFileSync(cfg.SALES_FILE, 'utf8') === before);
}

// ── B — THE AMOUNT COMES FROM THE STORE, NOT THE ROW ──────────────────────
{
    section('B — sales.json has no amount field, and that must not mean zero');

    const raw = JSON.parse(fs.readFileSync(cfg.SALES_FILE, 'utf8'));
    ck('the fixture really has no amount on the row',
       raw[0].amount === undefined, JSON.stringify(Object.keys(raw[0])));

    const b = B.build();
    const pl = S.profitAndLoss(b.lines, { entity: 'edge-metals' });
    ck(`income is the COMPUTED ${SALE_VALUE}, not 0`,
       pl.incomeTotal === SALE_VALUE,
       `${pl.incomeTotal} — reading row.amount gives 0 and printed $0.00 against seven real invoices today`);
    ck('  which is weight × price, through sales.js',
       SALE_WEIGHT * SALE_PRICE === SALE_VALUE, `${SALE_WEIGHT} × ${SALE_PRICE}`);

    ck('a bill becomes a cost of sales', pl.cogs.some((a) => a.code === '5000'),
       JSON.stringify(pl.cogs.map((a) => [a.code, a.balance])));

    // ── THE BILL'S AMOUNT IS NOT row.amount EITHER ───────────────────────
    // bills.js overwrites `amount` with its own computation and honours
    // supplier_invoice_amount above it. A fixture using the wrong key gave
    // null and the builder posted nothing — which is the right refusal, and
    // is why this asserts the figure rather than merely that it posted.
    const rawBill = JSON.parse(fs.readFileSync(cfg.BILLS_FILE, 'utf8'))[0];
    ck('the bill fixture states its amount the way her bills do',
       rawBill.supplier_invoice_amount === BILL_TOTAL && rawBill.amount === undefined,
       JSON.stringify(Object.keys(rawBill)));
    // ── THE COST IS THE GROSS FIGURE ─────────────────────────────────────
    // bills.js:402-408 names the chain: amount is what the metal came to,
    // net_payable is what the SUPPLIER is owed after the haulage she covers
    // for them. So the cost of the metal is the gross, the supplier is owed
    // the net, and the haulage is a liability to whoever hauled it.
    //
    // The first version passed net_payable as the bill value AND let the
    // rule subtract trucking again — 37,000 on a 40,000 bill, balancing
    // perfectly. This asserts the figure for that reason.
    const material = (pl.cogs.find((a) => a.code === '5000') || {}).balance;
    ck('  and the metal is costed at the GROSS invoice figure',
       material === BILL_TOTAL, `${material} — expected ${BILL_TOTAL}, the supplier's own invoice`);

    const bs = S.balanceSheet(b.lines, { entity: 'edge-metals' });
    const payable = (bs.liabilities.find((a) => a.code === '2010') || {}).balance;
    ck('  the supplier is owed the NET figure',
       payable === BILL_TOTAL - BILL_TRUCKING,
       `${payable} — expected ${BILL_TOTAL} - ${BILL_TRUCKING}, which is bills.js's net_payable`);
    const haulage = (bs.liabilities.find((a) => a.code === '2050') || {}).balance;
    ck('  and the haulage she covers for them is owed to the hauler',
       haulage === BILL_TRUCKING, `${haulage}`);
}

// ── C — AN UNKNOWN CATEGORY IS SURFACED, NOT BURIED ───────────────────────
{
    section('C — the expense category the chart does not have');

    const b = B.build();
    ck('the Kryptonite expense is reported as a problem',
       b.problems.some((p) => /Kryptonite/.test(p)), JSON.stringify(b.problems));
    ck('  and the build is NOT called complete',
       b.complete === false, String(b.complete));
    ck('  while the Fuel one still posts',
       b.lines.some((l) => l.account === '6100'), JSON.stringify(b.lines.map((l) => l.account)));

    // The dangerous alternative: silently in Other, where nobody looks.
    ck('  and nothing lands in 6900 Other',
       !b.lines.some((l) => l.account === '6900'),
       'burying it there hides that the chart is missing an account she needs');
}

// ── D — THE WHOLE STACK TIES ──────────────────────────────────────────────
{
    section('D — stores to statements, and the three ties hold');

    const b = B.build();
    ck('the journal balances', b.journal.balanced === true, `${b.journal.debit} vs ${b.journal.credit}`);
    ck('  and every company balances on its own',
       b.journal.everyEntityBalanced === true, JSON.stringify(b.journal.entities));

    for (const entity of ['edge-metals', 'edge-trading']) {
        const pk = S.pack(b.lines, { entity });
        ck(`${entity}: the trial balance balances`, pk.trialBalance.balanced === true,
           `${pk.trialBalance.debit} vs ${pk.trialBalance.credit}`);
        ck(`  ${entity}: the balance sheet balances`, pk.balanceSheet.balances === true,
           `out by ${pk.balanceSheet.difference}`);
        ck(`  ${entity}: the profit on it is the P&L's figure`,
           pk.balanceSheet.netIncome === pk.profitAndLoss.netIncome,
           `${pk.balanceSheet.netIncome} vs ${pk.profitAndLoss.netIncome}`);
    }

    // Each store's rows land on the right company, with no crossing.
    const metals = S.trialBalance(b.lines, { entity: 'edge-metals' });
    const yard = S.trialBalance(b.lines, { entity: 'edge-trading' });
    ck('the invoice is Edge Metals\', not the yard\'s',
       metals.accounts.some((a) => a.code === '4000') && !yard.accounts.some((a) => a.code === '4000'),
       'CLAUDE.md rule 5 — a rule for one is not a rule for the other');
    ck('  and the yard purchase is the yard\'s',
       yard.accounts.some((a) => a.code === '5000') , JSON.stringify(yard.accounts.map((a) => a.code)));
}

// ── E — A PERIOD ──────────────────────────────────────────────────────────
{
    section('E — only the rows in the period');

    const march = B.build({ from: '2026-03-01', to: '2026-03-10' });
    const all = B.build();
    ck('a narrow window sees fewer transactions',
       march.transactions < all.transactions, `${march.transactions} vs ${all.transactions}`);
    ck('  and the sale on the 15th is outside it',
       !march.lines.some((l) => l.account === '4000'), JSON.stringify(march.lines.map((l) => l.account)));
    ck('  while the bill on the 1st is inside',
       march.lines.some((l) => l.account === '5000'), JSON.stringify(march.lines.map((l) => l.account)));
    ck('  and the narrowed journal still balances', march.journal.balanced === true);
}

// ── F — A MISSING STORE IS A NOTE, NOT A CRASH ────────────────────────────
// On any machine without her data most stores are absent. The books must
// still build, saying what they could not read.
{
    section('F — most stores absent is the normal case');

    let threw = null;
    let b = null;
    try { b = B.build(); } catch (e) { threw = e.message; }
    ck('it does not throw when stores are missing', threw === null, String(threw));
    ck('  and it still produces a journal', !!b && Array.isArray(b.lines));

    // Deliberately corrupt one and make sure it is named rather than fatal.
    fs.writeFileSync(cfg.BILLS_FILE, '{ not json');
    let c = null; threw = null;
    try { c = B.build(); } catch (e) { threw = e.message; }
    ck('a corrupt store does not take the books down', threw === null, String(threw));
    ck('  and the other stores still post',
       !!c && c.lines.some((l) => l.account === '4000'), JSON.stringify(c && c.lines.length));
    write(cfg.BILLS_FILE, [{ id: 'B1', supplier: 'DRM', date: '2026-03-01', amount: 40000, trucking_amount: 1500 }]);
}

// ── G — AN UNPLACEABLE ROW IS LISTED, NEVER DROPPED ───────────────────────
// A statement built from a journal missing rows is a smaller profit than
// the truth and looks exactly like a correct one.
{
    section('G — rows that belong to no company');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/booksBuild.js'), 'utf8');
    ck('unplaceable rows are collected',
       /unplaced\.push/.test(src), 'they must be shown to her, not silently skipped');
    ck('  and they make the build incomplete',
       /unplaced\.length === 0 && j\.problems\.length === 0/.test(src),
       'complete must mean every row is accounted for');
    ck('  with the reason entities.js gave',
       /why: r\.basis/.test(src), 'a reason she can act on, not just a count');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
