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

    srv.close();
    console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('\nFAILED:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
    console.log('api.js: /api/health actually runs its checks.');
})().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
