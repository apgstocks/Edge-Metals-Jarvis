// ── tests/bank-payee.js ───────────────────────────────────────────────────
// Apsara, 2026-11-05, on a deposit Jarvis could not place:
//   "why my jarvis was not able to identify that?"
//   "Jarvis should able to identify everytgibg"
//   "Thats the edge we have over intutit quickbooks"
//   "IF it find any difficulty,it should have asked for my help rather than
//    neglecting or sitting dle"
//
// The line was hers, and real:
//
//   ARIS ENTERPRISES DES:ACH Pmt ID:XXXXX620487 INDN:Edge Metal Inc.
//   CO ID:XXXXX02235 CCD PMT INFO:Balance payment for Inv 261009_AP_26ARIS 03
//   on our PO 2026-641
//
// ── WHAT THIS FILE IS DEFENDING ──────────────────────────────────────────
// Three properties, and the third is the one that was quietly false:
//   A. the company name is read out of the bank's own field markers;
//   B. an unreadable line says so and gets ASKED, never guessed;
//   C. naming a company once holds for the NEXT payment, which carries a
//      different payment id. The screen promised that and did not do it.
//
// helpers/nameMatch.js refuses near-miss matching and is right to. Nothing
// here weakens that: parsing decides WHICH CHARACTERS are the name, and the
// existing exact rules still decide who that is.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const { payeeOf } = require(path.join(ROOT, 'helpers/bankPayee'));
const bankLearn = require(path.join(ROOT, 'helpers/bankLearn'));
const bankMatch = require(path.join(ROOT, 'helpers/bankMatch'));

const HERS = 'ARIS ENTERPRISES DES:ACH Pmt ID:XXXXX620487 INDN:Edge Metal Inc. '
    + 'CO ID:XXXXX02235 CCD PMT INFO:Balance payment for Inv 261009_AP_26ARIS 03 on our PO 2026-641';
// The same company, next month: a new payment id and a new PO.
const NEXT = HERS.replace('620487', '991122').replace('2026-641', '2026-999');

(() => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the name, out of the bank\'s own markers');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('her line reads as ARIS ENTERPRISES', payeeOf(HERS) === 'ARIS ENTERPRISES', JSON.stringify(payeeOf(HERS)));

    // Both real shapes. The first version of this parser assumed only one
    // and got four of nine formats wrong.
    const shapes = [
        ['name before the markers',
         'DEPOSIT ACH CREDIT TAEWON METALS CO LTD DES:WIRE ID:998877', 'TAEWON METALS CO LTD'],
        ['name after a label, late in the line',
         'WIRE TYPE:WIRE IN DATE:261104 TIME:0932 ET TRN:2026110400123 ORIG:INESH CORES CHAPIN', 'INESH CORES CHAPIN'],
        ['name after a label, early',
         'ORIG CO NAME:NUR METAL ORIG ID:1234567890 DESC DATE:261102', 'NUR METAL'],
        ['a plain name with nothing around it', 'Edge Scrap LLC', 'Edge Scrap LLC'],
        ['a reference phrase trailing a name',
         'PAYMENT FROM MODERN ENTERPRISES FOR INV 26ME07', 'MODERN ENTERPRISES'],
    ];
    for (const [what, line, want] of shapes) {
        ck(`  ${what}`, payeeOf(line) === want, `${JSON.stringify(payeeOf(line))} — wanted ${JSON.stringify(want)}`);
    }

    // INDN: on a deposit is the RECEIVER — Edge Metals itself. Reading it
    // would name every incoming payment after her own company.
    ck('  INDN: is never mistaken for the payer',
       payeeOf(HERS) !== 'Edge Metal Inc.' && !/edge/i.test(payeeOf(HERS)), payeeOf(HERS));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — when it cannot read one, it says so');
// ══════════════════════════════════════════════════════════════════════════
// "IF it find any difficulty,it should have asked for my help rather than
// neglecting". An honest '' is the ask. A half-parsed token is not.
{
    for (const [what, line] of [
        ['a bank fee is not a company', 'SERVICE CHARGE'],
        ['nor is an ATM withdrawal', 'ATM WITHDRAWAL 11/05'],
        ['a bare reference number', '#4455667788'],
        ['an empty line', '   '],
    ]) {
        ck(what, payeeOf(line) === '', JSON.stringify(payeeOf(line)));
    }
    // A colon surviving the strip means the format was not understood.
    // Handing that to an exact matcher is the near-miss nameMatch.js exists
    // to prevent, so it refuses instead.
    ck('a format it does not understand returns nothing, not a fragment',
       payeeOf('ZZPROTO:QQ:1234 WEIRD:FORMAT') === '', JSON.stringify(payeeOf('ZZPROTO:QQ:1234 WEIRD:FORMAT')));
}

