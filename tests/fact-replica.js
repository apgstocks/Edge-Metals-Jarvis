// ── tests/fact-replica.js ───────────────────────────────────────────────────
// Every fact Apsara has taught Jarvis lives in one JSON file, on one VM, with
// no backup. Lose that disk and the memory is gone — years of standing rules,
// nothing to restore from. This suite covers the off-VM copy that fixes that.
//
// Supabase is stubbed with a fake table that records every call, so
// "did it actually try to replicate" is an assertion rather than an
// assumption — and so this runs on a machine with no network at all, which is
// every machine this codebase is developed on.
//
// The design under test is deliberately a REPLICA, not the source of truth
// (see claude/jarvis-supabase-plan.md): reads stay local so phase 4's
// retrieval stays off the network, and a Supabase outage cannot stop a write.
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rep-'));
process.env.DATA_DIR = scratch;
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://fake.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'fake-key';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));

// ── fake Supabase ──────────────────────────────────────────────────────────
let TABLE = new Map();          // id -> row
let CALLS = [];                 // every operation attempted
let FAIL_NEXT = null;           // simulate an outage
const sb = require(R('helpers/supabase.js'));
sb.getSupabase = () => ({
    from(table) {
        return {
            upsert(rows) {
                CALLS.push({ op: 'upsert', table, n: rows.length });
                if (FAIL_NEXT) return Promise.resolve({ error: { message: FAIL_NEXT } });
                for (const r of rows) TABLE.set(r.id, r);
                return Promise.resolve({ error: null });
            },
            select(_cols, opts) {
                const chain = {
                    order() { return chain; },
                    range(from, to) {
                        CALLS.push({ op: 'select', table });
                        if (FAIL_NEXT) return Promise.resolve({ data: null, error: { message: FAIL_NEXT } });
                        const all = [...TABLE.values()];
                        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
                    },
                    limit() {
                        if (FAIL_NEXT) return Promise.resolve({ data: null, error: { message: FAIL_NEXT } });
                        return Promise.resolve({ data: [...TABLE.values()].slice(0, 1), error: null });
                    },
                };
                if (opts && opts.head) {
                    if (FAIL_NEXT) return Promise.resolve({ count: null, error: { message: FAIL_NEXT } });
                    return Promise.resolve({ count: TABLE.size, error: null });
                }
                return chain;
            },
        };
    },
});

const emb = require(R('helpers/embeddings.js'));
emb.storeEmbedding = async () => {}; emb.deleteEmbeddingsByText = async () => 1; emb.searchSimilar = async () => [];

const j = require(R('helpers/json.js'));
const replica = require(R('helpers/factReplica.js'));
const reset = () => { fs.writeFileSync(cfg.FACTS_FILE, '[]'); TABLE = new Map(); CALLS = []; };
const settle = () => new Promise((r) => setTimeout(r, 40));

