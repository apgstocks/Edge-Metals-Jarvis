// ── tests/bank-review.js ──────────────────────────────────────────────────
// Apsara, 2026-10-08: "i want like pending,posted transactions like qb with
// match,post", then "add as a carrier bill that is also better", then "match
// it better than quickbook in every part so that it eases customer issues
// completely".
//
// helpers/bankReview.js turns two matchers into one queue with one row
// shape. The checks here are mostly about the places QuickBooks is WORSE,
// because "better than QuickBooks" has to mean specific things or it means
// nothing:
//
//   · QuickBooks picks a match when several fit. This refuses.
//   · QuickBooks' "Add" names a category. This names the RECORD it will
//     create, which is what she cares about afterwards.
//   · QuickBooks offers bulk-accept over its own guesses. This offers it
//     only over exact matches, never over a guess from a descriptor.
//   · QuickBooks shows a row with no reason. Every row here carries why.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-review-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'helpers/bankReview'));

// ── ...o LAST CLOBBERS THE MERGE ────────────────────────────────────────
// First version put `...o` after the merged `deposit`/`row`, and `o`
// contains those keys — so the carefully merged default was thrown away and
// every partial fixture arrived with no amount, failing the CENT filter.
// Three checks went red reporting zero of everything, which looked like a
// bug in the queue and was a bug in the helper two lines above it.
const dep = (o) => ({ ...o, deposit: { id: 'd', date: '2026-10-06', amount: 1000, descriptor: '', ...(o.deposit || {}) } });
const wd = (o) => ({ ...o, row: { id: 'w', date: '2026-10-04', amount: 1000, descriptor: '', ...(o.row || {}) } });

// ── A — MONEY IN AND MONEY OUT ARE ONE MORNING'S WORK ─────────────────────
// They had entirely separate machinery and only one of them had a screen.
// A page with the receipts on it and the payments somewhere else is how
// half the bank goes unlooked-at for a month.
{
    section('A — one queue, both directions');
    const q = R.queue({
        depositResults: [dep({ deposit: { id: 'in1', amount: 5000, date: '2026-10-06' }, party: 'Eccomelt',
            proposals: [{ reasons: ['one invoice, to the cent'] }] })],
        withdrawalResults: [wd({ row: { id: 'out1', amount: 2180, date: '2026-10-07', descriptor: 'AJ TRANSPORT LLC' },
            outcome: 'not_recorded' })],
    });
    ck('both directions are in the same list', q.rows.length === 2, String(q.rows.length));
    ck('  newest first, the way a bank screen reads',
       q.rows[0].id === 'out1', q.rows.map((r) => r.id).join(','));
    ck('  and the money is counted per direction',
       q.money.in === 5000 && q.money.out === 2180, JSON.stringify(q.money));
    ck('a zero-amount row never reaches her', R.queue({
        depositResults: [dep({ deposit: { amount: 0 } })] }).rows.length === 0);
}

