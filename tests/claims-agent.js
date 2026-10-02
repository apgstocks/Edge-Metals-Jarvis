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


// ── H — THE BEST MODEL, WHERE BEING WRONG COSTS MONEY ─────────────────────
// Apsara, 2026-10-02: "Use the best model in google for QB and Claims."
//
// Checked against Google's own list (ai.google.dev/gemini-api/docs/models,
// updated 2026-10-01) rather than from memory, because the codebase already
// referenced models newer than anything I could assert:
//   gemini-3.8-flash        STABLE, "our most intelligent Flash model ...
//                           autonomous agents, complex enterprise workflows"
//   gemini-3.1-pro-preview  Pro-tier but PREVIEW — restrictive rate limits,
//                           and preview models are "deprecated with at least
//                           2 weeks notice"
// Claim mail is parsed by an unattended watcher every few minutes. A model
// that vanishes on two weeks' notice would break that silently, and silence
// is how the claims money went missing in the first place.
{
    section('H — the model on the money paths');

    const cfgM = require('../config');
    ck('claims gets an explicit model',
       !!cfgM.GEMINI_MODEL_CLAIMS, String(cfgM.GEMINI_MODEL_CLAIMS));
    ck('quickbooks gets one too',
       !!cfgM.GEMINI_MODEL_QB, String(cfgM.GEMINI_MODEL_QB));
    ck('  and it is a STABLE model, not a preview',
       !/preview|exp\b/i.test(String(cfgM.GEMINI_MODEL_CLAIMS))
       && !/preview|exp\b/i.test(String(cfgM.GEMINI_MODEL_QB)),
       'an unattended parser must not sit on something that deprecates with '
       + 'two weeks notice');
    ck('  and not the access-limited 2.5 family',
       !/^gemini-2\./.test(String(cfgM.GEMINI_MODEL_CLAIMS)),
       'Google: "we are limiting access to the 2.5 models ... for any new '
       + 'projects, use our latest models"');
    ck('  better than the global default',
       cfgM.GEMINI_MODEL_CLAIMS !== cfgM.GEMINI_MODEL,
       'if these matched, the override would be doing nothing');

    // ── THE OVERRIDE IS OPTIONAL, SO 45 CALLERS ARE UNTOUCHED ────────────
    const gsrc = fs.readFileSync(path.join(ROOT, 'helpers/gemini.js'), 'utf8');
    ck('the model argument is optional and last',
       /callGeminiJSON\(prompt, retries = 2, schema = null, opts = \{\}\)/.test(gsrc),
       'a required argument would have broken every existing call');
    ck('  and an absent one still uses the configured default',
       /wanted \|\| getModelName\(\)/.test(gsrc), 'no opts means exactly the old behaviour');

    // ── THE CALL SITES ACTUALLY PASS IT ──────────────────────────────────
    // A config entry nothing reads is a config entry that looks like it
    // works. These are the five calls that matter.
    const parseSrc = fs.readFileSync(path.join(ROOT, 'helpers/claimParse.js'), 'utf8');
    ck('the claim mail parser asks for the claims model',
       /GEMINI_MODEL_CLAIMS/.test(parseSrc),
       'this is the call that reads a weight AND a unit off a supplier mail');

    const kindSrc = fs.readFileSync(path.join(ROOT, 'helpers/claimKind.js'), 'utf8');
    const kindCalls = (kindSrc.match(/callGeminiJSON\(/g) || []).length;
    const kindModelled = (kindSrc.match(/\{ model: M\(\) \}/g) || []).length;
    ck(`all ${kindCalls} claim-kind calls use it, not just the first`,
       kindCalls > 0 && kindModelled === kindCalls,
       `${kindModelled} of ${kindCalls} — a half-upgraded file is the drift this test exists for`);
    ck('  through ONE helper, so they cannot drift apart',
       /const M = \(\) => require\('\.\.\/config'\)\.GEMINI_MODEL_CLAIMS;/.test(kindSrc));

    const qbSrc = fs.readFileSync(path.join(ROOT, 'helpers/quickbooks/routes.js'), 'utf8');
    ck('the QuickBooks account answer uses the QB model',
       /GEMINI_MODEL_QB/.test(qbSrc),
       'it answers "what does this party owe" off her real ledger');

    // ── TWO TIERS, NOT A SETTING PER FEATURE ─────────────────────────────
    // Apsara, 2026-10-02: "For jarvis chat window,give access to latest model
    // and same applicable for all complex things."
    //
    // The first cut added one config entry per path, which does not survive
    // "and all complex things" — it becomes a setting per feature, and the
    // day a model is superseded she has to find them all.
    ck('there is a SMART tier the complex paths share',
       !!cfgM.GEMINI_MODEL_SMART, String(cfgM.GEMINI_MODEL_SMART));
    ck('  and the per-path names default to it rather than repeating a value',
       cfgM.GEMINI_MODEL_CLAIMS === cfgM.GEMINI_MODEL_SMART
       && cfgM.GEMINI_MODEL_QB === cfgM.GEMINI_MODEL_SMART
       && cfgM.GEMINI_MODEL_CHAT === cfgM.GEMINI_MODEL_SMART,
       'one place to change when the best model changes');
    const cfgSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
    ck('  and they are DERIVED from it, not copies of the string',
       /GEMINI_MODEL_CLAIMS = process\.env\.GEMINI_MODEL_CLAIMS \|\| GEMINI_MODEL_SMART/.test(cfgSrc)
       && /GEMINI_MODEL_CHAT   = process\.env\.GEMINI_MODEL_CHAT   \|\| GEMINI_MODEL_SMART/.test(cfgSrc),
       'three copies of a model name is three places to forget');

    // ── THE CHAT WINDOWS ─────────────────────────────────────────────────
    // The most visible thing Jarvis does: she asks a free-text question of
    // her own business and acts on the answer.
    const yardAsk = fs.readFileSync(path.join(ROOT, 'helpers/yardAsk.js'), 'utf8');
    const yardCalls = (yardAsk.match(/callGeminiJSON\(prompt/g) || []).length;
    const yardSmart = (yardAsk.match(/callGeminiJSON\(prompt, 1, null, SMART\)/g) || []).length;
    ck(`the yard chat window uses it on all ${yardCalls} calls`,
       yardCalls > 0 && yardSmart === yardCalls,
       `${yardSmart} of ${yardCalls} — the retry landing on a weaker model than the first try `
       + 'is the worst of both');

    const askData = fs.readFileSync(path.join(ROOT, 'helpers/data/askData.js'), 'utf8');
    ck('the data chat uses it to write the SQL',
       /GEMINI_MODEL_CHAT/.test(askData),
       'a wrong query does not error — it returns a confident number that is '
       + 'not the answer');
    ck('  and on the repair pass too',
       (askData.match(/SMART\)/g) || []).length >= 2,
       'the pass that FIXES a broken query is the one that needs the better model most');

    // ── THE WORKHORSE IS STILL THE WORKHORSE ─────────────────────────────
    // Not everything should move. Most of the 45 calls are a yes/no gate or
    // a one-field extraction on a 5-minute loop, where cheap and fast is the
    // right answer and a frontier model is money burnt for no better result.
    ck('the cheap tier still exists and is still different',
       cfgM.GEMINI_MODEL && cfgM.GEMINI_MODEL !== cfgM.GEMINI_MODEL_SMART,
       'upgrading all 45 callers would multiply the bill for no better answer '
       + 'on a yes/no gate');

    // ── AND THE AGENTS THEMSELVES STAY DETERMINISTIC ─────────────────────
    // Worth being explicit: the claims and QB AGENTS built today call no
    // model at all. Deciding "this claim has sat 40 days and $18,400 is
    // being absorbed" is arithmetic, and arithmetic should not be asked of
    // a language model. The model reads MAIL; the agent does the maths.
    for (const f of ['helpers/claimsAgent.js', 'helpers/qbAgent.js', 'helpers/ledgerAgent.js']) {
        ck(`  ${f} still calls no model`,
           !/gemini/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
           'a figure she acts on should not depend on a sampling temperature');
    }
}


// Sections A-H above are synchronous. Section I drives the real job, which is
// async, so it and the summary run inside one IIFE — otherwise the totals
// print before the chase has finished and a failure in it is invisible.
(async () => {

// ── I — THE CHASE, END TO END ─────────────────────────────────────────────
// Rule 3. Her answer on the window was "there is no specific window - the
// faster the better", so AGE is the whole mechanism: the chase gets louder
// the longer something sits, and it does not stop.
{
    section('I — the morning chase');

    const job = require('../helpers/claimsAgentJob');
    const NOW = new Date('2026-10-02T12:00:00Z');
    const back = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

    const claims = [
        { id: 'C1', customer: 'MK Trading', supplier: 'Calderon', container_no: 'TGCU0053611',
          status: 'verified', claim_amount: 18400, our_claim: null, invoice_no: '26MK83',
          date: '2026-08-20', invoice_weight: 24000, claimed_weight: 22650, shortage: 1350,
          weight_unit: 'KG', created_at: back(40), history: [{ note: 'verified', at: back(34) }] },
        { id: 'C2', customer: 'Taewon', supplier: 'Gomez', container_no: 'MSDU1161015',
          status: 'verified', claim_amount: 2250, our_claim: null,
          created_at: back(9), history: [{ note: 'verified', at: back(5) }] },
        { id: 'C3', customer: 'MK', supplier: 'Hugo', container_no: 'KOCU4930737',
          status: 'recovery_raised', claim_amount: 7000, our_claim: 6500, created_at: back(60),
          history: [{ note: 'recovery raised on supplier', at: back(40) }] },
        { id: 'C4', customer: 'Ala', supplier: 'Ramesh', container_no: 'ZZZZ1111111',
          status: 'unverified', claim_amount: null, created_at: back(22), history: [] },
    ];

    let sent = null;
    const r = await job.run({ claims, send: async (t) => { sent = t; },
        alreadySent: async () => false, markSent: async () => {}, now: NOW });

    ck('the chase goes out', r.sent === true && !!sent);
    ck('  and LEADS with the money sitting on us',
       /^\*\$20,650\.00 is sitting on us\*/.test(sent),
       'that is the leak she named; it goes first — ' + String(sent).split('\n')[0]);
    ck('  naming the supplier and the container, not an id',
       /TGCU0053611 · Calderon/.test(sent), sent);
    ck('  with the age in days',
       /— 34d/.test(sent), 'ago is the whole argument when there is no deadline');

    // ── LOUDER WITH AGE, SINCE THERE IS NO WINDOW ────────────────────────
    ck('a 34-day claim is marked urgent',
       /‼️ TGCU0053611/.test(sent), sent);
    ck('  and a 5-day one is not',
       !/‼️ MSDU1161015/.test(sent),
       'if everything is urgent then nothing is, and she stops reading');
    ck('the ladder is by age', job.loudnessFor(40) === 'urgent'
       && job.loudnessFor(10) === 'named' && job.loudnessFor(1) === 'nudge',
       `${job.loudnessFor(40)} / ${job.loudnessFor(10)} / ${job.loudnessFor(1)}`);

    ck('the two totals stay apart in the message',
       /Asked and not answered — \$6,500\.00/.test(sent), sent);
    ck('the unquantified one is counted, never totalled',
       /\(not priced\)/.test(sent) && /no figure yet/.test(sent), sent);

    // ── SILENT WHEN THERE IS NOTHING ─────────────────────────────────────
    let quiet = null;
    const none = await job.run({ claims: [{ id: 'X', status: 'settled' }],
        send: async (t) => { quiet = t; }, alreadySent: async () => false,
        markSent: async () => {}, now: NOW });
    ck('a clean day says nothing at all',
       none.sent === false && quiet === null,
       'a chase that arrives saying "nothing to chase" is one she stops reading');

    // ── ONCE A DAY ───────────────────────────────────────────────────────
    const twice = await job.run({ claims, send: async () => {},
        alreadySent: async () => true, markSent: async () => {}, now: NOW });
    ck('it does not chase twice in one day', twice.skipped === true);

    // ── THE DRAFT ────────────────────────────────────────────────────────
    const d = job.draftRecovery(claims[0], r.absorbing[0]);
    ck('the draft says plainly it is not sent',
       /DRAFT — not sent/.test(d.status), d.status);
    ck('  it is addressed to the SUPPLIER, not the customer',
       /Dear Calderon,/.test(d.body) && !/MK Trading/.test(d.body),
       'we recover from the supplier; the customer is who deducted from us');
    ck('  every figure comes from the record',
       /24000 KG/.test(d.body) && /22650 KG/.test(d.body) && /1350 KG/.test(d.body)
       && /\$18,400\.00/.test(d.body),
       'a claim letter quoting a number that does not match her ledger is worse than none');
    ck('  it asks how they want to settle',
       /credit note|payment/.test(d.body));
    ck('  and offers them a way to disagree with the figures',
       /weighbridge/.test(d.body),
       'a claim letter with no route to dispute is one that gets ignored');

    // A draft with no amount must say so rather than leave a gap.
    const noAmount = job.draftRecovery(
        { supplier: 'Ramesh', container_no: 'ZZZZ1111111' },
        { money: null });
    ck('a draft with no figure refuses to invent one',
       /\(to be confirmed\)/.test(noAmount.body) && noAmount.needs.length === 1,
       JSON.stringify(noAmount.needs));

    // ── THE COMMAND THE CHASE PROMISES ───────────────────────────────────
    // The message ends with 'Say "draft claim <container>"'. A promise to a
    // bot with no such route is the closePurchaseOrder failure.
    const brain = require('../workflow/brain.js');
    const mk = (t) => ({ text: t, textLower: t.toLowerCase(), isManagerOrTeam: true,
                         isTrucker: false, isSupplier: false, pendingAction: null,
                         session: {}, activeBooking: null });
    const intent = (t) => { const x = brain.policyDecide(mk(t)); return x && !x.needsAI ? x.intent : '(needsAI)'; };
    for (const phrase of ['draft claim TGCU0053611', 'write claim email for TGCU0053611',
                          'prepare the claim TGCU0053611']) {
        ck(`"${phrase}" routes`, intent(phrase) === 'draft_claim', intent(phrase));
    }
    const offered = (String(sent).match(/\*draft claim <container>\*/) || [])[0];
    ck('  and the phrase the message offers is the one that routes',
       !!offered && intent('draft claim TGCU0053611') === 'draft_claim',
       'the promise is the bug if the route is missing');

    const actions = require('../workflow/actions.js');
    ck('the action exists and is wired',
       typeof actions.draftClaimEmail === 'function');
    const actionSrc = fs.readFileSync(path.join(ROOT, 'workflow/actions.js'), 'utf8');
    const slice = actionSrc.slice(actionSrc.indexOf('async function draftClaimEmail'),
        actionSrc.indexOf('async function draftClaimEmail') + 4000);
    ck('  and it sends nothing to a supplier',
       !/sendEmail|gmail/.test(slice),
       'it writes the letter; she sends it');
    ck('  nor writes to the claims register',
       !/raiseRecovery|setStatus|update\(/.test(slice),
       'raising the recovery is still her action — it is what moves the status');

    // ── WIRED TO RUN ─────────────────────────────────────────────────────
    const sched = fs.readFileSync(path.join(ROOT, 'scheduler.js'), 'utf8');
    ck('the chase is on the schedule',
       /require\('\.\/helpers\/claimsAgentJob'\)/.test(sched),
       'an agent nobody runs is the register nobody read, one level up');
    ck('  after the ledger agent, so the morning arrives in one block',
       sched.indexOf("'45 7 * * *'") > 0 && sched.indexOf("'30 7 * * *'") > 0);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
