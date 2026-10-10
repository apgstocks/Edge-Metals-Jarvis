// ── tests/render-client.js ────────────────────────────────────────────────
// Apsara, 2026-10-10: "think like a production system."
//
// Rendering moved into its own pm2 process so that a document which goes
// wrong takes down DOCUMENTS, instead of the 275 routes, 34 cron jobs and
// WhatsApp session that shared one 1500M process with it.
//
// ── WHAT THIS FILE IS ACTUALLY FOR ──────────────────────────────────────
// The fallback. Every failure mode of the render process has to end in a
// rendered document, because the alternative is that splitting the process
// turned one slow invoice into a missing one.
//
// A fallback is only ever exercised when something is broken, which is
// exactly the code that rots unnoticed — so all four paths are driven here
// with a REAL unix socket rather than a stubbed client:
//
//     served         the renderer answers
//     no-socket      not installed, or between restarts
//     stale-socket   the file outlived the process that made it
//     timeout        the renderer took the job and wedged
//     refused        a 500, or rubbish, from a version-skewed deploy
//
// No Chromium is involved: the fake renderer returns bytes. What is being
// tested is the DECISION, and that has to hold on the machines that cannot
// start Chromium — which is every machine this suite runs on today, since
// tests/pdf-browser.js's real-render half skips.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-render-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.RENDER_SOCKET = path.join(TMP, 'render.sock');
process.env.RENDER_TIMEOUT_MS = '400';          // a wedge cannot be waited out in a suite

const ROOT = path.join(__dirname, '..');
const RC = require(path.join(ROOT, 'helpers/renderClient'));

const JOB = { html: '<p>invoice</p>', modes: ['both'],
    pdfOptions: { width: '816px' }, fitOpts: { pageHeightMm: 297 }, label: 'invoice both' };
const inProcess = async () => ({ both: Buffer.from('IN-PROCESS-PDF') });

// A renderer that is whatever the test needs it to be.
// ── AND IT WAITS UNTIL IT IS GENUINELY CONNECTABLE ───────────────────────
// Node unlinks a unix socket path when the server closes, and on this
// platform that can land AFTER close()'s callback has let the next test move
// on — so a fake started immediately afterwards could have its socket file
// removed out from under it by the previous one. The symptom was EPIPE,
// which the client correctly reports as a stale socket, so the "bad JSON"
// check below passed while exercising the stale-socket path instead of its
// own. Probing before resolving makes the handover deterministic rather than
// a race that usually goes the right way.
function fakeRenderer(handler) {
    const server = http.createServer(handler);
    const sock = process.env.RENDER_SOCKET;
    const connectable = () => new Promise((r) => {
        const c = net.connect(sock);
        c.on('connect', () => { c.destroy(); r(true); });
        c.on('error', () => r(false));
    });
    return new Promise((resolve) => {
        try { fs.unlinkSync(sock); } catch (e) {}
        server.listen(sock, async () => {
            for (let i = 0; i < 50 && !(await connectable()); i += 1) {
                await new Promise((r) => setTimeout(r, 10));
            }
            resolve({
                server,
                // Unlink INSIDE the close callback, so the path is only
                // removed once this server has actually let go of it.
                // closeAllConnections first: server.close() waits for every
                // in-flight request to finish, and the wedge test deliberately
                // leaves one hanging for ever. Without this, a client with no
                // timeout of its own does not just fail the check above — it
                // hangs the whole file at this line, which is how the mutation
                // run that found this burned its budget.
                close: () => new Promise((r) => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close(() => { try { fs.unlinkSync(sock); } catch (e) {} r(); });
                }),
            });
        });
    });
}
const okHandler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const body = JSON.stringify({ ok: true,
            pdfs: Object.fromEntries(job.modes.map((m) => [m, Buffer.from(`RENDERED-${m}`).toString('base64')])) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
    });
};

