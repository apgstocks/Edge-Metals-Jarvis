// ── tests/ledger-agent.js ─────────────────────────────────────────────────
// Apsara, 2026-10-01: "Let an AI agent handle both bills and invoice and
// associated things", "which scans regularly and keep things perfect and
// neat", "resolves all payment confusion", "Every day,ensure that there is no
// discrepancy."
//
// Asked what it may change on its own, she chose: ONLY THINGS WITH ONE
// POSSIBLE ANSWER. Money is always proposed. Its own daily email.
//
// ── WHY ALMOST EVERY CHECK HERE IS ABOUT THE LINE ─────────────────────────
// The agent's value is that it tidies without being watched. Its risk is the
// same sentence. A wrong auto-match between a payment and a bill is close to
// unfindable afterwards — both rows look perfectly ordinary once it is done,
// and nothing in the ledger records that anything was guessed. A wrong
// spelling fix is visible the moment she reads the name.
//
// So the tests that matter are the ones that try to get money past the line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-'));
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const cfg = require('../config');
cfg.YARD_CLAIMS_FILE = path.join(TMP, 'yard_claims.json');
cfg.BILLS_FILE = path.join(TMP, 'bills.json');
cfg.SALES_FILE = path.join(TMP, 'sales.json');
for (const f of [cfg.YARD_CLAIMS_FILE, cfg.BILLS_FILE, cfg.SALES_FILE]) fs.writeFileSync(f, '[]');

