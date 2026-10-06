// ── tests/duplicate-invoices.js ───────────────────────────────────────────
// From her nightly sweep, 2026-10-06:
//   SELU4226126 — 2 invoices
//   TLLU2110739 — 3 invoices
//
// Double-counted revenue overstates profit exactly the way missing cost
// does, and on a return that is tax paid on money she never earned.
//
// ── THE TRAP THIS FILE EXISTS TO AVOID ───────────────────────────────────
// sales.json holds ONE ROW PER ITEM. A container of three grades is three
// rows and always has been. A tool that cried "duplicate" at every
// multi-grade container would be deleted within a week, and she would be
// right to delete it.
//
// What separates them is in her own data: sales.js:403 builds an id as
// `SALE_${Date.now()}_${random}`, so rows saved in ONE operation share the
// millisecond exactly. Her two cases decode as:
//   TLLU2110739  all three at 2026-09-21T11:31:47.253Z   — one save
//   SELU4226126  28 Sep 18:44 and 30 Sep 06:15           — 36 hours apart
//
// So section A is the false-positive test, and it matters more than the
// true-positive one.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dupinv-'));
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/duplicate-invoices.js');

// Her two real containers, with the real ids and timestamps from the sweep.
const ONE_SAVE = 1789990307253;        // 2026-09-21T11:31:47.253Z
const SAVE_A = 1790621049574;          // 2026-09-28T18:44:09.574Z
const SAVE_B = 1790748930629;          // 2026-09-30T06:15:30.629Z

const row = (id, container, item, weight, price, customer = 'Someone') => ({
    id, container_no: container, customer, date: '2026-09-21',
    item, weight, weight_unit: 'lb', invoice_price: price, price_unit: 'lb',
});

function run(sales, args = []) {
    fs.writeFileSync(path.join(TMP, 'sales.json'), JSON.stringify(sales, null, 2));
    try {
        const out = execFileSync(process.execPath, [SCRIPT, ...args], {
            env: { ...process.env, DATA_DIR: TMP, JARVIS_TEST: '1' }, encoding: 'utf8',
        });
        return { out, code: 0 };
    } catch (e) {
        return { out: String(e.stdout || ''), code: e.status === undefined ? -1 : e.status };
    }
}

// ── A — A MULTI-ITEM INVOICE IS NOT A DUPLICATE ───────────────────────────
// The false positive is the one that gets a tool thrown away.
{
    section('A — three grades in one container is normal');

    const r = run([
        row(`SALE_${ONE_SAVE}_t6oik`, 'TLLU2110739', 'Alternator', 10000, 1.2, 'Tiyansh Metal'),
        row(`SALE_${ONE_SAVE}_r6l8w`, 'TLLU2110739', 'Starter', 8000, 1.1, 'Tiyansh Metal'),
        row(`SALE_${ONE_SAVE}_kx1mv`, 'TLLU2110739', 'AC Compressor', 6000, 1.3, 'Tiyansh Metal'),
    ]);
    ck('her real 3-invoice container is NOT flagged',
       !/TLLU2110739\s+—/.test(r.out), r.out.slice(0, 400));
    ck('  it is counted as ordinary', /1 ordinary|ordinary/.test(r.out), r.out.slice(0, 200));
    ck('  and the run exits clean', r.code === 0, String(r.code));
    ck('  saying nothing needed looking at',
       /entered in one go|0 worth a look/.test(r.out), r.out.slice(0, 300));
}

// ── B — TWO SAVES, DAYS APART, IS WORTH A LOOK ────────────────────────────
{
    section('B — the same container invoiced twice');

    const r = run([
        row(`SALE_${SAVE_A}_wu3a1`, 'SELU4226126', 'Aluminium', 40000, 1.05, 'Auto Casting Tense'),
        row(`SALE_${SAVE_B}_boe7z`, 'SELU4226126', 'Aluminium', 40000, 1.05, 'Auto Casting Tense'),
    ]);
    ck('her real 2-invoice container IS flagged', /SELU4226126/.test(r.out), r.out.slice(0, 400));
    ck('  it says they were separate saves',
       /2 separate saves/.test(r.out), r.out.slice(0, 400));
    ck('  and how far apart, in hours',
       /35\.5 hours apart/.test(r.out), 'the gap is the evidence, so it has to be stated');
    ck('  it notices the rows are identical in item, weight and price',
       /IDENTICAL in item, weight and price/.test(r.out), r.out.slice(0, 500));
    ck('  and quantifies what income would be overstated by',
       /income is overstated by \$42,000\.00/.test(r.out),
       'a container-level figure is what makes this actionable');
    ck('  exiting non-zero so it can be wired into a check later', r.code === 1, String(r.code));

    // Oldest first — the original save is the one she is likeliest keeping.
    const iA = r.out.indexOf('2026-09-28');
    const iB = r.out.indexOf('2026-09-30');
    ck('  the saves read oldest first', iA > -1 && iB > -1 && iA < iB, `${iA} vs ${iB}`);
}

