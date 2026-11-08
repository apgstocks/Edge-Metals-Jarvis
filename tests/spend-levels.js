// ── tests/spend-levels.js ─────────────────────────────────────────────────
// Dissecting the spend report, level by level.
//
// Apsara, 2026-11-08: "The spend report should be built in a way sich that
// we can disect into lower level from higher level in a humanely possible
// way."
//
// The arithmetic rule this file exists to hold: EVERY LEVEL ADDS UP TO THE
// ONE ABOVE IT. A drill-down whose children do not sum to their parent is
// worse than no drill-down, because she will reconcile against it and the
// error will look like her bookkeeping rather than like ours.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-levels-'));
process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label);
           if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const L = require(path.join(__dirname, '..', 'helpers', 'spendLevels'));

// A yard month with the shapes that actually occur: two companies, several
// kinds, repeat counterparties, two months, and one row with no party.
const ROWS = [
    { kind: 'load',    direction: 'out', id: 'L1', date: '2026-11-06', amount: 8368.77, party: 'Randy Recycling',    company: 'edge-trading' },
    { kind: 'load',    direction: 'out', id: 'L2', date: '2026-11-05', amount: 3416.71, party: 'Randy Recycling',    company: 'edge-trading' },
    { kind: 'load',    direction: 'out', id: 'L3', date: '2026-10-28', amount: 1109.57, party: 'Edgar lopez',        company: 'edge-trading' },
    { kind: 'trucker', direction: 'out', id: 'T1', date: '2026-11-04', amount: 1200.00, party: 'Bayou Haulage',      company: 'edge-trading' },
    { kind: 'expense', direction: 'out', id: 'E1', date: '2026-11-02', amount: 240.50,  party: null,                 company: 'edge-trading' },
    { kind: 'supplier',direction: 'out', id: 'S1', date: '2026-11-03', amount: 5000.00, party: 'Eccomelt',           company: 'edge-metals' },
    { kind: 'sale',    direction: 'in',  id: 'I1', date: '2026-11-06', amount: 20000.0, party: 'FMC Metals',         company: 'edge-trading' },
];
const OUT_TOTAL = 8368.77 + 3416.71 + 1109.57 + 1200 + 240.50 + 5000;

section('A — the top: whose money, and it adds up');
{
    const top = L.level(ROWS, []);
    ck('the top level splits by company', top.by === 'company', String(top.by));
    ck('  and says so in words', top.heading === 'Whose money', top.heading);
    ck('  money out only — the sale is not mixed in',
       Math.abs(top.total - OUT_TOTAL) < 0.005,
       `${top.total} vs ${OUT_TOTAL} — money out and money in are two questions`);
    ck('  two companies', top.rows.length === 2, JSON.stringify(top.rows.map((r) => r.label)));
    ck('  named as she names them',
       top.rows.some((r) => r.label === 'Edge Yard') && top.rows.some((r) => r.label === 'Edge Metals'),
       JSON.stringify(top.rows.map((r) => r.label)));

    // THE RULE. Everything below is only worth having if this holds.
    const sum = top.rows.reduce((a, r) => a + r.amount, 0);
    ck('EVERY CHILD SUMS TO THE PARENT',
       Math.abs(sum - top.total) < 0.005, `${sum} vs ${top.total}`);
    ck('  and the shares add to 100%',
       Math.abs(top.rows.reduce((a, r) => a + r.share, 0) - 100) < 0.2,
       JSON.stringify(top.rows.map((r) => r.share)));
    ck('  biggest first', top.rows[0].amount >= top.rows[1].amount);
}

section('B — down one: what the yard money went on');
{
    const yard = L.level(ROWS, [{ by: 'company', key: 'edge-trading' }]);
    ck('the next level is what it went on', yard.by === 'kind', String(yard.by));
    ck('  in her words, not the database\'s',
       yard.rows.some((r) => r.label === 'Metal bought')
       && yard.rows.some((r) => r.label === 'Haulage'),
       JSON.stringify(yard.rows.map((r) => r.label)));
    ck('  Edge Metals money is gone from this branch',
       Math.abs(yard.total - (OUT_TOTAL - 5000)) < 0.005,
       `${yard.total}`);
    const sum = yard.rows.reduce((a, r) => a + r.amount, 0);
    ck('  and it still sums to its parent', Math.abs(sum - yard.total) < 0.005,
       `${sum} vs ${yard.total}`);
    ck('  the breadcrumb says where she is',
       yard.crumbs.map((c) => c.label).join(' / ') === 'Money out / Edge Yard',
       yard.crumbs.map((c) => c.label).join(' / '));
}

