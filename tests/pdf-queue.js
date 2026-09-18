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

// ── A. One at a time ────────────────────────────────────────────────────────
section('A. only one job runs at once');
q.reset();
{
    let running = 0, peak = 0;
    const job = async () => {
        running += 1; peak = Math.max(peak, running);
        await sleep(30);
        running -= 1;
        return 'done';
    };
    const results = await Promise.all([q.run(job, 'a'), q.run(job, 'b'), q.run(job, 'c')]);
    ck('THREE AT ONCE NEVER OVERLAP', peak === 1, `peak concurrency was ${peak}`);
    ck('  and all three still succeed', results.join(',') === 'done,done,done',
       'the queue dropped work instead of delaying it — she pressed Generate and got nothing');
    ck('  two of them had to wait', q.snapshot().queued === 2, JSON.stringify(q.snapshot()));
    ck('  and the queue is empty afterwards',
       q.snapshot().busy === false && q.snapshot().waiting === 0, JSON.stringify(q.snapshot()));
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
    let wedgedFinished = false;
    const wedged = q.run(() => new Promise((r) => setTimeout(() => { wedgedFinished = true; r('late'); }, 400)),
                         'wedged', { timeoutMs: 60 });
    await sleep(20);
    const behind = q.run(async () => 'got through', 'behind');

    const got = await Promise.race([behind, sleep(300).then(() => 'STILL WAITING')]);
    ck('a document behind a wedged one still generates', got === 'got through',
       'it waited behind a job that never finished — the hang this queue could have caused');
    ck('  and the wedge is counted, not hidden', q.snapshot().timedOut >= 1, JSON.stringify(q.snapshot()));
    ck('  while the stuck job is left to finish on its own', wedgedFinished === false);
    await wedged;   // let it land so it does not leak into the next section
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
    for (let i = 0; i < q.MAX_WAITING + 1; i++) runs.push(q.run(slow, `j${i}`).catch((e) => e));
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
