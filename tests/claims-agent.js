// ── tests/claims-agent.js ─────────────────────────────────────────────────
// Apsara, 2026-10-02: "Also for handling claims-I want to have an advanced
// agent because thats where we are losing money."
//
// Asked which of four leaks it was she said ALL FOUR, and gave the agent two
// powers — chase, and draft the recovery email — with no authority over money.
//
// ── WHY THE CHECKS CLUSTER AROUND TWO THINGS ──────────────────────────────
// The agent's value is one sentence: "we are absorbing $X because nobody
// raised the recovery." Its two ways of being worthless are:
//
//   · chasing a claim that is not actually stalled, which trains her to
//     ignore it;
//   · producing a total that includes a figure nobody verified, which makes
//     the one number she would act on untrustworthy.
//
// helpers/claims.js keeps claim_amount null until a human confirms the
// weights AND the unit, deliberately — her sheet holds "1,305.9KG" beside
// "58.901" beside "23,718" under a column headed MT, and a guess is wrong by
// a factor of 1000 in the figure she shows her uncle. So an unverified claim
// has NO money, and the agent must say so rather than reach for a shortage
// weight times a price nobody confirmed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claims-agent-'));
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const agent = require('../helpers/claimsAgent');

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const ahead = (d) => new Date(NOW + d * 86400000).toISOString();

// ── A — WHICH STAGE IS A CLAIM IN ─────────────────────────────────────────
{
    section('A — the stage, from the status and the figures');

    ck('unverified is unverified',
       agent.stageOf({ status: 'unverified' }) === agent.STAGE.UNVERIFIED);

    // THE DEFINITION THAT MATTERS, and it is the one stats() already uses:
    // verified with nothing recovered means we have absorbed it.
    ck('verified with no our_claim is AWAITING RECOVERY',
       agent.stageOf({ status: 'verified', claim_amount: 100, our_claim: null }) === agent.STAGE.AWAITING_RECOVERY,
       'this is the leak the code itself names: "most of what Edge has absorbed '
       + 'is a recovery nobody raised"');
    ck('  but verified WITH a figure recovered is unsettled, not absorbed',
       agent.stageOf({ status: 'verified', our_claim: 500 }) === agent.STAGE.UNSETTLED,
       'she has asked; it is now the supplier who owes');
    ck('recovery_raised is unsettled',
       agent.stageOf({ status: 'recovery_raised' }) === agent.STAGE.UNSETTLED);

    for (const s of ['settled', 'rejected', 'withdrawn']) {
        ck(`${s} is closed and never chased`,
           agent.stageOf({ status: s }) === agent.STAGE.CLOSED);
    }
}

// ── B — THE CLOCK STARTS WHEN THE STAGE DID ───────────────────────────────
{
    section('B — age is measured from the stage, not from the last edit');

    // THE TRAP: updated_at moves on ANY edit. Fixing a typo in a note would
    // reset the clock and hide a claim stalled for a month — the agent would
    // go quiet on exactly the row it exists to find.
    const c = {
        status: 'verified', claim_amount: 1000, our_claim: null,
        created_at: ago(60), updated_at: ago(0),
        history: [{ note: 'verified', at: ago(30) }],
    };
    const a = agent.assess(c, { now: NOW });
    ck('a claim verified 30 days ago reads as 30 days, not 0',
       a.ageDays === 30,
       `got ${a.ageDays} — updated_at is today, and using it would hide a month-old stall`);

    // Re-raised after a rejection is a NEW clock, so the LAST matching entry
    // wins, not the first.
    const re = {
        status: 'recovery_raised', our_claim: 500, created_at: ago(90),
        history: [
            { note: 'recovery raised on supplier', at: ago(80) },
            { note: 'status → rejected', at: ago(60) },
            { note: 'recovery raised on supplier', at: ago(5) },
        ],
    };
    ck('a recovery re-raised starts its clock again',
       agent.assess(re, { now: NOW }).ageDays === 5,
       'otherwise a freshly re-raised claim is chased as if it were 80 days old');

    // No history at all must not throw or read as zero age.
    const bare = { status: 'unverified', created_at: ago(12), history: [] };
    ck('with no history it falls back to created_at',
       agent.assess(bare, { now: NOW }).ageDays === 12);
    const nothing = { status: 'unverified' };
    ck('  and a claim with no dates at all is handled, not crashed on',
       agent.assess(nothing, { now: NOW }).ageDays === null);
}

