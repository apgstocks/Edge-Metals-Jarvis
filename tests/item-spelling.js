// ── tests/item-spelling.js ────────────────────────────────────────────────
// Apsara, 2026-09-16: "also in item description-say if i saved description say
// HMS and when i type ike hms in small,it i considering that as a new item."
//
// And, later the same day, asking what had actually become of it. Fair
// question: helpers/itemSpelling.js was written and wired into both load
// writers, and then NOT TESTED. A unit check on canonicalSpelling() is not a
// check that typing "hms" into a load stores "HMS", and the gap between those
// two is where this kind of fix quietly fails.
//
// ── WHAT IS AND IS NOT CLAIMED ──────────────────────────────────────────────
// CASE ONLY. "Al 6061" and "Al 6063" differ by one character and are different
// alloys worth different money; nothing here may join them. Section C spends as
// much effort on what must NOT merge as the rest does on what must.
//
// FORWARD ONLY. A load saved before this existed keeps the spelling it was
// saved with. Section D states that plainly as a test rather than leaving it to
// be discovered — the totals were always right, but an old row still shows its
// old spelling on its own card and its own PDF.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-spelling-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const spelling = require(path.join(ROOT, 'helpers/itemSpelling'));
const itemTypes = require(path.join(ROOT, 'helpers/itemTypes'));
const loads = require(path.join(ROOT, 'helpers/loads'));
const outbound = require(path.join(ROOT, 'helpers/outboundLoads'));

const descsIn = (rows) => [...new Set(rows.flatMap((l) => (l.items || []).map((i) => i.description)))];