// ── B — THE BUTTON NAMES WHAT WILL EXIST ──────────────────────────────────
// Her words on the mock-up: "add as a carrier bill that is also better".
// QuickBooks says "Add" and makes you pick a category; the useful question
// is what record you will have afterwards.
{
    section('B — the button names the record, not the category');
    const ntg = R.fromWithdrawal(wd({ row: { descriptor: 'NTG LOGISTICS ACH DEBIT' }, outcome: 'not_recorded' }));
    ck('a carrier by name becomes "Add as a carrier bill"',
       ntg.state === 'add' && ntg.label === 'Add as a carrier bill', JSON.stringify(ntg.label));
    ck('  and carries the account it would post to', ntg.account === '5200', ntg.account);
    for (const n of ['NTG', 'TQL', 'Schneider']) {
        ck(`  ${n} too`, R.fromWithdrawal(wd({ row: { descriptor: `${n} PAYMENT` }, outcome: 'not_recorded' })).state === 'add');
    }
    const fee = R.fromWithdrawal(wd({ row: { descriptor: 'MONTHLY MAINTENANCE FEE' }, outcome: 'not_recorded' }));
    ck('a bank fee becomes "Add as a bank charge"', fee.label === 'Add as a bank charge', fee.label);

    // ── A BUTTON WHOSE EXECUTOR WOULD REFUSE IT ──────────────────────────
    // Correction, 2026-10-10. The first version of this file asserted that
    // AJ Transport, Sher, Jio and Zimex all became `add` — and they did.
    // There is no store that would have taken the record:
    //
    //   carrierInvoices.CARRIERS  tql, ntg, schneider. addManual() exists.
    //   partyInvoices.PARTIES     zimex, eagle, jio, sher, ajtransport,
    //                             panmetal, gardunos. Rows come from her
    //                             Google sheet via upsertMany(), there is
    //                             no single-row add, and it has a lock.
    //
    // So the test was green on a promise nothing could keep — CLAUDE.md's
    // named trap (a requirement in shared code one caller cannot satisfy)
    // one layer up, with a BUTTON as the thing that cannot be satisfied.
    // Pressing it would have gone to carrierInvoices.addManual and come
    // back "carrier must be one of tql, ntg, schneider".
    const CI = require(path.join(ROOT, 'helpers/carrierInvoices'));
    const PI = require(path.join(ROOT, 'helpers/partyInvoices'));
    for (const n of ['AJ TRANSPORT LLC', 'SHER TRUCKING', 'JIO', 'ZIMEX', "GARDUNO'S",
                     'EAGLE BRIT', 'PAN METAL']) {
        const r = R.fromWithdrawal(wd({ row: { descriptor: `${n} ACH DEBIT` }, outcome: 'not_recorded' }));
        ck(`  ${n} is NOT offered a button no store would honour`, r.state === 'ask', JSON.stringify(r));
        // It still says what Jarvis knew it was — the row is not dumber for
        // being honest about what one press can do.
        ck(`    but Jarvis still recognised it`, r.kind === 'party-invoice', JSON.stringify(r.kind));
        ck(`    and says where to pay it instead`, /Transport tab|sheet/.test(r.why || ''), r.why);
    }

    // ── AND THE TABLE STAYS IN STEP WITH THE STORE ───────────────────────
    // bankReview.js is pure and may not require either store, so the
    // invariant lives here: every name the carrier-bill rule claims must be
    // one carrierInvoices will actually accept. The next person to add a
    // hauler will add it to a regex and not read the comment above it.
    const carrierRule = R.KINDS.find((k) => k.kind === 'carrier-bill');
    ck('the carrier-bill rule matches every carrier the store accepts',
       CI.CARRIERS.every((c) => carrierRule.re.test(c)), JSON.stringify(CI.CARRIERS));
    ck('  and matches NO party-register hauler',
       !Object.keys(PI.PARTIES).some((p) => carrierRule.re.test(p)),
       Object.keys(PI.PARTIES).filter((p) => carrierRule.re.test(p)).join(','));
    ck('  and every postable kind names the store that will take it',
       R.KINDS.filter((k) => k.postable).every((k) => !!k.store),
       JSON.stringify(R.KINDS.map((k) => [k.kind, k.postable, k.store])));

    // ── AND IT REFUSES TO GUESS WHEN IT CANNOT TELL ──────────────────────
    // A fallback of "Add as an expense" would be a category chosen by the
    // ABSENCE of information, and 6300 would slowly fill with everything
    // nobody classified. Worse, it would look like a decision.
    const unknown = R.fromWithdrawal(wd({ row: { descriptor: 'POS PURCHASE 4411' }, outcome: 'not_recorded' }));
    ck('an unrecognised payee gets NO suggested record', unknown.state === 'ask', JSON.stringify(unknown));
    ck('  and asks her instead of defaulting to an expense',
       !/expense/i.test(unknown.label) && R.guessKind('POS PURCHASE 4411') === null, unknown.label);
}

