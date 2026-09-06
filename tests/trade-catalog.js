// ── tests/trade-catalog.js ────────────────────────────────────────────────
// Apsara, 2026-09-07: "maintain a separate catalogue for edge metals. keep on
// appending to that new catalogue as i generate proforma and keep the
// existing workflow catalogue for yard."
//
// TWO VOCABULARIES, AND THE POINT IS THE SEPARATION
// -------------------------------------------------
// data/item_types.json is the yard's — "Auto cast", "Sealed units" — typed on
// a load ticket by someone standing at a scale with a phone. A proforma is
// read by a buyer's accounts department and says "Aluminium Auto Casting
// Scrap". Merging them means either the yard picking from a dropdown full of
// export phrasing, or export documents carrying scale-house shorthand — and
// I had already caused the second half of that, an hour before she asked for
// this, by printing her yard spelling on a customer's document.
//
// WHAT THIS FILE GUARDS, hardest first:
//   1. the yard list is never written to. That is the whole request, and the
//      damage is silent: a dropdown that slowly fills with words nobody at
//      the scale recognises.
//   2. the append happens on GENERATION, from both paths, through one hook
//   3. junk never enters, because an entry of "21" would poison every later
//      description match
//   4. day one still works — an empty trade catalogue must not undo the
//      "autocasting" fix she reported an hour earlier

const path = require('path');
const fs = require('fs');
const os = require('os');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');

// A REAL temp dir for every run. I seeded her live data/proforma_pricing.json
// while exploring the previous change and had to delete it; a test that
// writes to the live store is a test that edits her business records.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-trade-'));
process.env.DATA_DIR = dir;
const fresh = () => {
    for (const k of Object.keys(require.cache)) {
        if (/helpers\/(json|itemTypes|tradeCatalog|proformaDraft|proformaPricing)|config\.js$/.test(k)) {
            delete require.cache[k];
        }
    }
};
fresh();
const tc = require(path.join(ROOT, 'helpers/tradeCatalog.js'));
const it = require(path.join(ROOT, 'helpers/itemTypes.js'));
const pd = require(path.join(ROOT, 'helpers/proformaDraft.js'));

console.log('\n─ the selling catalogue ─────────────────────────────────────');

