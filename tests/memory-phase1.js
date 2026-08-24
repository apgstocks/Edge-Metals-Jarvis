// ── tests/memory-phase1.js ──────────────────────────────────────────────────
// Apsara, 2026-08-25: "Lets work on this memory layer... I can learn-relearn-
// unlearn-improve-become best."
//
// Phase 1 of that work is not the new architecture — it is stopping the
// current one from actively corrupting itself. Four defects, all live before
// this file existed, each with a test here that FAILS if the fix is reverted:
//
//   F1  a fact deleted from facts.json kept its Supabase vector row, and
//       helpers/context.js's semantic recall pulled it back into the very
//       next prompt labelled "[recalled from memory, N% relevant]".
//   F4  helpers/graph.js does not exist (verified on disk AND on GitHub), so
//       the require inside the fact-delete handler threw before .catch could
//       attach — a 500 returned on a delete that had already succeeded.
//   F5  pin/delete addressed facts by ARRAY INDEX; addFact's 200-cap eviction
//       shifts every index below it, so a delete could hit the wrong fact.
//   ——  and the whole reason none of this was caught: nothing ever invoked
//       these paths. Everything below is a real call against real modules.
//
// Scratch DATA_DIR, real helpers/json.js, real helpers/context.js. Only the
// genuinely networked edges (Gemini embeddings, Supabase) are stubbed — and
// the stubs RECORD what they were asked to do, so "did the delete actually
// try to remove the vector row" is an assertion, not an assumption.
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem1-'));
process.env.DATA_DIR = scratch;
// Must be set BEFORE config.js is required — cfg.API_TOKEN is captured at
// module load, so setting it later leaves the bearer check comparing against
// whatever the real environment had (or ''), and every admin route 401s.
process.env.API_TOKEN = 'phase1-test-token';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'phase1-test-admin';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));

// ── stub the networked edges, but RECORD every call ────────────────────────
const embeddings = require(R('helpers/embeddings.js'));
let STORED = [];      // [{text, type}]
let DELETED = [];     // [{text, type}]
let SEARCH_HITS = []; // what searchSimilar returns
let DELETE_SHOULD_THROW = false;
embeddings.storeEmbedding = async ({ text, type }) => { STORED.push({ text, type }); };
embeddings.deleteEmbeddingsByText = async (text, type) => {
    if (DELETE_SHOULD_THROW) throw new Error('supabase unreachable');
    DELETED.push({ text, type });
    return 1;
};
embeddings.searchSimilar = async () => SEARCH_HITS;

const json = require(R('helpers/json.js'));

const settle = () => new Promise((r) => setTimeout(r, 20)); // fire-and-forget writes