(async () => {

// ── A — THE RENDERER ANSWERS ─────────────────────────────────────────────
{
    section('A — the render process does the work');
    const r = await fakeRenderer(okHandler);
    const out = await RC.render(JOB, inProcess);
    ck('the socket is seen', RC.available() === true);
    ck('a document comes back', !!out && !!out.both, JSON.stringify(Object.keys(out || {})));
    ck('  from the RENDER PROCESS, not this one',
       out.both.toString() === 'RENDERED-both', out.both.toString());
    ck('  as a real Buffer, not base64 text',
       Buffer.isBuffer(out.both), typeof out.both);
    ck('  and it is counted as served', RC.snapshot().served >= 1, JSON.stringify(RC.snapshot()));
    await r.close();
}

// ── B — THE FOUR WAYS IT CAN FAIL, AND THE ONE THING THAT MUST HAPPEN ────
// Every one of these ends in a document. That is the whole contract: moving
// rendering out must not turn a slow invoice into a missing invoice.
{
    section('B — every failure still produces a document');

    // 1. NOT INSTALLED. The socket does not exist — which is also what a
    // deploy of this code without the pm2 app looks like.
    try { fs.unlinkSync(process.env.RENDER_SOCKET); } catch (e) {}
    ck('no socket means the renderer is not available', RC.available() === false);
    const a = await RC.render(JOB, inProcess);
    ck('  and the document is rendered HERE instead',
       a.both.toString() === 'IN-PROCESS-PDF', a.both.toString());

    // 2. STALE SOCKET. The file outlived the process — a SIGKILL never gets
    // to unlink it. available() says yes and connecting says no.
    const sock = process.env.RENDER_SOCKET;
    fs.writeFileSync(sock, '');
    ck('a stale socket LOOKS available', RC.available() === true,
       'which is exactly why connecting has to be the real test');
    const before = { ...RC.snapshot().byReason };
    const b = await RC.render(JOB, inProcess);
    ck('  and it still falls back rather than failing',
       b.both.toString() === 'IN-PROCESS-PDF', b.both.toString());
    // ── AND IT IS NAMED CORRECTLY ────────────────────────────────────────
    // A socket left by a SIGKILLed process does not always answer
    // ECONNREFUSED — connecting succeeds and the WRITE fails, with EPIPE.
    // Calling that 'refused' sends whoever reads the log looking for a
    // renderer that is running and unhappy, when there is no renderer at all.
    const after = RC.snapshot().byReason;
    ck('  and is logged as a STALE SOCKET, not as a refusal',
       (after['stale-socket'] || 0) > (before['stale-socket'] || 0),
       JSON.stringify(after));
    try { fs.unlinkSync(sock); } catch (e) {}

    // 3. WEDGED. It takes the job and never answers — this morning's
    // failure, one layer along.
    const hang = await fakeRenderer(() => { /* never responds */ });
    const t0 = Date.now();
    // ── THE TEST BOUNDS ITS OWN WAIT ─────────────────────────────────────
    // Awaiting this bare is correct only while the client HAS a timeout. The
    // mutation that deletes req.setTimeout made this file hang until the
    // suite runner killed it at 180s — a mutation reported as killed by a
    // timeout says nothing about which property was lost, and it cost a
    // whole mutation run. Racing it turns "no timeout in the client" into a
    // named failure in under a second.
    const c = await Promise.race([
        RC.render(JOB, inProcess),
        new Promise((r) => setTimeout(() => r({ both: Buffer.from('CLIENT-NEVER-GAVE-UP') }), 2500)),
    ]);
    const waited = Date.now() - t0;
    ck('a wedged renderer still produces a document',
       c.both.toString() === 'IN-PROCESS-PDF',
       c.both.toString() === 'CLIENT-NEVER-GAVE-UP'
           ? 'the client waited with no timeout of its own — a wedged renderer would hang the request'
           : c.both.toString());
    ck('  after the timeout, not after 30 seconds',
       waited >= 350 && waited < 3000, `${waited}ms`);
    await hang.close();

    // 4. REFUSED. A 500, or an answer that is not the shape agreed — which
    // is what a half-finished deploy looks like, one process new and one old.
    const broken = await fakeRenderer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'chromium died' }));
    });
    const d = await RC.render(JOB, inProcess);
    ck('a refusal falls back', d.both.toString() === 'IN-PROCESS-PDF', d.both.toString());
    // ── AND THE MESSAGE NAMES THE STATUS ─────────────────────────────────
    // Removing the status check does not change the BEHAVIOUR — the ok/pdfs
    // check below catches it and falls back anyway — so the only thing it
    // buys is the diagnosis. "said 500" sends whoever is looking at the
    // renderer's logs; a bare "refused" sends them to the job. Both
    // mutations survived until this was asserted.
    ck('  and the reason recorded names the HTTP status',
       /said 500/.test(RC.snapshot().lastError || ''), RC.snapshot().lastError);
    ck('  carrying the renderer\'s own words', /chromium died/.test(RC.snapshot().lastError || ''),
       RC.snapshot().lastError);
    await broken.close();

    // ── CONSUME THE BODY FIRST, OR THIS TESTS THE WRONG THING ────────────
    // Replying without reading the request closes the socket mid-write and
    // the client sees EPIPE — which it correctly calls a stale socket. So
    // this check was passing while exercising the case above, not bad JSON.
    const garbage = await fakeRenderer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' });
                              res.end('<html>not json</html>'); });
    });
    const beforeJunk = RC.snapshot().byReason.refused || 0;
    const e = await RC.render(JOB, inProcess);
    ck('so does an answer that is not the shape agreed',
       e.both.toString() === 'IN-PROCESS-PDF', e.both.toString());
    ck('  counted as a REFUSAL — the renderer answered, it just made no sense',
       (RC.snapshot().byReason.refused || 0) > beforeJunk,
       JSON.stringify(RC.snapshot().byReason));
    ck('  and the reason says the answer was not JSON, not something vaguer',
       /bad JSON/.test(RC.snapshot().lastError || ''), RC.snapshot().lastError);
    await garbage.close();

    // ── A 200 THAT PARSES AND STILL IS NOT A DOCUMENT ────────────────────
    // What a half-finished deploy looks like: the renderer is new enough to
    // answer, old enough to answer the wrong shape. Its own case, because
    // the status check cannot catch it and the JSON parse will not either.
    const shapeless = await fakeRenderer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' });
                              res.end(JSON.stringify({ ok: true, rendered: 'yes' })); });
    });
    const f = await RC.render(JOB, inProcess);
    ck('a 200 with no pdfs in it is not mistaken for a document',
       f.both.toString() === 'IN-PROCESS-PDF', f.both.toString());
    ck('  and says the renderer refused rather than crashing on undefined',
       /refused/.test(RC.snapshot().lastError || ''), RC.snapshot().lastError);
    await shapeless.close();

    // ── AND IT SAYS WHY, EVERY TIME ──────────────────────────────────────
    // A silent fallback is how this ends up never being used and nobody
    // noticing — the renderer would be dead for a month and the only symptom
    // would be the old memory profile coming back.
    const snap = RC.snapshot();
    ck('every fallback is counted by REASON', snap.fellBack >= 5, JSON.stringify(snap.byReason));
    ck('  naming no-socket, a stale socket, a timeout and a refusal separately',
       !!snap.byReason['no-socket'] && !!snap.byReason['stale-socket']
       && !!snap.byReason.timeout && !!snap.byReason.refused,
       JSON.stringify(snap.byReason));
}

