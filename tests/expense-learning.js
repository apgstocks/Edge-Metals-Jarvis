// ── tests/expense-learning.js ─────────────────────────────────────────────
// Apsara, 2026-10-26: make the product need "very less human intervention".
//
// Her own Expenses tab: Santiago filed under Labour five times, Rigo twice,
// Fede three times. Every one of those was a decision she made by hand and
// nothing remembered the first. helpers/expenseLearning.js derives the answer
// from her history rather than asking the model again.
//
// ── THE ASSERTION THAT MATTERS MOST IS SECTION C ─────────────────────────
// Learning from history means learning her MISTAKES too. Fede's rows are
// $99,243 of copper filed under "Other" — three times out of three, perfectly
// consistent, and wrong. A learner that acts on consistency alone would
// pre-fill "Other" for every future copper purchase and make a one-off
// mis-categorisation permanent with Jarvis's help. So a learned catch-all is
// never confident, however consistent, and the same vendor is reported as
// something to FIX.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-xl-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'helpers/expenseLearning'));

// HER REAL ROWS, from the Expenses tab she pasted on 2026-10-26. Used rather
// than invented ones because the catch-all trap in section C was found by
// running this on her data and not by imagining a case.
const HERS = [
    { id: 'EXP_23', date: '2026-10-10', amount: 1200, category: 'Labour', vendor: 'Santiago', method: 'Cash' },
    { id: 'EXP_22', date: '2026-10-10', amount: 150, category: 'Fuel', vendor: 'shell & 7/11', method: 'Cash' },
    { id: 'EXP_21', date: '2026-10-03', amount: 1200, category: 'Labour', vendor: 'Santiago', method: 'Cash' },
    { id: 'EXP_20', date: '2026-10-03', amount: 60, category: 'Labour', vendor: 'Rigo', method: 'Cash' },
    { id: 'EXP_17', date: '2026-09-26', amount: 100, category: 'Labour', vendor: 'Rego', method: 'Cash' },
    { id: 'EXP_16', date: '2026-09-16', amount: 200, category: 'Freight', vendor: 'Raman', method: 'Cash' },
    { id: 'EXP_13', date: '2026-09-12', amount: 1200, category: 'Labour', vendor: 'Santiago', method: 'Cash' },
    { id: 'EXP_10', date: '2026-09-05', amount: 25238, category: 'Other', vendor: 'Fede', method: 'Cash', description: 'Fede copper' },
    { id: 'EXP_09', date: '2026-09-05', amount: 1200, category: 'Labour', vendor: 'Santiago', method: 'Cash' },
    { id: 'EXP_07', date: '2026-09-03', amount: 39005, category: 'Other', vendor: 'Fede', method: 'Cash', description: 'Copper' },
    { id: 'EXP_06', date: '2026-09-02', amount: 35000, category: 'Other', vendor: 'Fede', description: 'copper advance 30k' },
];

// ─────────────────────────────────────────────────────────────────────────
section('A. a vendor she is consistent about');
{
    const c = L.categoryFor('Santiago', HERS);
    ck('Santiago comes back as Labour', c.category === 'Labour', JSON.stringify(c));
    ck('  and confidently — four of four', c.confident === true, c.why);
    ck('  with the evidence attached, so the reason can be SHOWN to her',
       /4 of her last 4/.test(c.why) && c.seen === 4, c.why);

    const m = L.methodFor('Santiago', HERS);
    ck('how he is paid is learned too — Cash', m.method === 'Cash' && m.confident === true, JSON.stringify(m));
    // Blank method is what sends an expense to 2090 Unallocated payments.
    ck('  which is the field whose absence costs a trip to 2090',
       m.confident === true, 'a vendor always paid in cash never needs asking');
}

// ─────────────────────────────────────────────────────────────────────────
section('B. not enough history, and no history at all');
{
    const rigo = L.categoryFor('Rigo', HERS);
    ck('one row is not a pattern', rigo.confident === false, rigo.why);
    ck('  and it says so plainly rather than hedging', /not a pattern yet/.test(rigo.why), rigo.why);
    ck('  but the guess is still offered for a human to accept',
       rigo.category === 'Labour', JSON.stringify(rigo));

    // ── A VENDOR SHE IS NOT CONSISTENT ABOUT ────────────────────────────
    // Added after a mutation SURVIVED: dropping CONFIDENT_AT from 0.8 to 0.1
    // changed nothing, because every vendor in her real rows is either
    // unanimous or the catch-all. The threshold was untested. Five rows,
    // three Labour and two Fuel — 0.6, a real majority and not a habit.
    const MIXED = [
        { id: 'M1', date: '2026-09-01', amount: 10, category: 'Labour', vendor: 'Mixed', method: 'Cash' },
        { id: 'M2', date: '2026-09-02', amount: 10, category: 'Labour', vendor: 'Mixed', method: 'Cash' },
        { id: 'M3', date: '2026-09-03', amount: 10, category: 'Labour', vendor: 'Mixed', method: 'Cash' },
        { id: 'M4', date: '2026-09-04', amount: 10, category: 'Fuel', vendor: 'Mixed', method: 'Cash' },
        { id: 'M5', date: '2026-09-05', amount: 10, category: 'Fuel', vendor: 'Mixed', method: 'Cash' },
    ];
    const mixed = L.categoryFor('Mixed', MIXED);
    ck('a vendor split 3/2 across categories is NOT confident', mixed.confident === false,
       `share ${mixed.share} — ${mixed.why}`);
    ck('  and the share is reported, not hidden', mixed.share === 0.6, String(mixed.share));
    ck('  the majority is still offered as a guess', mixed.category === 'Labour', JSON.stringify(mixed));
    ck('  and the alternative she also uses is named',
       (mixed.alternatives || []).some((a) => a.category === 'Fuel'), JSON.stringify(mixed.alternatives));
    // 4 of 5 IS a habit — one disagreement in five does not break a pattern.
    const nearly = L.categoryFor('Mixed', MIXED.map((r, i) => (i === 4 ? { ...r, category: 'Labour' } : r)));
    ck('  but 4 of 5 is confident — the threshold is 0.8, not unanimity',
       nearly.confident === true && nearly.share === 0.8, `${nearly.share} ${nearly.why}`);

    const none = L.categoryFor('Someone New', HERS);
    ck('an unknown vendor returns null, not a guess', none.category === null, JSON.stringify(none));
    ck('  and is never confident', none.confident === false, none.why);
    ck('a blank vendor is not treated as a vendor',
       L.categoryFor('', HERS).category === null && L.categoryFor(null, HERS).category === null);
}

