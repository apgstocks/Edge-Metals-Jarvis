// ── helpers/renderClient.js — ask the render process, or do it here ───────
//
// Apsara, 2026-10-10, after the invoice timed out and we counted what one
// process is carrying: "think like a production system".
//
// ── WHAT THIS IS FOR, AND IT IS NOT SPEED ───────────────────────────────
// One pm2 process holds 275 HTTP routes, 34 cron jobs, the WhatsApp client
// and its Chromium, and every PDF render — under a 1500M ceiling that
// restarts the lot when it is crossed. So a single large document can take
// down the API for every customer, disconnect WhatsApp, interrupt 34 jobs
// mid-flight and silently drop every queued document, because
// helpers/pdfQueue.js's line is an in-memory array.
//
// Moving rendering into its own process does not make a document faster. It
// makes a bad document stop being everyone's problem. That is the whole
// point of this file.
//
// ── THE FALLBACK IS THE FEATURE ─────────────────────────────────────────
// Every failure mode here ends in a rendered document:
//
//   no socket file          the render process is not installed yet, or is
//                           between restarts
//   ECONNREFUSED            the socket is stale — the process died without
//                           unlinking it
//   timeout                 the renderer is wedged, which is exactly what
//                           WhatsApp's Chromium was doing this morning
//   non-200, bad JSON       a version skew between the two processes after
//                           a partial deploy
//
// all fall through to rendering in THIS process, exactly as the code did
// before today. So:
//
//   · deploying this without adding the pm2 app changes nothing;
//   · the render process dying mid-document costs one retry, not a failure;
//   · rolling back is deleting one pm2 app.
//
// A fallback that is only exercised when something is broken is a fallback
// nobody has tested, so tests/render-client.js drives all four.
//
// ── IT CARRIES NO SECRET AND NO SESSION ─────────────────────────────────
// What crosses is HTML that this process already built, and PDF options. No
// token, no password, no database handle. The socket lives in DATA_DIR with
// the file permissions of the user running pm2, which is the access control
// — there is no port for anything else on the box to find.

const fs = require('fs');
const http = require('http');
const path = require('path');
const cfg = require('../config');

// A unix socket, not a TCP port. Nothing to pick, nothing to collide with,
// nothing reachable from off the box even by accident.
const SOCKET = process.env.RENDER_SOCKET || path.join(cfg.DATA_DIR, 'render.sock');

// ── THE TIMEOUT IS THE POINT OF HAVING ONE ──────────────────────────────
// Generous enough for a real document (a slow BOL measured ~8s, and the
// renderer queues too, so a busy moment adds its own wait) and short enough
// that a wedged renderer costs one wait rather than the 30 seconds puppeteer
// used to spend before anybody knew.
const TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 45 * 1000;

const stats = { asked: 0, served: 0, fellBack: 0, byReason: {}, lastError: null, lastAt: null };
const note = (why, message) => {
    stats.fellBack += 1;
    stats.byReason[why] = (stats.byReason[why] || 0) + 1;
    // ── THE LAST REASON, KEPT ────────────────────────────────────────────
    // Two guards below are redundant for BEHAVIOUR — remove either and the
    // document still falls back — so the only thing that distinguishes them
    // is what the message says, and a message nothing can read is a message
    // nobody checks. "said 500" and "refused: ..." send whoever is
    // diagnosing to different places, which is the whole value of having
    // both checks rather than one.
    if (message) { stats.lastError = String(message).slice(0, 300); stats.lastAt = new Date().toISOString(); }
};

function available() {
    try { return fs.existsSync(SOCKET); } catch (e) { return false; }
}

// ── THE JOB, AS SOMETHING THAT FITS THROUGH A SOCKET ────────────────────
// pdfBrowser.withPage takes a FUNCTION, which cannot be sent anywhere. So
// the boundary is drawn one level up, at the thing every document actually
// is: some HTML, the modes to print it in, and the PDF options. That shape
// is already what invoicePdf.renderModes receives, which is why this could
// be slid underneath it without moving a template.
function post(job) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(job));
        const req = http.request({
            socketPath: SOCKET, path: '/render', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) {
                    return reject(new Error(`render process said ${res.statusCode}: ${raw.slice(0, 200)}`));
                }
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { return reject(new Error('render process sent bad JSON')); }
                if (!parsed || !parsed.ok || !parsed.pdfs) {
                    return reject(new Error(`render process refused: ${(parsed && parsed.error) || 'no reason given'}`));
                }
                // Base64 over the wire, Buffer on both sides. res.send() needs
                // a real Buffer or it JSON-stringifies byte by byte — the same
                // gotcha documented in proformaPdf.js.
                const out = {};
                for (const [mode, b64] of Object.entries(parsed.pdfs)) out[mode] = Buffer.from(b64, 'base64');
                resolve(out);
            });
        });
        req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error(`render process did not answer in ${TIMEOUT_MS}ms`)); });
        req.on('error', reject);
        req.end(body);
    });
}

// ── render(job, inProcess) ──────────────────────────────────────────────
// `inProcess` is the function that does it here — the code that ran before
// this file existed. It is passed IN rather than required, so this module
// knows nothing about invoices, and so a caller migrating onto the render
// process cannot accidentally lose its own fallback.
async function render(job, inProcess) {
    if (typeof inProcess !== 'function') {
        throw new Error('renderClient.render needs the in-process renderer to fall back to');
    }
    // An explicit off switch, for the deploy where the render process has to
    // be stopped and documents must keep working.
    if (process.env.RENDER_IN_PROCESS === '1') { note('disabled'); return inProcess(); }
    if (!available()) { note('no-socket'); return inProcess(); }

    stats.asked += 1;
    try {
        const out = await post(job);
        stats.served += 1;
        return out;
    } catch (e) {
        // LOUD, because a silent fallback is how this ends up never being
        // used and nobody noticing. One line names the reason; the document
        // still arrives.
        // ── THE LABEL IS THE DIAGNOSIS, SO IT HAS TO BE RIGHT ────────────
        // A socket file left behind by a SIGKILLed process does not answer
        // ECONNREFUSED on every platform — connecting succeeds and the write
        // fails with EPIPE or ECONNRESET. Classifying those as 'refused'
        // sent whoever read the log looking for a renderer that was running
        // and unhappy, when there was no renderer at all.
        const why = /did not answer/.test(e.message) ? 'timeout'
            : /ECONNREFUSED|ENOENT|EPIPE|ECONNRESET|socket hang up/.test(e.message) ? 'stale-socket'
                : 'refused';
        note(why, e.message);
        console.warn(`[RENDER] falling back to in-process (${why}): ${e.message}`);
        return inProcess();
    }
}

const snapshot = () => ({ ...stats, socket: SOCKET, available: available() });

module.exports = { render, available, snapshot, SOCKET, TIMEOUT_MS };
