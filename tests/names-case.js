// ── tests/names-case.js ───────────────────────────────────────────────────
// Apsara, 2026-09-16: "Sellers name/bUyers name-make it case insensitive".
//
// Three separate jobs hide in that one sentence, and running them together is
// how this sort of fix half-lands:
//
//   GROUPING   "Ramesh" and "ramesh" are one seller, so the per-seller totals
//              are ONE row. Needs no change to stored data.
//   DISPLAY    Having grouped them, the row still needs a name — and the
//              lower-cased key is the wrong one. Labelling a group with its
//              key is exactly what put "al combo" beside "Al combo" on this
//              same screen the day before.
//   STORAGE    The load records still hold whatever was typed, so two tickets
//              for the same man print two spellings. Grouping a report does
//              not fix a piece of paper.
//
// All three are asserted here. The third is the one that would be quietly
// skipped, because the screen looks right once the first two are done.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_TEST = '1';

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-names-'));
const cfg = require('../config');
cfg.LOADS_FILE = path.join(TMP, 'loads.json');
cfg.OUTBOUND_LOADS_FILE = path.join(TMP, 'outbound_loads.json');
fs.writeFileSync(cfg.LOADS_FILE, '[]');
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');

const { canonicalName, groupByName, normalizeName } = require('../helpers/canonicalName');
const loads = require('../helpers/loads');
const outbound = require('../helpers/outboundLoads');

(async () => {

section('A — which spelling wins, and why');
{
    // Most-used wins. NOT the oldest — one early all-caps typo would then
    // brand a supplier for ever; NOT the newest — the name would flap about
    // with every entry. Frequency is closest to what she actually uses, and
    // it self-heals: correct it a few times and the correction takes over.
    const names = ['Ramesh', 'ramesh', 'RAMESH', 'Ramesh'];
    ck('the spelling used most often wins', canonicalName(names, 'ramesh') === 'Ramesh',
       canonicalName(names, 'ramesh'));
    ck('  and typing it in any case gets that same spelling',
       canonicalName(names, 'RaMeSh') === 'Ramesh' && canonicalName(names, '  ramesh  ') === 'Ramesh');

    // Punctuation and spacing too — a name differing only by a full stop is
    // the same complaint one keystroke over.
    ck('  spacing and punctuation are ignored when matching',
       canonicalName(['M K Metal', 'M K Metal', 'MK Metal'], 'mkmetal') === 'M K Metal',
       canonicalName(['M K Metal', 'M K Metal', 'MK Metal'], 'mkmetal'));

    // ── NOTHING IS INVENTED ──────────────────────────────────────────────
    // The tempting version of this feature title-cases names on the way in.
    // It is wrong: "MK Metal Trading", "d.c. scrap" and "JB's" are real, and
    // a rule that rewrites them is a rule that gets fought every day.
    ck('a NEW name is stored exactly as typed, not title-cased',
       canonicalName(['Ramesh'], 'd.c. scrap') === 'd.c. scrap',
       canonicalName(['Ramesh'], 'd.c. scrap'));
    ck('  and an established lowercase name stays lowercase',
       canonicalName(['jb metals', 'jb metals'], 'JB Metals') === 'jb metals',
       'her spelling wins even when it is the unconventional one');
    ck('  a blank name comes back blank', canonicalName(['Ramesh'], '') === ''
       && canonicalName(['Ramesh'], null) === '');
    ck('  and a punctuation-only name is left alone', canonicalName(['Ramesh'], '...') === '...',
       'it normalises to nothing, so it can match nothing');
}

section('B — grouping, and what the row is called');
{
    const rows = [
        { seller: 'Ramesh' }, { seller: 'ramesh' }, { seller: 'RAMESH' }, { seller: 'Ramesh' },
        { seller: 'M K Metal' }, { seller: 'MK Metal' },
        { seller: '' },
    ];
    const g = groupByName(rows, (r) => r.seller, 'Unknown seller');
    ck('four spellings of one seller make one group', g.size === 3,
       [...g.values()].map((x) => `${x.label}×${x.rows.length}`).join(' | '));
    const ramesh = [...g.values()].find((x) => normalizeName(x.label) === 'ramesh');
    ck('  holding all four rows', ramesh && ramesh.rows.length === 4);
    ck('  labelled with her spelling, NOT the lower-cased key',
       ramesh && ramesh.label === 'Ramesh',
       `label was ${JSON.stringify(ramesh && ramesh.label)}`);
    // A blank name is its own bucket. Merging it into whatever sorts first
    // would file unnamed loads under a real supplier.
    const blank = [...g.values()].find((x) => x.label === 'Unknown seller');
    ck('  and a blank name keeps its own row', blank && blank.rows.length === 1);
}

section('C — the per-seller report on real records');
{
    fs.writeFileSync(cfg.LOADS_FILE, '[]');
    const mk = (seller, n) => ({
        date: '2026-09-14', seller, buyer: 'Edge Trading', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: n, tare_weight: 0, price: 1 }],
    });
    await loads.addLoad(mk('Ramesh', 100));
    await loads.addLoad(mk('ramesh', 200));
    await loads.addLoad(mk('RAMESH', 300));

    const rep = loads.getInventoryReport(loads.loadLoads(), {});
    const sellers = rep.bySeller || [];
    ck('three loads from one man are ONE row', sellers.length === 1,
       sellers.map((s) => `${s.seller} (${s.loadCount})`).join(' | '));

    // ── THE ROW THAT ALMOST VANISHED ─────────────────────────────────────
    // The grouping helper and the two report loops each carry the sentinel
    // used for a nameless row. They were briefly out of step — the helper
    // filed blanks under one key and the loop looked up another — and the
    // effect was not an error but a SILENT DROP: the load disappeared from
    // the report entirely. Every seller in this fixture had a name, so
    // nothing noticed.
    //
    // A load that vanishes from a report is the worst failure this file can
    // miss, so the fixture now contains one.
    ck('  and the totals still add up', sellers[0] && sellers[0].net === 600,
       'this is the number the split rows were hiding');
    ck('  with all three loads counted', sellers[0] && sellers[0].loadCount === 3,
       JSON.stringify(sellers[0] && { seller: sellers[0].seller, loadCount: sellers[0].loadCount, net: sellers[0].net }));
}

