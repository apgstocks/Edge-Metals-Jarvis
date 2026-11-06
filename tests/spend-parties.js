// ── tests/spend-parties.js ────────────────────────────────────────────────
// Apsara, 2026-11-07: "What if i want supplier wise filter in edge yard".
// Asked which counterparty she meant, because "supplier" already means an
// Edge Metals bill payment inside this report, she answered:
//
//     "TWO FILTERS,WHOM WE BUY,WHOM WE SELL"
//
// ── THE FOUR THINGS THESE CHECKS DEFEND ──────────────────────────────────
//
//  1. TWO FILTERS, NOT ONE. boughtFrom narrows money OUT and leaves money IN
//     alone; soldTo does the reverse. One combined "counterparty" filter
//     would empty the received block whenever the name is a seller — and
//     this business already has settleAgainst because "his seller is also a
//     buyer" (2026-10-17), so that is not a hypothetical.
//
//  2. THE NAMES ARE OPTIONAL. helpers/tools.js line 419 — the voice path —
//     and ~50 test call sites pass no names at all. CLAUDE.md records two
//     outages from a new requirement in shared code that the voice path
//     could not satisfy. With no map every row must read "Not recorded" and
//     every existing figure must be unchanged.
//
//  3. THE BREAKDOWNS RECONCILE. byBoughtFrom adds to total out, bySoldTo
//     adds to received, and the two are NEVER added to each other.
//
//  4. EDGE YARD AND EDGE METALS STAY APART. A yard seller and an Edge Metals
//     supplier are different kinds from different companies. They may both
//     appear in the Bought-from list, but a payment must never be filed
//     under the wrong one because two ids collided.
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'helpers/spendReport'));
const NOT_REC = S.NOT_RECORDED;

// One purchase from each of two sellers, one sale to a buyer, one trucker,
// one Edge Metals supplier payment — enough that a filter can be wrong in a
// visible way.
const PAY = () => ([
    { id: 'p1', load_id: 1, load_kind: 'purchase', amount: 1000, paid_on: '2026-03-10', mode: 'Wire', bank: 'BofA', paid_via: 'Edge Yard' },
    { id: 'p2', load_id: 2, load_kind: 'purchase', amount: 2000, paid_on: '2026-03-20', mode: 'Cash' },
    { id: 'p3', load_id: 1, load_kind: 'purchase', amount: 500, paid_on: '2026-04-02', mode: 'Cash' },
    { id: 'p4', load_id: 7, load_kind: 'trucker', amount: 300, paid_on: '2026-03-12', mode: 'Zelle' },
    { id: 'p5', load_id: 55, load_kind: 'bill', amount: 4000, paid_on: '2026-03-15', mode: 'Wire', paid_via: 'Edge Metals' },
    { id: 'p6', load_id: 9, load_kind: 'sale', amount: 9000, paid_on: '2026-03-22', mode: 'Wire' },
    { id: 'p7', load_id: 10, load_kind: 'sale', amount: 1000, paid_on: '2026-03-23', mode: 'Cash' },
]);
// Note load 1 and bill 55 and trucker 7 all have different ids on purpose —
// see section E for what happens when they do not.
const NAMES = {
    'load:1': 'Eccomelt', 'load:2': 'Ramesh',
    'trucker:7': 'Zimex', 'supplier:55': 'Houston Junk Car Buyers',
    'sale:9': 'Hynos', 'sale:10': 'Eccomelt',
};
const run = (o = {}) => S.buildSpendReport({ payments: PAY(), expenses: [], parties: NAMES, ...o });

(() => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the report finally knows who it paid');
// ══════════════════════════════════════════════════════════════════════════
{
    const r = run();
    ck('money out is grouped by counterparty',
       r.byBoughtFrom.Eccomelt === 1500 && r.byBoughtFrom.Ramesh === 2000,
       JSON.stringify(r.byBoughtFrom));
    ck('  two payments to the same seller add together',
       r.byBoughtFrom.Eccomelt === 1500, 'p1 1000 + p3 500');
    ck('  a trucker is named too', r.byBoughtFrom.Zimex === 300);
    ck('  and an Edge Metals supplier', r.byBoughtFrom['Houston Junk Car Buyers'] === 4000);
    ck('money in is grouped separately',
       r.bySoldTo.Hynos === 9000 && r.bySoldTo.Eccomelt === 1000, JSON.stringify(r.bySoldTo));

    // THE RECONCILIATION. Each breakdown adds to its own total and the two
    // are never mixed — which is the entire reason there are two filters.
    const outSum = Object.values(r.byBoughtFrom).reduce((a, b) => a + b, 0);
    const inSum = Object.values(r.bySoldTo).reduce((a, b) => a + b, 0);
    ck('whom-we-buy adds up to total out', Math.abs(outSum - r.total) < 0.01,
       `${outSum} vs ${r.total}`);
    ck('whom-we-sell adds up to money received', Math.abs(inSum - r.received.total) < 0.01,
       `${inSum} vs ${r.received.total}`);
    ck('  and the two are different numbers, never summed',
       outSum !== inSum && r.total !== r.received.total);

    // Eccomelt is BOTH a seller and a buyer here, deliberately.
    ck('a party who is both a seller and a buyer appears on both sides, separately',
       r.byBoughtFrom.Eccomelt === 1500 && r.bySoldTo.Eccomelt === 1000,
       'settleAgainst exists because "his seller is also a buyer"');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — TWO filters: each narrows its own direction');
// ══════════════════════════════════════════════════════════════════════════
// The check that would fail if someone "simplified" this into one filter.
{
    const all = run();
    const bought = run({ boughtFrom: 'Eccomelt' });
    ck('bought-from narrows the money out', bought.total === 1500, String(bought.total));
    ck('  and leaves money received completely alone',
       bought.received.total === all.received.total && bought.received.total === 10000,
       `${bought.received.total} — filtering a purchase must not empty the sales`);

    const sold = run({ soldTo: 'Hynos' });
    ck('sold-to narrows the money received', sold.received.total === 9000, String(sold.received.total));
    ck('  and leaves the spend completely alone',
       sold.total === all.total, `${sold.total} vs ${all.total}`);

    const both = run({ boughtFrom: 'Ramesh', soldTo: 'Hynos' });
    ck('the two combine, each on its own side',
       both.total === 2000 && both.received.total === 9000,
       JSON.stringify({ out: both.total, in: both.received.total }));

    // Same name, both sides, at once — the case one combined filter gets
    // wrong in both directions.
    const ecco = run({ boughtFrom: 'Eccomelt', soldTo: 'Eccomelt' });
    ck('one party on both sides gives both of their figures',
       ecco.total === 1500 && ecco.received.total === 1000, JSON.stringify(ecco.byBoughtFrom));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — and they combine with the date range and the other three');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, immediately before this: "What if i want from this date to this
// date in this filter". The answer has to be yes for every combination.
{
    ck('date range alone', run({ from: '2026-04-01' }).total === 500);
    ck('date range + bought-from',
       run({ from: '2026-04-01', boughtFrom: 'Eccomelt' }).total === 500);
    ck('  and a window that excludes them gives zero, not everything',
       run({ from: '2026-04-01', boughtFrom: 'Ramesh' }).total === 0);
    ck('bought-from + method',
       run({ boughtFrom: 'Eccomelt', method: 'Cash' }).total === 500, 'p3 only');
    ck('bought-from + bank',
       run({ boughtFrom: 'Eccomelt', bank: 'BofA' }).total === 1000, 'p1 only');
    ck('bought-from + paid via',
       run({ boughtFrom: 'Eccomelt', paidVia: 'Edge Yard' }).total === 1000);
    ck('all five at once',
       run({ from: '2026-03-01', to: '2026-03-31', method: 'Wire', bank: 'BofA',
             paidVia: 'Edge Yard', boughtFrom: 'Eccomelt' }).total === 1000);
    ck('  and one contradictory choice gives zero rather than ignoring it',
       run({ from: '2026-03-01', to: '2026-03-31', method: 'Cash',
             boughtFrom: 'Eccomelt' }).total === 0, 'Eccomelt paid cash in APRIL, not March');

    // A name that matches nothing is echoed back, not silently dropped —
    // same rule the bank follows, so an empty report makes sense.
    const nobody = run({ boughtFrom: 'Nobody Ltd' });
    ck('a name that matches nothing returns zero and says what was asked',
       nobody.total === 0 && nobody.boughtFrom === 'Nobody Ltd', JSON.stringify(nobody.boughtFrom));
    ck('  and matching is case-insensitive, like the bank filter',
       run({ boughtFrom: 'eccomelt' }).total === 1500);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — WITHOUT names, nothing that worked yesterday changes');
// ══════════════════════════════════════════════════════════════════════════
// The voice path (helpers/tools.js:419) and ~50 test call sites pass no map.
// CLAUDE.md: twice the caller that could not satisfy a new requirement was
// the voice path, because it has no form to put a field on.
{
    const withNames = run();
    // ── CAUGHT, NOT LET THROUGH ──────────────────────────────────────────
    // If this throws, the whole file dies and the harness reports "CRASHED",
    // which names nothing. The voice path breaking is the single most likely
    // regression in this feature and it deserves a sentence, not a stack.
    let without = null, threw = null;
    try { without = S.buildSpendReport({ payments: PAY(), expenses: [] }); }
    catch (e) { threw = (e && e.message) || String(e); }
    ck('a report built with NO names does not throw — this is the voice path',
       threw === null, 'helpers/tools.js:419 passes no parties map: ' + threw);
    if (!without) without = { byBoughtFrom: {}, bySoldTo: {}, boughtFromColumns: [], soldToColumns: [],
        received: {}, total: null };
    ck('  and it still builds a report', without.total > 0, String(without.total));
    ck('  and every money figure is identical',
       without.total === withNames.total
       && without.received.total === withNames.received.total
       && without.loadTotal === withNames.loadTotal
       && without.truckerTotal === withNames.truckerTotal
       && without.supplierTotal === withNames.supplierTotal,
       JSON.stringify({ a: without.total, b: withNames.total }));
    ck('  every row reads "Not recorded" rather than throwing or going blank',
       Object.keys(without.byBoughtFrom).length === 1
       && without.byBoughtFrom[NOT_REC] === without.total, JSON.stringify(without.byBoughtFrom));
    ck('  the sold-to side likewise',
       without.bySoldTo[NOT_REC] === without.received.total, JSON.stringify(without.bySoldTo));
    ck('  and the chip lists are one entry long, so no screen renders a dead row',
       without.boughtFromColumns.length === 1 && without.soldToColumns.length === 1,
       JSON.stringify(without.boughtFromColumns));

    // A partial map is the real-world case: some payments named, some not.
    const partial = S.buildSpendReport({ payments: PAY(), expenses: [],
        parties: { 'load:1': 'Eccomelt' } });
    ck('a partly-named ledger names what it can and buckets the rest',
       partial.byBoughtFrom.Eccomelt === 1500 && partial.byBoughtFrom[NOT_REC] === 6300,
       JSON.stringify(partial.byBoughtFrom));
    ck('  and the bucket still reconciles to the total',
       Object.values(partial.byBoughtFrom).reduce((a, b) => a + b, 0) === partial.total);
    ck('  "Not recorded" sorts LAST in the chip list, because it is a gap',
       partial.boughtFromColumns[partial.boughtFromColumns.length - 1] === NOT_REC,
       JSON.stringify(partial.boughtFromColumns));
    ck('and it can be filtered FOR, which is how the gap gets closed',
       S.buildSpendReport({ payments: PAY(), expenses: [],
           parties: { 'load:1': 'Eccomelt' }, boughtFrom: NOT_REC }).total === 6300);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — a name is keyed by KIND as well as id');
// ══════════════════════════════════════════════════════════════════════════
// Yard load 55 and Edge Metals bill payment 55 are different things at
// different companies. Keying on the bare id would file one under the
// other's name — the Edge Yard / Edge Metals mistake this whole app is
// built to prevent, arriving through a lookup table.
{
    const pay = [
        { id: 'a', load_id: 55, load_kind: 'purchase', amount: 100, paid_on: '2026-03-01', mode: 'Cash' },
        { id: 'b', load_id: 55, load_kind: 'bill', amount: 200, paid_on: '2026-03-01', mode: 'Wire' },
    ];
    const r = S.buildSpendReport({ payments: pay, expenses: [],
        parties: { 'load:55': 'Ramesh (yard seller)', 'supplier:55': 'Houston (Edge Metals)' } });
    ck('the same id under two kinds resolves to two different names',
       r.byBoughtFrom['Ramesh (yard seller)'] === 100
       && r.byBoughtFrom['Houston (Edge Metals)'] === 200, JSON.stringify(r.byBoughtFrom));
    ck('  so filtering one does not pull in the other',
       S.buildSpendReport({ payments: pay, expenses: [],
           parties: { 'load:55': 'Ramesh (yard seller)', 'supplier:55': 'Houston (Edge Metals)' },
           boughtFrom: 'Ramesh (yard seller)' }).total === 100);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — an expense carries its own vendor, and is not guessed at');
// ══════════════════════════════════════════════════════════════════════════
{
    const exp = [
        { id: 'e1', date: '2026-03-05', amount: 150, payment_method: 'Cash', vendor: 'Shell', description: 'Fuel for the loader' },
        { id: 'e2', date: '2026-03-06', amount: 60, payment_method: 'Cash', description: 'Paid Costco for supplies' },
    ];
    const r = S.buildSpendReport({ payments: [], expenses: exp, parties: {} });
    ck('an expense with a vendor is filed under it', r.byBoughtFrom.Shell === 150,
       JSON.stringify(r.byBoughtFrom));
    ck('an expense with NO vendor is "Not recorded", not mined from the description',
       r.byBoughtFrom[NOT_REC] === 60 && !r.byBoughtFrom.Costco,
       'a name guessed from free text is a name she would then filter on and trust');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the chip list survives the filter being applied');
// ══════════════════════════════════════════════════════════════════════════
// The classic one-way door: build the list from the FILTERED rows and
// choosing a name removes every other name, so the filter cannot be undone
// from the control that set it. bankColumns has always been built over the
// whole store; these must be too.
{
    const picked = run({ boughtFrom: 'Eccomelt' });
    ck('every counterparty is still listed after one is chosen',
       picked.boughtFromColumns.includes('Ramesh') && picked.boughtFromColumns.includes('Zimex'),
       JSON.stringify(picked.boughtFromColumns));
    ck('  and the date range does not shrink the list either',
       run({ from: '2026-04-01', to: '2026-04-30' }).boughtFromColumns.includes('Ramesh'),
       'Ramesh has nothing in April, but must stay choosable');
    ck('the sold-to list likewise',
       run({ soldTo: 'Hynos' }).soldToColumns.includes('Eccomelt'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