// ── C — THE OFF SWITCH ───────────────────────────────────────────────────
// For the deploy where the render process has to be stopped and documents
// must keep working: one env var, no code change, no pm2 surgery.
{
    section('C — RENDER_IN_PROCESS=1');
    const r = await fakeRenderer(okHandler);
    process.env.RENDER_IN_PROCESS = '1';
    const out = await RC.render(JOB, inProcess);
    ck('a working renderer is ignored when it is switched off',
       out.both.toString() === 'IN-PROCESS-PDF', out.both.toString());
    delete process.env.RENDER_IN_PROCESS;
    const back = await RC.render(JOB, inProcess);
    ck('  and used again when it is not', back.both.toString() === 'RENDERED-both', back.both.toString());
    await r.close();
}

// ── D — IT REFUSES TO RENDER WITHOUT SOMEWHERE TO FALL BACK TO ───────────
// A caller that forgets the fallback has silently made the render process a
// single point of failure for its document — the opposite of the point.
{
    section('D — the fallback is not optional');
    let threw = null;
    try { await RC.render(JOB, null); } catch (e) { threw = e; }
    ck('calling without an in-process renderer throws', !!threw, String(threw));
    ck('  and says what is missing', /fall back/.test(String(threw && threw.message)),
       String(threw && threw.message));
}

// ── E — THE DOCUMENT MUST NOT DEPEND ON WHICH PATH RAN ───────────────────
// The page setup was about to exist twice: once in the job sent to the
// render process and once in the in-process renderer. Two copies means an
// invoice laid out one way here and another way there, and the only way to
// find out is a broker querying a document. One definition, used by both.
{
    section('E — one page setup, not two');
    const inv = require(path.join(ROOT, 'helpers/invoicePdf'));
    ck('the invoice states its page once', !!inv.PAGE && !!inv.FIT,
       JSON.stringify([inv.PAGE, inv.FIT]));
    ck('  816px wide, as every one of these has always been laid out',
       inv.PAGE.width === '816px', inv.PAGE.width);
    ck('  A4, stated rather than defaulted',
       inv.FIT.pageHeightMm === 297 && inv.FIT.pageWidthMm === 210, JSON.stringify(inv.FIT));
    ck('  printing backgrounds, or the ruled table loses its lines',
       inv.PAGE.printBackground === true);

    const src = fs.readFileSync(path.join(ROOT, 'helpers/invoicePdf.js'), 'utf8');
    // The literals must appear ONCE — in the definition. A second occurrence
    // is the drift coming back.
    ck('and 816px is written down exactly once in the file',
       (src.match(/'816px'/g) || []).length === 1,
       String((src.match(/'816px'/g) || []).length));
    ck('  as is the A4 height', (src.match(/pageHeightMm: 297/g) || []).length === 1,
       String((src.match(/pageHeightMm: 297/g) || []).length));
    ck('the job sent over the wire carries those same constants, not copies',
       /pdfOptions: PAGE, fitOpts: FIT/.test(src));
}