(async () => {

await itemTypes.addCustomItemType('HMS');
await itemTypes.addCustomItemType('Al combo');

// ══════════════════════════════════════════════════════════════════════════
section('A — her exact case, end to end');
// ══════════════════════════════════════════════════════════════════════════
{
    // NOT a unit test of canonicalSpelling. This saves a real load through the
    // real writer and reads back what landed on disk, because that is the
    // thing she was describing and the only thing that settles it.
    await loads.addLoad({
        date: '2026-09-16', seller: 'Ramesh', weight_unit: 'lb',
        items: [{ description: 'hms', gross_weight: 1000, tare_weight: 0, price: 0.11 }],
    });
    ck('typing "hms" on a purchase stores "HMS"',
       descsIn(loads.loadLoads()).includes('HMS'), JSON.stringify(descsIn(loads.loadLoads())));
    ck('  and does not store "hms"',
       !descsIn(loads.loadLoads()).includes('hms'), JSON.stringify(descsIn(loads.loadLoads())));

    // Sales too. The fix is wired into both writers, and a fix on one side
    // only would make the two halves of the yard disagree about a name.
    await outbound.addOutboundLoad({
        date: '2026-09-16', buyer: 'Eccomelt', weight_unit: 'lb',
        items: [{ description: 'HmS', gross_weight: 400, tare_weight: 0, price: 0.2 }],
    });
    ck('typing "HmS" on a SALE stores "HMS" too',
       descsIn(outbound.loadOutboundLoads()).includes('HMS'),
       JSON.stringify(descsIn(outbound.loadOutboundLoads())));

    // Whitespace on either side must not defeat the match — a stored type with
    // a trailing space would otherwise never match anything she types, and the
    // mismatch would look exactly like this fix not working.
    ck('  and "  hms  " matches too',
       spelling.canonicalSpelling('  hms  ', ['HMS ']) === 'HMS');

    // It does NOT become a second catalogue entry.
    ck('the catalogue still holds one HMS',
       itemTypes.loadCustomItemTypes().filter((d) => /^hms$/i.test(d)).length === 1,
       JSON.stringify(itemTypes.loadCustomItemTypes()));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — and the figures were never wrong');
// ══════════════════════════════════════════════════════════════════════════
{
    // Worth pinning, because it is the part that was ALREADY right and could
    // be broken by a careless change to any of the three readers.
    // groupItemsByDescription keys on lowercase, so this held even when the
    // stored spellings differed. What was wrong was what she SAW, not the maths.
    const inv = loads.getInventoryReport(loads.loadLoads(), {});
    const rows = (inv.byType || []).filter((g) => /^hms$/i.test(g.description));
    ck('one HMS row, not two', rows.length === 1,
       JSON.stringify((inv.byType || []).map((g) => g.description)));
    ck('  carrying the whole 1000', rows[0] && rows[0].net === 1000, JSON.stringify(rows[0]));

    // The stock guard folds case too, so a sale typed in the wrong case is not
    // refused for a shortage that does not exist.
    const guard = require(path.join(ROOT, 'helpers/stockGuard'));
    ck('the stock guard sees the stock however it is typed',
       guard.shortfalls([{ description: 'hms', gross_weight: 100, tare_weight: 0 }]).length === 0,
       'a shortfall here would block a sale over capitalisation');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — what must NOT merge');
// ══════════════════════════════════════════════════════════════════════════
{
    // The dangerous version of this feature. A resemblance test in
    // itemSpelling would silently join two alloys and put a wrong number on a
    // report — which is why the alias flow (helpers/itemAliases.js) exists and
    // asks HER instead.
    await itemTypes.addCustomItemType('Al 6061');
    ck('"Al 6063" is not pulled onto "Al 6061"',
       spelling.canonicalSpelling('Al 6063', ['Al 6061']) === 'Al 6063',
       'one character apart, different alloys, different money');
    ck('"Aluminium combo" is not pulled onto "Al combo"',
       spelling.canonicalSpelling('Aluminium combo', ['Al combo']) === 'Aluminium combo',
       'that is a question for her, and helpers/itemAliases.js is where it gets asked');
    ck('a genuinely new material is kept exactly as typed',
       spelling.canonicalSpelling('Zorba', ['HMS', 'Al combo']) === 'Zorba');
    ck('  including its capitalisation',
       spelling.canonicalSpelling('zorba', ['HMS']) === 'zorba',
       'nothing on file to match, so nothing to correct to — inventing one would be a guess');

    // Blank stays blank. A default here would file an unnamed line under a
    // real material.
    ck('blank stays blank', spelling.canonicalSpelling('', ['HMS']) === '');
    ck('  and null does not become a string', spelling.canonicalSpelling(null, ['HMS']) === '');
}

// ══════════════════════════════════════════════════════════════════════════
section('D — it is FORWARD ONLY, and that is worth saying out loud');
// ══════════════════════════════════════════════════════════════════════════
{
    // A load written before this existed keeps the spelling it was written
    // with. Nothing rewrites her history, and nothing should without her
    // asking — but the consequence has to be visible somewhere other than in
    // my own head.
    const old = loads.loadLoads();
    fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify(old.concat([{
        id: 'OLD_1', date: '2026-08-01', seller: 'Ramesh', weight_unit: 'lb',
        net_weight: 500, amount: 55,
        items: [{ description: 'hms', gross_weight: 500, tare_weight: 0, net_weight: 500, price: 0.11, amount: 55 }],
    }])));

    ck('an old row still carries its old spelling',
       descsIn(loads.loadLoads()).includes('hms'),
       JSON.stringify(descsIn(loads.loadLoads())) + ' — forward only, by design; nothing rewrites her history');

    // But it still does not double-count, and it still does not produce two
    // entries anywhere she picks a material from. That is the difference
    // between an untidy record and a wrong one.
    const inv = loads.getInventoryReport(loads.loadLoads(), {});
    const rows = (inv.byType || []).filter((g) => /^hms$/i.test(g.description));
    ck('  but the report still shows ONE HMS', rows.length === 1,
       JSON.stringify((inv.byType || []).map((g) => g.description)));
    ck('  totalling both loads', rows[0] && rows[0].net === 1500, JSON.stringify(rows[0]));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — fail soft');
// ══════════════════════════════════════════════════════════════════════════
{
    // If the catalogue cannot be read, the description is stored exactly as
    // typed — the OLD behaviour, merely untidy. Refusing to save a load
    // because a spelling list is unreadable would be far worse than a name in
    // the wrong case.
    ck('no catalogue means no correction, not a crash',
       spelling.canonicalSpelling('hms', null) === 'hms');
    ck('  and an empty one behaves the same',
       spelling.canonicalSpelling('hms', []) === 'hms');
    ck('  a malformed catalogue entry is skipped rather than thrown on',
       spelling.canonicalSpelling('hms', [null, undefined, { x: 1 }, 'HMS']) === 'HMS',
       'one bad row in item_types.json must not cost her the whole feature');

    // knownSpellings() is the convenience wrapper the writers use. It must
    // never throw — it sits inside a mutateJson mutator.
    ck('knownSpellings always returns a list', Array.isArray(spelling.knownSpellings()));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