section('C2 — a load with no seller still appears');
{
    fs.writeFileSync(cfg.LOADS_FILE, '[]');
    const mk = (seller, n) => ({
        date: '2026-09-14', seller, buyer: 'Edge Trading', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: n, tare_weight: 0, price: 1 }],
    });
    await loads.addLoad(mk('Ramesh', 100));
    // validateLoadForSave requires a seller, so a nameless load cannot be
    // created through addLoad — it is written straight to the store, which is
    // how the old ones with a blank seller got there in the first place.
    const raw = JSON.parse(fs.readFileSync(cfg.LOADS_FILE, 'utf8'));
    raw.unshift({ id: 'EDGE_99', date: '2026-09-14', seller: '', buyer: 'Edge Trading',
                  net_weight: 50, amount: 50, weight_unit: 'lb',
                  items: [{ description: 'Al combo', gross_weight: 50, tare_weight: 0, net_weight: 50, price: 1, amount: 50 }] });
    fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify(raw));

    const sellers = loads.getInventoryReport(loads.loadLoads(), {}).bySeller || [];
    ck('a nameless load is not silently dropped from the report', sellers.length === 2,
       sellers.map((s) => `${s.seller} (${s.loadCount})`).join(' | ') +
       ' — the grouping helper and the report loop must agree on the blank sentinel');
    const unknown = sellers.find((s) => s.seller === 'Unknown seller');
    ck('  it gets its own row, under the caller\'s label', !!unknown && unknown.loadCount === 1,
       sellers.map((s) => s.seller).join(' | '));
    ck('  and it is NOT merged into a real supplier',
       sellers.find((s) => s.seller === 'Ramesh')
       && sellers.find((s) => s.seller === 'Ramesh').loadCount === 1,
       'filing unnamed loads under whoever sorts first would be worse than dropping them');
}

section('D — the stored record, which is what gets printed');
{
    fs.writeFileSync(cfg.LOADS_FILE, '[]');
    const mk = (seller) => ({
        date: '2026-09-14', seller, buyer: 'Edge Trading', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 100, tare_weight: 0, price: 1 }],
    });
    const first = await loads.addLoad(mk('Ramesh'));
    ck('the first load keeps the name exactly as typed', first.seller === 'Ramesh');
    const second = await loads.addLoad(mk('ramesh'));
    // THE POINT. Without this the ticket for the second load prints
    // "ramesh" and the one for the first prints "Ramesh", for one man.
    ck('  a later load typed in another case is STORED with her spelling',
       second.seller === 'Ramesh', `stored ${JSON.stringify(second.seller)}`);
    const third = await loads.addLoad(mk('  RAMESH  '));
    ck('  regardless of case or surrounding spaces', third.seller === 'Ramesh',
       JSON.stringify(third.seller));
    const fresh = await loads.addLoad(mk('Brand New Yard'));
    ck('  while a name never seen before is stored as typed',
       fresh.seller === 'Brand New Yard', JSON.stringify(fresh.seller));
}

section('E — buyers get the same treatment, not just sellers');
{
    // She named both. These two reports were the same code with one word
    // changed, which is exactly the shape where a fix lands on one of them
    // and the other quietly keeps the bug.
    fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, '[]');
    const mk = (buyer, n) => ({
        date: '2026-09-14', buyer, weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: n, tare_weight: 0, price: 1 }],
    });
    const a = await outbound.addOutboundLoad(mk('Eccomelt', 100));
    const b = await outbound.addOutboundLoad(mk('eccomelt', 200));
    ck('a buyer typed in another case is stored with her spelling',
       a.buyer === 'Eccomelt' && b.buyer === 'Eccomelt',
       `${a.buyer} / ${b.buyer}`);

    const rep = outbound.getOutboundReport(outbound.loadOutboundLoads(), {});
    const buyers = rep.byBuyer || [];
    ck('  and the per-buyer report shows one row', buyers.length === 1,
       buyers.map((x) => `${x.buyer} (${x.loadCount})`).join(' | '));
    ck('  labelled with her spelling', buyers[0] && buyers[0].buyer === 'Eccomelt',
       JSON.stringify(buyers[0] && buyers[0].buyer));
    ck('  with both loads counted', buyers[0] && buyers[0].loadCount === 2);
}

section('F — one implementation, not two that drift');
{
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const f of ['helpers/loads.js', 'helpers/outboundLoads.js']) {
        ck(`${f} groups through the shared helper`,
           /require\('\.\/canonicalName'\)/.test(src(f)),
           'the seller and buyer reports were identical code with one word changed — ' +
           'fixing one of them only is how half a bug survives');
    }
    // The old raw-name keys must be gone, or the shared helper is decoration.
    ck('no report still keys on the raw typed name',
       !/const key = \(l\.seller && String\(l\.seller\)\.trim\(\)\)/.test(src('helpers/loads.js'))
       && !/const key = \(l\.buyer && String\(l\.buyer\)\.trim\(\)\)/.test(src('helpers/outboundLoads.js')));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
