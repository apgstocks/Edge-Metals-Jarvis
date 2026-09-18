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

let busy = false;
const waiting = [];

// Stats, so a "why was that slow" question has an answer other than a guess.
const stats = { ran: 0, queued: 0, refused: 0, timedOut: 0, maxDepth: 0 };

function depth() { return waiting.length + (busy ? 1 : 0); }

function next() {
    if (busy || !waiting.length) return;
    const job = waiting.shift();
    busy = true;

    let settled = false;
    const release = (why) => {
        if (settled) return;
        settled = true;
        if (why === 'timeout') stats.timedOut += 1;
        busy = false;
        // setImmediate, not a direct call: starting the next job inside this
        // one's own resolution would grow the stack by one frame per document
        // on a busy day, and the failure would look like a Chromium problem.
        setImmediate(next);
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
        if (busy) {
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
        next();
    });
}

// For tests and for an admin route that wants to say how busy this has been.
function snapshot() { return { ...stats, busy, waiting: waiting.length }; }
function reset() {
    busy = false; waiting.length = 0;
    Object.assign(stats, { ran: 0, queued: 0, refused: 0, timedOut: 0, maxDepth: 0 });
}

module.exports = { run, snapshot, reset, MAX_WAITING, JOB_TIMEOUT_MS };