// ── C — WHERE QUICKBOOKS IS WORSE, AND THE REASON IT MATTERS ─────────────
{
    section('C — several things fit, so nothing is chosen');
    const two = R.fromWithdrawal(wd({ outcome: 'ambiguous', proposals: [{ x: 1 }, { x: 2 }],
        note: 'two recorded payments come to exactly this' }));
    ck('an ambiguous withdrawal asks her to choose', two.state === 'choose' && two.label === 'Choose');
    ck('  and every rival is handed over, not just the first',
       (two.options || []).length === 2, String((two.options || []).length));
    const twoIn = R.fromDeposit(dep({ ambiguous: true, proposals: [{ x: 1 }, { x: 2 }] }));
    ck('the same on the money-in side', twoIn.state === 'choose' && (twoIn.options || []).length === 2);

    // ── THE BULK OFFER, AND WHAT IT MUST NOT COVER ───────────────────────
    // QuickBooks will happily accept its own guesses in bulk, which is how
    // a quarter of a ledger ends up categorised by a machine nobody
    // checked. Bulk here covers EXACT MATCHES only — a match creates
    // nothing, it ties two existing records together. Creating records in
    // bulk from a guess about a descriptor is a different and much worse
    // offer, however similar the button looks.
    const q = R.queue({
        depositResults: [dep({ deposit: { id: 'm1' }, proposals: [{ reasons: ['exact'] }] })],
        withdrawalResults: [
            wd({ row: { id: 'm2' }, outcome: 'matched', proposals: [{ reasons: ['exact'] }] }),
            wd({ row: { id: 'a1', descriptor: 'NTG FREIGHT' }, outcome: 'not_recorded' }),
            wd({ row: { id: 'c1' }, outcome: 'ambiguous', proposals: [{}, {}] }),
        ],
    });
    ck('post-all counts the exact matches', q.canPostAll === 2, String(q.canPostAll));
    ck('  and NEVER the ones that would create a record from a guess',
       q.canPostAll === q.counts.match && q.counts.add === 1,
       JSON.stringify(q.counts));
    ck('  nor the ambiguous one', q.counts.choose === 1);
}

// ── D — EVERY ROW SAYS WHY ────────────────────────────────────────────────
// At tax time the question is never "what did it think", it is "why is this
// $47,310.22 sitting against these three invoices". A row with a button and
// no reason cannot answer that, and QuickBooks' rows cannot.
{
    section('D — a row with no reason is not a row');
    const q = R.queue({
        depositResults: [dep({ party: 'Eccomelt', proposals: [{ reasons: ['3 invoices, to the cent'] }] }),
                         dep({ deposit: { id: 'd2' }, outcome: 'no_party', note: 'nothing in the ledger is named that' })],
        withdrawalResults: [wd({ row: { descriptor: 'TQL' }, outcome: 'not_recorded' }),
                            wd({ row: { id: 'w2' }, outcome: 'ambiguous', proposals: [{}, {}], note: 'two fit' })],
    });
    // Non-empty, not "longer than ten characters". My first version used a
    // length threshold and a legitimate fixture note of "two fit" failed it
    // — an arbitrary number standing in for the property, which is the
    // check shaped like the code rather than like the rule.
    ck('every row carries a why', q.rows.every((r) => String(r.why || '').trim().length > 0),
       JSON.stringify(q.rows.map((r) => [r.id, r.why])));
    ck('every row carries a state the screen knows',
       q.rows.every((r) => R.STATES.includes(r.state)), JSON.stringify(q.rows.map((r) => r.state)));
    ck('every row carries a button label', q.rows.every((r) => String(r.label || '').length > 2));
    ck('and a matched row hands over the match itself, for the trail',
       !!q.rows.find((r) => r.state === 'match').match);
}

// ── E — IT DECIDES NOTHING AND WRITES NOTHING ────────────────────────────
{
    section('E — pure');
    const before = fs.readdirSync(TMP).length;
    R.queue({ withdrawalResults: [wd({ outcome: 'matched', proposals: [{ reasons: ['x'] }] })] });
    ck('building the queue writes no file', fs.readdirSync(TMP).length === before);
    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankReview.js'), 'utf8');
    ck('  and the module has no store, no fetch, no mutateJson',
       !/mutateJson|require\('\.\/json'\)|fetch\(/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