(async () => {

section('Facts are replicated as they change');
{
    reset();
    const f = await j.addFact('Busan rate is $2,400/MT', true, { origin: 'manager' });
    await settle();
    ck('adding a fact replicates it', TABLE.has(f.id));
    ck('with the full schema, not just the text',
        TABLE.get(f.id).origin === 'manager' && TABLE.get(f.id).authority === 'act'
        && TABLE.get(f.id).status === 'active');
    ck('keyed on the app id, so a restore is byte-identical',
        TABLE.get(f.id).id === f.id);

    const sup = await j.supersedeFact(f.id, 'Busan rate is $2,600/MT', { origin: 'manager' });
    await settle();
    ck('a correction replicates the NEW fact', TABLE.has(sup.fact.id));
    ck('AND the superseded one, so the backup does not still call it active',
        TABLE.get(f.id).status === 'superseded' && !!TABLE.get(f.id).superseded_by,
        'the replica would restore a stale belief as current');

    const ret = await j.retractFact(sup.fact.id, 'wrong');
    await settle();
    ck('a retraction is replicated, not dropped',
        TABLE.get(sup.fact.id).status === 'retracted',
        'a backup that drops retracted facts restores a memory she cannot audit or undo');

    await j.unretractFact(sup.fact.id);
    await settle();
    ck('and so is a restore', TABLE.get(sup.fact.id).status === 'active');
}

section('Strength changes reach the backup too');
{
    reset();
    const f = await j.addFact('Pickups need 24h notice', true, { origin: 'manager' });
    await settle();
    await j.addFact('Pickups need 24h notice', true, { origin: 'manager' });   // confirm
    await settle();
    ck('a confirmation updates the replica', TABLE.get(f.id).confirmations === 1,
        'the backup would restore a fact with the wrong decay strength');

    await j.setFactPinned(f.id, false);
    await settle();
    ck('so does an unpin', TABLE.get(f.id).pinned === false);
}

section('An outage must never block her teaching Jarvis something');
{
    reset();
    FAIL_NEXT = 'supabase unreachable';
    let threw = null;
    let f = null;
    try { f = await j.addFact('Written during an outage', true, { origin: 'manager' }); }
    catch (e) { threw = e; }
    await settle();
    FAIL_NEXT = null;

    ck('the local write succeeds anyway', !threw && !!f);
    ck('and the fact IS in the local store', j.loadActiveFacts().length === 1);
    ck('it is just missing from the backup for now', !TABLE.has(f.id));

    // ...and the nightly pass is what repairs it.
    await replica.syncAll();
    ck('the nightly sync repairs what the outage dropped', TABLE.has(f.id),
        'a dropped replication would stay dropped forever');
}

section('Full sync and restore');
{
    reset();
    const a = await j.addFact('Fact one', true, { origin: 'manager' });
    const b = await j.addFact('Fact two', false, { origin: 'agent' });
    await j.retractFact(b.id, 'nope');
    await settle();

    CALLS = [];
    const out = await replica.syncAll();
    ck('syncAll pushes every fact, including retracted ones', out.replicated === 2);
    ck('and does it in as few round-trips as possible',
        CALLS.filter((c) => c.op === 'upsert').length === 1);

    const pulled = await replica.pull();
    ck('pull returns them in fact shape', pulled.length === 2 && pulled.every((f) => f.id && f.text));
    ck('with replica bookkeeping stripped', pulled.every((f) => f.replicated_at === undefined));

    // The disaster path.
    const dry = await replica.restore();
    ck('restore DEFAULTS to a dry run', dry.dryRun === true);
    ck('and reports what it would change without doing it',
        dry.remote === 2 && dry.local === 2 && j.loadFacts().length === 2);

    // Local has something the replica does not. Note this needs replication
    // to FAIL — per-write replication backs a new fact up instantly, so the
    // only way to be genuinely ahead of the backup is for a push to drop.
    // (That the first attempt at this test failed is itself evidence the
    // per-write path works.)
    FAIL_NEXT = 'outage';
    await j.addFact('Newer than the backup', true, { origin: 'manager', confirmIfExists: false });
    await settle();
    FAIL_NEXT = null;
    ck('(setup) it really is missing from the backup', !TABLE.has(j.loadActiveFacts().find((f) => f.text === 'Newer than the backup').id));
    const dry2 = await replica.restore();
    ck('a restore WARNS about local facts the backup lacks',
        dry2.wouldDropLocalOnly === 1 && dry2.wouldDropTexts.length === 1,
        'a silent restore would delete corrections made since the last replication');
}

section('Restore refuses to do the dangerous thing');
{
    reset();
    await j.addFact('The only fact she has', true, { origin: 'manager' });
    await settle();
    TABLE = new Map();   // replica is empty — misconfigured, or never ran

    let threw = null;
    try { await replica.restore({ dryRun: false }); } catch (e) { threw = e; }
    ck('restoring from an EMPTY replica is refused, not obeyed', !!threw,
        'this would wipe facts.json because a connection was misconfigured');
    ck('and the local store is untouched', j.loadActiveFacts().length === 1);

    // A real restore keeps the file it overwrites.
    await replica.syncAll();
    const remoteCount = TABLE.size;
    FAIL_NEXT = 'outage';
    await j.addFact('Something added after the backup', true, { origin: 'manager' });
    await settle();
    FAIL_NEXT = null;
    ck('(setup) local is now ahead of the backup', j.loadFacts().length === remoteCount + 1);

    const done = await replica.restore({ dryRun: false });
    ck('a real restore reports what it did',
        done.restored === remoteCount && done.dryRun === false,
        `restored ${done.restored}, expected ${remoteCount}`);
    ck('and rolling back DOES drop the un-backed-up fact — which is why it warns first',
        !j.loadFacts().some((f) => f.text === 'Something added after the backup'));
    ck('and backs up the file it replaced', !!done.backup && fs.existsSync(done.backup),
        'if the replica turns out to be stale there is no way back');
}

section('Health — is the backup real, and how stale?');
{
    reset();
    await j.addFact('One', true, { origin: 'manager' });
    await j.addFact('Two', true, { origin: 'manager' });
    await settle();

    const st = await replica.status();
    ck('status reports both counts', st.ok === true && st.localCount === 2 && st.remoteCount === 2);
    ck('and zero drift when in sync', st.drift === 0);

    FAIL_NEXT = 'connection refused';
    const bad = await replica.status();
    FAIL_NEXT = null;
    ck('an unreachable backup reports ok:false rather than throwing', bad.ok === false && !!bad.error,
        'a health check that throws tells you nothing');
}

section('Not configured — the whole thing stays inert');
{
    reset();
    const url = cfg.SUPABASE_URL, key = cfg.SUPABASE_KEY;
    cfg.SUPABASE_URL = ''; cfg.SUPABASE_KEY = '';

    ck('configured() is false', replica.configured() === false);
    ck('push is a no-op', (await replica.push([{ id: 'x', text: 'y' }])).skipped === 'not-configured');
    ck('pull returns nothing rather than throwing', (await replica.pull()).length === 0);
    ck('status says so plainly', (await replica.status()).configured === false);

    const f = await j.addFact('Still works with no backup configured', true, { origin: 'manager' });
    ck('and facts still save normally', !!f && j.loadActiveFacts().length === 1);

    cfg.SUPABASE_URL = url; cfg.SUPABASE_KEY = key;
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
