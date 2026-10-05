// ── tests/qb-agent-asks-once.js ───────────────────────────────────────────
// Apsara, 2026-10-05: "Make this quick book in jarvis such a perfect user
// friendly highly intelligent agent".
//
// ── THE GAP THAT MAKES IT A CRON JOB ─────────────────────────────────────
// helpers/quickbooks/decisions.js opens by naming its own purpose:
//
//   "The difference between an agent and a cron job that nags is that the
//    agent asks once."
//
// It stores her answers — specific ("these two are not duplicates") and
// standing ("Garduno's bills at one total on one day are separate hauls") —
// in git, beside the name map. It is good, and it was consulted in exactly
// ONE place: checks.js. Not by the QB Agent.
//
// So the morning mail re-reported the same ten doubled documents and the same
// sixteen cheques every single day, including the ones she had opened, judged
// and dismissed. An agent that cannot be told anything is one she stops
// reading — and then it is worse than nothing, because the day something NEW
// appears it is sitting in a list she has learned to skip.
//
// ── AND THE RULE THAT KEEPS IT HONEST ────────────────────────────────────
// checks.js already had the right answer and this copies it word for word:
// "Silenced, never deleted — a rule quietly hiding a growing pile is its own
// problem, so they stay counted." The risk of an agent that can be told to
// stop asking is that it stops asking about something that later matters. So
// every silenced finding stays counted, is reported as a count, and says it
// can be un-answered.
//
// Both halves are tested: that it goes quiet, AND that going quiet is visible.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qb-once-'));
process.env.JARVIS_TEST = '1';
process.env.DATA_DIR = TMP;
// Her real decisions live in qb-settings/ and are in git. Pointed at a temp
// file so this never reads, and above all never WRITES, the real ones.
process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json');

const ROOT = path.join(__dirname, '..');
const decisions = require(path.join(ROOT, 'helpers/quickbooks/decisions'));
if (!String(decisions.FILE()).startsWith(TMP)) {
    console.error('  ABORT  decisions file is not isolated — refusing to touch her real answers');
    process.exit(1);
}

const books = require(path.join(ROOT, 'helpers/quickbooks/books'));
const agent = require(path.join(ROOT, 'helpers/quickbooks/agent'));

// ── A SURVEY WITH TWO DOUBLED PAIRS AND TWO CHEQUES ───────────────────────
// Stubbed at books.duplicates and agent.miscodedCheques — property access on
// the module object, which is the seam that is actually reached.
const groups = () => ([
    { id: 'DUP_A', party: 'Mazariegos Recycling', cost: 51000,
      rows: [{ id: 'BILL_1' }, { id: 'BILL_2' }], containers: ['MSDU1111111'] },
    { id: 'DUP_B', party: 'Calderon Cores', cost: 20000,
      rows: [{ id: 'BILL_3' }, { id: 'BILL_4' }], containers: ['TCNU5059310'] },
]);
const empty = () => ({ duplicate: { groups: [], cost: 0 }, doubledLine: { groups: [], cost: 0 }, sameContainer: { groups: [], cost: 0 } });
const dupeFixture = () => ({
    unapplied: { total: 0, payments: 0, byParty: [] },
    suppliers: { ...empty(), duplicate: { groups: groups(), cost: 71000 } },
    customers: empty(),
});
const miscodedFixture = () => ({
    number: 100000, count: 2,
    fixable: { count: 1, money: 60000, rows: [{ id: 'CHQ_1', date: '2026-03-02', payee: 'Junk Car', amount: 60000, containers: [] }] },
    noPayee: { count: 1, money: 40000, rows: [{ id: 'CHQ_2', date: '2026-07-02', payee: null, amount: 40000, containers: [] }] },
    span: ['2026-03-02', '2026-07-02'],
});

books.duplicates = async () => dupeFixture();
books.overview = async () => ({ owe: { total: 100 }, payable: [] });