// ── F — THE SECOND PROCESS IS REAL, AND ROLLING BACK IS DELETING IT ──────
{
    section('F — pm2 knows about it');
    const eco = require(path.join(ROOT, 'ecosystem.config.js'));
    const names = eco.apps.map((a) => a.name);
    ck('there are two processes now', eco.apps.length === 2, JSON.stringify(names));
    ck('  and the renderer is one of them', names.includes('jarvis-render'), JSON.stringify(names));
    const r = eco.apps.find((a) => a.name === 'jarvis-render');
    ck('  running render-server.js', r.script === 'render-server.js', r.script);
    // Lower than jarvis's cap on purpose: this process holds Chromium and
    // nothing else, and should be restarted long before it can threaten the
    // box the other one lives on.
    const main = eco.apps.find((a) => a.name === 'jarvis');
    ck('  with a TIGHTER memory cap than jarvis', r.max_memory_restart === '700M'
       && main.max_memory_restart === '1500M', `${r.max_memory_restart} vs ${main.max_memory_restart}`);
    ck('  its own logs, so a render crash is not buried in the API log',
       /render-/.test(r.out_file) && /render-/.test(r.error_file), r.out_file);
    ck('  and it restarts on its own', r.autorestart === true);

    const srv = fs.readFileSync(path.join(ROOT, 'render-server.js'), 'utf8');
    ck('the renderer listens on a unix socket, not a port',
       /server\.listen\(SOCKET/.test(srv) && !/listen\(\s*\d{4}/.test(srv),
       'a localhost port is one firewall mistake from being a public PDF renderer');
    ck('  locks it to the user running pm2', /chmodSync\(SOCKET, 0o600\)/.test(srv));
    ck('  clears a socket left behind by a crash', /clearStaleSocket/.test(srv));
    ck('  and refuses to start if another renderer is already listening',
       /already listening/.test(srv));
    ck('the job size is bounded, or the renderer becomes the thing that OOMs',
       /render job too large/.test(srv));
}

// ── G — THE REGRESSION HER FIRST REAL DOCUMENT FOUND ─────────────────────
// 2026-10-10 14:37, minutes after the split went live:
//
//   [PDF-TIME] invoice both total 14211ms — launch-chromium 11844ms,
//              load-page 1641ms, fit(1 passes) 231ms, render 468ms
//
// Eighty-three per cent of it was launching Chromium. The render process
// never gets WhatsApp's browser — pdfBrowser.init() is only called from
// index.js — so it uses its own, and pdfBrowser closed that one minute
// after the last document. A cold launch costs ~11.5s on her VM, so an
// invoice generated twice an hour paid it EVERY time: 2.7s before the
// split, 14.2s after. The split made her occasional document five times
// slower, and only production said so.
//
// Two things stop it, and both are checked here rather than in a comment.
{
    section('G — the renderer keeps its browser warm');

    // `|| 60 * 1000` could not express "never close": Number('0') is falsy,
    // so passing 0 silently meant sixty seconds — the exact value being
    // overridden. That is why this reads the parsed result, not the env var.
    const fresh = (env) => {
        const before = { ...process.env };
        Object.assign(process.env, env);
        for (const k of Object.keys(require.cache)) {
            if (/helpers\/pdfBrowser\.js$/.test(k)) delete require.cache[k];
        }
        const mod = require(path.join(ROOT, 'helpers/pdfBrowser'));
        process.env = before;
        return mod;
    };

    const dflt = fresh({ PDF_BROWSER_IDLE_MS: '' });
    ck('inside the main process it still closes after a quiet minute',
       dflt.IDLE_MS === 60000 && dflt.KEEP_WARM === false,
       `${dflt.IDLE_MS} ${dflt.KEEP_WARM}`);

    const warm = fresh({ PDF_BROWSER_IDLE_MS: '0' });
    ck('0 means KEEP IT, not "fall back to sixty seconds"',
       warm.KEEP_WARM === true, `IDLE_MS ${warm.IDLE_MS} KEEP_WARM ${warm.KEEP_WARM}`);
    ck('  which is the bug: Number(\'0\') is falsy, so `|| 60000` silently ignored it',
       warm.IDLE_MS === 0, String(warm.IDLE_MS));

    const neg = fresh({ PDF_BROWSER_IDLE_MS: '-1' });
    ck('  and so does anything below zero', neg.KEEP_WARM === true, String(neg.IDLE_MS));

    // The pm2 app is what actually sets it, so an entry that drifts puts the
    // eleven seconds straight back.
    const eco = require(path.join(ROOT, 'ecosystem.config.js'));
    const r = eco.apps.find((a) => a.name === 'jarvis-render');
    ck('the render app tells it to keep the browser', r.env.PDF_BROWSER_IDLE_MS === '0',
       JSON.stringify(r.env));
    ck('  and to use its own, since WhatsApp\'s lives in the other process',
       r.env.PDF_BROWSER === 'own', JSON.stringify(r.env));
    const main = eco.apps.find((a) => a.name === 'jarvis');
    ck('  while the MAIN process is left alone to close its idle browser',
       !main.env.PDF_BROWSER_IDLE_MS,
       'a Chromium kept resident there is memory taken from 275 routes and 34 crons');

    // And the first document after a restart must not pay it either — a
    // restart is exactly when she is most likely to be watching.
    const srv = fs.readFileSync(path.join(ROOT, 'render-server.js'), 'utf8');
    // ── THE LINE, NOT JUST THE TEXT ──────────────────────────────────────
    // This was `/pdfBrowser'\)\.warm\(\)/.test(srv)` — a text match, which
    // a mutation satisfied with DEAD CODE: prefixing `if (false) ` leaves
    // the call written down and never executed, and the check stayed green.
    // The same trap tests/pdf-queue.js solved by slicing the wrapper's body.
    // So the STATEMENT is read: warming must not sit behind a condition.
    const warmLine = (srv.split('\n').find((l) => /pdfBrowser'\)\.warm\(\)/.test(l)) || '');
    ck('the renderer warms Chromium at boot', !!warmLine, 'no warm() call at all');
    ck('  unconditionally, not behind a guard that can be flipped off',
       !!warmLine && !/\bif\s*\(/.test(warmLine), warmLine.trim().slice(0, 90));
    ck('  without awaiting it, so the socket accepts immediately',
       !/await require\('\.\/helpers\/pdfBrowser'\)\.warm\(\)/.test(srv),
       'a renderer slow to listen sends everything back in-process and looks like it is working');
    ck('  and warming is exported to be called', typeof dflt.warm === 'function');

    // ── AND THE BROWSER REALLY IS KEPT ───────────────────────────────────
    // Everything above reads a CONSTANT. The mutation that deletes
    // `if (KEEP_WARM) return;` from scheduleIdleClose leaves every one of
    // them true and closes the browser anyway — it survived until this
    // existed. So: drive it, and watch whether close() is called.
    const driveIdle = async (env, waitMs) => {
        const mod = fresh(env);
        let closed = 0;
        const page = { setViewport: async () => {}, setDefaultNavigationTimeout() {},
            setDefaultTimeout() {}, close: async () => {}, render: async () => 'PDF' };
        mod._resetForTests();
        mod.init({ getBrowser: () => null,
                   launch: async () => ({ newPage: async () => page, close: async () => { closed += 1; } }) });
        await mod.withPage(async (pg) => pg.render());
        await new Promise((r) => setTimeout(r, waitMs));
        return { closed, open: mod.snapshot().ownOpen };
    };

    const kept = await driveIdle({ PDF_BROWSER_IDLE_MS: '0', PDF_BROWSER: 'own' }, 120);
    ck('a renderer that was told to keep its browser STILL HAS IT',
       kept.closed === 0 && kept.open === true,
       `closed ${kept.closed}, open ${kept.open}`);

    const dropped = await driveIdle({ PDF_BROWSER_IDLE_MS: '20', PDF_BROWSER: 'own' }, 150);
    ck('  while a short idle still closes it, as the main process wants',
       dropped.closed === 1, `closed ${dropped.closed}`);
    ck('  so the difference is behaviour, not a constant nobody reads',
       kept.closed !== dropped.closed, `${kept.closed} vs ${dropped.closed}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