(async () => {

// ── F5 ─────────────────────────────────────────────────────────────────────
section('F5 — a fact is addressed by identity, not by position');
{
    fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify([], null, 2));
    const a = await json.addFact('Rate for Busan is $2,100/MT', true);
    const b = await json.addFact('TQL needs 24h notice', false);
    const c = await json.addFact('Bose is CC on all Zimex mail', true);

    ck('addFact returns the record it wrote', !!(a && a.id && a.text));
    ck('every fact gets a distinct id', new Set([a.id, b.id, c.id]).size === 3);
    ck('ids are prefixed so they can never be read as an index', /^fct_/.test(a.id) && !/^\d+$/.test(a.id));

    // The actual F5 scenario: something shifts positions between render and
    // click. Delete the FIRST fact, then delete `c` by id — under the old
    // index scheme, c's rendered index (2) would now point at nothing, or
    // worse, at a different record.
    await json.deleteFactById(a.id);
    const removed = await json.deleteFactById(c.id);
    ck('deleting by id still hits the right fact after positions shifted',
        !!removed && removed.text === 'Bose is CC on all Zimex mail');

    const left = json.loadFacts();
    ck('and only the untouched fact remains', left.length === 1 && left[0].text === 'TQL needs 24h notice');
    ck('deleting an unknown id reports honestly instead of removing something else',
        (await json.deleteFactById('fct_doesnotexist')) === null && json.loadFacts().length === 1);

    const okPin = await json.setFactPinned(left[0].id, true);
    ck('pin by id works', okPin === true && json.loadFacts()[0].pinned === true);
    ck('pin with an unknown id returns false, changes nothing',
        (await json.setFactPinned('fct_nope', false)) === false && json.loadFacts()[0].pinned === true);
}

// ── legacy migration ───────────────────────────────────────────────────────
section('Legacy facts on disk — ids must be stable across the migration');
{
    // A facts.json written before this change: no id field anywhere.
    fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify([
        { text: 'Old pinned rule', pinned: true, created_at: '2026-06-01T00:00:00.000Z' },
        { text: 'Old loose note', pinned: false, created_at: '2026-06-02T00:00:00.000Z' },
    ], null, 2));

    const before = json.loadFacts();
    ck('legacy facts are given ids on read', before.every((f) => /^fct_/.test(f.id)));
    ck('two legacy facts get different ids', before[0].id !== before[1].id);

    // THE property that makes this migration safe: a dashboard page rendered
    // BEFORE anything was persisted sends an id that must still resolve after
    // a write has happened. Derived from immutable content, so it does.
    const idFromStaleRender = before[0].id;
    await json.addFact('something new', false);          // forces a persist
    const after = json.loadFacts();
    ck('a legacy fact keeps the SAME id after the store is rewritten',
        after.find((f) => f.text === 'Old pinned rule').id === idFromStaleRender);

    const removed = await json.deleteFactById(idFromStaleRender);
    ck('an id captured before migration still deletes the right fact',
        !!removed && removed.text === 'Old pinned rule');
    ck('deriveFactId is a pure function of text + created_at',
        json.deriveFactId({ text: 'a', created_at: 'b' }) === json.deriveFactId({ text: 'a', created_at: 'b' }));
    ck('different content derives a different id',
        json.deriveFactId({ text: 'a', created_at: 'b' }) !== json.deriveFactId({ text: 'a', created_at: 'c' }));
}

// ── F1, half one ───────────────────────────────────────────────────────────
section('F1a — deleting a fact also deletes its vector row');
{
    fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify([], null, 2));
    STORED = []; DELETED = [];
    const f = await json.addFact('Zimex cutoff is Thursday', true);
    await settle();
    ck('adding a fact stores an embedding for it', STORED.some((s) => s.text === 'Zimex cutoff is Thursday' && s.type === 'fact'));

    await json.deleteFactById(f.id);
    await settle();
    ck('deleting a fact asks the vector store to drop it too',
        DELETED.some((d) => d.text === 'Zimex cutoff is Thursday' && d.type === 'fact'));

    // The vector delete is a network call. It must never be able to fail the
    // local delete — the fact is gone from Jarvis's beliefs either way.
    DELETE_SHOULD_THROW = true;
    const g = await json.addFact('Temporary note', false);
    let threw = null;
    try { await json.deleteFactById(g.id); } catch (e) { threw = e; }
    await settle();
    ck('a vector-store outage does NOT fail the local delete', !threw);
    ck('and the fact really is gone locally', !json.loadFacts().some((x) => x.id === g.id));
    DELETE_SHOULD_THROW = false;
}