// ── C — THE MONEY, ONLY WHERE IT IS REAL ──────────────────────────────────
{
    section('C — it never invents a figure');

    ck('an unverified claim has NO money at risk',
       agent.atRisk({ status: 'unverified', claim_amount: null }) === null,
       'claim_amount is null until a human confirms the weights and the unit');
    ck('  even when a shortage weight is sitting right there',
       agent.atRisk({ status: 'unverified', shortage: 1305.9, sell_price: 0.42, claim_amount: null }) === null,
       'shortage x price is exactly the MT/KG guess helpers/claims.js refuses to make');
    ck('absorbed money is the customer\'s deduction',
       agent.atRisk({ status: 'verified', claim_amount: 18400, our_claim: null }) === 18400);
    ck('unsettled money is what we asked for',
       agent.atRisk({ status: 'recovery_raised', claim_amount: 7000, our_claim: 6500 }) === 6500,
       'what we asked the supplier for, not what the customer took');
    ck('  falling back to the claim amount when no figure was asked',
       agent.atRisk({ status: 'recovery_raised', claim_amount: 7000, our_claim: null }) === 7000);
}

// ── D — TRIAGE: THE SENTENCE SHE NEEDS ────────────────────────────────────
{
    section('D — the register, triaged');

    const claims = [
        { id: 'C1', customer: 'MK Trading', supplier: 'Calderon', container_no: 'TGCU0053611',
          status: 'verified', claim_amount: 18400, our_claim: null,
          created_at: ago(30), history: [{ note: 'verified', at: ago(11) }] },
        { id: 'C2', customer: 'Taewon', supplier: 'Gomez', container_no: 'MSDU1161015',
          status: 'verified', claim_amount: 2250, our_claim: null,
          created_at: ago(9), history: [{ note: 'verified', at: ago(4) }] },
        { id: 'C3', customer: 'MK', supplier: 'Hugo', container_no: 'KOCU4930737',
          status: 'recovery_raised', claim_amount: 7000, our_claim: 6500, created_at: ago(60),
          history: [{ note: 'verified', at: ago(50) }, { note: 'recovery raised on supplier', at: ago(40) }] },
        { id: 'C4', customer: 'Ala', supplier: 'Ramesh', container_no: 'ZZZZ1111111',
          status: 'unverified', claim_amount: null, created_at: ago(22), history: [] },
        // Verified YESTERDAY — must not be chased.
        { id: 'C5', customer: 'X', supplier: 'Y', status: 'verified', claim_amount: 900,
          our_claim: null, created_at: ago(2), history: [{ note: 'verified', at: ago(1) }] },
        { id: 'C6', customer: 'Z', supplier: 'W', status: 'settled', claim_amount: 5000,
          our_claim: 5000, created_at: ago(80), history: [] },
    ];
    const t = agent.triage(claims, { now: NOW });

    ck('the money we are ABSORBING is totalled on its own',
       t.money.absorbing === 20650, JSON.stringify(t.money));
    ck('  and what a supplier owes us is a SEPARATE total',
       t.money.unsettled === 6500,
       'absorbing and owed-to-us are different kinds of bad; one grand total means nothing');
    ck('  and there is no grand total to mislead her',
       !('total' in t.money) && !('all' in t.money),
       Object.keys(t.money).join(','));

    ck('biggest absorbed claim comes first',
       t.absorbing[0].id === 'C1' && t.absorbing[1].id === 'C2',
       t.absorbing.map((a) => a.id).join(','));

    ck('a claim verified YESTERDAY is not chased',
       !t.absorbing.some((a) => a.id === 'C5'),
       'chasing something three days old trains her to ignore the report');
    ck('a settled claim never appears',
       !JSON.stringify(t).includes('C6'));

    ck('the unquantified ones are COUNTED, not totalled',
       t.counts.unquantified === 1 && t.unverified.length === 1
       && t.unverified[0].money === null,
       JSON.stringify(t.counts));

    // The wording she will actually read.
    ck('the reason says what is wrong, in plain terms',
       /nothing has been asked of the supplier/.test(t.absorbing[0].why)
       && /absorbing/.test(t.absorbing[0].why), t.absorbing[0].why);
    ck('  and the unsettled one says it was raised and ignored',
       /raised on the supplier for 40 days with no settlement/.test(t.unsettled[0].why),
       t.unsettled[0].why);
    ck('  and the unverified one says it is claimed from nobody',
       /not been claimed from anyone/.test(t.unverified[0].why), t.unverified[0].why);

    ck('every flagged claim carries the next step',
       [...t.absorbing, ...t.unsettled, ...t.unverified].every((a) => !!a.next),
       'a list with no action beside it is a list that gets read once');
    ck('  and the step for an absorbed claim is to raise the recovery',
       /raise the recovery/.test(t.absorbing[0].next), t.absorbing[0].next);
}