// ── STUBBED AT client.query, NOT AT agent.miscodedCheques ────────────────
// survey() calls miscodedCheques as a LOCAL function, so replacing the export
// does nothing — the third time this seam has caught me this week (the live
// Google sheet on Saturday, invoiceVerify yesterday, this). Stubbing one
// level down at client.query is both reachable AND more faithful: the real
// miscodedCheques runs, including its cost-of-goods line filter, so a change
// to that filter turns these checks red.
const client = require(path.join(ROOT, 'helpers/quickbooks/client'));
const cogs = (amount) => ({ Amount: amount, DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: { AccountRef: { name: 'Cost of Goods Sold', value: '80' } } });
client.query = async (q) => {
    if (!/from Purchase/i.test(String(q))) return {};
    return { Purchase: [
        { Id: 'CHQ_1', TxnDate: '2026-03-02', TotalAmt: 60000,
          EntityRef: { name: 'Junk Car', value: '7' }, Line: [cogs(60000)] },
        // No EntityRef at all — the nameless half.
        { Id: 'CHQ_2', TxnDate: '2026-07-02', TotalAmt: 40000, Line: [cogs(40000)] },
        // A purchase with NO cost-of-goods line must be ignored entirely; if
        // the filter ever stops working this row appears and the counts move.
        { Id: 'CHQ_3', TxnDate: '2026-08-01', TotalAmt: 999, EntityRef: { name: 'Someone', value: '9' },
          Line: [{ Amount: 999, DetailType: 'AccountBasedExpenseLineDetail',
                   AccountBasedExpenseLineDetail: { AccountRef: { name: 'Office Supplies', value: '1' } } }] },
    ] };
};
void miscodedFixture;
// The other survey legs are not what this file is about; make them quiet.
for (const m of ['receivables', 'payables', 'applyReceipts']) {
    try {
        const mod = require(path.join(ROOT, 'helpers/quickbooks', m));
        if (mod.survey) mod.survey = async () => null;
        if (mod.plan) mod.plan = async () => null;
    } catch (e) { /* not all exist in every build */ }
}

