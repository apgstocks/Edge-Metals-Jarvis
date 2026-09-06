// ── tests/replywatch-concurrency.js — P9 ────────────────────────────────────
// run: node tests/replywatch-concurrency.js
//
// THE BUG (audit item P9, open since the replyWatch rebuild):
// run() reads the store, scans for minutes, then writes back what it holds. A
// 25-email run can outlast the 5-minute cron, so two scans overlap and the
// second one's write erases the first's. Emails get re-assessed and re-billed
// — and an `ignore 3` she typed during a scan is silently undone by a scan
// that was already in flight.
//
// Against the code as it stood before the fix this file scored 3/9.
//
// ⚠ The DATA_DIR line below MUST stay first, before anything requires
// config.js — config resolves DATA_DIR once at load and caches it. Without it
// this suite writes into the LIVE data/reply_watch.json and destroys her real
// inbox state. tests/integration.js did exactly that until 2026-09-01, and
// building this file I removed the line by accident and reproduced it inside
// five minutes. The assertion at the bottom is there because a comment alone
// clearly is not enough.
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/p9-');
const path = require('path');
const R = (p) => require("path").join(__dirname, "..", p);
const cfg = require(R('config'));
const rw = require(R('workflow/replyWatch'));
const { loadStore, saveStore } = rw;

let pass = 0, fail = 0;
const ck = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w);
  ok ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log(`  FAIL  ${l}\n    got:  ${JSON.stringify(g)}\n    want: ${JSON.stringify(w)}`)); };

(async () => {
console.log('\n=== P9: two overlapping scans must not clobber each other ===');

// Seed: three tracked items, as if from a previous run.
// RELATIVE dates, never hardcoded. `seen` is trimmed to a retention window,
// so a fixed date silently ages out of it and the test starts failing on a
// date unrelated to any code change — which is exactly what it did.
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
let s0 = loadStore();
s0.tracked = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
s0.seen = { a: hoursAgo(2) };
await saveStore(s0);

// Scan A and scan B both load the SAME starting state — the overlap.
const A = loadStore();
const B = loadStore();

// A finds a new email and tracks it.
A.tracked.push({ id: 'd' });
A.seen.d = hoursAgo(1);

// Meanwhile she types "ignore c" — B drops it.
B.tracked = B.tracked.filter((t) => t.id !== 'c');
B.muted = { senders: { 'x@y.com': hoursAgo(1) }, threads: {} };

// A finishes first, then B writes over the top.
await saveStore(A);
await saveStore(B);

const final = loadStore();
const ids = final.tracked.map((t) => t.id).sort();

ck("A's new item survives B's write", ids.includes('d'), true);
ck("her `ignore c` is NOT undone by A's in-flight scan", ids.includes('c'), false);
ck('untouched items survive both', ids.filter((i) => i === 'a' || i === 'b').length, 2);
ck('final tracked set', ids, ['a', 'b', 'd']);
ck("A's seen entry survives", Object.keys(final.seen).sort(), ['a', 'd']);
ck("B's mute survives A's write", Object.keys(final.muted.senders), ['x@y.com']);

// The reverse order must be just as safe.
console.log('\n=== reverse write order ===');
let s1 = loadStore();
s1.tracked = [{ id: 'p' }, { id: 'q' }];
await saveStore(s1);
const C = loadStore(), D = loadStore();
C.tracked = C.tracked.filter((t) => t.id !== 'q');   // she ignores q
D.tracked.push({ id: 'r' });                          // other scan adds r
await saveStore(D);   // D first this time
await saveStore(C);   // C (the ignore) last
ck('ignore still holds when it writes last', loadStore().tracked.map((t) => t.id).sort(), ['p', 'r']);

// A counter updated by one run must not be reset by the other.
console.log('\n=== chase counters ===');
let s2 = loadStore();
s2.tracked = [{ id: 'z', chases: 2 }];
await saveStore(s2);
const E = loadStore(), F = loadStore();
E.tracked[0].chases = 3;        // E chased it
F.seen.unrelated = hoursAgo(1);  // F did something else entirely
await saveStore(E);
await saveStore(F);
ck("F's unrelated write does not reset E's chase count",
   loadStore().tracked.find((t) => t.id === 'z').chases, 3);

// Timestamps take the later value, never the older one.
console.log('\n=== heartbeat ===');
const G = loadStore(), H = loadStore();
const NEWER = hoursAgo(1), OLDER = hoursAgo(2);
G.lastScanAt = NEWER;
H.lastScanAt = OLDER;
await saveStore(G);
await saveStore(H);   // older one writes last
ck('an older scan cannot roll the heartbeat backwards', loadStore().lastScanAt, NEWER);

// The guard this file's own header is about: prove, at runtime, that nothing
// here can reach the live store.
const liveStore = path.join(__dirname, '..', 'data', 'reply_watch.json');
ck('never writes to the live data/ directory',
   path.resolve(cfg.REPLY_WATCH_FILE) !== path.resolve(liveStore), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
