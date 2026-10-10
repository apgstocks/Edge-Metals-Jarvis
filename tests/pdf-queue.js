// ── tests/pdf-queue.js ────────────────────────────────────────────────────
// Apsara, 2026-09-18: "parallel simulatenous connection should be allowed in
// website and document", after a second person's download never completed
// while she had the website open.
//
// ── WHAT THIS FILE IS GUARDING AGAINST ──────────────────────────────────────
// A queue's own failure mode is a HANG, and a hang is harder to diagnose than
// the memory problem it was added to fix. So the checks are not "does it queue"
// — that part is easy — they are the four ways it could make things worse:
//
//   a job that THROWS keeps the slot, and every document after it waits for
//     ever;
//   a job that WEDGES keeps the slot, same result;
//   the line grows without limit, so a busy minute becomes a queue of two
//     hundred and a proxy timeout for everyone;
//   it serialises more than the rendering, and the app becomes single-user —
//     the opposite of what she asked for.
//
// And one that is not about the queue at all: the three PDF helpers must
// actually go through it, or this file is testing a component nothing uses.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const q = require(path.join(ROOT, 'helpers/pdfQueue'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A SILENT EXIT IS A FAILURE, NOT A PASS ──────────────────────────────────
// Every timer in pdfQueue is unref'd, deliberately: the queue must never hold
// the process open between documents. The consequence for THIS file is that a
// job which never settles lets node's event loop empty, and the process exits
// 0 having printed nothing at all — a deadlock that reads as success.
//
// Found by a mutation making the queue unbounded: it "survived" because the
// run ended silently instead of failing. CLAUDE.md records the mirror of this
// ("36 passed, 0 failed" and exit 1); this is the same lesson upside down.
//
// In production the HTTP server keeps node alive, so this is a property of
// the test, not a bug in the queue — but only this guard can tell the two
// apart.
let finished = false;
process.on('exit', (code) => {
    if (!finished && code === 0) {
        console.log('\n  FAIL  the suite exited before finishing — a job never settled');
        process.exitCode = 1;
    }
});