section('C — down again: who, then when, then the payment itself');
{
    const p = [{ by: 'company', key: 'edge-trading' }, { by: 'kind', key: 'load' }];
    const who = L.level(ROWS, p);
    ck('after what, comes who', who.by === 'party', String(who.by));
    ck('  Randy\'s two loads are one row of two',
       (who.rows.find((r) => r.label === 'Randy Recycling') || {}).count === 2,
       JSON.stringify(who.rows));
    ck('  adding to both of them',
       Math.abs((who.rows.find((r) => r.label === 'Randy Recycling') || {}).amount
                - (8368.77 + 3416.71)) < 0.005);

    // Randy's two loads are BOTH in November, so the month level has one
    // child and the humane rule walks past it — straight to the payments.
    // Written the other way round first; the code was right and the test was
    // wrong, which is worth leaving on the record.
    const when = L.level(ROWS, p.concat([{ by: 'party', key: 'Randy Recycling' }]));
    ck('one month means no month screen — straight to the two payments',
       when.by === null && when.records.length === 2,
       `${when.by} / ${when.records.length}`);
    ck('  newest first, like every other list here',
       when.records[0].date === '2026-11-06', when.records[0].date);
    ck('  and nothing below offers a click that does nothing',
       when.rows.length === 0);

    // And when a counterparty really does span months, the month level earns
    // its place. Its own fixture, so the totals above stay readable.
    const TWO_MONTHS = [
        { kind: 'load', direction: 'out', id: 'A', date: '2026-11-06', amount: 100, party: 'Randy Recycling', company: 'edge-trading' },
        { kind: 'load', direction: 'out', id: 'B', date: '2026-11-01', amount: 200, party: 'Randy Recycling', company: 'edge-trading' },
        { kind: 'load', direction: 'out', id: 'C', date: '2026-10-14', amount: 300, party: 'Randy Recycling', company: 'edge-trading' },
    ];
    const months = L.level(TWO_MONTHS, []);
    ck('a seller across two months DOES get a month screen',
       months.by === 'month', `${months.by} (company and kind were skipped — only one of each)`);
    ck('  a month reads as a month, not a code',
       months.rows[0].label === 'November 2026', months.rows[0].label);
    ck('  and the months add to the whole',
       Math.abs(months.rows.reduce((a, r) => a + r.amount, 0) - 600) < 0.005,
       JSON.stringify(months.rows.map((r) => [r.label, r.amount])));
}

section('D — THE HUMANE RULE: a level that cannot split is skipped');
{
    // Edge Metals has one payment, to one supplier, in one month. Making her
    // click through three screens that each hold one thing is the ceremony
    // that makes people stop using a drill-down.
    const metals = L.level(ROWS, [{ by: 'company', key: 'edge-metals' }]);
    ck('one lonely payment does not become three clicks',
       metals.by === null || metals.rows.length > 1,
       `landed on ${metals.by} with ${metals.rows.length} row(s)`);
    ck('  it goes straight to the payment', metals.records.length === 1,
       JSON.stringify(metals.records.map((r) => r.id)));
    ck('  and SAYS which levels it walked past',
       metals.skipped.length > 0,
       'skipping silently would leave her unable to tell where she is');
    ck('  naming them', metals.skipped.some((s) => s.label === 'Supplier settlements'),
       JSON.stringify(metals.skipped));
}

section('E — money in is its own question');
{
    const inLvl = L.level(ROWS, [], { direction: 'in' });
    ck('money in totals only the money in', Math.abs(inLvl.total - 20000) < 0.005, String(inLvl.total));
    ck('  and says so at the top of the trail',
       inLvl.crumbs[0].label === 'Money in', inLvl.crumbs[0].label);
    ck('  with no money-out rows anywhere in it',
       inLvl.rows.every((r) => r.amount <= 20000) && inLvl.count === 1,
       `${inLvl.count} rows`);
}

section('F — the gaps are named, never dropped');
{
    // The expense has no party. A drill-down that silently omits it makes the
    // children stop summing to the parent, which is the one thing that must
    // never happen here.
    const p = [{ by: 'company', key: 'edge-trading' }, { by: 'kind', key: 'expense' }];
    const who = L.level(ROWS, p);
    const named = who.by === 'party' ? who.rows : [];
    ck('a payment with no counterparty still appears',
       who.records.length === 1 || named.some((r) => r.label === 'Not recorded'),
       JSON.stringify({ by: who.by, rows: named.map((r) => r.label), recs: who.records.length }));

    // And the whole-tree version of the same rule, walked for real.
    const top = L.level(ROWS, []);
    let deepSum = 0;
    for (const c of top.rows) {
        const kinds = L.level(ROWS, c.path);
        deepSum += kinds.by ? kinds.rows.reduce((a, r) => a + r.amount, 0) : kinds.total;
    }
    ck('WALKING THE WHOLE TREE STILL ADDS UP TO THE TOP',
       Math.abs(deepSum - top.total) < 0.005,
       `${deepSum} vs ${top.total} — if this drifts she will reconcile against `
       + 'it and the error will look like her bookkeeping');
}

section('G — it survives the shapes that break things');
{
    ck('no rows at all is an empty answer, not a crash',
       L.level([], []).total === 0 && L.level([], []).rows.length === 0);
    ck('a row with no date still groups',
       L.level([{ kind: 'load', direction: 'out', amount: 10, company: 'edge-trading', party: 'X' }],
               [{ by: 'company', key: 'edge-trading' }]).total === 10);
    ck('a path naming a level that does not exist is ignored, not obeyed',
       L.level(ROWS, [{ by: 'nonsense', key: 'x' }]).total > 0);
    ck('a path to a value with no rows totals zero rather than everything',
       L.level(ROWS, [{ by: 'company', key: 'no-such-company' }]).total === 0,
       'narrowing to nothing must not silently widen back to all of it');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
