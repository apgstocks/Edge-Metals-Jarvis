// ── tests/memory-phase2.js ──────────────────────────────────────────────────
// Apsara, 2026-08-25: "phase 2" — validity, lineage, supersede/retract, and
// contradiction detection. See claude/jarvis-memory-architecture-v2.md.
//
// Phase 1 made a fact addressable. Phase 2 makes it CORRECTABLE. The
// guarantees under test, each of which was impossible before:
//
//   G1  Only what Jarvis currently believes reaches a prompt. A superseded
//       or retracted fact is on disk, is auditable, and is NEVER injected.
//   G2  A correction destroys nothing. The old fact keeps its window
//       (valid_from -> valid_until) and points at what replaced it.
//   G3  "It was never true" (retract) is a different operation from "it
//       stopped being true" (supersede), and retract is reversible.
//   G4  A contradiction NEVER auto-overwrites a fact Apsara taught Jarvis.
//       It stages a question. This is the deliberate departure from Mem0,
//       and the direct lesson of the MARTINEZ incident.
//   G5  The schema migrates with no migration — a legacy fact normalises to
//       the same record before and after it is persisted. This matters
//       because the live facts.json is on the VM and has never been seen
//       from a dev machine (claude/jarvis-deployment-model-RESOLVED.md).
//
// Real invocations against real modules. Only Gemini and Supabase are
// stubbed, and the stubs record their calls so "did it actually try" is an
// assertion rather than an assumption.
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

let pass = 0, fail = 0;
const failures = [];
function ck(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem2-'));
process.env.DATA_DIR = scratch;
process.env.API_TOKEN = 'phase2-test-token';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));

// ── stubs that record ──────────────────────────────────────────────────────
const embeddings = require(R('helpers/embeddings.js'));
let STORED = [], DELETED = [], SEARCH_HITS = [];
embeddings.storeEmbedding = async ({ text, type }) => { STORED.push({ text, type }); };
embeddings.deleteEmbeddingsByText = async (text, type) => { DELETED.push({ text, type }); return 1; };
embeddings.searchSimilar = async () => SEARCH_HITS;

const gemini = require(R('helpers/gemini.js'));
let AI_VERDICT = null;   // what the contradiction classifier "decides"
let AI_CALLS = 0;
let AI_THROWS = false;
gemini.callGeminiJSON = async () => {
    AI_CALLS++;
    if (AI_THROWS) throw new Error('gemini down');
    return AI_VERDICT;
};

const json = require(R('helpers/json.js'));
const settle = () => new Promise((r) => setTimeout(r, 20));
const writeFacts = (arr) => fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify(arr, null, 2));