// ─────────────────────────────────────────────────────────────────────────
section('C. THE CATCH-ALL TRAP — learning her mistakes back to her');
{
    // Fede: three rows, three times "Other", $99,243 of copper. Perfectly
    // consistent and completely wrong.
    const fede = L.categoryFor('Fede', HERS);
    ck('Fede IS consistently "Other" — the history really does say that',
       fede.category === 'Other' && fede.seen === 3, JSON.stringify(fede));
    ck('  but it is NOT confident, however consistent',
       fede.confident === false,
       'acting on this would pre-fill Other for every future copper purchase');
    ck('  and it says the catch-all is something to fix, not repeat',
       /something to fix rather than something to repeat/.test(fede.why), fede.why);

    // Three identical rows under a REAL category must still be confident —
    // otherwise the guard above is just breaking the feature.
    const real = L.categoryFor('Santiago', HERS);
    ck('  while the same consistency under a real category IS confident',
       real.confident === true, real.why);

    // The other half: the same vendor reported as a job, ranked by MONEY.
    const pile = L.catchAllVendors(HERS);
    ck('Fede is reported as piling into the catch-all', pile.length === 1 && pile[0].rows === 3,
       JSON.stringify(pile));
    ck('  with the VALUE, because 3 rows of $99k and 3 of $9 are not the same finding',
       pile[0].amount === 99243, String(pile[0].amount));
    ck('  and examples she will recognise', /copper/i.test(pile[0].examples.join(' ')),
       JSON.stringify(pile[0].examples));
    ck('  a vendor with ONE catch-all row is not yet a pattern',
       L.catchAllVendors([{ category: 'Other', vendor: 'Once', amount: 5 }]).length === 0);
}

// ─────────────────────────────────────────────────────────────────────────
section('D. exact after normalisation, never fuzzy');
{
    // Her yard has BOTH a Rigo and a Rego. One letter apart, two people, and
    // money filed against the wrong one is the failure nameMatch.js exists
    // to prevent.
    const rigo = L.historyFor('Rigo', HERS);
    const rego = L.historyFor('Rego', HERS);
    ck('Rigo and Rego are kept apart', rigo.seen === 1 && rego.seen === 1,
       `rigo ${rigo.seen}, rego ${rego.seen}`);
    ck('  neither absorbs the other', rigo.rows[0].id === 'EXP_20' && rego.rows[0].id === 'EXP_17',
       JSON.stringify([rigo.rows[0].id, rego.rows[0].id]));
    // Case and spacing SHOULD collapse — that is normalisation, not fuzziness.
    ck('case and spacing do not split one vendor in two',
       L.historyFor('  SANTIAGO ', HERS).seen === 4, String(L.historyFor('  SANTIAGO ', HERS).seen));
}

// ─────────────────────────────────────────────────────────────────────────
section('E. it derives, and writes nothing');
{
    const src = fs.readFileSync(path.join(ROOT, 'helpers/expenseLearning.js'), 'utf8');
    ck('no write of any kind in the module',
       !/mutateJson|writeFile|appendFile|saveJson|loadJson/.test(src),
       'a learned-rules file can disagree with the expenses it came from');
    const before = fs.readdirSync(TMP).length;
    L.categoryFor('Santiago', HERS); L.methodFor('Santiago', HERS); L.catchAllVendors(HERS);
    ck('  and calling it creates no file', fs.readdirSync(TMP).length === before, 'TMP grew');

    // A deleted expense must change the answer immediately — the whole point
    // of deriving rather than storing.
    const fewer = HERS.filter((e) => e.id !== 'EXP_09' && e.id !== 'EXP_13');
    const after = L.categoryFor('Santiago', fewer);
    ck('removing rows changes the verdict at once, with no stale rule left behind',
       after.seen === 2 && after.confident === false, JSON.stringify(after));
}

// ─────────────────────────────────────────────────────────────────────────
section('F. bad input does not throw');
{
    let threw = null;
    try {
        L.categoryFor('Santiago', [null, 'nonsense', 42, [], { }]);
        L.catchAllVendors([null, undefined, { category: 'Other' }]);
        L.methodFor('x', null);
        L.historyFor('x', undefined);
    } catch (e) { threw = e; }
    ck('a store with junk in it does not take the caller down', threw === null,
       threw && threw.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
