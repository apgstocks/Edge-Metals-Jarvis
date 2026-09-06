// ── tests/numbering.js ────────────────────────────────────────────────────
// Apsara, 2026-09-07, writing the numbering rules out in full:
//
//   Container number 26JY95 = year(2) + agent letter code + running number.
//   Invoice number 260901_RC_26JY100 = date(YYMMDD) + item code + container.
//   "PDF / form — one combined number naming every container:
//    260901_RC_26JY100,101 (shared prefix written once)"
//   "Edge Metals sheet — one row per container, each with its own full number"
//
// WHAT WAS ACTUALLY WRONG
// -----------------------
// Two things, both silent, both already shipped:
//
// 1. The email/voice path never combined. invNo was built from the FIRST
//    container and handed straight to the PDF, so a two-container order went
//    out as 260823_AC_26JY90 while the customer was billed for 90 AND 91.
//    tests/action-invoke.js's fixture — which its own comment says was copied
//    from a REAL pending in the live brain.json — carries exactly that shape.
//    It went unnoticed because proformaFilename() combines separately, so the
//    SAVED FILE was named correctly while the number inside the document was
//    not.
//
// 2. The item-code list existed twice and had drifted. 'ALLOY WHEEL' and
//    'TAINT TABOO' were on the dashboard's list and missing from the server's,
//    so the same material produced a different invoice number depending on
//    which screen raised the document.
//
// The second of those is the reason section C exists: it reads BOTH copies
// and fails the day a keyword is added to one and not the other.

const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const cc = require(path.join(ROOT, 'helpers/containerCodes.js'));
const ic = require(path.join(ROOT, 'helpers/itemCode.js'));

console.log('\n─ container and invoice numbering ───────────────────────────');

section('A — the invoice number names every container');
{
    // HER EXAMPLE, verbatim from the spec.
    ck('260901_RC_26JY100 + 101 → 260901_RC_26JY100,101',
       cc.combineInvNo('260901_RC_26JY100', ['26JY100', '26JY101']) === '260901_RC_26JY100,101',
       cc.combineInvNo('260901_RC_26JY100', ['26JY100', '26JY101']));

    // THE LIVE CASE, from tests/action-invoke.js's real-data fixture.
    ck('  the shipped bug: 26JY90 + 91 → 26JY90,91',
       cc.combineInvNo('260823_AC_26JY90', ['26JY90', '26JY91']) === '260823_AC_26JY90,91',
       'this went out naming one of two containers the customer was billed for');

    // Her "5 loads → 95,96,97,98,99".
    ck('  five containers, shared prefix written once',
       cc.combineInvNo('260823_AC_26JY95', ['26JY95', '26JY96', '26JY97', '26JY98', '26JY99'])
           === '260823_AC_26JY95,96,97,98,99');

    // ONE container is unchanged — there is nothing to combine, and appending
    // a lone comma would be a number that does not exist.
    ck('  one container is left exactly as it is',
       cc.combineInvNo('260823_AC_26JY90', ['26JY90']) === '260823_AC_26JY90');
    ck('  and so is an empty list', cc.combineInvNo('260823_AC_26JY90', []) === '260823_AC_26JY90');

    // COMBINING TWICE MUST NOT DOUBLE IT. prepareProformaNumbers can run
    // again on a re-confirm, and "26JY90,91,91" is a number nobody can read.
    const once = cc.combineInvNo('260823_AC_26JY90', ['26JY90', '26JY91']);
    ck('  combining an already-combined number is a no-op',
       cc.combineInvNo(once, ['26JY90', '26JY91']) === once,
       cc.combineInvNo(once, ['26JY90', '26JY91']));
}

section('B — and it refuses when the number is not from that series');
{
    // She typed the number herself, or pasted it from her old system. Gluing
    // container tails onto it produces a number that means nothing, and this
    // is a financial document.
    ck('a bespoke invoice number is left alone',
       cc.combineInvNo('SOMETHING-ELSE', ['26JY90', '26JY91']) === 'SOMETHING-ELSE');
    ck('  and one ending in a DIFFERENT container',
       cc.combineInvNo('260823_AC_26JY77', ['26JY90', '26JY91']) === '260823_AC_26JY77',
       'appending 90,91 to a number about 77 would invent a document');

    // A container from another series keeps its full code — "26JY90,ABC12" is
    // at least readable, where "26JY90,12" is a number that does not exist.
    ck('  a foreign container code is not shortened',
       cc.combineInvNo('260823_AC_26JY90', ['26JY90', 'ABC12']) === '260823_AC_26JY90,ABC12');

    ck('  and nothing at all comes back empty', cc.combineInvNo('', ['26JY90', '26JY91']) === '');
}