const agent = require('../helpers/ledgerAgent');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — WHAT IT MAY FIX WITHOUT ASKING');
// ══════════════════════════════════════════════════════════════════════════
// One possible answer, and the answer is already in the data. Applying it
// writes down what is true rather than deciding anything.
{
    const settled = [
        ['a supplier spelt two ways on one booking',
         { field: 'supplier', from: 'FEDE', to: 'Fede', from_source: 'the other rows on BK1' }],
        ['MT missing where lbs exist',
         { field: 'net_weight_mt', from: '', to: '9.072', from_source: 'computed from 20,000 lb' }],
        ['a container already on the booking',
         { field: 'container_no', from: '', to: 'TCLU6619618', from_source: 'the booking' }],
        ['a date in the wrong format',
         { field: 'date', from: '09/30/26', to: '2026-09-30', from_source: 'the row itself' }],
    ];
    for (const [what, fix] of settled) {
        ck(`${what} -> fixed`, agent.classify(fix) === agent.SETTLED, agent.classify(fix));
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('B — AND WHAT IT MUST NEVER TOUCH');
// ══════════════════════════════════════════════════════════════════════════
{
    for (const f of ['amount', 'price', 'supplier_price', 'advance', 'paid',
                     'total', 'freight', 'commission', 'claim_amount',
                     'trucking_amount', 'net_payable', 'rate']) {
        ck(`${f} is never fixed on its own`,
           agent.classify({ field: f, from: '1', to: '2', from_source: 'the sheet' }) === agent.PROPOSED,
           'this is the half of the ledger a wrong guess cannot be found in afterwards');
    }
    // ── A FIELD THIS FILE HAS NEVER HEARD OF ─────────────────────────────
    // The dangerous case: a check added next year invents `freight_cost` and
    // the allowlist has never seen it. Defaulting to "fix it" would let money
    // through the one door that is supposed to be shut.
    ck('an UNKNOWN money-smelling field is proposed, not fixed',
       agent.classify({ field: 'freight_cost', to: '50', from_source: 'the sheet' }) === agent.PROPOSED,
       'a new check must not be able to opt itself into auto-fixing money');
    ck('  and so is one with a $ in the name',
       agent.classify({ field: 'total_$', to: '5', from_source: 'x' }) === agent.PROPOSED);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — THREE WAYS A FIX STAYS A PROPOSAL');
{
    ck('no provenance -> proposal',
       agent.classify({ field: 'supplier', to: 'Fede' }) === agent.PROPOSED,
       'a fix that cannot say where the value came from is a guess however sure it looks');
    ck('no value to write -> proposal',
       agent.classify({ field: 'supplier', from: 'x', from_source: 'y' }) === agent.PROPOSED);
    ck('an empty value -> proposal',
       agent.classify({ field: 'supplier', to: '  ', from_source: 'y' }) === agent.PROPOSED,
       'blanking a field is a decision, not a tidy-up');
    ck('the check flags its own doubt -> proposal',
       agent.classify({ field: 'supplier', to: 'Fede', from_source: 'guess', needs_her: true }) === agent.PROPOSED,
       'an explicit refusal always wins; nothing here overrides a check that knows it is unsure');
    ck('no fix at all -> proposal',
       agent.classify(undefined) === agent.PROPOSED,
       'a weight gap or an unjoined container is a question, not a typo');
    ck('rubbish -> proposal', agent.classify('nonsense') === agent.PROPOSED);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — sorting a run');
{
    const out = agent.sort([
        { what: 'A', fix: { field: 'supplier', to: 'Fede', from_source: 'BK1' } },
        { what: 'B', fix: { field: 'amount', from: '1', to: '2', from_source: 'the sheet' } },
        { what: 'C' },
        null,
    ]);
    ck('settled and proposed are separated', out.settled.length === 1 && out.proposed.length === 2);
    ck('  the money one is in proposed', out.proposed.some((x) => x.what === 'B'));
    ck('  each finding is told which it is', out.settled[0].kind === agent.SETTLED);
    ck('  and nulls are dropped rather than counted', out.total === 3);
    // sort() READS. The applying is a separate call, so a caller can show her
    // the split first and a dry run is the default rather than a flag.
    ck('sorting writes nothing', fs.readFileSync(cfg.BILLS_FILE, 'utf8') === '[]');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — IT READS THE JOBS THAT ALREADY RUN');
// ══════════════════════════════════════════════════════════════════════════
// Five jobs already scan. A sixth scanner would be a sixth voice telling her
// slightly different things, so this one reads what they compute.
{
    const yc = require('../helpers/yardClaims');
    await yc.raise({ load_id: 'EDGE_9', seller: 'Ramesh', amount: 450,
        reason: '20% dirt', raised_on: '2026-09-01' });

    const got = agent.collect();
    ck('it collects from the existing checks', got.findings.length > 0);
    ck('  including the open claim', got.findings.some((f) => f.check === 'open-claim'));
    ck('  and nothing is broken', got.broken.length === 0, JSON.stringify(got.broken));

    // Sweep findings arrive with no `fix`, so every one is a proposal. That is
    // correct and worth pinning: nothing from the sweep should ever be
    // auto-applied, because none of it has one possible answer.
    const sorted = agent.sort(got.findings);
    ck('nothing from the existing checks is auto-applied', sorted.settled.length === 0,
       'a weight gap is a question; the sweep produces questions, not typos');
}
{
    // One broken source must not cost her the report. Same contract
    // integritySweep already uses for its own checks.
    const got = agent.collect({ sources: [
        { id: 'fine', run: () => [{ what: 'ok' }] },
        { id: 'broken', run: () => { throw new Error('boom'); } },
    ] });
    ck('a throwing source is reported, not fatal',
       got.findings.length === 1 && got.broken.length === 1 && got.broken[0].id === 'broken');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — THE EMAIL, AND WHEN IT DOES NOT ARRIVE');
{
    ck('nothing at all -> no email',
       agent.reportText({ settled: [], proposed: [], broken: [] }) === null,
       'a daily "all clear" for a month is an email she stops opening, including the day it matters');

    const txt = agent.reportText({
        settled: [{ what: 'BK1 — Fede', fix: { field: 'supplier', to: 'Fede' } }],
        proposed: [{ what: 'TCLU6619618', detail: 'needs weights',
                     fix: { field: 'supplier_price', from: '0.32', to: '0.34', from_source: 'the sheet' } }],
        broken: [],
    });
    ck('what needs her comes FIRST', txt.indexOf('WAITING FOR YOU') < txt.indexOf('TIDIED'),
       'the part she must act on should not be below the part she need not read');
    ck('  and leads with how many', /^1 thing needs you\./.test(txt), txt.split('\n')[0]);
    ck('a proposal shows BOTH figures', /0\.32 → 0\.34/.test(txt),
       'she should not have to go and look one up to judge the other');
    ck('  and says where the new one came from', /\(the sheet\)/.test(txt));
    ck('what was tidied is listed so she can object', /TIDIED/.test(txt) && /supplier → Fede/.test(txt));
    ck('a broken check is said out loud',
       /A CHECK DID NOT RUN/.test(agent.reportText({ settled: [], proposed: [],
            broken: [{ id: 'x', error: 'boom' }] })),
       'a check that silently stopped running is worse than one that fails — the report keeps looking clean');
    ck('tidied-only still sends, and says nothing needs her',
       /Nothing needs you today/.test(agent.reportText({
           settled: [{ what: 'A' }], proposed: [], broken: [] })),
       'she asked to see what it changed');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
