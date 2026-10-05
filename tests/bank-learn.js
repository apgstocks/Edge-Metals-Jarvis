// ── tests/bank-learn.js ───────────────────────────────────────────────────
// Apsara, 2026-10-05: "it should able to self learn, self find".
//
// What "learned" is allowed to mean here. The expensive mistake in this file
// is not failing to learn — it is learning something that then quietly
// misallocates money, which is why most of these checks are about what it
// must REFUSE to conclude.

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

// HER REAL FILE MUST NEVER BE TOUCHED. Same rule QB_DECISIONS_FILE follows.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bank-learn-'));
process.env.DATA_DIR = TMP;
process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json');
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
const L = require(path.join(ROOT, 'helpers/bankLearn'));
if (!String(L.FILE()).startsWith(TMP)) {
    console.error('  ABORT  bankLearn would write ' + L.FILE());
    process.exit(1);
}

(async () => {

// ── A — AN ALIAS IS LEARNED ONCE AND THEN JUST WORKS ──────────────────────
{
    section('A — one answer, then it resolves itself for ever');

    const customers = ['Custom Alloys', 'Daekwang Metals', 'Zimex'];
    const before = L.resolverFrom(L.listAliases(), customers);
    ck('an unknown bank description resolves to nothing',
       before('WIRE IN CUSTOM-ALLOYS LLC REF 88213') === null);

    await L.learnAlias('WIRE IN CUSTOM-ALLOYS LLC REF 88213', 'Custom Alloys', { by: 'apsara', why: 'confirmed on the review screen' });
    const after = L.resolverFrom(L.listAliases(), customers);
    ck('  after she answers once, it resolves',
       after('WIRE IN CUSTOM-ALLOYS LLC REF 88213') === 'Custom Alloys');
    ck('  and punctuation and case do not matter',
       after('wire in custom  alloys  llc ref 88213') === 'Custom Alloys',
       'otherwise the same payer teaches it twice');

    ck('  the alias records WHO said so and WHEN',
       L.listAliases().some((a) => a.customer === 'Custom Alloys' && a.by === 'apsara' && a.at),
       JSON.stringify(L.listAliases()));

    // ONE ALIAS PER DESCRIPTOR. Re-answering must replace, not accumulate —
    // two rows for one key means the resolution depends on array order.
    await L.learnAlias('WIRE IN CUSTOM-ALLOYS LLC REF 88213', 'Zimex');
    ck('  changing her mind replaces the alias rather than adding a second',
       L.listAliases().filter((a) => a.key === require(path.join(ROOT, 'helpers/nameMatch')).normalizeName('WIRE IN CUSTOM-ALLOYS LLC REF 88213')).length === 1,
       JSON.stringify(L.listAliases().map((a) => a.customer)));
    ck('  and the new answer is the one that wins',
       L.resolverFrom(L.listAliases(), customers)('WIRE IN CUSTOM-ALLOYS LLC REF 88213') === 'Zimex');

    const gone = await L.forgetAlias('WIRE IN CUSTOM-ALLOYS LLC REF 88213');
    ck('un-learning is as easy as learning', gone && gone.customer === 'Zimex', JSON.stringify(gone));
    ck('  and it really is gone',
       L.resolverFrom(L.listAliases(), customers)('WIRE IN CUSTOM-ALLOYS LLC REF 88213') === null,
       'a wrong alias misallocates every future deposit from that payer');

    await L.learnAlias('x', 'Zimex').then(() => 0);
    let threw = null;
    try { await L.learnAlias('', 'Zimex'); } catch (e) { threw = e.message; }
    ck('an empty description cannot be learned', /nothing to learn/.test(threw || ''), String(threw));
    threw = null;
    try { await L.learnAlias('SOMETHING', '   '); } catch (e) { threw = e.message; }
    ck('  nor an empty customer', /learn it as whose/.test(threw || ''), String(threw));
}

// ── B — IT RESOLVES EXACTLY, OR NOT AT ALL ────────────────────────────────
{
    section('B — exact, or it asks');

    const r = L.resolverFrom([], ['Custom Alloys', 'Daekwang Metals', 'AJ', 'AJAX TRADING LLC']);
    ck('a customer name on its own resolves', r('daekwang metals') === 'Daekwang Metals');
    ck('  with punctuation ignored', r('Daekwang-Metals') === 'Daekwang Metals');
    ck('a name buried in bank noise does NOT resolve',
       r('WIRE IN DAEKWANG METALS REF 4410') === null,
       'containment is a suggestion, not a resolution — that is section C');
    ck('  and noise alone resolves to nothing', r('ACH CREDIT 884102') === null);
    ck('  an all-punctuation description cannot sweep up the roster',
       r('---') === null && r('') === null && r(null) === null);

    // TWO SPELLINGS OF ONE NAME IS A COIN FLIP, SO IT IS A QUESTION. It is
    // also how she finds out she has the same company in twice.
    const dup = L.resolverFrom([], ['Custom Alloys', 'Custom-Alloys', 'Zimex']);
    ck('two spellings normalising to one key resolve to NEITHER',
       dup('Custom Alloys') === null, String(dup('Custom Alloys')));
    ck('  while an unaffected name still resolves', dup('Zimex') === 'Zimex');
    // An identical duplicate row is the SAME company listed twice, not two
    // companies — resolving it is correct and refusing would be a false alarm.
    const same = L.resolverFrom([], ['Edge Scrap', 'Edge Scrap']);
    ck('  but an identical duplicate row still resolves', same('Edge Scrap') === 'Edge Scrap');
}

// ── C — SUGGESTIONS ARE QUARANTINED, AND USE THE PROVEN NAME LOGIC ────────
// This section used to check a MIN_SUGGEST length threshold of my own. That
// guard is gone: helpers/partyName.js answers the same question with the
// GENERIC trade-word list extracted from scripts/qb-bank-match.js, where it
// has run against her real bank exports since September. The behaviours below
// are the ones that logic was written for, including the 2026-09-23 incident
// where a similarity match put a $60,000 wire against the wrong supplier.
{
    section('C — name matching lives here, and decides nothing');

    const customers = ['Custom Alloys', 'AJ', 'AJAX TRADING LLC', 'Zimex Freight',
        'Daekwang Metals', '5 Core Trading Inc', 'Calderon Cores'];
    const names = (d) => L.suggestParty(d, customers).map((x) => x.customer);

    const s = L.suggestParty('WIRE TYPE:WIRE IN FROM CUSTOM ALLOYS LLC', customers);
    ck('a name inside the description is offered as a suggestion',
       s.length === 1 && s[0].customer === 'Custom Alloys', JSON.stringify(names('WIRE TYPE:WIRE IN FROM CUSTOM ALLOYS LLC')));
    ck('  labelled as a suggestion, with its basis',
       s[0].basis === 'name found in the bank description', s[0].basis);

    // THE $60,000 INCIDENT. Both names end in a shared trade word, and a
    // similarity score treats them as close relatives.
    ck('"Inesh Cores Chapin" never suggests "Calderon Cores"',
       !names('INESH CORES CHAPIN').includes('Calderon Cores'),
       JSON.stringify(names('INESH CORES CHAPIN')));
    ck('  in fact it suggests nobody at all',
       names('INESH CORES CHAPIN').length === 0, JSON.stringify(names('INESH CORES CHAPIN')));

    // A two-letter customer inside a longer name. My length threshold got
    // this right by luck; partyName gets it right because "AJ" has no word
    // of its own longer than two letters and is too short to contain-match.
    ck('a two-letter customer is never suggested from a longer name',
       !names('PAYMENT FROM AJAX TRADING LLC').includes('AJ'),
       JSON.stringify(names('PAYMENT FROM AJAX TRADING LLC')));
    ck('  while the long name is', names('PAYMENT FROM AJAX TRADING LLC').includes('AJAX TRADING LLC'));

    // A name made ENTIRELY of generic trade words. Nothing distinctive
    // survives, so only an outright containment of the whole name counts —
    // never a shared word like TRADING.
    ck('a name of only generic words matches on the whole name',
       names('5 CORE TRADING INC WIRE').includes('5 Core Trading Inc'),
       JSON.stringify(names('5 CORE TRADING INC WIRE')));
    ck('  but a shared trade word alone does not pull it in',
       !names('ZIMEX TRADING TRANSFER').includes('5 Core Trading Inc'),
       JSON.stringify(names('ZIMEX TRADING TRANSFER')));

    ck('nothing recognisable suggests nothing',
       names('ACH CREDIT 00912').length === 0, JSON.stringify(names('ACH CREDIT 00912')));
    ck('  and an empty description suggests nothing',
       L.suggestParty('', customers).length === 0 && L.suggestParty(null, customers).length === 0);

    // Two customers in one description: BOTH returned. Hiding the second
    // would make a coin flip look certain.
    const two = L.suggestParty('TRANSFER CUSTOM ALLOYS VIA ZIMEX FREIGHT', customers);
    ck('two possible customers in one description are both offered',
       two.length === 2, JSON.stringify(two.map((x) => x.customer)));

    // ── IT USES THE SHARED MODULE, NOT A COPY ────────────────────────────
    // The whole reason partyName.js exists. A copy here would drift from the
    // CSV path, and the drift would be invisible until a wire went to the
    // wrong supplier again.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankLearn.js'), 'utf8');
    ck('bankLearn requires helpers/partyName rather than carrying its own copy',
       /require\('\.\/partyName'\)/.test(src) && !/const GENERIC = new Set/.test(src),
       'a second copy of this list is a second thing to forget to update');
    ck('  and the GENERIC list really is the one from the CSV path',
       L.partyName.GENERIC === require(path.join(ROOT, 'helpers/partyName')).GENERIC
       && L.partyName.GENERIC.has('CORES') && L.partyName.GENERIC.has('TRADING'),
       'same object, so there is nothing to keep in step');

    // And a suggestion still resolves nothing on its own.
    const r = L.resolverFrom([], customers);
    ck('a suggestion never resolves on its own',
       r('WIRE TYPE:WIRE IN FROM CUSTOM ALLOYS LLC') === null,
       'the engine proposes; it never decides who paid');
}

// ── D — THE PATTERNS ARE MEASURED, NOT STORED ─────────────────────────────
{
    section('D — how she actually gets paid, computed from her own receipts');

    const sales = new Map([
        ['S1', { date: '2026-08-01', amount: 22000 }],
        ['S2', { date: '2026-08-05', amount: 18000 }],
        ['S3', { date: '2026-07-01', amount: 50000 }],
    ]);
    const receipts = [
        { customer: 'Custom Alloys', date: '2026-09-05', amount: 40000,
          allocations: [{ sale_id: 'S1', amount: 22000 }, { sale_id: 'S2', amount: 18000 }] },
        { customer: 'Custom Alloys', date: '2026-08-31', amount: 21975,
          allocations: [{ sale_id: 'S1', amount: 21975, deduction_amount: 25, deduction_reason: 'bank_charge' }] },
        { customer: 'Daekwang', date: '2026-07-20', amount: 20000,
          allocations: [{ sale_id: 'S3', amount: 20000 }] },
        { customer: 'Daekwang', date: '2026-08-10', amount: 5000,
          allocations: [{ sale_id: 'S3', amount: 5000, deduction_amount: 300, deduction_reason: 'discount' }] },
    ];
    const p = L.patternsFromHistory(receipts, sales);

    ck('a customer who has paid two invoices at once is marked as combining',
       p['Custom Alloys'].combines === true && p['Custom Alloys'].combinedCount === 1,
       JSON.stringify(p['Custom Alloys']));
    ck('  and one who never has, is not',
       p.Daekwang.combines === false, JSON.stringify(p.Daekwang));
    ck('a customer who part-pays is marked as such',
       p.Daekwang.partPays === true && p.Daekwang.partCount === 2, JSON.stringify(p.Daekwang));
    ck('  and one who always pays in full is not', p['Custom Alloys'].partPays === false);

    // ── bank_charge TEACHES AN ALLOWANCE; discount MUST NOT ──────────────
    // A discount is money she AGREED to give up. Rolling it into the
    // allowance would teach the matcher to silently close any invoice this
    // customer underpays — and a short payment she did not agree to is
    // precisely what she needs to see.
    ck('a bank charge in transit becomes a fee allowance',
       p['Custom Alloys'].feeAllowance === 25 && p['Custom Alloys'].feeSamples === 1,
       JSON.stringify(p['Custom Alloys']));
    ck('  a DISCOUNT never does, however large',
       p.Daekwang.feeAllowance === 0 && p.Daekwang.feeSamples === 0,
       '300 of discount must not license a 300 shortfall on the next invoice');

    // MEDIAN, not mean: one invoice paid nine months late would otherwise
    // make every normal payment look early.
    const late = L.patternsFromHistory([
        { customer: 'X', date: '2026-08-11', amount: 1, allocations: [{ sale_id: 'S1', amount: 1 }] },
        { customer: 'X', date: '2026-08-12', amount: 1, allocations: [{ sale_id: 'S1', amount: 1 }] },
        { customer: 'X', date: '2027-05-01', amount: 1, allocations: [{ sale_id: 'S1', amount: 1 }] },
    ], sales);
    ck('the usual payment delay is a median, so one very late invoice cannot skew it',
       late.X.typicalDays === 11, String(late.X.typicalDays));

    ck('every field carries its sample count, so "always" and "once" differ',
       typeof p['Custom Alloys'].receipts === 'number' && p['Custom Alloys'].receipts === 2
       && typeof p['Custom Alloys'].feeSamples === 'number', JSON.stringify(p['Custom Alloys']));

    ck('a receipt with no customer is skipped rather than filed under ""',
       !Object.keys(L.patternsFromHistory([{ customer: '  ', date: '2026-01-01', allocations: [] }], sales)).length,
       JSON.stringify(L.patternsFromHistory([{ customer: '  ', date: '2026-01-01', allocations: [] }], sales)));
    ck('  and no receipts at all is an empty object, not a throw',
       JSON.stringify(L.patternsFromHistory([], sales)) === '{}');
    ck('  an allocation naming a sale that no longer exists does not throw',
       (() => { try { L.patternsFromHistory([{ customer: 'Y', date: '2026-01-01', allocations: [{ sale_id: 'GONE', amount: 5 }] }], sales); return true; } catch (e) { return false; } })());
}

// ── E — A BROKEN LEARNING FILE DEGRADES TO ASKING ─────────────────────────
// The direction of failure matters. Unreadable learning must mean "nothing
// learned yet", which means it asks her — never a crash in the middle of
// reconciling, and never a silently wrong resolution.
{
    section('E — when the file is unreadable');

    for (const junk of ['not json at all', '[]', '{"aliases":"nope"}', 'null', '{}']) {
        fs.writeFileSync(process.env.BANK_LEARN_FILE, junk);
        let ok = false, got = null;
        try { got = L.listAliases(); ok = Array.isArray(got) && got.length === 0; } catch (e) { ok = false; got = e.message; }
        ck(`'${junk.slice(0, 22)}' gives no aliases rather than throwing`, ok, JSON.stringify(got));
    }
    fs.writeFileSync(process.env.BANK_LEARN_FILE, '[]');
    ck('  and a resolver built on it resolves nothing',
       L.resolverFrom(L.listAliases(), ['Custom Alloys'])('WIRE IN CUSTOM ALLOYS') === null);
    ck('  while a real customer name still resolves — the ledger is not the broken part',
       L.resolverFrom(L.listAliases(), ['Custom Alloys'])('Custom Alloys') === 'Custom Alloys');

    // And it must be able to recover: learning over a broken file works.
    await L.learnAlias('WIRE IN CUSTOM ALLOYS', 'Custom Alloys');
    ck('  learning over a broken file repairs it',
       L.resolverFrom(L.listAliases(), ['Custom Alloys'])('WIRE IN CUSTOM ALLOYS') === 'Custom Alloys',
       'otherwise one hand-edit wedges the feature for ever');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