// ── E — THE WINDOWS ARE TUNABLE, AND ASYMMETRIC ON PURPOSE ────────────────
{
    section('E — how long is too long');

    const absorbed = (d) => ({ id: 'A', status: 'verified', claim_amount: 1000, our_claim: null,
        created_at: ago(d + 1), history: [{ note: 'verified', at: ago(d) }] });

    ck('money being absorbed is chased after 3 days, not 3 weeks',
       agent.DEFAULT_WINDOWS.awaiting_recovery_days === 3,
       'every day this sits is money leaving — it is the one chased hardest');
    ck('  an unverified claim gets longer, because it has not cost anything yet',
       agent.DEFAULT_WINDOWS.unverified_days > agent.DEFAULT_WINDOWS.awaiting_recovery_days,
       JSON.stringify(agent.DEFAULT_WINDOWS));

    ck('at 2 days it is left alone',
       agent.triage([absorbed(2)], { now: NOW }).absorbing.length === 0);
    ck('at 3 days it is raised',
       agent.triage([absorbed(3)], { now: NOW }).absorbing.length === 1);

    // Tunable without a release — the real windows depend on her contracts,
    // and a number invented in code that is quietly wrong is worse than one
    // she corrects once.
    ck('the windows can be overridden per run',
       agent.triage([absorbed(3)], { now: NOW, windows: { awaiting_recovery_days: 10 } }).absorbing.length === 0,
       'she can tune the thresholds without waiting for a deploy');
}

// ── F — THE DEADLINE CHECK IS READY AND SILENT ────────────────────────────
{
    section('F — the claim window');

    // There is NO deadline field on the record today (#158). The check reads
    // whatever she has set, so it works the day the field exists and stays
    // quiet until then — rather than inventing a date, which would either
    // cry wolf on every claim or give false comfort on all of them.
    const noField = { id: 'N', status: 'verified', claim_amount: 500, our_claim: null,
        created_at: ago(10), history: [{ note: 'verified', at: ago(9) }] };
    const a1 = agent.assess(noField, { now: NOW });
    ck('with no deadline set, nothing is claimed about the window',
       a1.deadline === null && a1.closing === false,
       'a date invented here would be false comfort on every claim');

    const soon = { ...noField, claim_deadline: ahead(5) };
    const a2 = agent.assess(soon, { now: NOW });
    ck('a window closing in 5 days is flagged',
       a2.closing === true && /closes in 5 days/.test(a2.why), a2.why);

    const gone = { ...noField, claim_deadline: ago(3) };
    const a3 = agent.assess(gone, { now: NOW });
    ck('a window that already closed says so, and by how long',
       a3.closing === true && /closed 3 days ago/.test(a3.why), a3.why);

    const far = { ...noField, claim_deadline: ahead(90) };
    ck('a window 90 days out is not noise',
       agent.assess(far, { now: NOW }).closing === false);

    const t = agent.triage([soon, gone, far], { now: NOW });
    ck('closing windows are listed soonest-first',
       t.closing.length === 2 && t.closing[0].daysToDeadline < t.closing[1].daysToDeadline,
       t.closing.map((c) => c.daysToDeadline).join(','));
}

// ── G — IT WRITES NOTHING ─────────────────────────────────────────────────
{
    section('G — no authority over money');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/claimsAgent.js'), 'utf8');
    ck('it never calls the claims store\'s writers',
       !/\b(verify|raiseRecovery|setStatus|update|create)\s*\(/.test(
           src.replace(/\/\/.*$/gm, '').replace(/^.*require\(.*$/gm, '')),
       'she gave it chase-and-draft, not authority over a figure');
    ck('  it requires no store at all',
       !/require\(['"]\.\/claims['"]\)/.test(src),
       'pure: claims in, assessment out — testable without a register');
    ck('  and it writes no files',
       !/writeFileSync|mutateJson/.test(src));
    ck('rule 5 holds — it never reads a yard store',
       !/yardClaims|yardLoads|outboundLoads/.test(src),
       'Edge Yard claims are a different company and have the 8PM report');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
