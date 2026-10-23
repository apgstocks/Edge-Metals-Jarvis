// ── tests/books-parity.js ───────────────────────────────────────────────────
// Jarvis's books against QuickBooks', while there is still a QuickBooks.
//
// Apsara, 2026-10-23: "from next year-no qb", "so accounts should be
// perfectly handled", "so that we can convince owner to let go of qb and
// jarvis does better".
//
// The window to PROVE the books are right closes when QB does. These checks
// guard the tool that does the proving — and in particular guard it against
// becoming reassuring, which is the one failure mode that would actually
// cost her: a parity report that says "agrees" when it does not is worse
// than no report, because the owner acts on it.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'helpers/booksParity.js'));

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 200))); } };
const section = (t) => console.log('\n' + t);

const QB = { from: '2026-01-01', to: '2026-09-30',
    income: 4820133.22, cogs: 4410877.10, grossProfit: 409256.12,
    expenses: 188420.55, netIncome: 220835.57 };
const SAME = { incomeTotal: 4820133.22, cogsTotal: 4410877.10, grossProfit: 409256.12,
    expenseTotal: 188420.55, netIncome: 220835.57 };

section('A — agreement is only ever claimed when it is true');
{
    const r = P.compare(QB, SAME);
    ck('identical books agree', r.agrees === true && r.differing.length === 0);
    ck('  and it says so in words she can forward', /agree on all five figures/.test(P.verdict(r)));
    ck('  net income is called out on its own', r.netIncomeAgrees === true);
}

section('B — a cent is a difference');
{
    // "Close enough" is the answer that loses the argument with an
    // accountant. One cent out is out.
    const off = P.compare(QB, { ...SAME, netIncome: 220835.58 });
    ck('one cent apart does NOT pass as agreement', off.agrees === false, off.differing[0]);
    ck('  and net income is flagged', off.netIncomeAgrees === false);
    // A wider tolerance is available but must be asked for, and reported.
    const loose = P.compare(QB, { ...SAME, netIncome: 220835.58 }, { tolerance: 1 });
    ck('a tolerance can be widened deliberately', loose.agrees === true && loose.tolerance === 1);
    ck('  and the report states which tolerance was used', loose.tolerance === 1);
}

section('C — a missing figure is the most important gap, not a zero');
{
    // One book not having the concept at all is the thing worth knowing.
    // Treating null as 0 would report a difference equal to the other side
    // and bury the real finding.
    const r = P.compare(QB, { ...SAME, cogsTotal: null });
    const row = r.differing.find((x) => x.key === 'cogs');
    ck('a null on one side is a difference', r.agrees === false && !!row);
    ck('  it is NOT reported as a delta of the full amount', row.delta === null, row);
    ck('  it names which side is missing it', row.missing === 'jarvis', row);
    ck('  and points at the chart, which is where that comes from',
        /chart/i.test(P.whereToLook(row)), P.whereToLook(row));
}

section('D — the biggest gap is first, because it usually explains the rest');
{
    // Understating cost by 13k moves gross profit and net income by the same
    // 13k. All three differ; only one is worth chasing.
    const r = P.compare(QB, { ...SAME, cogsTotal: 4397877.10, grossProfit: 422256.12, netIncome: 233835.57 });
    ck('three figures differ', r.differing.length === 3, r.differing.map((x) => x.key));
    ck('  cost of goods is listed first', r.differing[0].key === 'cogs', r.differing[0].key);
    ck('  the derived lines say to fix the ones above first',
        /fix those first/.test(P.whereToLook(r.differing[1])));
    ck('  the direction is read correctly — Jarvis shows LESS cost',
        /LESS cost/.test(P.whereToLook(r.differing[0])), P.whereToLook(r.differing[0]));
    const over = P.compare(QB, { ...SAME, cogsTotal: 4420877.10 });
    ck('  and the other direction says MORE', /MORE cost/.test(P.whereToLook(over.differing[0])));
}

section('E — it compares, it never adjusts');
{
    // A parity tool that "fixes" a difference hides the one thing worth
    // knowing. Nothing in this module may mutate either side.
    const qbCopy = { ...QB };
    const jsCopy = { ...SAME, cogsTotal: 1 };
    P.compare(qbCopy, jsCopy);
    ck('the QuickBooks figures are untouched', qbCopy.cogs === QB.cogs);
    ck('the Jarvis figures are untouched', jsCopy.cogsTotal === 1);
    const src = require('fs').readFileSync(path.join(ROOT, 'helpers/booksParity.js'), 'utf8');
    ck('  and nothing in the module writes anywhere',
        !/saveJson|mutateJson|writeFile|\.push\(.*ledger/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('  FAILED:'); failures.forEach((f) => console.log('   · ' + f)); }
process.exit(fail ? 1 : 0);