// ══════════════════════════════════════════════════════════════════════════
section('C — her line resolves with NO alias, and keeps resolving');
// ══════════════════════════════════════════════════════════════════════════
{
    const customers = ['Aris Enterprises', 'Taewon', 'Inesh Cores Chapin'];
    const resolve = bankLearn.resolverFrom([], customers);

    ck('the deposit she showed me now resolves, with nothing learned',
       resolve(HERS) === 'Aris Enterprises', JSON.stringify(resolve(HERS)));
    // THE ONE THAT WAS FALSE. The alias used to be keyed on the whole line,
    // so a new payment id missed and she would have named ARIS forever.
    ck("  and next month's payment, with a new id and PO, resolves too",
       resolve(NEXT) === 'Aris Enterprises', JSON.stringify(resolve(NEXT)));

    ck('a company that is NOT in the ledger still asks',
       resolve('ZZZ TRADING LLC DES:ACH ID:1') === null, JSON.stringify(resolve('ZZZ TRADING LLC DES:ACH ID:1')));
    ck('a bank fee is never named as a customer',
       resolve('SERVICE CHARGE') === null, JSON.stringify(resolve('SERVICE CHARGE')));

    // Every alias she has already created was keyed on a full line. Those
    // must keep working or this change costs her the learning she has done.
    const { normalizeName } = require(path.join(ROOT, 'helpers/nameMatch'));
    const old = bankLearn.resolverFrom([{ key: normalizeName(HERS), customer: 'Aris Enterprises' }], []);
    ck('an alias she created the OLD way still works', old(HERS) === 'Aris Enterprises', JSON.stringify(old(HERS)));
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the ask carries what Jarvis already worked out');
// ══════════════════════════════════════════════════════════════════════════
// suggestParty had the answer all along and nothing put it on screen. She
// was shown 160 characters of machine noise and a promise that was false.
{
    const sugg = (d) => bankLearn.suggestParty(d, ['Aris Enterprises']);
    const r = bankMatch.matchDeposit({ descriptor: HERS, amount: 8968.80 }, [],
        { resolveParty: () => null, suggestParty: sugg, payeeOf });

    ck('it says the NAME it read, not the whole bank line',
       r.read_as === 'ARIS ENTERPRISES' && !/Pmt ID/.test(r.note), r.note);
    ck('  and offers the company it already identified',
       /looks like Aris Enterprises/.test(r.note), r.note);
    ck('  with the reason it thinks so', /name found in the bank description/.test(r.note), r.note);
    ck('  and the suggestion rides on the result, not just the sentence',
       Array.isArray(r.suggestions) && r.suggestions.length === 1
       && r.suggestions[0].customer === 'Aris Enterprises', JSON.stringify(r.suggestions));

    // Two near-equal candidates must NOT be resolved to either.
    const two = bankMatch.matchDeposit({ descriptor: HERS, amount: 100 }, [],
        { resolveParty: () => null, payeeOf,
          suggestParty: () => [{ customer: 'Aris Enterprises', basis: 'x' }, { customer: 'Aris Enterprise LLC', basis: 'x' }] });
    ck('two candidates are offered, never chosen between',
       /too close to call/.test(two.note) && two.suggestions.length === 2, two.note);

    // A line with no readable name says THAT, rather than quoting itself.
    const none = bankMatch.matchDeposit({ descriptor: 'SERVICE CHARGE', amount: 35 }, [],
        { resolveParty: () => null, suggestParty: () => [], payeeOf });
    ck('an unreadable line admits it instead of quoting itself',
       /no company name Jarvis can read/.test(none.note), none.note);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the guard that must not have moved');
// ══════════════════════════════════════════════════════════════════════════
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankLearn.js'), 'utf8');
    // Parsing decides which characters are the name. nameMatch still decides
    // who that is, and still does it exactly.
    ck('the resolver still matches through normalizeName, not by containment',
       /normalizeName\(name\)/.test(src) && !/includes\(k\)/.test(src),
       'a containment match here pays the wrong company');
    ck('  and the full-line key is still tried first',
       src.indexOf('byKey.has(whole)') < src.indexOf('payeeOf(descriptor)'),
       'every alias she already created must keep working');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — her own company is not a candidate, and a cut name resolves');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, shown "could be Edge Metals Recycling or A.LEE METAL TRADING":
// "How can it assume its edge recycling?" — then "still bad".
{
    const CUT = 'ALEE METAL TRADI DES:ACH Pmt ID:XXXXX81012 INDN:Edge Metal Inc. CO ID:XXXXX02235 CCD';
    const names = ['Edge Metals Recycling', 'A.LEE METAL TRADING', 'Taewon', 'AJAX TRADING'];

    // It never assumed. An ACH line carries INDN: — the RECEIVER, Edge
    // itself — and the suggester searched the WHOLE line, so her own
    // company was in the haystack on every incoming payment.
    const hints = bankLearn.suggestParty(CUT, names).map((h) => h.customer);
    ck('her own company is no longer offered as the payer',
       !hints.includes('Edge Metals Recycling'), JSON.stringify(hints));
    ck('  leaving exactly the one it really is',
       JSON.stringify(hints) === JSON.stringify(['A.LEE METAL TRADING']), JSON.stringify(hints));

    // ── A CUT NAME IS NOT A NEAR MISS ────────────────────────────────────
    const resolve = bankLearn.resolverFrom([], names);
    ck('a name the bank truncated resolves on its own',
       resolve(CUT) === 'A.LEE METAL TRADING', JSON.stringify(resolve(CUT)));

    // The three conditions, each proved to matter.
    ck('  two companies sharing the cut prefix are NOT chosen between',
       bankLearn.resolverFrom([], ['ALEE METAL TRADING LLC', 'ALEE METAL TRADING INC'])(CUT) === null,
       'ambiguity is the danger nameMatch.js names, and she is asked');
    ck('  a short name can never select a long one',
       resolve('AJ DES:ACH ID:1') === null,
       '"AJ" must not pick AJAX TRADING — fewer than 8 characters read');
    ck('  and it is a prefix, not a fuzzy distance',
       bankLearn.resolverFrom([], ['TAEWON METALS'])('WAEWON METALS DES:ACH ID:1') === null,
       'one letter different is a different company, not a cut one');

    // A full exact name still resolves, as it always did.
    ck('an exact name is unaffected', resolve('TAEWON DES:ACH ID:1') === 'Taewon',
       JSON.stringify(resolve('TAEWON DES:ACH ID:1')));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