(async () => {

// ── A — BEFORE SHE ANSWERS ANYTHING ───────────────────────────────────────
{
    section('A — nothing answered yet');

    const s = await agent.survey({ year: 2026, env: 'production' });
    ck('both doubled pairs are reported', s.invariants.duplicates.count === 2,
       String(s.invariants.duplicates.count));
    ck('  with their money', s.invariants.duplicates.number === 71000,
       String(s.invariants.duplicates.number));
    ck('  and nothing is silenced', !s.invariants.duplicates.silenced,
       String(s.invariants.duplicates.silenced));
    ck('both cheques are reported', s.invariants.miscoded.count === 2,
       String(s.invariants.miscoded.count));

    const text = agent.reportText({ survey: s, did: [], asked: [], dryRun: false });
    ck('  and the mail says nothing about answers', !/already answered|answered them already/.test(text));
}

// ── B — SHE ANSWERS ONE ───────────────────────────────────────────────────
// "These two are not duplicates." It must not come back tomorrow.
{
    section('B — she answers one doubled pair');

    decisions.remember({
        about: 'duplicate', subjects: ['BILL_1', 'BILL_2'], party: 'Mazariegos Recycling',
        verdict: 'not-duplicate', reason: 'two separate hauls on the same day', by: 'apsara',
    });

    const s = await agent.survey({ year: 2026, env: 'production' });
    ck('it is not reported again', s.invariants.duplicates.count === 1,
       String(s.invariants.duplicates.count));
    ck('  and the money shrinks with the list',
       s.invariants.duplicates.number === 20000, String(s.invariants.duplicates.number));
    ck('  the OTHER pair is untouched',
       s.invariants.duplicates.suppliers.duplicate.groups[0].id === 'DUP_B',
       JSON.stringify(s.invariants.duplicates.suppliers.duplicate.groups.map((g) => g.id)));
}

// ── C — SILENCED IS NOT HIDDEN ────────────────────────────────────────────
// The half that keeps this safe. An agent that can be told to stop asking
// will one day stop asking about something that matters.
{
    section('C — it says what it is not showing');

    const s = await agent.survey({ year: 2026, env: 'production' });

    ck('the silenced one is still counted', s.invariants.duplicates.silenced === 1,
       String(s.invariants.duplicates.silenced));
    ck('  and kept, with her own reason on it',
       (s.invariants.duplicates.suppliers.duplicate.silencedGroups || []).length === 1
       && /separate hauls/.test(s.invariants.duplicates.suppliers.duplicate.silencedGroups[0].answeredWhy || ''),
       JSON.stringify((s.invariants.duplicates.suppliers.duplicate.silencedGroups || [])
           .map((g) => g.answeredWhy)));
    ck('  and when she answered it',
       !!(s.invariants.duplicates.suppliers.duplicate.silencedGroups[0] || {}).answeredAt);

    const text = agent.reportText({ survey: s, did: [], asked: [], dryRun: false });
    ck('the mail says one is not shown', /1 not shown, you have already answered those/.test(text),
       (text.split('\n').find((l) => /doubled/.test(l)) || '(missing)'));
    ck('  and says it can be undone',
       /still counted, never deleted/.test(text) && /un-answered/.test(text),
       'without this, silenced becomes disappeared within a week');
}

// ── D — A CHEQUE SHE HAS ACCEPTED ─────────────────────────────────────────
// A different kind of answer — about a finding, not a pair — and it must work
// the same way.
{
    section('D — she accepts a cheque');

    decisions.remember({
        about: 'finding', subjects: ['CHQ_1'], party: 'Junk Car',
        verdict: 'accepted', reason: 'that one really is cost of goods', by: 'apsara',
    });

    const s = await agent.survey({ year: 2026, env: 'production' });
    ck('it stops being listed', s.invariants.miscoded.count === 1, String(s.invariants.miscoded.count));
    ck('  the named pile shrinks', s.invariants.miscoded.fixable.count === 0
        && s.invariants.miscoded.fixable.money === 0,
       JSON.stringify({ c: s.invariants.miscoded.fixable.count, m: s.invariants.miscoded.fixable.money }));
    ck('  the nameless one is untouched', s.invariants.miscoded.noPayee.count === 1,
       String(s.invariants.miscoded.noPayee.count));
    ck('  the total follows the rows', s.invariants.miscoded.number === 40000,
       String(s.invariants.miscoded.number));
    ck('  and it is still counted as silenced', s.invariants.miscoded.silenced === 1,
       String(s.invariants.miscoded.silenced));

    const text = agent.reportText({ survey: s, did: [], asked: [], dryRun: false });
    ck('the mail reports both silenced findings together',
       /2 findings above are not listed/.test(text),
       (text.split('\n').find((l) => /not listed/.test(l)) || '(missing)'));
}

// ── E — UN-ANSWERING BRINGS IT BACK ───────────────────────────────────────
// The promise the mail makes. If forget() did not restore the finding, the
// sentence would be a lie.
{
    section('E — she changes her mind');

    const all = decisions.list();
    const dup = all.find((d) => d.about === 'duplicate');
    ck('the decision is on file', !!dup, JSON.stringify(all.map((d) => d.about)));

    decisions.forget(dup.id);
    const s = await agent.survey({ year: 2026, env: 'production' });
    ck('the pair is reported again', s.invariants.duplicates.count === 2,
       String(s.invariants.duplicates.count));
    ck('  with its money back', s.invariants.duplicates.number === 71000,
       String(s.invariants.duplicates.number));
    ck('  and nothing silenced on that side', !s.invariants.duplicates.silenced,
       String(s.invariants.duplicates.silenced));
}

// ── F — A BROKEN DECISIONS FILE MUST NOT BLIND THE AGENT ──────────────────
// Failing OPEN is the only safe direction: if her answers cannot be read, the
// agent must report everything rather than silently report nothing.
{
    section('F — when the answers cannot be read');

    fs.writeFileSync(decisions.FILE(), '{ not json');
    let err = null; let s = null;
    try { s = await agent.survey({ year: 2026, env: 'production' }); } catch (e) { err = e; }
    ck('the survey still runs', !err, err && err.message);
    ck('  and reports everything rather than nothing',
       !!s && s.invariants.duplicates.count === 2 && s.invariants.miscoded.count === 2,
       JSON.stringify({ d: s && s.invariants.duplicates.count, m: s && s.invariants.miscoded.count }));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
