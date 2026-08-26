// ── tests/api-health.js ────────────────────────────────────────────────────
// Apsara, 2026-08-24, live: "Check for new mail" / "Which needs my reply" ->
// "Something broke while handling that: send is not defined". Root-caused to
// a bare `send(chatId, ...)` in workflow/actions.js — a global that has
// never existed. Fixed, then swept the WHOLE repo with eslint's no-undef
// rule for the same bug class rather than waiting for the next one to
// surface on its own. That sweep found a second, independent instance: this
// file's own /api/health endpoint has been throwing "fs is not defined" on
// its very FIRST check since whenever it was written — caught by its own
// try/catch, so gemini_key/sheet_sync/whatsapp/load_warnings never once
// actually ran. It always reported ok:false with a useless generic message,
// which is worse than no health check: it looks monitored and isn't.
//
// api.js has never had ANY test coverage — this file is that coverage,
// starting with the endpoint that was silently broken.
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


const path = require('path');
const R = (p) => path.join(__dirname, '..', p);
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
function ck(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
function ckTrue(name, cond, why) { ck(name, !!cond, true); if (!cond && why) console.log(`        why: ${why}`); }

function get(port, headers) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/health', headers }, (res) => {
            let body = ''; res.on('data', (d) => body += d);
            res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, raw: body }); } });
        }).on('error', reject);
    });
}

(async () => {
    process.env.API_TOKEN = process.env.API_TOKEN || 'test-token-for-suite';
    delete require.cache[require.resolve(R('api.js'))];
    const { createApi } = require(R('api.js'));
    const app = createApi();
    const srv = http.createServer(app).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;

    const unauth = await get(port, {});
    ck('no token: still 401, health check does not bypass auth', unauth.status, 401);

    const res = await get(port, { Authorization: `Bearer ${process.env.API_TOKEN}` });
    ck('authorized: 200, not a crash', res.status, 200);
    ckTrue('the response is real JSON, not an error page', !!res.json, res.raw);
    ckTrue('drive_keyfile check actually ran (not "fs is not defined")',
        res.json && res.json.checks && 'drive_keyfile' in res.json.checks,
        'this is the exact check that was silently throwing before any other check could run');
    ckTrue('every check downstream of drive_keyfile also ran',
        res.json && res.json.checks && ['gemini_key', 'sheet_sync', 'load_warnings'].every((k) => k in res.json.checks),
        'these never ran at all while drive_keyfile threw first — reported nothing, not "false"');
    ckTrue('no check silently swallowed into the outer catch',
        !res.json.error, res.json.error);

    // ══════════════════════════════════════════════════════════════════════
    // /healthz — what an external uptime monitor (HetrixTools) will hit.
    // The ONE property that matters: it must return a NON-200 status code
    // when Jarvis is up but not working. A monitor cannot read a JSON flag.
    // ══════════════════════════════════════════════════════════════════════
    const hz = (port) => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
            let body = ''; res.on('data', (d) => (body += d));
            res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, raw: body }); } });
        }).on('error', (e) => resolve({ status: 0, raw: e.message }));
    });

    const fsx = require('fs');
    const cfgx = require(R('config.js'));
    const writeStore = (o) => fsx.writeFileSync(cfgx.REPLY_WATCH_FILE, JSON.stringify(o));
    const savedUptime = process.uptime;
    const fakeUptime = (s) => { process.uptime = () => s; };

    // 1. Reachable without a token — a monitor has no session cookie.
    delete global.__jarvisWaReady;
    writeStore({ seen: {}, lastScanAt: new Date().toISOString() });
    fakeUptime(10000);
    let h = await hz(port);
    ck('healthz needs no auth (401 here would make it useless)', h.status, 200);
    ckTrue('and reports ok', h.json && h.json.ok === true, JSON.stringify(h.json));

    // 2. THE CASE THE OLD ENDPOINTS COULD NOT REPORT: process up, scans dead.
    writeStore({ seen: {}, lastScanAt: new Date(Date.now() - 90 * 60000).toISOString() });
    h = await hz(port);
    ck('a stalled inbox scan returns 503, not 200', h.status, 503);
    ckTrue('and names the problem with its age', h.json && /inbox_scan_stalled_9\dm/.test((h.json.problems || []).join(',')), JSON.stringify(h.json));

    // 3. WhatsApp down while Express is perfectly healthy — same process, so
    //    a plain HTTP monitor on / or /health sees 200 and tells her nothing.
    writeStore({ seen: {}, lastScanAt: new Date().toISOString() });
    global.__jarvisWaReady = () => false;
    h = await hz(port);
    ck('WhatsApp disconnected returns 503 even though the web server is fine', h.status, 503);
    ckTrue('and says so', h.json && (h.json.problems || []).includes('whatsapp_disconnected'), JSON.stringify(h.json));
    global.__jarvisWaReady = () => true;
    h = await hz(port);
    ck('reconnected goes back to 200', h.status, 200);

    // 4. A fresh boot must not alert — otherwise every deploy pages her and
    //    the alert gets muted, which is how monitoring dies.
    writeStore({ seen: {} });                     // no scan yet, as after a restart
    fakeUptime(30);
    h = await hz(port);
    ck('a just-restarted process is not called stalled', h.status, 200);
    fakeUptime(10000);
    h = await hz(port);
    ck('but a long-running process with no scan at all IS a problem', h.status, 503);
    ckTrue('named honestly', h.json && (h.json.problems || []).includes('no_scan_recorded'), JSON.stringify(h.json));

    // 5. It must not leak. Three booleans and a timestamp, nothing else.
    writeStore({ seen: {}, lastScanAt: new Date().toISOString() });
    h = await hz(port);
    ckTrue('the body exposes no business data',
        h.json && Object.keys(h.json).sort().join(',') === 'at,last_scan_age_min,last_scan_at,ok,problems,uptime_s,whatsapp',
        Object.keys(h.json || {}).join(','));

    process.uptime = savedUptime;
    delete global.__jarvisWaReady;

    srv.close();
    console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
    console.log('api.js: /api/health actually runs its checks.');
})().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
