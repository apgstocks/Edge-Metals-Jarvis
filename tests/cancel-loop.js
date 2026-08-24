// REGRESSION TEST — reproduces Apsara's live 2026-08-20 23:24 transcript,
// where "cancel" -> "Cancelled." -> "(Next up...)" -> the SAME question
// looped forever against a queue several deep.
//
//   Run:  node tests/cancel-loop.js      (from the repo root)
//
// REQUIRES A WRITABLE data/ DIRECTORY — it exercises the real setPending/
// promoteQueued/resolvePending against real brain.json writes (backing the
// file up first and restoring it at the end), because the whole bug lives
// in the queue PERSISTENCE, not in pure logic. If every line prints
// "[JSON] Mutate failed ... EPERM ... brain.json.lock", the writes are
// silently no-oping and the results are meaningless — run it in a normal
// Terminal on the machine itself, not through a remote/sandboxed mount
// that can't delete the lock directory.
// ── TEST ISOLATION (2026-08-25) ────────────────────────────────────────────
// Point DATA_DIR at a throwaway directory BEFORE anything requires config.js,
// which captures every file path at module load.
//
// Until now this suite ran against the REAL data/ — Apsara's live bookings,
// brain.json, reply_watch.json. Two concrete harms, both observed:
//   1. It MUTATED live files. data/reply_watch.json spent a day holding
//      "Raj / wants a rate / e1,e2,e3" — integration.js fixtures, not real
//      mail — which then read as live traffic when auditing what runs where.
//   2. proper-lockfile creates a <file>.json.lock DIRECTORY per write. Run
//      from the Cowork bridge, which cannot rmdir on the mounted volume,
//      every run leaves one behind. That is where the stale locks in data/
//      came from, and a no-op'd write makes a test's results meaningless
//      rather than failing loudly.
// A scratch dir fixes all of it and costs nothing: these tests exercise real
// file persistence either way, just not HER files.
const os = require('os');
const _p = require('path');
const _fs = require('fs');
process.env.DATA_DIR = process.env.DATA_DIR || _fs.mkdtempSync(_p.join(os.tmpdir(), 'jarvis-test-'));


const fs = require('fs'), path = './data/brain.json';
const backup = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
const actions = require('../workflow/actions.js');
const brain = require('../workflow/brain.js');
const CHAT = 'regress@g.us';
const sent = [];
// Wire the outbound-send hooks the same way index.js does at boot, but
// capture instead of sending — otherwise _send is undefined and every
// reply path throws.
actions.init({
    sendMessage: async (_id, t) => { sent.push(t); },
    sendToManager: async () => {}, sendToTeam: async () => {}, pushAlert: async () => {},
});

const cargo = () => ({ type: 'await_quote_cargo_details', state: { originQuery: 'Junk car', destinationQuery: 'Eccomelt' } });
const scale = () => ({ type: 'await_quote_scale_tickets', state: { originQuery: 'Junk car', destinationQuery: 'Eccomelt' } });

let P = 0, F = 0;
const ck = (d, a, e) => { const ok = a === e; ok ? P++ : F++; console.log(`  ${ok ? 'PASS' : 'FAIL'} | ${d}: ${a} (expect ${e})`); };

(async () => {
    await actions.clearAllPending(CHAT);

    console.log('\n=== A. Reproduce the pileup as it happened live ===');
    // She sent the quote command repeatedly while cargo was stuck.
    await actions.setPending(CHAT, scale());
    for (let i = 0; i < 6; i++) await actions.setPending(CHAT, cargo());
    const depth = actions.getQueuedPendings(CHAT).length;
    console.log(`  active=${actions.getPending(CHAT).type}, queued=${depth}`);
    ck('queue holds ONE cargo copy, not six', depth, 1);

    console.log('\n=== B. "cancel all" ends it in ONE message ===');
    sent.length = 0;
    const ctx = {
        isManagerOrTeam: true, pendingAction: actions.getPending(CHAT),
        text: 'cancel all', textLower: 'cancel all', chatId: CHAT, session: {},
    };
    const d = brain.policyDecide(ctx);
    ck('routes to resolve_pending', d.intent, 'resolve_pending');
    ck('carries cancelText', !!d.data.cancelText, true);
    await actions.resolvePending(CHAT, ctx.pendingAction, d.data.answer, d.data.selection, d.data.cancelText);
    ck('active pending gone', actions.getPending(CHAT), null);
    ck('queue fully drained', actions.getQueuedPendings(CHAT).length, 0);
    const promoted = await actions.promoteQueued(CHAT);
    ck('nothing re-promoted (LOOP BROKEN)', promoted, null);

    console.log('\n=== C. Bare "cancel" warns about what is still stacked ===');
    await actions.clearAllPending(CHAT);
    await actions.setPending(CHAT, scale());
    await actions.setPending(CHAT, cargo());   // different type -> genuinely queues
    const beforeC = actions.getQueuedPendings(CHAT).length;
    ck('one genuinely different question is queued', beforeC, 1);
    await actions.resolvePending(CHAT, actions.getPending(CHAT), 'no', null, 'cancel');
    ck('bare cancel drops only the active one', actions.getQueuedPendings(CHAT).length, 1);

    console.log('\n=== D. Cancel-all with a deep MIXED queue still ends in one shot ===');
    await actions.clearAllPending(CHAT);
    await actions.setPending(CHAT, scale());
    await actions.setPending(CHAT, cargo());
    await actions.setPending(CHAT, { type: 'await_quote_cargo_details', state: { originQuery: 'LA', destinationQuery: 'NY' } });
    await actions.setPending(CHAT, { type: 'await_container_number' });
    const total = 1 + actions.getQueuedPendings(CHAT).length;
    console.log(`  built a mixed queue: ${total} total questions`);
    const res = await actions.clearAllPending(CHAT);
    ck('clearAllPending reports the true count', res.count, total);
    ck('active gone', actions.getPending(CHAT), null);
    ck('queue gone', actions.getQueuedPendings(CHAT).length, 0);
    ck('nothing re-promoted', await actions.promoteQueued(CHAT), null);

    await actions.clearAllPending(CHAT);
    if (backup !== null) fs.writeFileSync(path, backup);
    console.log(`\n${'='.repeat(50)}\n${P} passed, ${F} failed`);
    process.exit(F ? 1 : 0);
})().catch(e => { if (backup !== null) fs.writeFileSync(path, backup); console.error(e); process.exit(1); });