section('C — ONE item-code list, and it stays one');
{
    // THE DRIFT THAT HAD ALREADY HAPPENED. Two keywords were on the
    // dashboard's list and missing from the server's, so the same material
    // produced a different invoice number depending on the screen.
    ck("'alloy wheel' → AW", ic.itemCodeFor('alloy wheel') === 'AW',
       'was null from an emailed order, AW from the dashboard');
    ck("  'taint taboo' → TT", ic.itemCodeFor('taint taboo') === 'TT');

    // Her stated examples.
    for (const [desc, code] of [
        ['REGULAR COMBO', 'RC'], ['AUTO CAST', 'AC'], ['ALUMINIUM COMBO', 'AL'],
        ['BATTERY', 'BT'], ['chrome wheel', 'CW'], ['sealed unit', 'SU'],
    ]) ck(`  "${desc}" → ${code}`, ic.itemCodeFor(desc) === code, String(ic.itemCodeFor(desc)));

    // "It normalises first, so 'aluminum' and 'aluminium' both hit AW/AL."
    ck('  spelling and spacing do not matter',
       ic.itemCodeFor('aluminum combo') === 'AL' && ic.itemCodeFor('ALUMINIUM COMBO') === 'AL'
       && ic.itemCodeFor('autocast') === 'AC' && ic.itemCodeFor('Auto-Cast') === 'AC');

    // NULL IS A REAL ANSWER. An unrecognised grade keeps the plain number
    // rather than carrying a code describing the wrong goods.
    ck('  an unknown grade gets no code', ic.itemCodeFor('something nobody listed') === null);
    ck('  and so does nothing at all', ic.itemCodeFor('') === null && ic.itemCodeFor(null) === null);

    // ── THE DRIFT GUARD ──────────────────────────────────────────────────
    // The browser copy stays in dashboard/documents.html — it is a static
    // page with no bundler. So instead of sharing the code, this reads BOTH
    // and fails the day a keyword is added to one and not the other. That is
    // the check that would have caught 'ALLOY WHEEL' the day it was typed.
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/documents.html'), 'utf8');
    const m = /const ITEM_CODE_RULES = \[([\s\S]*?)\n\];/.exec(html);
    ck('the dashboard copy was found', !!m,
       'if this rule was renamed the guard is silently not guarding');
    if (m) {
        const parse = (body) => {
            const out = {};
            const re = /\['([A-Z]{2})',\s*\[([^\]]*)\]\]/g;
            let hit;
            while ((hit = re.exec(body))) {
                out[hit[1]] = hit[2].split(',')
                    .map((x) => x.trim().replace(/^['"]|['"]$/g, '').toUpperCase().replace(/[^A-Z]/g, ''))
                    .filter(Boolean).sort();
            }
            return out;
        };
        const browser = parse(m[1]);
        const server = {};
        for (const [code, keys] of ic.ITEM_CODE_RULES) {
            server[code] = keys.map((k) => ic.norm(k)).sort();
        }
        ck('  both lists have the same codes',
           JSON.stringify(Object.keys(browser).sort()) === JSON.stringify(Object.keys(server).sort()),
           'browser: ' + Object.keys(browser).sort().join(',') + '\n        server:  ' + Object.keys(server).sort().join(','));
        const diffs = [];
        for (const code of Object.keys(server)) {
            if (JSON.stringify(browser[code]) !== JSON.stringify(server[code])) {
                diffs.push(`${code}: browser ${JSON.stringify(browser[code])} vs server ${JSON.stringify(server[code])}`);
            }
        }
        ck('  and the same keywords under each',
           diffs.length === 0,
           diffs.join('\n        ') + '\n        — the same material would get a different invoice number on each screen');
    }
}

section('D — the two callers both use the shared combiner');
{
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    ck('prepareProformaNumbers combines before handing over the number',
       /invNo = require\('\.\.\/helpers\/containerCodes'\)\.combineInvNo\(invNo, containerNos\)/.test(acts),
       'this is the line whose absence shipped a one-container number on a two-container invoice');
    ck('  and the filename uses the same combiner',
       /combineInvNo\(base, list\)/.test(acts),
       'a filename that combines separately is what hid the bug — the file looked right');
    ck('  the old private loop is gone',
       !/const extras = list\.slice\(1\)\.map/.test(acts),
       'a third copy of the rule');
    ck('  and so is the private item-code table',
       !/\['AC', \['AUTOCAST'\]\]/.test(acts),
       'itemCodeFor now delegates to helpers/itemCode.js');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
