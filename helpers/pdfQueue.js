// ── helpers/pdfQueue.js — one Chromium at a time ────────────────────────────
//
// Apsara, 2026-09-18: "parallel simulatenous connection should be allowed in
// website and document", after a second person's download never completed
// while she had the site open — and worked the moment she closed it.
//
// ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────
// Nothing in this app refuses a second user. There is no rate limiter, no cap
// on sessions, no lock held while a page is open, and the download route is a
// plain sendFile. All of that was checked before this file was written.
//
// What there IS: three helpers (bolPdf, invoicePdf, proformaPdf) that each
// launch a WHOLE CHROMIUM per document and close it afterwards. That is
// 300-400MB a time on top of node. Two people pressing Generate together ask
// a small VM for the better part of a gigabyte at once, and the box does the
// only thing it can — the second browser fails to start, or the kernel kills
// node and pm2 restarts it, taking every request in flight with it. Including
// somebody's download.
//
// ── SO: PARALLEL USERS, SERIAL RENDERING ────────────────────────────────────
// This does not make the app single-user. Logins, browsing, saving, listing,
// downloading an ALREADY-GENERATED document — all still fully concurrent and
// untouched. Only the few seconds of actual Chromium work are serialised, so
// two simultaneous Generates now both succeed and one waits a moment, instead
// of both failing.
//
// ── A QUEUE'S FAILURE MODE IS A HANG, SO THIS ONE IS BOUNDED ────────────────
// The obvious version of this file makes things worse: one wedged job and
// every document behind it waits for ever, which is a harder problem to
// diagnose than the one being fixed. Three bounds, all deliberate:
//
//   THE SLOT IS RELEASED IN A finally. A job that throws frees the queue.
//   That is the single most important line here.
//
//   A JOB CANNOT HOLD THE SLOT FOR EVER. Past JOB_TIMEOUT_MS the queue stops
//   waiting on it and starts the next one. The stuck job is not killed — it
//   owns a browser this file did not open and cannot safely tear down — but
//   it stops being everyone else's problem. Deliberately generous: a slow
//   BOL is ~8s and the point is to catch a WEDGE, not a slow document.
//
//   THE LINE HAS A LENGTH. Past MAX_WAITING the newest caller is refused
//   immediately with a sentence she can act on. A refusal in a second beats a
//   spinner that ends in a proxy timeout two minutes later, and it is the
//   signal that something is genuinely wrong rather than merely busy.

const MAX_WAITING = 12;
// ~8s for a slow BOL; this is for a WEDGE, not a slow document.
const JOB_TIMEOUT_MS = 90 * 1000;

// ── HOW MANY AT ONCE, AND WHY IT IS NO LONGER ONE ───────────────────────
// Apsara, 2026-10-10: "what if many people share the website and try to
// download simulatenously", then "i want everything to handle fast-its a
// quick business".
//
// This file serialised to ONE render for a specific, correct reason, written
// at the top: each document launched its OWN Chromium, 300–400 MB a time, and
// two at once asked a small VM for the better part of a gigabyte.
//
// THAT REASON EXPIRED ON 2026-10-03. helpers/pdfBrowser.js stopped launching a
// browser per document and started opening a TAB in the Chromium WhatsApp
// already runs — tens of MB, not hundreds. The serialisation stayed because
// nobody revisited it, so every extra person pressing Download has been
// waiting behind a limit that was protecting against a cost that no longer
// exists. With a ~5s document and twelve in the line, the last person waited
// a minute for no reason.
//
// THREE, NOT UNLIMITED. Tabs are cheap, not free, and pm2's
// max_memory_restart is still the thing that takes WhatsApp down with it. The
// number is deliberately small and deliberately an env var: PDF_CONCURRENCY=1
// restores the old behaviour exactly, with no deploy.
//
// AND IT DROPS BACK TO ONE WHEN WE ARE ON OUR OWN CHROMIUM. If WhatsApp's
// browser has stalled, pdfBrowser falls back to launching ours — and then a
// render really is a heavyweight thing again. Running three of those
// concurrently on a small VM is the 2026-09-18 outage rebuilt by hand. So the
// limit is read fresh for every scheduling decision rather than fixed at boot.
const LIMIT = Math.max(1, Number(process.env.PDF_CONCURRENCY) || 3);

