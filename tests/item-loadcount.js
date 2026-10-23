// ── tests/item-loadcount.js ──────────────────────────────────────────────
// Apsara, 2026-10-17: "If user wants to see say item basis what how much
// loads we bought from this date to that date,it shpuld able to show na" —
// then, on scope: "Build it properly so as sales".
//
// The per-item rows already carried `count`, and `count` is the number of
// weighed LINES. That is a different question: one load can weigh
// alternators across four lines, and one item appears across many loads. So
// "how many loads had alternator in them" could not be read off the screen —
// the only honest way to answer it was to open the item and count by hand.
//
// BOTH SIDES, because these two functions are the same report with "bought"
// and "sold" swapped, and this repo has already paid for fixing one of the
// pair and not the other (see the per-seller / per-buyer case-insensitivity
// note in helpers/outboundLoads.js, which says exactly that about exactly
// these two functions).
//
//   A  purchases: distinct loads per item, inside the date range
//   B  aliases — one load, two spellings, ONE load
//   C  sales: the same number, computed the same way
//   D  the screens actually show it

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-loadcount-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const { getInventoryReport } = require(path.join(ROOT, 'helpers/loads'));
const { getOutboundReport } = require(path.join(ROOT, 'helpers/outboundLoads'));

const rowFor = (report, name) =>
    (report.byType || []).find((g) => String(g.description).trim().toLowerCase() === name.toLowerCase());

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — purchases: how many LOADS carried this item');
{
    // L1 weighs alternators TWICE. If loadCount were read off `count` it
    // would say three loads where there are two — which is the whole bug.
    const loads = [
        { id: 'L1', date: '2026-09-05', items: [
            { description: 'Alternator', net_weight: 100, amount: 40 },
            { description: 'Alternator', net_weight: 50, amount: 20 }] },
        { id: 'L2', date: '2026-09-20', items: [
            { description: 'alternator', net_weight: 80, amount: 30 },
            { description: 'Starter', net_weight: 10, amount: 5 }] },
        { id: 'L3', date: '2026-10-02', items: [
            { description: 'Alternator', net_weight: 999, amount: 999 }] },
    ];
    const r = getInventoryReport(loads, { from: '2026-09-01', to: '2026-09-30' });

    ck('the range holds two loads', r.loadCount === 2, String(r.loadCount));
    const alt = rowFor(r, 'Alternator');
    ck('alternator is a row', !!alt);
    ck('  three weighed LINES', alt.count === 3, String(alt && alt.count));
    ck('  but TWO loads', alt.loadCount === 2, String(alt && alt.loadCount));
    ck('  and they are different numbers, which is the point',
       alt.count !== alt.loadCount, 'if these are equal the fixture stopped testing the distinction');
    ck('  the money and weight are unchanged', alt.net === 230 && alt.amount === 90,
       `${alt.net} / ${alt.amount}`);

    const starter = rowFor(r, 'Starter');
    ck('an item in one load says one', starter && starter.loadCount === 1, String(starter && starter.loadCount));

    // THE DATE RANGE IS REAL. L3 is October and must not be counted.
    ck('October is outside the range and is not counted', alt.loadCount === 2 && alt.net === 230,
       'the from/to filter is not reaching the load count');
    const wide = getInventoryReport(loads, {});
    ck('  widening the range picks it up', rowFor(wide, 'Alternator').loadCount === 3,
       String(rowFor(wide, 'Alternator').loadCount));

    // EVERY row carries it, including one that only ever shipped.
    ck('every row has a loadCount', (r.byType || []).every((g) => typeof g.loadCount === 'number'),
       JSON.stringify((r.byType || []).map((g) => [g.description, g.loadCount])));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — one load, two spellings of one metal, ONE load');
{
    // helpers/itemAliases.js merges "Al combo" and "Aluminium combo" into one
    // row. If the count were built per raw description and then summed when
    // the rows merged, a single load carrying both would report TWO.
    const aliases = require(path.join(ROOT, 'helpers/itemAliases'));
    // SEEDED, not hoped for. On a fresh DATA_DIR there are no aliases, so the
    // merge branch never ran and this section quietly checked the easy case —
    // which is the branch where double-counting CANNOT happen. The one that
    // can is the merged one, so it is created here.
    await aliases.remember('Al combo', 'Aluminium combo', true, { by: 'test' });
    const rows = aliases.list();
    const merged = rows.length > 0;
    ck('the alias was saved, so the MERGE path is what runs below', merged,
       'without it this section tests the branch that cannot fail');

    const loads = [{ id: 'M1', date: '2026-09-10', items: [
        { description: 'Al combo', net_weight: 10, amount: 5 },
        { description: 'Aluminium combo', net_weight: 20, amount: 9 }] }];
    const r = getInventoryReport(loads, {});
    const total = (r.byType || []).reduce((t, g) => t + (g.loadCount || 0), 0);

    ck('the fixture is one load', r.loadCount === 1, String(r.loadCount));
    if (merged) {
        ck('  the two spellings became one row', r.byType.length === 1, JSON.stringify(r.byType.map((g) => g.description)));
        ck('  counted as ONE load, not two', total === 1, `load counts add to ${total}`);
    } else {
        // No aliases saved in this environment, so the two stay separate
        // rows. Each is still ONE load — and that is the property that must
        // hold either way, so it is checked either way rather than skipped.
        ck('  each row still says one load', r.byType.every((g) => g.loadCount === 1),
           JSON.stringify(r.byType.map((g) => [g.description, g.loadCount])));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('C — sales: the same number, on the other side');
{
    const sales = [
        { id: 'S1', date: '2026-09-06', buyer: 'Taewon', net_weight: 100, amount: 500, items: [
            { description: 'Alternator', net_weight: 60, amount: 300 },
            { description: 'Alternator', net_weight: 40, amount: 200 }] },
        { id: 'S2', date: '2026-09-21', buyer: 'Daekwang', net_weight: 70, amount: 350, items: [
            { description: 'alternator', net_weight: 70, amount: 350 }] },
        { id: 'S3', date: '2026-10-03', buyer: 'Taewon', net_weight: 900, amount: 9000, items: [
            { description: 'Alternator', net_weight: 900, amount: 9000 }] },
    ];
    const r = getOutboundReport(sales, { from: '2026-09-01', to: '2026-09-30' });

    ck('two sales in the range', r.loadCount === 2, String(r.loadCount));
    const alt = rowFor(r, 'Alternator');
    ck('alternator is a SOLD row', !!alt);
    ck('  three lines', alt.count === 3, String(alt && alt.count));
    ck('  across TWO sales', alt.loadCount === 2, String(alt && alt.loadCount));
    ck('  case does not split it', alt.net === 170 && alt.amount === 850, `${alt.net} / ${alt.amount}`);
    ck('  October is excluded here too', alt.loadCount === 2);

    const wide = getOutboundReport(sales, {});
    ck('  and widening picks the third up', rowFor(wide, 'Alternator').loadCount === 3,
       String(rowFor(wide, 'Alternator').loadCount));

    // BOTH SIDES, SAME SHAPE. The two reports are read side by side, so a
    // field present on one and missing on the other is a trap.
    const bought = getInventoryReport(
        [{ id: 'B1', date: '2026-09-06', items: [{ description: 'Alternator', net_weight: 1, amount: 1 }] }], {});
    ck('purchases and sales name the field identically',
       'loadCount' in rowFor(bought, 'Alternator') && 'loadCount' in alt,
       'one side would read as "no data" rather than as a missing column');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — and the screens show it');
{
    const inv = fs.readFileSync(path.join(ROOT, 'dashboard/app/02-dashboard-bookings.js'), 'utf8');
    ck('the Inventory table has a Loads column', /<th[^>]*>Loads<\/th>/.test(inv));
    ck('  filled from loadCount', /g\.loadCount != null \? g\.loadCount/.test(inv));
    ck('  and lines are still shown beside it, not replaced',
       /\$\{g\.count\}/.test(inv), 'the weighed-line count is a real figure and was not removed');
    // The drill-down row spans the table; a stale colspan leaves a visible
    // gap the moment a column is added.
    ck('  the drill-down colspan follows the new column',
       /colspan="\$\{data\.onHandAvailable \? 9 : 7\}"/.test(inv),
       'colspan was not updated, so the expanded lines will not span the table');

    const out = fs.readFileSync(path.join(ROOT, 'dashboard/outbound-loads.html'), 'utf8');
    ck('the Sales report has a by-item table', /id="rptByItem"/.test(out));
    ck('  fed from data.byType, which the server already returned',
       /\(data\.byType \|\| \[\]\)\.length/.test(out),
       'the figure existed and the page was throwing it away');
    ck('  with its own Loads column', /title="How many separate sales carried this item"/.test(out));
    ck('  and the per-buyer breakdown is still there', /rptByBuyer/.test(out));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('ABORT', e); process.exit(1); });