(async () => {

// ── A. BOUNDED, NOT SERIAL ──────────────────────────────────────────────────
// This section used to be called "only one job runs at once" and asserted
// peak concurrency of exactly 1. That was right while every document launched
// its OWN 300–400MB Chromium — the whole reason this file exists (Apsara,
// 2026-09-18: "parallel simulatenous connection should be allowed in website
// and document").
//
// helpers/pdfBrowser.js stopped launching a browser per document on
// 2026-10-03; a document is a TAB. So on 2026-10-10 — "i want everything to
// handle fast-its a quick business" — the limit went to three.
//
// The PROPERTY this section protects has not changed and is the one that
// matters: the number of simultaneous renders is BOUNDED and everything
// submitted still comes back. Only the bound moved, so the check reads it
// from the queue instead of pinning 1.
section('A. renders are bounded, and nothing is dropped');
q.reset();
{
    let running = 0, peak = 0;
    const job = async () => {
        running += 1; peak = Math.max(peak, running);
        await sleep(30);
        running -= 1;
        return 'done';
    };
    const lim = q.snapshot().limit;
    const n = lim + 2;                       // two more than can run together
    const results = await Promise.all(
        Array.from({ length: n }, (_, i) => q.run(job, `a${i}`)));
    ck('NEVER MORE THAN THE LIMIT AT ONCE', peak === lim, `peak ${peak}, limit ${lim}`);
    ck('  and it is more than one, so the second person is not simply waiting',
       lim > 1 || process.env.PDF_CONCURRENCY === '1', `limit ${lim}`);
    ck('  and every one of them still succeeds', results.every((r) => r === 'done'),
       'the queue dropped work instead of delaying it — she pressed Generate and got nothing');
    ck('  the ones over the limit had to wait', q.snapshot().queued === n - lim,
       JSON.stringify(q.snapshot()));
    ck('  and the queue is empty afterwards',
       q.snapshot().running === 0 && q.snapshot().waiting === 0, JSON.stringify(q.snapshot()));
}

// ── B. Order ────────────────────────────────────────────────────────────────
section('B. first come, first served');
q.reset();
{
    const order = [];
    await Promise.all(['a', 'b', 'c', 'd'].map((n) =>
        q.run(async () => { await sleep(10); order.push(n); }, n)));
    ck('jobs run in the order they arrived', order.join('') === 'abcd', order.join(''));
}

// ── C. A THROWING JOB MUST NOT KEEP THE SLOT ────────────────────────────────
// The single most important check here. Without the finally, one failed
// generate stops every document on the server until pm2 is restarted.
section('C. a failure releases the queue');
q.reset();
{
    let err = null;
    try { await q.run(async () => { throw new Error('chromium died'); }, 'bad'); }
    catch (e) { err = e; }
    ck('the error reaches the caller unchanged', err && err.message === 'chromium died',
       'the queue swallowed it, so the screen would say nothing useful');
    ck('  and the slot is free', q.snapshot().busy === false);

    const after = await q.run(async () => 'still works', 'good');
    ck('  so the next document still generates', after === 'still works',
       'one failed generate wedged the server until a restart');
}

// A synchronous throw, which is a different path — the job never returns a
// promise at all.
q.reset();
{
    let err = null;
    try { await q.run(() => { throw new Error('threw before awaiting'); }, 'sync-bad'); }
    catch (e) { err = e; }
    ck('a job that throws synchronously also releases the slot',
       !!err && q.snapshot().busy === false, JSON.stringify(q.snapshot()));
    ck('  and the queue keeps working', (await q.run(async () => 'ok')) === 'ok');
}

// ── D. A WEDGED JOB MUST NOT KEEP IT EITHER ─────────────────────────────────
// A Chromium that never returns is the case the timeout exists for. Tested by
// pointing the module's own constant at something short — the behaviour is
// what matters, not the ninety seconds.
section('D. a wedged job is stepped over');
q.reset();
{
    // A per-job timeout, passed in. An earlier version of this test
    // overwrote the exported JOB_TIMEOUT_MS constant and the override did
    // NOTHING — next() closes over the internal binding — so the wedge was
    // never actually stepped over and the check failed for the right reason.
    // Ninety seconds cannot be waited out in a suite, so the seam is real.
    // ── EVERY SLOT WEDGED, NOT JUST ONE ──────────────────────────────────
    // With one render at a time, a single wedged job blocked everything and
    // one was enough to test with. Since 2026-10-10 the queue runs `limit`
    // at once, so ONE wedge leaves free slots and the job behind it sails
    // through without the timeout ever mattering — the check passed while
    // proving nothing, and `timedOut` was read before the timer had fired.
    // Saturating is what reproduces the real situation.
    let wedgedFinished = 0;
    const lim = q.snapshot().limit;
    const wedges = Array.from({ length: lim }, (_, i) =>
        q.run(() => new Promise((r) => setTimeout(() => { wedgedFinished += 1; r('late'); }, 400)),
              `wedged${i}`, { timeoutMs: 60 }));
    await sleep(20);
    ck('every slot is held by a wedged job', q.snapshot().running === lim,
       JSON.stringify(q.snapshot()));
    const behind = q.run(async () => 'got through', 'behind');

    const got = await Promise.race([behind, sleep(500).then(() => 'STILL WAITING')]);
    ck('a document behind a wedged one still generates', got === 'got through',
       'it waited behind jobs that never finished — the hang this queue could have caused');
    ck('  and the wedge is counted, not hidden', q.snapshot().timedOut >= lim,
       JSON.stringify(q.snapshot()));
    // Not killed — the queue does not own the browser those jobs are driving
    // and cannot safely tear one down. It only stops them being everyone
    // else's problem. Zero FINISHED so far is what says they are still going.
    ck('  while the stuck jobs are left to finish on their own', wedgedFinished === 0,
       String(wedgedFinished));
    await Promise.all(wedges);   // let it land so it does not leak into the next section
}

// ── E. The line has a length ────────────────────────────────────────────────
// Refusing in a second beats a spinner that ends in a proxy timeout, and it is
// the signal that something is wrong rather than merely busy.
section('E. the queue is bounded');
q.reset();
{
    const held = [];
    const slow = () => new Promise((r) => held.push(r));
    const runs = [];
    // ── FILL THE LINE FROM THE QUEUE'S OWN NUMBERS ───────────────────────
    // This used to submit MAX_WAITING + 1 and expect the next to be refused,
    // which was right while exactly ONE job ran at a time. Since 2026-10-10
    // the queue runs `limit` concurrently (3 by default), so the running ones
    // do not occupy the WAITING line and the refusal arrives later. Reading
    // the limit from snapshot() keeps this correct at any PDF_CONCURRENCY
    // instead of pinning the arithmetic of one setting.
    const lim = q.snapshot().limit;
    for (let i = 0; i < lim + q.MAX_WAITING; i++) runs.push(q.run(slow, `j${i}`).catch((e) => e));
    // One more than fits.
    const overflow = await q.run(slow, 'one too many').catch((e) => e);
    ck('past the limit it REFUSES rather than queueing for ever',
       overflow instanceof Error && overflow.code === 'PDF_QUEUE_FULL', String(overflow));
    ck('  with a sentence she can act on',
       /busy generating other documents/i.test(overflow.message) && /try again|press Generate again/i.test(overflow.message),
       overflow.message);
    ck('  and the refusal is counted', q.snapshot().refused === 1);

    // Drain in a LOOP. A held job only registers its resolver once it starts,
    // so releasing the one that happened to be running left the other twelve
    // queued for ever and this file hung at 90s with no summary printed —
    // which looks exactly like the queue deadlocking. It was the test.
    for (let i = 0; i < 200 && (held.length || q.snapshot().busy || q.snapshot().waiting); i++) {
        while (held.length) held.shift()('done');
        await sleep(5);
    }
    await Promise.all(runs);
    ck('  and the whole backlog drains', q.snapshot().waiting === 0 && q.snapshot().busy === false,
       JSON.stringify(q.snapshot()));
}

// ── E2. MANY PEOPLE DOWNLOADING AT ONCE ─────────────────────────────────────
// Apsara, 2026-10-10: "what if many people share the website and try to
// download simulatenously" and "i want everything to handle fast-its a quick
// business".
//
// This file serialised to ONE render because each document launched its own
// 300–400MB Chromium. helpers/pdfBrowser.js stopped doing that on 2026-10-03
// — a document is a TAB now — so the limit was protecting against a cost that
// no longer exists, and the twelfth person in the line was waiting minutes
// for nothing.
section('E2. more than one document renders at a time');
q.reset();
{
    const held = [];
    const slow = () => new Promise((r) => held.push(r));
    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(q.run(slow, `c${i}`).catch((e) => e));
    await sleep(20);
    const snap = q.snapshot();
    ck('three documents render at once, not one', snap.running === 3, JSON.stringify(snap));
    ck('  and the rest wait rather than being refused', snap.waiting === 3, JSON.stringify(snap));
    ck('  the limit is reported, so "why was that slow" has an answer',
       snap.limit === 3 && snap.configuredLimit === 3, JSON.stringify(snap));
    while (held.length) held.shift()('done');
    for (let i = 0; i < 200 && (held.length || q.snapshot().waiting || q.snapshot().running); i++) {
        while (held.length) held.shift()('done');
        await sleep(5);
    }
    await Promise.all(runs);
    ck('  and every one of them finishes', q.snapshot().waiting === 0 && q.snapshot().running === 0,
       JSON.stringify(q.snapshot()));
    ck('  the high-water mark is recorded', q.snapshot().maxRunning === 3, JSON.stringify(q.snapshot()));
}

// ── E3. AND IT DROPS BACK TO ONE WHEN WE ARE ON OUR OWN CHROMIUM ────────────
// The tabs are only cheap while they are tabs. If WhatsApp's browser has
// stalled, pdfBrowser falls back to launching OUR Chromium — and three of
// those at once on a small VM is the 2026-09-18 outage rebuilt by hand.
section('E3. a stalled shared browser makes it serial again');
q.reset();
{
    const pb = require(path.join(ROOT, 'helpers/pdfBrowser'));
    // Put pdfBrowser into the stalled state the honest way — through a failed
    // render on a browser that hands out a tab and then hangs — rather than
    // poking at its internals, which would stop testing the real path the
    // moment that state is stored differently.
    const hangPage = { setViewport: async () => {}, setDefaultNavigationTimeout() {},
        setDefaultTimeout() {}, close: async () => {},
        render: async () => { const e = new Error('Navigation timeout'); e.name = 'TimeoutError'; throw e; } };
    const okPage = { setViewport: async () => {}, setDefaultNavigationTimeout() {},
        setDefaultTimeout() {}, close: async () => {}, render: async () => 'PDF' };
    pb._resetForTests();
    pb.init({ getBrowser: () => ({ isConnected: () => true, newPage: async () => hangPage }),
              launch: async () => ({ newPage: async () => okPage }) });
    await pb.withPage(async (pg) => pg.render());
    ck('the shared browser is now marked stalled', pb.snapshot().sharedStalled === true);

    const held = [];
    const slow = () => new Promise((r) => held.push(r));
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(q.run(slow, `s${i}`).catch((e) => e));
    await sleep(20);
    ck('  so the queue renders ONE at a time again', q.snapshot().running === 1,
       JSON.stringify(q.snapshot()));
    ck('  and says so', q.snapshot().limit === 1 && q.snapshot().configuredLimit === 3,
       JSON.stringify(q.snapshot()));
    for (let i = 0; i < 200 && (held.length || q.snapshot().waiting || q.snapshot().running); i++) {
        while (held.length) held.shift()('done');
        await sleep(5);
    }
    await Promise.all(runs);
    ck('  and the backlog still drains', q.snapshot().waiting === 0 && q.snapshot().running === 0,
       JSON.stringify(q.snapshot()));
    pb._resetForTests();
    pb.init({ getBrowser: () => null, launch: (o) => require('puppeteer').launch(o) });
}

// ── E4. WHEN THE SHARED BROWSER COMES BACK ──────────────────────────────────
// The case the drain LOOP exists for, and the only one that distinguishes it
// from starting a single job per release.
//
// While WhatsApp's Chromium is stalled the limit is 1, so a backlog builds
// behind one render. When the cooldown passes the limit goes back to 3 — and
// the next release frees ONE slot while THREE are now allowed. Starting one
// job per release would leave the queue running at a third of capacity until
// another document happened to arrive, which on a quiet afternoon could be
// minutes. She would see the backlog crawl and nothing in the log would say
// why.
section('E4. the backlog catches up the moment capacity returns');
q.reset();
{
    const pb = require(path.join(ROOT, 'helpers/pdfBrowser'));
    const hangPage = { setViewport: async () => {}, setDefaultNavigationTimeout() {},
        setDefaultTimeout() {}, close: async () => {},
        render: async () => { const e = new Error('Navigation timeout'); e.name = 'TimeoutError'; throw e; } };
    pb._resetForTests();
    pb.init({ getBrowser: () => ({ isConnected: () => true, newPage: async () => hangPage }),
              launch: async () => ({ newPage: async () => ({ setViewport: async () => {},
                  setDefaultNavigationTimeout() {}, setDefaultTimeout() {},
                  close: async () => {}, render: async () => 'PDF' }) }) });
    await pb.withPage(async (pg) => pg.render());
    ck('the shared browser is stalled, so the limit is 1', q.snapshot().limit === 1);

    const held = [];
    const slow = () => new Promise((r) => held.push(r));
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(q.run(slow, `b${i}`).catch((e) => e));
    await sleep(20);
    ck('  one renders, three wait', q.snapshot().running === 1 && q.snapshot().waiting === 3,
       JSON.stringify(q.snapshot()));

    // The cooldown passes — WhatsApp's browser is usable again.
    pb._resetForTests();
    pb.init({ getBrowser: () => null, launch: async () => ({ newPage: async () => ({}) }) });
    ck('  capacity is back', q.snapshot().limit === 3, JSON.stringify(q.snapshot()));

    // ONE job finishes. That frees one slot while THREE are now allowed.
    held.shift()('done');
    await sleep(30);
    ck('the whole backlog starts, not one job per finished document',
       q.snapshot().running === 3, JSON.stringify(q.snapshot()));

    for (let i = 0; i < 200 && (held.length || q.snapshot().waiting || q.snapshot().running); i++) {
        while (held.length) held.shift()('done');
        await sleep(5);
    }
    await Promise.all(runs);
    ck('  and it drains', q.snapshot().waiting === 0 && q.snapshot().running === 0,
       JSON.stringify(q.snapshot()));
    pb._resetForTests();
    pb.init({ getBrowser: () => null, launch: (o) => require('puppeteer').launch(o) });
}

// ── F. IT DOES NOT MAKE THE APP SINGLE-USER ─────────────────────────────────
// The point of the whole change. Only the render is serialised; everything
// else stays parallel, so this file must not have crept into the routes.
section('F. only the rendering is serialised');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('no route is wrapped in the queue', !/pdfQueue/.test(api),
       'the queue reached the HTTP layer, and now logins and downloads serialise too');

    for (const [file, fn] of [['helpers/bolPdf.js', 'generateBolPdf'],
                              ['helpers/proformaPdf.js', 'generateProformaDc2Pdf'],
                              ['helpers/invoicePdf.js', 'renderModes']]) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        // ── READ THE WRAPPER'S BODY, NOT THE WHOLE FILE ──────────────────
        // This was "does pdfQueue appear anywhere in this file", and a
        // mutation satisfied it with DEAD CODE: an early return above the
        // queue call left the call present but unreachable, and the check
        // stayed green. Now the wrapper's body is sliced out and the FIRST
        // thing it returns must be the queue call — an early return fails.
        const start = src.indexOf(`async function ${fn}(`);
        const body = start >= 0 ? src.slice(start, src.indexOf('\n}', start)) : '';
        const afterFirstReturn = body.slice(body.indexOf('return')).trim();
        ck(`${fn} goes through the queue`,
           start >= 0 && body.includes('return')
           && afterFirstReturn.startsWith("return require('./pdfQueue').run("),
           `${file} still launches Chromium without taking the slot`);
        ck(`  and ${fn} keeps an unqueued inner function`,
           new RegExp(`${fn}Unqueued`).test(src),
           'the body was inlined into the wrapper, so the slot covers the wrong span');
    }

    // The packing list renders through invoicePdf's renderModes, so it is
    // covered without a fourth launch site. Worth asserting, because a future
    // packing list that launched its own browser would slip past this queue.
    const pl = fs.readFileSync(path.join(ROOT, 'helpers/packingList.js'), 'utf8');
    ck('the packing list has no Chromium of its own', !/puppeteer\.launch/.test(pl),
       'a fourth launch site would bypass the queue entirely');
}

// ── G. Nothing is held open ─────────────────────────────────────────────────
// An unref'd timer, or the process would not exit between documents.
section('G. it does not hold the process open');
q.reset();
{
    await q.run(async () => 'x', 'quick');
    ck('the queue is idle after a job', q.snapshot().busy === false && q.snapshot().waiting === 0);
    ck('  and it counted the run', q.snapshot().ran === 1, JSON.stringify(q.snapshot()));
}

finished = true;
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '));
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('CRASHED:', e && e.stack); process.exit(1); });