(async () => {

// ── G5 ─────────────────────────────────────────────────────────────────────
section('G5 — the schema migrates without a migration');
{
    // Exactly what is sitting in facts.json on the VM right now: no id, no
    // status, no validity fields.
    writeFacts([
        { text: 'Bose is CC on all Zimex mail', pinned: true, created_at: '2026-06-01T00:00:00.000Z' },
        { text: 'Busan rate is $2,100/MT', pinned: true, created_at: '2026-06-02T00:00:00.000Z' },
    ]);

    const before = json.loadFacts();
    ck('a legacy fact reads back as active', before.every((f) => f.status === 'active'));
    ck('valid_from is backfilled from created_at', before[0].valid_from === '2026-06-01T00:00:00.000Z');
    ck('valid_until is null — a legacy fact has not stopped being true', before.every((f) => f.valid_until === null));
    ck('lineage fields default to empty, not undefined',
        before.every((f) => Array.isArray(f.supersedes) && f.superseded_by === null));

    const snapshot = JSON.stringify(before);
    await json.addFact('something new', false);      // forces a full persist
    const afterPersist = json.loadFacts().filter((f) => f.text !== 'something new');
    ck('normalising is idempotent — the same record before and after persist',
        JSON.stringify(afterPersist) === snapshot,
        'a legacy fact changed when the file was rewritten — the migration is not safe to run blind');
}

// ── G1 + G2 ────────────────────────────────────────────────────────────────
section('G2 — a correction records history instead of destroying it');
{
    writeFacts([]);
    STORED = [];
    const original = await json.addFact('Busan rate is $2,100/MT', true);
    const replacement = await json.supersedeFact(original.id, 'Busan rate is $2,400/MT', { reason: 'manager correction' });
    await settle();

    ck('supersede returns the new record', !!replacement && replacement.text === 'Busan rate is $2,400/MT');
    ck('the correction inherits the pin from what it replaced', replacement.pinned === true);

    const all = json.loadFacts();
    const old = all.find((f) => f.id === original.id);
    const neu = all.find((f) => f.id === replacement.id);

    ck('nothing was deleted — both records are on disk', all.length === 2);
    ck('the old fact is marked superseded', old.status === 'superseded');
    ck('the old fact gets an end date', typeof old.valid_until === 'string' && old.valid_until.length > 0);
    ck('the old fact points forward to its replacement', old.superseded_by === replacement.id);
    ck('the new fact points back at what it replaced', neu.supersedes.includes(original.id));
    ck('the reason for the change is recorded', old.change_reason === 'manager correction');
    ck('the new fact is the only active one', json.loadActiveFacts().map((f) => f.id).join() === replacement.id);
    ck('the replacement is embedded so it is searchable', STORED.some((x) => x.text === 'Busan rate is $2,400/MT'));

    const chain = json.factHistory(replacement.id);
    ck('history walks back to the original', chain.length === 2 && chain[1].id === original.id);

    // Superseding an already-superseded record would fork its history into
    // two competing chains — refuse rather than branch it silently.
    const again = await json.supersedeFact(original.id, 'Busan rate is $9,999/MT');
    ck('a superseded fact cannot be superseded a second time', again === null);
    ck('and nothing was written by that attempt', json.loadFacts().length === 2);
}

// ── G3 ─────────────────────────────────────────────────────────────────────
section('G3 — retract is a different thing from supersede, and is reversible');
{
    writeFacts([]);
    DELETED = []; STORED = [];
    const bad = await json.addFact('Trucker Dave handles Houston', true);
    const good = await json.addFact('Bose is CC on all Zimex mail', true);

    const out = await json.retractFact(bad.id, 'that was never true');
    await settle();

    ck('retract returns the record it retracted', !!out && out.id === bad.id);
    ck('the record is still on disk', json.loadFacts().length === 2);
    ck('but it is no longer believed', json.loadActiveFacts().map((f) => f.id).join() === good.id);
    ck('it is marked retracted, NOT superseded', json.loadFacts().find((f) => f.id === bad.id).status === 'retracted');
    ck('with no superseded_by — nothing replaced it', json.loadFacts().find((f) => f.id === bad.id).superseded_by === null);
    ck('retract drops the vector row (unlike supersede)', DELETED.some((d) => d.text === 'Trucker Dave handles Houston'));

    STORED = [];
    const revived = await json.unretractFact(bad.id);
    await settle();
    ck('a retraction can be undone', !!revived && json.loadActiveFacts().length === 2);
    ck('and the fact becomes searchable again', STORED.some((x) => x.text === 'Trucker Dave handles Houston'));

    // Reviving a superseded fact would leave two active contradicting facts —
    // exactly the state phase 2 exists to prevent.
    const orig = await json.addFact('Rate is $1', true);
    await json.supersedeFact(orig.id, 'Rate is $2');
    const badRevive = await json.unretractFact(orig.id);
    ck('unretract refuses to revive a SUPERSEDED fact', badRevive === null);
    ck('so a correction can never be silently undone',
        !json.loadActiveFacts().some((f) => f.text === 'Rate is $1'));
}

// ── G1 ─────────────────────────────────────────────────────────────────────
section('G1 — only active facts reach the prompt');
{
    writeFacts([]);
    const keep = await json.addFact('Bose is CC on all Zimex mail', true);
    const stale = await json.addFact('Busan rate is $2,100/MT', true);
    await json.supersedeFact(stale.id, 'Busan rate is $2,400/MT', { reason: 'rate rose' });
    const wrong = await json.addFact('Dave handles Houston', true);
    await json.retractFact(wrong.id, 'never true');
    fs.writeFileSync(cfg.TRANSCRIPTS_FILE, JSON.stringify({}, null, 2));

    // Supabase still holds vector rows for the superseded and retracted
    // facts — the live failure mode. All three must be filtered out.
    SEARCH_HITS = [
        { id: 1, text: 'Busan rate is $2,100/MT', type: 'fact', similarity: 0.95, created_at: '2026-06-01T00:00:00.000Z' },
        { id: 2, text: 'Dave handles Houston', type: 'fact', similarity: 0.93, created_at: '2026-06-01T00:00:00.000Z' },
        { id: 3, text: 'Busan rate is $2,400/MT', type: 'fact', similarity: 0.91, created_at: '2026-08-01T00:00:00.000Z' },
    ];

    delete require.cache[require.resolve(R('helpers/context.js'))];
    const context = require(R('helpers/context.js'));
    const out = await context.formatForAI({
        chatId: 'sim', text: 'what is the busan rate', role: 'manager', isManagerOrTeam: true,
        allBookings: {}, allWorkflow: {}, truckers: [], suppliers: [],
        session: {}, activeSlots: [], urgentBookings: [],
    });
    const blob = typeof out === 'string' ? out : JSON.stringify(out);

    ck('a SUPERSEDED fact never reaches the prompt', !blob.includes('$2,100/MT'),
        'the corrected-away rate is still being injected');
    ck('a RETRACTED fact never reaches the prompt', !blob.includes('Dave handles Houston'));
    ck('the current rate does reach the prompt', blob.includes('$2,400/MT'));
    ck('an untouched fact is unaffected', blob.includes('Bose is CC on all Zimex mail'));
    SEARCH_HITS = [];
}

// ── G4 ─────────────────────────────────────────────────────────────────────
section('G4 — a contradiction asks; it never silently overwrites');
{
    const actions = require(R('workflow/actions.js'));
    const sent = [];
    actions.init({
        sendMessage: async (_c, t) => { sent.push(String(t)); },
        sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: () => {},
    });

    writeFacts([]);
    const existing = await json.addFact('Busan rate is $2,100/MT', true);
    SEARCH_HITS = [{ id: 1, text: 'Busan rate is $2,100/MT', type: 'fact', similarity: 0.94, created_at: '2026-06-01T00:00:00.000Z' }];
    AI_VERDICT = { contradicts: 1, confidence: 0.9, why: 'the rate changed' };

    sent.length = 0;
    const r = await actions.rememberFact('sim', 'Busan rate is $2,400/MT');
    ck('a contradiction stages a question instead of writing', r.action_taken === 'fact_conflict_staged');
    ck('THE FACT WAS NOT OVERWRITTEN', json.loadActiveFacts().map((f) => f.text).join() === 'Busan rate is $2,100/MT',
        'a fact Apsara taught Jarvis was replaced without her seeing it — this is the MARTINEZ failure in the memory layer');
    ck('she is shown both versions', sent[0].includes('$2,400/MT') && sent[0].includes('$2,100/MT'));
    ck('and told exactly how to answer', /replace/i.test(sent[0]) && /both/i.test(sent[0]) && /cancel/i.test(sent[0]));

    const pending = actions.getPending('sim');
    ck('a resolvable pending is staged', pending && pending.type === 'await_fact_conflict' && pending.oldId === existing.id);

    // replace
    sent.length = 0;
    const rep = await actions.resolveFactConflict('sim', pending, 'replace');
    ck('"replace" supersedes the old fact', rep.action_taken === 'fact_superseded');
    ck('the new rate is now the only active one', json.loadActiveFacts().map((f) => f.text).join() === 'Busan rate is $2,400/MT');
    ck('the old one is kept on record, not destroyed', json.loadFacts().length === 2);
    ck('and she is told the old one is retained', /record/i.test(sent.join(' ')));

    // both
    writeFacts([]);
    const e2 = await json.addFact('Pickups need 24h notice', true);
    SEARCH_HITS = [{ id: 1, text: 'Pickups need 24h notice', type: 'fact', similarity: 0.9, created_at: '2026-06-01T00:00:00.000Z' }];
    AI_VERDICT = { contradicts: 1, confidence: 0.85, why: 'conflicting notice periods' };
    await actions.rememberFact('sim', 'Pickups need 48h notice');
    const both = await actions.resolveFactConflict('sim', actions.getPending('sim'), 'both');
    ck('"both" keeps them side by side', both.action_taken === 'fact_conflict_kept_both' && json.loadActiveFacts().length === 2);

    // cancel
    writeFacts([]);
    await json.addFact('Pickups need 24h notice', true);
    SEARCH_HITS = [{ id: 1, text: 'Pickups need 24h notice', type: 'fact', similarity: 0.9, created_at: '2026-06-01T00:00:00.000Z' }];
    AI_VERDICT = { contradicts: 1, confidence: 0.85, why: 'conflicting' };
    await actions.rememberFact('sim', 'Pickups need 48h notice');
    sent.length = 0;
    const canc = await actions.resolveFactConflict('sim', actions.getPending('sim'), 'cancel');
    ck('"cancel" drops the new one', canc.action_taken === 'fact_conflict_cancelled');
    ck('and the original still stands', json.loadActiveFacts().map((f) => f.text).join() === 'Pickups need 24h notice');
    ck('she is told what Jarvis is still going by', sent.join(' ').includes('24h notice'));

    // Not every similar fact is a contradiction.
    writeFacts([]);
    await json.addFact('Bose is CC on all Zimex mail', true);
    SEARCH_HITS = [{ id: 1, text: 'Bose is CC on all Zimex mail', type: 'fact', similarity: 0.88, created_at: '2026-06-01T00:00:00.000Z' }];
    AI_VERDICT = { contradicts: null, confidence: 0.9, why: 'different subject' };
    sent.length = 0;
    const plain = await actions.rememberFact('sim', 'Bose prefers morning calls');
    ck('a merely SIMILAR fact stores normally, no question asked', plain.action_taken === 'fact_stored');
    ck('and both facts are active', json.loadActiveFacts().length === 2);

    // Low confidence is not a contradiction.
    AI_VERDICT = { contradicts: 1, confidence: 0.3, why: 'maybe?' };
    const lowConf = await actions.rememberFact('sim', 'Something vaguely related');
    ck('a low-confidence guess does not interrupt her', lowConf.action_taken === 'fact_stored');

    // The check must never block her storing a fact.
    AI_THROWS = true;
    sent.length = 0;
    const degraded = await actions.rememberFact('sim', 'Gemini is down right now');
    ck('a failed contradiction check degrades to plain storing, never blocks',
        degraded.action_taken === 'fact_stored' && json.loadActiveFacts().some((f) => f.text === 'Gemini is down right now'));
    AI_THROWS = false;

    // No embeddings configured at all -> no crash, no question.
    SEARCH_HITS = [];
    AI_CALLS = 0;
    const noHits = await actions.rememberFact('sim', 'A totally novel fact');
    ck('with no similar facts, the classifier is never even called', AI_CALLS === 0 && noHits.action_taken === 'fact_stored');
}

// ── routing ────────────────────────────────────────────────────────────────
section('Routing — the answer words reach the resolver, and stay scoped');
{
    delete require.cache[require.resolve(R('workflow/brain.js'))];
    const brain = require(R('workflow/brain.js'));
    const withPending = (text) => brain.policyDecide({
        text, textLower: text.toLowerCase(), isManagerOrTeam: true, role: 'manager',
        chatId: 'sim', pendingAction: { type: 'await_fact_conflict', oldId: 'a', oldText: 'old', newText: 'new' },
    });

    ck('"replace" resolves the conflict', withPending('replace').intent === 'resolve_fact_conflict');
    ck('"both" resolves the conflict', withPending('both').intent === 'resolve_fact_conflict');
    // "cancel" is caught by brain.js's GLOBAL cancel rule, which fires before
    // this pending's own parse — that is correct and deliberate (cancel should
    // always cancel, for every pending). What matters is that it still lands
    // on the fact-conflict handling rather than a generic "Cancelled.",
    // which resolvePending delegates. Asserted for real below.
    ck('"cancel" routes to the global cancel, not a dead end',
        withPending('cancel').intent === 'resolve_pending' && withPending('cancel').data.answer === 'no');
    ck('"replace" is read as replace, not as a generic yes', withPending('replace').data.answer === 'replace');
    ck('an unrelated sentence is arbitrated, not force-fed as an answer',
        withPending('what is the cutoff for DALA123').arbitrate === true);

    // "replace" and "both" are ordinary freight words. They must not become
    // global confirmation keywords.
    const noPending = (text) => brain.policyDecide({
        text, textLower: text.toLowerCase(), isManagerOrTeam: true, role: 'manager',
        chatId: 'sim', pendingAction: null,
    });
    ck('"replace the seal on that container" is NOT a fact-conflict answer',
        noPending('replace the seal on that container').intent !== 'resolve_fact_conflict');
    ck('"both containers are ready" is NOT a fact-conflict answer',
        noPending('both containers are ready').intent !== 'resolve_fact_conflict');
}

section('Cancel via the global rule still gives the useful answer');
{
    const actions = require(R('workflow/actions.js'));
    const sent = [];
    actions.init({
        sendMessage: async (_c, t) => { sent.push(String(t)); },
        sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: () => {},
    });
    writeFacts([]);
    await json.addFact('Pickups need 24h notice', true);
    SEARCH_HITS = [{ id: 1, text: 'Pickups need 24h notice', type: 'fact', similarity: 0.9, created_at: '2026-06-01T00:00:00.000Z' }];
    AI_VERDICT = { contradicts: 1, confidence: 0.85, why: 'conflicting' };
    await actions.rememberFact('sim', 'Pickups need 48h notice');

    sent.length = 0;
    // Exactly what the global cancel rule produces: resolvePending(..., 'no').
    const res = await actions.resolvePending('sim', actions.getPending('sim'), 'no');
    ck('typing "cancel" lands on the fact-conflict handler, not a bare "Cancelled."',
        res.action_taken === 'fact_conflict_cancelled');
    ck('and it names which version Jarvis is still going by', sent.join(' ').includes('24h notice'));
    ck('nothing was written', json.loadActiveFacts().map((f) => f.text).join() === 'Pickups need 24h notice');
    ck('the pending is cleared', !actions.getPending('sim'));
    SEARCH_HITS = [];
}

console.log(`\n================================================================`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log(`  - ${f}`)); }
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

})().catch((e) => {
    console.error('HARNESS CRASHED:', e);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
});
