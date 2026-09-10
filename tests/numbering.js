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

section('A2 — MIXED materials keep their own item codes');
{
    // Apsara, 2026-09-10: "When i add two containers, only one container's
    // invoice number is coming, second container inv no is getting appended
    // with a comma".
    //
    // The comma form writes the head ONCE. That is right for containers that
    // share a date and an item code, and a false statement of goods the moment
    // they do not: "260901_AL_26JY96,97" says both containers are ALUMINIUM
    // COMBO when the second is REGULAR COMBO. On a document a customs broker
    // reads, that is not a cosmetic difference.
    // Apsara, 2026-09-10, correcting my first cut, which joined with "_":
    // "it should be 260901_AL_26JY96,260901_RC_26JY97". ONE separator
    // throughout — an underscore is already the separator INSIDE a number
    // (date_item_code), so using it between numbers too made the boundary
    // invisible.
    ck('AL + RC → both full numbers, comma-separated',
       cc.combineInvNos(['260901_AL_26JY96', '260901_RC_26JY97'])
         === '260901_AL_26JY96,260901_RC_26JY97',
       cc.combineInvNos(['260901_AL_26JY96', '260901_RC_26JY97']));
    ck('  and NOT joined with an underscore',
       !cc.combineInvNos(['260901_AL_26JY96', '260901_RC_26JY97']).includes('96_260901'),
       'the underscore spelling hides where one number ends and the next begins');

    // Confirmed with her: same material keeps the 2026-09-01 comma form. This
    // change must not touch the case that was already right.
    ck('  same material is UNCHANGED — still the comma form',
       cc.combineInvNos(['260901_AL_26JY96', '260901_AL_26JY97'])
         === '260901_AL_26JY96,97',
       cc.combineInvNos(['260901_AL_26JY96', '260901_AL_26JY97']));

    ck('  mixed batch: shorten within a material, join across',
       cc.combineInvNos(['260901_AL_26JY96', '260901_AL_26JY97', '260901_RC_26JY98'])
         === '260901_AL_26JY96,97,260901_RC_26JY98',
       cc.combineInvNos(['260901_AL_26JY96', '260901_AL_26JY97', '260901_RC_26JY98']));

    ck('  head order follows sheet order, not alphabetical',
       cc.combineInvNos(['260901_RC_26JY98', '260901_AL_26JY96'])
         === '260901_RC_26JY98,260901_AL_26JY96',
       'the number must read in the same sequence as the item rows beneath it');

    ck('  a single container is left exactly as it was',
       cc.combineInvNos(['260901_AL_26JY96']) === '260901_AL_26JY96');
    ck('  a repeated number is not written twice',
       cc.combineInvNos(['260901_AL_26JY96', '260901_AL_26JY96']) === '260901_AL_26JY96',
       'one container with several line items must not double its own number');
    ck('  nothing in, nothing out', cc.combineInvNos([]) === '');
    ck('  a run crossing a code change stays whole',
       cc.combineInvNos(['260901_RC_26JY99', '260901_RC_26KA01'])
         === '260901_RC_26JY99,26KA01',
       '26JY99,01 would name a container that does not exist');

    // The merged-invoice builder must actually USE it. This was the bug: it
    // returned first.inv_no, so a two-container merge billed the customer
    // under a number naming one of the two containers.
    const isrc = fs.readFileSync(path.join(ROOT, 'helpers/invoiceSheet.js'), 'utf8');
    ck('  buildMultiContainerInvoiceData uses the combiner',
       /combineInvNos\(rowInvNos\)/.test(isrc),
       'it returned first.inv_no — the first matched row, ignoring the rest');
    ck('  ...and it is NOT written back to the sheet',
       !/inv_no:\s*mergedInvNo[\s\S]{0,400}appendRow/.test(isrc),
       'the Invoice sheet is a per-container ledger — one full number per row');

    // Found while fixing the number: the same function resolved EVERY row's
    // item description from the FIRST row's invoice number, so a REGULAR
    // COMBO container merged behind an ALUMINIUM one was labelled ALUMINIUM
    // whenever its own Item Description cell was blank.
    // ── the search box has to find them again ──────────────────────────────
    // invNoTailCodes took only the LAST "_" token, so searching "26JY96" for
    // a mixed-material merged invoice returned nothing — which on a search box
    // reads as "that container does not exist", not "the parser gave up".
    const inv = require(path.join(ROOT, 'helpers/invoiceSheet.js'));
    const tails = (n) => JSON.stringify(inv.invNoTailCodes(n));
    ck('  the plain number still expands as before',
       tails('260901_AL_26JY96') === '["26JY96"]', tails('260901_AL_26JY96'));
    ck('  the comma form still expands as before',
       tails('260901_RC_26JY100,101') === '["26JY100","26JY101"]',
       tails('260901_RC_26JY100,101'));
    ck('  and the mixed form finds BOTH containers',
       tails('260901_AL_26JY96,260901_RC_26JY97') === '["26JY96","26JY97"]',
       tails('260901_AL_26JY96,260901_RC_26JY97'));
    ck('  ...short and whole codes in one number',
       tails('260901_AL_26JY96,97,260901_RC_26JY98') === '["26JY96","26JY97","26JY98"]',
       tails('260901_AL_26JY96,97,260901_RC_26JY98'));
    ck('  a code run crossing a code change stays whole',
       tails('260901_RC_26JY99,26KA01') === '["26JY99","26KA01"]',
       tails('260901_RC_26JY99,26KA01'));
    // Not what Jarvis writes, but it IS how her own files are named — a number
    // pasted from a filename must still find both containers.
    ck('  the UNDERSCORE spelling from her filing is tolerated on search',
       tails('260901_AL_26JY96_260901_RC_26JY97') === '["26JY96","26JY97"]',
       tails('260901_AL_26JY96_260901_RC_26JY97'));
    ck('  ...including the mixed short/whole one',
       tails('260901_AL_26JY96,97_260901_RC_26JY98') === '["26JY96","26JY97","26JY98"]',
       tails('260901_AL_26JY96,97_260901_RC_26JY98'));

    ck('  each row resolves its description from its OWN number',
       /resolveItemDesc\(d\.item_desc, d\.inv_no \|\| first\.inv_no\)/.test(isrc),
       'first.inv_no put the wrong goods on the mixed-material invoice');
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

section('E — a new year starts at one');
{
    // Apsara, 2026-09-07: "Numbering restarts each year. 25JY ran to 106
    // while 26JY runs its own 01→95. It only ever looks at rows whose year
    // prefix matches, so it can't jump onto last year's tail."
    //
    // suggestNextInvNo used to fall back to the newest PRIOR year and
    // continue ITS count, so a consignee whose last invoice was 25JY106 got
    // 25JY107 as their first invoice of 2026 — last year's prefix on this
    // year's document. The comment defending it said the alternative was
    // "guessing a fresh restart at 1"; restarting is not a guess, it is the
    // rule she has now stated twice.
    //
    // fetchInvoiceSheetRows pulls a Google Sheet as CSV, so it is stubbed —
    // the rule is what is being tested, not the transport.
    // nextFromRows, NOT suggestNextInvNo. My first version stubbed the
    // exported fetchInvoiceSheetRows and it did NOTHING — suggestNextInvNo
    // calls the LOCAL function, so the test read the real Google Sheet and
    // reported numbers that had nothing to do with its fixture. A seam that
    // cannot be reached is not a seam, so the decision was split out from the
    // transport and this tests the decision.
    const ni = require(path.join(ROOT, 'helpers/nextInvoiceNo.js'));
    const yy = String(new Date().getFullYear()).slice(-2);
    const last = String(new Date().getFullYear() - 1).slice(-2);

    // ONLY LAST YEAR'S ROWS. Her exact example: 25JY ran to 106.
    const fresh = ni.nextFromRows([
        { consignee: 'Joey/Taewon', invNo: `${last}JY104` },
        { consignee: 'Joey/Daekwang', invNo: `${last}JY106` },
    ]);
    ck('the first invoice of a new year restarts at 1',
       !!fresh && fresh.next_number === 1, fresh ? String(fresh.next_number) : 'null');
    ck('  under THIS year\'s prefix', !!fresh && fresh.year_prefix === yy,
       fresh ? fresh.year_prefix : 'null');
    ck('  so 25JY106 does NOT become 25JY107',
       !!fresh && fresh.code_only === `${yy}JY01`,
       fresh ? fresh.code_only : 'null');
    // THE LETTER CODE STILL COMES FROM THE PRIOR YEAR. "JY" is Joey's
    // whatever the year; losing it gives a sequence nobody can identify the
    // consignee by.
    ck('  while the letter code survives the rollover',
       !!fresh && fresh.letter_code === 'JY', fresh ? fresh.letter_code : 'null');
    ck('  and it says the count restarted',
       !!fresh && fresh.restarted_for_new_year === true,
       'a jump from 106 to 01 looks like a mistake unless something says so');
    // Her spec writes it as 01, not 1 — the prior year's unpadded 3-digit
    // rows are no guide to how a restart should read.
    ck('  padded to two, as her spec writes it',
       !!fresh && /01$/.test(fresh.code_only), fresh ? fresh.code_only : 'null');

    // THIS YEAR ALREADY HAS ROWS — unchanged behaviour, highest + 1.
    const running = ni.nextFromRows([
        { consignee: 'Joey/Taewon', invNo: `${last}JY106` },
        { consignee: 'Joey/Taewon', invNo: `${yy}JY94` },
        { consignee: 'Joey/Daekwang', invNo: `${yy}JY95` },
    ]);
    ck('a year already running continues from its own highest',
       !!running && running.next_number === 96, running ? String(running.next_number) : 'null');
    ck('  and never jumps onto last year\'s tail',
       !!running && running.next_number !== 107);
    ck('  nor is it flagged as restarted',
       !!running && running.restarted_for_new_year === false);
    // HER RULE 2: everything before the "/" shares one count. Joey/Daekwang's
    // 95 is why Joey/Taewon gets 96 — the caller filters by agent prefix and
    // hands both rows in.
    ck('  agent-tagged consignees share one sequence',
       !!running && running.code_only === `${yy}JY96`, running ? running.code_only : 'null');

    // A padded prior year restarts padded too.
    const padded = ni.nextFromRows([{ consignee: 'MK Trading', invNo: `${last}MK09` }]);
    ck('a padded prior year restarts padded', !!padded && padded.code_only === `${yy}MK01`,
       padded ? padded.code_only : 'null');

    // Nothing at all on file is still nothing — she supplies the number.
    ck('no history at all is still null', ni.nextFromRows([]) === null);
    ck('  and an unparseable row is not a number',
       ni.nextFromRows([{ consignee: 'x', invNo: 'not-a-code' }]) === null);
}

section('F — the numbers reach the document she is shown');
{
    // Apsara, 2026-09-07: "both invoice nd container no - not updated."
    //
    // They were minted AFTER the preview was built. handle() called
    // pdfPayload() with NO ARGUMENTS, so inv_no defaulted to '' and the
    // single container block carried container_no: ''. The numbering worked
    // perfectly the whole time and never reached the document on her screen.
    //
    // A preview showing blanks where the two identifying numbers go is worse
    // than no preview: it is a document that looks wrong for a reason she
    // cannot see, and the only sane thing to do with it is distrust it.
    const ppP = require.resolve(path.join(ROOT, 'helpers/proformaPricing.js'));
    const realPp = require.cache[ppP];
    require.cache[ppP] = { id: ppP, filename: ppP, loaded: true, exports: { lookup: () => ({}) } };
    const pro = require(path.join(ROOT, 'helpers/proformaDraft.js'));

    pro.clear();
    pro.start('create a proforma for Daekwang, 2 containers, 21 MT of auto cast at 8450');

    const withNums = pro.pdfPayload({
        inv_no: '260907_AC_26JY104,105',
        containerNos: ['26JY104', '26JY105'],
        addressLines: ['Daekwang Metal Co., Ltd.'],
    });
    ck('the invoice number reaches the payload',
       withNums.inv_no === '260907_AC_26JY104,105', withNums.inv_no);
    ck('  and there is ONE block per container',
       withNums.containers.length === 2, String(withNums.containers.length));
    ck('  each carrying its own number',
       withNums.containers.map((c) => c.container_no).join(',') === '26JY104,26JY105',
       JSON.stringify(withNums.containers.map((c) => c.container_no)));
    ck('  and the address', withNums.consignee_address.length === 1);

    // AND IT RENDERS. buildProformaDc2Html is the same generator the sent
    // document goes through, so if the number is not in this HTML it is not
    // on the paper either.
    const html = require(path.join(ROOT, 'helpers/proformaPdf.js'))
        .buildProformaDc2Html(withNums).html;
    ck('the invoice number is in the rendered document',
       html.includes('260907_AC_26JY104,105'));
    ck('  and both container numbers',
       html.includes('26JY104') && html.includes('26JY105'));

    // WITHOUT numbers it still renders one block per container rather than
    // collapsing to a single blank — otherwise a two-container proforma looks
    // like a one-container proforma with a missing number.
    const bare = pro.pdfPayload();
    ck('with no numbers yet, the blocks still match the count',
       bare.containers.length === 2, String(bare.containers.length));

    // THE ORDER IN api.js. Minting after the preview is the bug; the source
    // has to show the mint happening first.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const iMint = api.indexOf('prepareProformaNumbers(step.draft)');
    const iDraw = api.indexOf('buildProformaDc2Html');
    ck('the numbers are minted BEFORE the preview is drawn',
       iMint !== -1 && iDraw !== -1 && iMint < iDraw,
       'mint at ' + iMint + ', draw at ' + iDraw);
    // Asserted on the payload being PASSED, not merely built. My first
    // version matched the construction of `withNums` and a mutation that
    // built it and then rendered step.pdf anyway left the test green — the
    // exact bug, reintroduced, undetected.
    ck('  and the preview is rebuilt with them, not from step.pdf',
       /buildProformaDc2Html\(withNums/.test(api),
       'step.pdf was built by handle() before the numbers existed');
    ck('  and they are not minted twice',
       /if \(!nums\) nums = await acts\.prepareProformaNumbers/.test(api),
       'a second fetch could hand her a different number from the one on screen');

    // THE SILENCE THAT HID IT. prepareProformaNumbers swallowed every sheet
    // failure into empty numbers with no explanation.
    const acts = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    // The ASSIGNMENT inside the catch, not the declaration. `let invNo = '',
    // containerNos = [], numbersWarning = null` also matches /numbersWarning
    // = /, so my first assertion passed with the catch gutted.
    ck('a failed sheet lookup is reported, not swallowed',
       /numbersWarning = `Couldn't reach the invoice sheet/.test(acts)
       && !/catch \(e\) \{ \/\* no history/.test(acts),
       'the bare catch turned a broken INVOICE_SHEET_ID into "no numbers, no reason"');
    ck('  and the reply says so when there is no number',
       /could not work out the invoice number/.test(api),
       'silence is indistinguishable from a number she did not catch');

    if (realPp) require.cache[ppP] = realPp; else delete require.cache[ppP];
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);
