// ── tests/banks.js ────────────────────────────────────────────────────────
// Apsara, 2026-09-09: "I want to create an option for zelle,wire --> options
// like BofA, Chase Bank, Others. when they select others a text box should
// appear in mobile app and website."
//
// WHAT THIS GUARDS, in order of how badly it fails:
//   1. a payment recorded with NO bank on a Zelle or a Wire — the gap this
//      feature exists to close, reopening silently
//   2. a bank stored on a CASH payment — "paid cash from Chase" is a sentence
//      that is not true, and it would go on the ledger looking authoritative
//   3. the same account under two spellings, so the report grows two columns
//      for one bank and neither figure is the real one
//   4. old payments, which have no bank at all, being dropped from the report
//      rather than counted under "Not recorded"
//   5. the two clients drifting apart, which is how one of them comes to
//      offer a bank the server rejects

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
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-banks-'));

const banks = require(path.join(ROOT, 'helpers/banks.js'));
const sr = require(path.join(ROOT, 'helpers/spendReport.js'));

(async () => {

console.log('\n─ which account the money left ──────────────────────────────');

section('A — the two she named, and the escape hatch');
{
    ck('BofA and Chase Bank are offered',
       banks.options().includes('BofA') && banks.options().includes('Chase Bank'),
       JSON.stringify(banks.options()));
    // The label is SENT to the clients rather than hardcoded in each. A client
    // sending "Other" to a server expecting "Others" is a 400 she would read
    // as a broken Save button, not as a mismatched string.
    ck('  and "Others" is the exact label both clients are told to use',
       banks.OTHER === 'Others');
    ck('  Zelle and Wire are the modes that have a bank',
       banks.needsBank('Zelle') && banks.needsBank('Wire'));
    ck('  Cash and Cheque do not',
       !banks.needsBank('Cash') && !banks.needsBank('Cheque'));
    ck('  and the check is case-insensitive, because clients send what they send',
       banks.needsBank('zelle') && banks.needsBank('WIRE'));
}

section('B — what it refuses, and why each one matters');
{
    // 1. THE GAP THIS EXISTS TO CLOSE.
    for (const mode of ['Zelle', 'Wire']) {
        for (const bad of ['', '   ', null, undefined]) {
            let threw = null;
            try { await banks.resolveForMode(mode, bad, { required: true }); } catch (e) { threw = e.message; }
            ck(`a ${mode} with no bank (${JSON.stringify(bad)}) is refused`, !!threw, String(threw));
        }
    }
    // The message has to say what to DO. "Invalid bank" would be true and
    // useless; she is standing at a form with a dropdown in front of her.
    let msg = '';
    try { await banks.resolveForMode('Zelle', '', { required: true }); } catch (e) { msg = e.message; }
    ck('  and the refusal names the escape hatch',
       /Others/.test(msg) && /Zelle/.test(msg), msg);

    // 2. A BANK ON CASH IS A CLAIM THAT IS NOT TRUE.
    for (const mode of ['Cash', 'Cheque']) {
        let threw = null;
        try { await banks.resolveForMode(mode, 'Chase Bank'); } catch (e) { threw = e.message; }
        // Refused whether or not the caller said it was required: a bank on a
        // cash payment is a false statement, not a missing one.
        let threwToo = null;
        try { await banks.resolveForMode(mode, 'Chase Bank', { required: true }); } catch (e) { threwToo = e.message; }
        ck(`  ...and refused from the forms too`, !!threwToo, String(threwToo));
        ck(`a bank on a ${mode} payment is refused, not ignored`, !!threw, String(threw));
    }
    // REFUSED rather than silently dropped, and this is the assertion that
    // says so: a dropped field makes the form look like it saved something it
    // did not, which is the failure mode that survives longest.
    ck('  Cash with no bank is fine and stores null',
       (await banks.resolveForMode('Cash', null, { required: true })) === null);
    ck('  Cash with an empty string is also fine',
       (await banks.resolveForMode('Cash', '', { required: true })) === null);
}

section('C — one account, one spelling');
{
    ck('the canonical spelling comes back, whatever she typed',
       (await banks.resolveForMode('Zelle', 'bofa', { required: true })) === 'BofA'
       && (await banks.resolveForMode('Zelle', '  CHASE BANK ', { required: true })) === 'Chase Bank');

    // Her choice over a Banks screen: "Fixed three, but Others text is
    // remembered". Typed once, offered ever after.
    const first = await banks.resolveForMode('Wire', 'Wells Fargo');
    ck('a bank typed under Others is stored as she typed it', first === 'Wells Fargo');
    ck('  and is on the list next time', banks.options().includes('Wells Fargo'),
       JSON.stringify(banks.options()));
    // FIRST SPELLING WINS. Two spellings of one account is worse than either,
    // because the report would grow two columns and neither is the real total.
    ck('  a different casing later resolves to the first spelling',
       (await banks.resolveForMode('Wire', 'wells fargo')) === 'Wells Fargo');
    ck('  and it is not added twice',
       banks.options().filter((b) => b.toLowerCase() === 'wells fargo').length === 1);

    // Rendered into two clients and a PDF, so it cannot be unbounded.
    const long = await banks.resolveForMode('Wire', 'x'.repeat(200));
    ck('  a pasted essay is capped rather than stored whole', long.length <= 40, String(long.length));
    const spaced = await banks.resolveForMode('Wire', 'First   Republic\n Bank');
    ck('  and newlines and runs of spaces are flattened',
       spaced === 'First Republic Bank', JSON.stringify(spaced));
}

section('D — the report counts every row, including the ones with no bank');
{
    // The mixture she actually has: new payments with a bank, old ones
    // without, and cash which never has one.
    const payments = [
        { id: 'p1', load_id: 'L1', load_kind: 'purchase', mode: 'Zelle', bank: 'BofA', amount: 100, paid_on: '2026-09-01' },
        { id: 'p2', load_id: 'L2', load_kind: 'purchase', mode: 'Wire', bank: 'Chase Bank', amount: 250, paid_on: '2026-09-02' },
        { id: 'p3', load_id: 'T1', load_kind: 'trucker', mode: 'Zelle', bank: 'BofA', amount: 40, paid_on: '2026-09-03' },
        { id: 'p4', load_id: 'L4', load_kind: 'purchase', mode: 'Cash', amount: 15, paid_on: '2026-09-04' },
        // Written before 2026-09-09. No bank, and nothing migrates it.
        { id: 'p5', load_id: 'L5', load_kind: 'purchase', mode: 'Zelle', amount: 70, paid_on: '2026-08-20' },
    ];
    const rep = sr.buildSpendReport({ payments, expenses: [], pettyEntries: [] });

    // THE ARITHMETIC THAT MATTERS. A breakdown that does not reconcile with
    // its own total invites her to pick which number to believe.
    const bankSum = Object.values(rep.byBank).reduce((a, b) => a + b, 0);
    ck('the per-bank figures add up to the total exactly',
       Math.abs(bankSum - rep.total) < 0.005,
       `${bankSum} vs ${rep.total}`);
    ck('  BofA carries both its payments', rep.byBank['BofA'] === 140, JSON.stringify(rep.byBank));
    ck('  including the trucker one, not only the load',
       rep.byBank['BofA'] === 140, 'a trucker payment is money out of the same account');

    // 4. OLD ROWS ARE COUNTED, NOT DROPPED. This is the assertion that stops
    //    a future "tidy-up" from filtering them out and quietly shrinking the
    //    total.
    ck('  payments with no bank are counted under "Not recorded"',
       rep.byBank[sr.NOT_RECORDED] === 85, JSON.stringify(rep.byBank));
    ck('    which is the old Zelle AND the cash, both of which are real spend',
       rep.byBank[sr.NOT_RECORDED] === 70 + 15);
    // Its own name, not "Unclassified" — that already means "a payment METHOD
    // not on the list" on this report, and two unknowns sharing a label is how
    // a report gets misread.
    ck('    under its own name, not the method report\'s "Unclassified"',
       sr.NOT_RECORDED !== sr.UNCLASSIFIED);
}

section('E — filtering by bank narrows every figure, not just the rows');
{
    const payments = [
        { id: 'p1', load_id: 'L1', load_kind: 'purchase', mode: 'Zelle', bank: 'BofA', amount: 100, paid_on: '2026-09-01' },
        { id: 'p2', load_id: 'L2', load_kind: 'purchase', mode: 'Wire', bank: 'Chase Bank', amount: 250, paid_on: '2026-09-02' },
        { id: 'p3', load_id: 'T1', load_kind: 'trucker', mode: 'Zelle', bank: 'BofA', amount: 40, paid_on: '2026-09-03' },
    ];
    const only = sr.buildSpendReport({ payments, expenses: [], pettyEntries: [], bank: 'BofA' });
    // The same rule the method filter follows, and for the same reason: a
    // filter that hides rows but leaves the totals alone is a report where the
    // header disagrees with the table.
    ck('the total follows the filter', only.total === 140, String(only.total));
    ck('  the load and trucker splits follow it too',
       only.loadTotal === 100 && only.truckerTotal === 40,
       `${only.loadTotal} / ${only.truckerTotal}`);
    ck('  and they still reconcile with the total',
       Math.abs((only.loadTotal + only.expenseTotal + only.truckerTotal) - only.total) < 0.005);
    ck('  matching is case-insensitive, so a typed filter still finds it',
       sr.buildSpendReport({ payments, expenses: [], pettyEntries: [], bank: 'bofa' }).total === 140);
    ck('  the filter is echoed back so an empty report explains itself',
       sr.buildSpendReport({ payments, expenses: [], pettyEntries: [], bank: 'Nowhere' }).bank === 'Nowhere');
    ck('  and an unknown bank reports zero rather than everything',
       sr.buildSpendReport({ payments, expenses: [], pettyEntries: [], bank: 'Nowhere' }).total === 0);

    // ── AND SHE CAN FILTER TO THE GAP ITSELF ─────────────────────────────
    // "Not recorded" is a filter value, not just a label. It is how she finds
    // the Zelles from before the bank field existed — the ONLY way that gap
    // ever gets closed, since nothing migrates them.
    //
    // This also happens to be the assertion that makes the NOT_RECORDED
    // fallback in collectRows load-bearing: without it those rows carry null,
    // the per-bank tally still totals correctly because it has its own
    // fallback, and only the filter breaks. Two guards overlapping is how a
    // mutation of one survives a whole suite — found exactly that way.
    const withGap = [
        { id: 'g1', load_id: 'L1', load_kind: 'purchase', mode: 'Zelle', bank: 'BofA', amount: 100, paid_on: '2026-09-01' },
        { id: 'g2', load_id: 'L2', load_kind: 'purchase', mode: 'Zelle', amount: 70, paid_on: '2026-08-20' },
        { id: 'g3', load_id: 'L3', load_kind: 'purchase', mode: 'Cash', amount: 15, paid_on: '2026-09-04' },
    ];
    const gap = sr.buildSpendReport({ payments: withGap, expenses: [], pettyEntries: [], bank: sr.NOT_RECORDED });
    ck('filtering on "Not recorded" finds the payments with no bank',
       gap.total === 85, String(gap.total));
    ck('  and only those', gap.rows.length === 2 && !gap.rows.some(r => r.bank === 'BofA'),
       JSON.stringify(gap.rows.map(r => r.bank)));
    ck('  and it is offered as a filter, not only as a label',
       (sr.buildSpendReport({ payments: withGap, expenses: [], pettyEntries: [] }).bankColumns || [])
         .includes(sr.NOT_RECORDED));

    // Method and bank compose. "Wire out of Chase last month" is one question.
    const both = sr.buildSpendReport({ payments, expenses: [], pettyEntries: [], method: 'Wire', bank: 'Chase Bank' });
    ck('  method and bank narrow together', both.total === 250, String(both.total));
    const contradiction = sr.buildSpendReport({ payments, expenses: [], pettyEntries: [], method: 'Cash', bank: 'BofA' });
    ck('  and a combination nothing matches is zero, not everything',
       contradiction.total === 0, String(contradiction.total));
}

section('F — both clients offer the same thing, and neither invents it');
{
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

    for (const [name, src] of [['website', web], ['mobile app', app]]) {
        ck(`the ${name} has a bank field on the load pay form`,
           /id="pay_bank"/.test(src) && /id="pay_bank_other"/.test(src));
        ck(`  and on the trucker pay form`,
           /id="trk_pay_bank"/.test(src) && /id="trk_pay_bank_other"/.test(src));
        // The text box appears only for Others — her actual request.
        ck(`  the ${name} hides the text box until Others is chosen`,
           /sel\.value === bankOther/.test(src));
        ck(`  and hides the whole row for a mode with no bank`,
           /row\.style\.display = needs \? '' : 'none'/.test(src));
        // Sent as null rather than '' for Cash, or the server refuses it.
        ck(`  the ${name} sends null when the mode has no bank`,
           /if \(!bankModes\.some\(m => m\.toLowerCase\(\) === String\(mode\)\.toLowerCase\(\)\)\) return null;/.test(src));
        // THE LIST COMES FROM THE SERVER. A hardcoded list in a client is the
        // one that drifts, and the way it fails is a Save button that does
        // nothing while the dropdown looks perfectly reasonable.
        ck(`  and takes the list from the server, not from itself`,
           /data\.banks/.test(src) && /bankOptions = d\.banks/.test(src));
    }

    // The two are meant to behave identically, so the shared helpers must be
    // literally the same text — not merely similar. Similar is what drifts.
    const grab = (src) => {
        const i = src.indexOf('function syncBankFields(prefix) {');
        return i === -1 ? null : src.slice(i, src.indexOf('\n}', i));
    };
    ck('the two clients share the SAME bank logic, character for character',
       grab(web) && grab(web) === grab(app),
       'if these drift, one client offers what the other cannot save');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})();