// ── C — SEPARATE SAVES THAT ARE GENUINELY DIFFERENT ITEMS ─────────────────
// Two grades invoiced on different days is a part shipment, not a
// duplicate. It is still shown — she asked for things worth a look, not
// only things that are certainly wrong — but it must NOT claim they are
// identical.
{
    section('C — different items, entered on different days');

    const r = run([
        row(`SALE_${SAVE_A}_aaaa1`, 'MIXED1', 'Copper', 10000, 3.0),
        row(`SALE_${SAVE_B}_bbbb2`, 'MIXED1', 'Brass', 5000, 2.1),
    ]);
    ck('it is shown, because two saves is worth a look', /MIXED1/.test(r.out), r.out.slice(0, 300));
    ck('  but it does NOT call them identical',
       !/IDENTICAL/.test(r.out), 'different grades on different days is a part shipment');
    ck('  and both items are listed so she can see that',
       /Copper/.test(r.out) && /Brass/.test(r.out), r.out.slice(0, 500));
}

// ── D — IDENTICAL ROWS IN ONE SAVE ────────────────────────────────────────
// The same grade twice in a single save is a slip of the hand, and the
// timestamp cannot catch it because there is only one timestamp.
{
    section('D — the same grade twice in one save');

    const r = run([
        row(`SALE_${ONE_SAVE}_dup11`, 'SAMESAVE', 'Copper', 10000, 3.0),
        row(`SALE_${ONE_SAVE}_dup22`, 'SAMESAVE', 'Copper', 10000, 3.0),
    ]);
    ck('identical rows are caught even in a single save',
       /SAMESAVE/.test(r.out) && /IDENTICAL/.test(r.out), r.out.slice(0, 400));
    ck('  and it does not claim they were separate saves',
       !/separate saves/.test(r.out), r.out.slice(0, 400));
}

// ── E — IT CHANGES NOTHING ────────────────────────────────────────────────
{
    section('E — read-only, and says so');

    const before = fs.readFileSync(path.join(TMP, 'sales.json'), 'utf8');
    run(JSON.parse(before));
    ck('the store is untouched', fs.readFileSync(path.join(TMP, 'sales.json'), 'utf8') === before);

    const src = fs.readFileSync(SCRIPT, 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    ck('  it has no way to delete anything',
       !/deleteSale|mutateJson|writeFile|editSale/.test(code),
       'a script that quietly deleted revenue would be the worst thing in this repo');
    const r = run(JSON.parse(before));
    ck('  and it tells her where deleting actually happens',
       /Documents screen/.test(r.out), r.out.slice(-300));
}

// ── F — IT DOES NOT FALL OVER ─────────────────────────────────────────────
{
    section('F — rows that are not the usual shape');

    // An imported row with no SALE_ id must not be grouped with other
    // unknown-id rows into one false batch.
    const r = run([
        row('IMPORTED-1', 'ODDONE', 'Copper', 1000, 2),
        row('IMPORTED-2', 'ODDONE', 'Copper', 1000, 2),
    ]);
    ck('rows with no timestamp in the id do not crash it', r.code === 0 || r.code === 1, String(r.code));
    ck('  and identical ones are still caught on their own merits',
       /IDENTICAL/.test(r.out), r.out.slice(0, 400));

    // ── AND IT MUST NOT CLAIM TO KNOW WHEN THEY WERE ENTERED ─────────────
    // An earlier version gave every undated row its own batch and then
    // announced "entered in 2 separate saves, 0 hours apart" — a false
    // claim, not a cautious one. The timing is the evidence this whole tool
    // rests on; evidence we do not have must not be asserted.
    ck('  it does NOT claim they were separate saves',
       !/separate saves/.test(r.out),
       'an id with no timestamp says nothing about when the row was entered');
    ck('  and says plainly that it cannot tell',
       /cannot be told from here/.test(r.out), r.out.slice(0, 500));

    // Two undated rows that are NOT identical have nothing against them at
    // all, and must not be flagged on timing alone.
    const differing = run([
        row('IMPORTED-3', 'ODDTWO', 'Copper', 1000, 2),
        row('IMPORTED-4', 'ODDTWO', 'Brass', 2000, 3),
    ]);
    ck('  two undated rows with different items are not flagged',
       !/ODDTWO/.test(differing.out) && differing.code === 0, differing.out.slice(0, 300));

    const empty = run([]);
    ck('an empty store is fine', empty.code === 0, String(empty.code));
    const noContainer = run([{ id: `SALE_${ONE_SAVE}_x`, customer: 'X', item: 'Copper' }]);
    ck('  and a row with no container is skipped rather than grouped',
       noContainer.code === 0, noContainer.out.slice(0, 200));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
