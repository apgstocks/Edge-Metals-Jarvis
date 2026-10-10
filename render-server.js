// ── render-server.js — documents, in a process of their own ──────────────
//
// Apsara, 2026-10-10: "think like a production system", after an invoice
// download failed with "Navigation timeout of 30000 ms exceeded".
//
// ── THE SITUATION THIS EXISTS TO CHANGE ─────────────────────────────────
// Until today one pm2 process held 275 HTTP routes, 34 cron jobs, the
// WhatsApp client and its Chromium, and every PDF render, under a 1500M
// ceiling that restarts all of it when crossed.
//
// So one large document could:
//   · push memory past the cap and restart the API for every customer,
//   · take the WhatsApp session down with it and force a re-sync,
//   · interrupt all 34 scheduled jobs mid-flight,
//   · and silently drop every queued document, because the queue in
//     helpers/pdfQueue.js is an in-memory array.
//
// After this, a document that goes wrong takes down DOCUMENTS. pm2 restarts
// this process; the other one never notices. That is the entire win. It is
// not a speed change and should not be sold as one.
//
// ── WHY A UNIX SOCKET ───────────────────────────────────────────────────
// No port to choose and no port to collide with, nothing off the box can
// reach it even by misconfiguration, and the file permissions of the user
// running pm2 are the access control. The alternative — a localhost port —
// is one firewall mistake away from being a public PDF renderer, and this
// endpoint takes arbitrary HTML.
//
// ── WHAT IT WILL AND WILL NOT DO ────────────────────────────────────────
// It renders HTML that the OTHER process already built. It does not read
// her stores, hold a session, or know what an invoice is. If this process
// is compromised or crashes, what is lost is the ability to make PDFs.
//
// ── RUN IT ──────────────────────────────────────────────────────────────
//     pm2 start ecosystem.config.js          # starts jarvis AND jarvis-render
//     pm2 logs jarvis-render
//
// NOT RUNNING IT IS A SUPPORTED STATE. helpers/renderClient.js falls back to
// rendering in the main process whenever the socket is absent, so deploying
// this without starting it changes nothing at all.

const fs = require('fs');
const http = require('http');
const path = require('path');

// install() takes no arguments — the boot line it writes carries the pid,
// which is what tells the two processes apart in data/logs/jarvis.log.
require('./helpers/crashlog').install();

const cfg = require('./config');
const SOCKET = process.env.RENDER_SOCKET || path.join(cfg.DATA_DIR, 'render.sock');

// ── A STALE SOCKET IS THE NORMAL CASE, NOT AN ERROR ─────────────────────
// A process killed with SIGKILL never gets to unlink its socket, so the file
// outsurvives it and bind fails with EADDRINUSE on the next boot. Checking
// whether anything is actually listening — rather than assuming — is what
// stops a crash becoming a permanent outage of this process.
async function clearStaleSocket() {
    if (!fs.existsSync(SOCKET)) return;
    const alive = await new Promise((resolve) => {
        const probe = http.request({ socketPath: SOCKET, path: '/healthz', method: 'GET', timeout: 1500 },
            () => resolve(true));
        probe.on('error', () => resolve(false));
        probe.on('timeout', () => { probe.destroy(); resolve(false); });
        probe.end();
    });
    if (alive) {
        console.error(`[RENDER] another render process is already listening on ${SOCKET} — exiting`);
        process.exit(1);
    }
    console.warn(`[RENDER] removing a stale socket left by a previous process: ${SOCKET}`);
    try { fs.unlinkSync(SOCKET); } catch (e) { /* it went away on its own */ }
}

function readBody(req, limitBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            // A render job is HTML. 25MB is already absurd for one document,
            // and an unbounded read is how a renderer becomes the thing that
            // OOMs — which is the failure this whole process exists to stop
            // mattering.
            if (size > limitBytes) { reject(new Error('render job too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// ── THE ONE THING IT DOES ───────────────────────────────────────────────
// Identical to what helpers/invoicePdf.js does in-process — same fitter,
// same options, same modes loop. Copied in shape deliberately rather than
// imported: invoicePdf.js builds HTML from her stores and requires nine
// helpers to do it, none of which belong in a process whose only job is to
// drive Chromium.
async function renderJob(job) {
    const { html, modes, pdfOptions, fitOpts, label } = job;
    if (typeof html !== 'string' || !html) throw new Error('a render job needs html');
    if (!Array.isArray(modes) || !modes.length) throw new Error('a render job needs modes');

    const timer = require('./helpers/pdfTiming').start(label || 'render');
    try {
        return await require('./helpers/pdfBrowser').withPage(async (page) => {
            timer.mark('launch-chromium');
            await page.setContent(html, { waitUntil: 'networkidle0' });
            timer.mark('load-page');
            const out = {};
            for (const mode of modes) {
                // The mode is a BODY CLASS and the template's CSS hides the
                // other document — one DOM, re-labelled, so the two PDFs
                // cannot disagree about the data.
                await page.evaluate((m) => {
                    document.body.classList.remove('only-invoice', 'only-packing');
                    if (m) document.body.classList.add(m);
                }, mode === 'both' ? null : `only-${mode}`);
                const { pdfFittedToOnePage } = require('./helpers/pdfFit');
                const pdf = await pdfFittedToOnePage(page, pdfOptions || {},
                    { ...(fitOpts || {}), timer, label: `${label || 'render'} ${mode}` });
                out[mode] = Buffer.from(pdf).toString('base64');
            }
            return out;
        });
    } finally {
        timer.mark('close-chromium');
        timer.done({ html_kb: Math.round(String(html || '').length / 1024), modes: modes.length });
    }
}

const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    if (req.method === 'GET' && req.url === '/healthz') {
        return send(200, { ok: true, pid: process.pid,
            queue: require('./helpers/pdfQueue').snapshot(),
            browser: require('./helpers/pdfBrowser').snapshot() });
    }
    if (req.method !== 'POST' || req.url !== '/render') return send(404, { ok: false, error: 'not found' });

    try {
        const raw = await readBody(req, 25 * 1024 * 1024);
        const job = JSON.parse(raw);
        // Queued HERE, so the limit and the backpressure live with the thing
        // that actually costs memory. The calling process keeps no queue of
        // its own and stays free to answer requests.
        const pdfs = await require('./helpers/pdfQueue').run(
            () => renderJob(job), job.label || 'render');
        send(200, { ok: true, pdfs });
    } catch (e) {
        // A refusal, not a crash. renderClient falls back to rendering in the
        // calling process, so a failure here costs one retry and never a
        // missing document.
        console.error('[RENDER] job failed:', e && e.message);
        send(500, { ok: false, error: String((e && e.message) || e) });
    }
});

// ── SHUTDOWN ────────────────────────────────────────────────────────────
// Unlink the socket on the way out so the next boot does not have to decide
// whether it is stale. Close the browser too — a Chromium outliving its
// parent is how a box ends up with orphans nobody can account for.
let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`[RENDER] ${signal} — closing`);
    try { server.close(); } catch (e) {}
    try { await require('./helpers/pdfBrowser').shutdown(); } catch (e) {}
    try { if (fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET); } catch (e) {}
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
    await clearStaleSocket();
    server.listen(SOCKET, () => {
        // 0600: only the user running pm2 can talk to it. The default would
        // be whatever the umask says, and "whatever the umask says" is not an
        // access-control decision.
        try { fs.chmodSync(SOCKET, 0o600); } catch (e) {}
        console.log(`[RENDER] listening on ${SOCKET} (pid ${process.pid})`);
    });
})();

module.exports = { renderJob, SOCKET };