// ── F1, half two — the one that actually closes the hole ───────────────────
section('F1b — a deleted fact can never be resurrected by semantic recall');
{
    fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify([
        { id: 'fct_live', text: 'Busan rate is $2,400/MT', pinned: false, created_at: '2026-08-01T00:00:00.000Z' },
    ], null, 2));
    fs.writeFileSync(cfg.TRANSCRIPTS_FILE, JSON.stringify({}, null, 2));

    // Exactly the live failure: Supabase still holds a row for a fact that
    // was deleted from facts.json weeks ago, and hands it back at 91%.
    SEARCH_HITS = [
        { id: 1, text: 'Busan rate is $2,400/MT', type: 'fact', similarity: 0.93, created_at: '2026-08-01T00:00:00.000Z' },
        { id: 2, text: 'Busan rate is $1,800/MT', type: 'fact', similarity: 0.91, created_at: '2026-06-01T00:00:00.000Z' }, // DELETED long ago
        { id: 3, text: 'topic: booking status', type: 'session_summary', similarity: 0.80, created_at: '2026-08-01T00:00:00.000Z' },
    ];

    delete require.cache[require.resolve(R('helpers/context.js'))];
    const context = require(R('helpers/context.js'));
    const out = await context.formatForAI({
        chatId: 'sim', text: 'what is the busan rate', role: 'manager',
        isManagerOrTeam: true, allBookings: {}, allWorkflow: {},
        truckers: [], suppliers: [], session: {}, activeSlots: [], urgentBookings: [],
    });
    const blob = typeof out === 'string' ? out : JSON.stringify(out);

    ck('a stale vector row for a DELETED fact never reaches the prompt', !blob.includes('$1,800/MT'),
        'the deleted fact was re-injected — F1 is back');
    ck('the fact that IS still live is unaffected', blob.includes('$2,400/MT'));
    ck('session-summary recall still works (the filter is fact-scoped)', blob.includes('topic: booking status'));
    SEARCH_HITS = [];
}

// ── F4 ─────────────────────────────────────────────────────────────────────
section('F4 — a module that was never written cannot 500 a real delete');
{
    let graphResolved = true;
    try { require.resolve(R('helpers/graph.js')); } catch { graphResolved = false; }
    ck('helpers/graph.js is genuinely absent (the premise of this test)', graphResolved === false);

    const http = require('http');
    fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify([
        { id: 'fct_target', text: 'Delete me cleanly', pinned: false, created_at: '2026-08-01T00:00:00.000Z' },
    ], null, 2));

    let app;
    try {
        delete require.cache[require.resolve(R('api.js'))];
        app = require(R('api.js')).createApi();
    } catch (e) {
        ck('api.js loads', false, e.message);
    }

    if (app) {
        const server = http.createServer(app).listen(0);
        await new Promise((r) => server.once('listening', r));
        const port = server.address().port;

        const call = (method, p) => new Promise((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, path: p, method,
                headers: { Authorization: `Bearer ${cfg.API_TOKEN}` } }, (res) => {
                let body = ''; res.on('data', (d) => { body += d; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });
            req.on('error', (e) => resolve({ status: 0, body: e.message }));
            req.end();
        });

        const del = await call('DELETE', '/api/facts/fct_target');
        ck('deleting a fact returns success, not a 500 from the missing module',
            del.status === 200, `got ${del.status} — ${del.body.slice(0, 160)}`);
        // SEMANTICS CHANGED IN PHASE 2 (2026-08-25): DELETE now RETRACTS
        // rather than destroys — the fact leaves every prompt immediately but
        // stays on disk, auditable and recoverable from a mis-click. So the
        // assertion is "no longer believed", not "no longer exists". This
        // test failing was the correct signal when that change landed.
        ck('and the fact is no longer believed', !json.loadActiveFacts().some((f) => f.id === 'fct_target'));
        ck('but it is retained on record, marked retracted',
            json.loadFacts().find((f) => f.id === 'fct_target')?.status === 'retracted');

        const stale = await call('DELETE', '/api/facts/3');
        ck('a stale page sending a bare index is refused, not acted on',
            stale.status === 409, `got ${stale.status}`);

        const trace = await call('GET', '/api/graph/trace?entity=TQL');
        ck('graph trace honours its documented "never an error" contract',
            trace.status === 200, `got ${trace.status} — ${trace.body.slice(0, 120)}`);
        const status = await call('GET', '/api/graph/status');
        ck('graph status reports not-configured rather than crashing',
            status.status === 200 && /"configured":\s*false/.test(status.body), status.body.slice(0, 120));

        await new Promise((r) => server.close(r));
    }
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