(async () => {

section('A — it starts empty, and day one still works');
{
    ck('the trade catalogue starts genuinely empty', tc.list().length === 0,
       JSON.stringify(tc.list()) + ' — no seed list, because seeding it with my '
       + 'guesses at export phrasing is the hardcoded-vocabulary mistake this week has been about');

    // THE REGRESSION THIS MUST NOT CAUSE. An hour before she asked for a
    // second catalogue, "send a proforma for autocasting" was failing because
    // nothing in the vocabulary matched. If recognition read ONLY the new
    // empty list, that bug comes straight back on the first day.
    ck('  but "autocasting" still resolves, from the yard list',
       pd.materialIn('21 MT of autocasting at 900') === 'Auto cast',
       'got ' + pd.materialIn('21 MT of autocasting at 900'));
}

section('B — it learns from a generated proforma, and only the trade list grows');
{
    const yardBefore = it.loadCustomItemTypes().slice();

    // The one hook: proformaPricing.recordFromGeneration, which is called
    // from the Documents page AND the WhatsApp/voice flow and nowhere else.
    const pp = require(path.join(ROOT, 'helpers/proformaPricing.js'));
    await pp.recordFromGeneration('Daekwang', 'CIF', 'Busan', [
        { desc: 'Aluminium Auto Casting Scrap', rate: 2100, unit: 'MT' },
        { desc: 'Aluminium Wheel Scrap (Troma)', rate: 2400, unit: 'MT' },
    ]);

    const after = tc.list();
    ck('both descriptions were learned',
       after.includes('Aluminium Auto Casting Scrap')
       && after.includes('Aluminium Wheel Scrap (Troma)'), JSON.stringify(after));

    // THE WHOLE REQUEST. Silent damage if it fails: the yard's dropdown
    // slowly fills with words nobody at the scale recognises.
    const yardAfter = it.loadCustomItemTypes();
    ck('  and the YARD list is untouched',
       JSON.stringify(yardAfter) === JSON.stringify(yardBefore),
       'yard list changed: ' + JSON.stringify(yardAfter));
    ck('  it does not contain the export phrasing',
       !yardAfter.some((y) => /Aluminium Auto Casting/i.test(y)),
       JSON.stringify(yardAfter));

    // ...and the reverse: the trade list has not swallowed the yard's.
    ck('  nor does the trade list copy the yard in',
       !tc.list().some((t) => t === 'Sealed units' || t === 'Ac compressor'),
       JSON.stringify(tc.list()) + ' — recognition READS both; only this one is written');
}

section('C — the hook is in ONE place, reached by both generation paths');
{
    // Two call sites would be two things to keep in step, and the one that
    // drifts is the one that stops learning without anyone noticing.
    const pricing = fs.readFileSync(path.join(ROOT, 'helpers/proformaPricing.js'), 'utf8');
    ck('recordFromGeneration appends to the catalogue',
       /require\('\.\/tradeCatalog'\)\.addMany/.test(pricing));
    ck('  non-fatally',
       /catch \(err\)[\s\S]{0,160}trade catalogue append failed/.test(pricing),
       'a catalogue that fails to learn a word is a smaller problem than a proforma that fails to send');

    // Both generators call it. Read from the source rather than remembered.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('  the WhatsApp/voice generator calls it',
       /recordFromGeneration\(/.test(acts));
    ck('  and so does the Documents page',
       /recordFromGeneration\(/.test(api));
    ck('  and neither appends to the catalogue itself',
       !/tradeCatalog/.test(acts.slice(acts.indexOf('async function generateProformaFromPending'))),
       'a second append site is a second set of rules to keep in step');
}

section('D — junk never gets in');
{
    // An entry of "21" would poison every later description match, and a
    // proforma line CAN carry an empty desc.
    for (const junk of ['', '   ', 'x', '21', '2,100.00', null, undefined]) {
        const before = tc.list().length;
        await tc.add(junk);
        ck(`"${junk === null ? 'null' : junk === undefined ? 'undefined' : junk}" is refused`,
           tc.list().length === before, JSON.stringify(tc.list()));
    }
    const before = tc.list().length;
    await tc.add('x'.repeat(200));
    ck('  and so is an essay', tc.list().length === before);

    // addMany filters the same way — it is the path the automatic hook uses,
    // so a filter that only existed on add() would be a filter that never ran.
    const b2 = tc.list().length;
    await tc.addMany(['', '21', null, 'Copper Millberry 99.9%']);
    ck('  addMany filters too, and keeps the real one',
       tc.list().length === b2 + 1 && tc.list().includes('Copper Millberry 99.9%'),
       JSON.stringify(tc.list()));
}

section('E — the same description twice is one entry');
{
    const before = tc.list().length;
    await tc.add('Aluminium Auto Casting Scrap');
    await tc.add('aluminium  auto  casting  scrap');
    await tc.add('ALUMINIUM AUTO CASTING SCRAP');
    ck('case and spacing do not create duplicates', tc.list().length === before,
       JSON.stringify(tc.list()));
    ck('  and the FIRST spelling is kept',
       tc.list().includes('Aluminium Auto Casting Scrap'),
       'that is the one already on a document somewhere');

    // THROUGH addMany, which is the path the automatic hook uses. Section E
    // only exercised add(), so a mutation deleting the dedup from addMany
    // survived — and that is the one that runs on every proforma. The same
    // grade sent to the same customer twice a week would have entered the
    // list twice a week for ever.
    const b3 = tc.list().length;
    await tc.addMany(['Aluminium Auto Casting Scrap', 'ALUMINIUM AUTO CASTING SCRAP']);
    ck('  and addMany dedups too, against the file AND within one call',
       tc.list().length === b3,
       JSON.stringify(tc.list()) + ' — this is the path every generated proforma takes');

    const b4 = tc.list().length;
    await tc.addMany(['Zorba 95/5', 'zorba 95/5']);
    ck('  including two spellings of a NEW entry in one proforma',
       tc.list().length === b4 + 1, JSON.stringify(tc.list()));
}

section('F — it is used for recognition, longest first');
{
    pd._clearMaterialCache();
    ck('a learned selling description is recognised',
       pd.materialIn('21 MT of Aluminium Wheel Scrap (Troma) at 2400')
           === 'Aluminium Wheel Scrap (Troma)',
       'got ' + pd.materialIn('21 MT of Aluminium Wheel Scrap (Troma) at 2400'));
    ck('  parentheses in an entry do not break the pattern',
       pd.catalogPattern('Aluminium Wheel Scrap (Troma)').test('of Aluminium Wheel Scrap (Troma) at'),
       'an unescaped ( compiles as a capture group');

    // The fuller export description must beat the yard shorthand, because
    // both lists are in play and the buyer's PO carries the long one.
    ck('  the export description beats the yard shorthand',
       pd.materialIn('21 MT of Aluminium Auto Casting Scrap at 2100')
           === 'Aluminium Auto Casting Scrap',
       'got ' + pd.materialIn('21 MT of Aluminium Auto Casting Scrap at 2100')
       + ' — "Auto cast" also matches that string, and the longer one has to win');
}

section('G — hers to tidy, never tidied automatically');
{
    await tc.add('Aluminum Auto Casting Scrapp');          // a typo that got sent
    ck('a typo can be renamed',
       (await tc.rename('Aluminum Auto Casting Scrapp', 'Aluminium Auto Casting Scrap II')).renamed === true);
    ck('  and removed', (await tc.remove('Aluminium Auto Casting Scrap II')).removed === true);
    ck('  and it is gone', !tc.list().includes('Aluminium Auto Casting Scrap II'));

    // Nothing in the automatic path deletes. A description that has been sent
    // to a customer is a fact about a document that exists.
    //
    // Asserted on BEHAVIOUR, not by grepping the source for "filter(" — which
    // is what I wrote first, and it failed against correct code because
    // addMany legitimately filters its own INPUT to reject junk. Filtering
    // what comes in and removing what is stored are opposite things that
    // share a word.
    const kept = tc.list().slice();
    await tc.addMany(['Brass Honey 99%', 'Copper Millberry 99.9%']);
    const now = tc.list();
    ck('  the append path never loses an existing entry',
       kept.every((k) => now.includes(k)),
       'lost: ' + JSON.stringify(kept.filter((k) => !now.includes(k))));
    ck('  and it only grows', now.length >= kept.length);
}

section('H — the yard staff cannot reach it');
{
    // /api/item-types IS staff-allowed, because the load form needs it at the
    // scale. The selling catalogue is not, and the prefix list is the only
    // thing enforcing that.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const line = /const STAFF_ALLOWED_PATH_PREFIXES = \[([^\]]+)\]/.exec(api);
    ck('the staff allow-list was found', !!line);
    ck('  /api/item-types is on it', /\/api\/item-types/.test(line[1]),
       'the yard load form needs it');
    ck('  and /api/trade-catalog is NOT',
       !/trade-catalog/.test(line[1]),
       'selling descriptions are not yard-staff business');
    ck('  the route exists to be blocked', /'\/api\/trade-catalog'/.test(api));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})();