function limitNow() {
    if (LIMIT === 1) return 1;
    try {
        // Lazy require: pdfQueue must not need pdfBrowser to exist, so the
        // queue keeps working in the suites that test it on its own.
        const snap = require('./pdfBrowser').snapshot();
        if (snap && snap.sharedStalled) return 1;
    } catch (e) { /* no browser module here — keep the configured limit */ }
    return LIMIT;
}

let running = 0;
const waiting = [];

// Stats, so a "why was that slow" question has an answer other than a guess.
const stats = { ran: 0, queued: 0, refused: 0, timedOut: 0, maxDepth: 0, maxRunning: 0 };

function depth() { return waiting.length + running; }

function next() {
    if (running >= limitNow() || !waiting.length) return;
    const job = waiting.shift();
    running += 1;
    if (running > stats.maxRunning) stats.maxRunning = running;

    let settled = false;
    const release = (why) => {
        if (settled) return;
        settled = true;
        if (why === 'timeout') stats.timedOut += 1;
        running -= 1;
        // setImmediate, not a direct call: starting the next job inside this
        // one's own resolution would grow the stack by one frame per document
        // on a busy day, and the failure would look like a Chromium problem.
        setImmediate(drain);
    };

    // ── THE TIMEOUT IS PER JOB, NOT A MODULE CONSTANT ────────────────────
    // It reads job.timeoutMs, defaulting to JOB_TIMEOUT_MS. That is a real
    // seam rather than a convenience: a ninety-second wedge cannot be tested
    // in a suite that has to finish, and a test that re-implements the timing
    // rule instead of exercising it proves nothing about this code. An
    // earlier version had the test overwrite the exported constant — which
    // silently did nothing, because next() closes over the internal binding.
    const ms = Number(job.timeoutMs) > 0 ? Number(job.timeoutMs) : JOB_TIMEOUT_MS;
    const timer = setTimeout(() => {
        console.warn(`[PDF-QUEUE] "${job.label}" has held the slot for ${ms / 1000}s — `
            + 'moving on so the queue does not stall. That job is still running.');
        release('timeout');
    }, ms);
    if (timer.unref) timer.unref();   // never hold the process open

    Promise.resolve()
        .then(job.fn)
        .then(
            (v) => { clearTimeout(timer); release('done'); job.resolve(v); },
            (e) => { clearTimeout(timer); release('failed'); job.reject(e); },
        );
}

// Run fn with the slot held. Resolves or rejects with whatever fn does — the
// queue is invisible to the caller apart from the wait, which is the point.
// opts.timeoutMs overrides JOB_TIMEOUT_MS for this job. Nothing in the app
// passes it; it exists so the wedge case is testable in under a second.
function run(fn, label = 'document', opts = {}) {
    return new Promise((resolve, reject) => {
        if (waiting.length >= MAX_WAITING) {
            stats.refused += 1;
            const e = new Error('The server is busy generating other documents right now. '
                + 'Give it a few seconds and press Generate again.');
            e.code = 'PDF_QUEUE_FULL';
            return reject(e);
        }
        stats.ran += 1;
        if (running >= limitNow()) {
            stats.queued += 1;
            // Logged, because "it took nine seconds" and "it waited six of
            // them behind someone else" are different answers to the same
            // complaint, and only one of them means anything is wrong.
            console.log(`[PDF-QUEUE] "${label}" is waiting — ${depth()} in the queue.`);
        }
        waiting.push({ fn, resolve, reject,
                       label: String(label || 'document').slice(0, 60),
                       timeoutMs: opts && opts.timeoutMs });
        if (depth() > stats.maxDepth) stats.maxDepth = depth();
        drain();
    });
}

// For tests and for an admin route that wants to say how busy this has been.
// Start as many as the limit allows. next() takes one; a release can free a
// slot while the limit has ALSO risen (the shared browser came back), and a
// single next() would leave the queue running below capacity until the next
// document happened to arrive.
function drain() {
    let guard = MAX_WAITING + LIMIT + 1;   // cannot spin: every pass shifts or stops
    while (guard-- > 0 && waiting.length && running < limitNow()) next();
}

function snapshot() {
    return { ...stats, running, busy: running > 0, limit: limitNow(),
             configuredLimit: LIMIT, waiting: waiting.length };
}
function reset() {
    running = 0; waiting.length = 0;
    Object.assign(stats, { ran: 0, queued: 0, refused: 0, timedOut: 0, maxDepth: 0 });
}

module.exports = { run, snapshot, reset, MAX_WAITING, JOB_TIMEOUT_MS };
