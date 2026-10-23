// ── tests/api-no-cache.js ────────────────────────────────────────────────────
// Live data is never cached, and never shared between sessions.
//
// Apsara, 2026-10-23: "when i create a load/sle,i have to log out n relogin to
// view the latest change.same is hapeening in docs also.it should be dynamic."
//
// Nothing was wrong with the server or the screen — both were checked. POST
// then GET returns the new row immediately and the ETag changes; the Loads tab
// refetches on every open. What was missing was a Cache-Control header on
// /api/ at all, which leaves every browser and every proxy between her and the
// VM free to decide how long yesterday's inventory stays fresh.
//
// THE SAME BUG, ON A DIFFERENT SURFACE, IS ALREADY IN THIS REPO. routes/
// pages.js forces no-cache on .html after a 2026-08-15 support case where she
// pulled two rounds of PDF fixes and still saw the old buttons. Static HTML
// was fixed then; the JSON the dashboard actually runs on was not.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nocache-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw';
delete require.cache[require.resolve(R('config.js'))];
const cfg = require(R('config.js'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT — DATA_DIR outside the temp dir'); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push(n); console.log('  FAIL ' + n + (extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 200))); } };

(async () => {
const { createApi } = require(R('api.js'));
const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = { Accept: 'text/html' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, raw, json: j, h: res.headers }); });
    });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
});

try {
    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    // ── THE HEADER ───────────────────────────────────────────────────────
    for (const p of ['/api/loads', '/api/outbound-loads', '/api/documents', '/api/claims']) {
        const r = await req('GET', p, { sid });
        ck(`${p} is never cached`, /no-store/.test(r.h['cache-control'] || ''),
            { got: r.h['cache-control'] });
        // Without Vary a shared cache that keeps one of these serves it to
        // whoever asks next — a staff session handed a manager's loads.
        ck(`  and cannot be shared between sessions`, /Cookie/.test(r.h['vary'] || ''), r.h['vary']);
    }

    // A refusal must not be cached either: cache a 401 and the browser keeps
    // bouncing her to /login after she has signed back in.
    const un = await req('GET', '/api/loads');
    ck('a 401 is not cached either', /no-store/.test(un.h['cache-control'] || ''), un.h['cache-control']);

    // ── THE THING SHE ACTUALLY REPORTED ──────────────────────────────────
    // Create, then read back through the SAME route the screen reads, and
    // prove the new row is there without signing out. A delta, so an
    // unrelated fixture moving above this cannot break it.
    const before = (await req('GET', '/api/loads', { sid })).json.length;
    const made = await req('POST', '/api/loads', { sid, body: {
        seller: 'Cache Test Seller', date: '2026-10-23', item: 'AL', net_lb: 1000, price: 0.5 } });
    ck('a load is created', made.status === 200, made.raw.slice(0, 140));
    const after = (await req('GET', '/api/loads', { sid })).json;
    ck('it is visible on the very next read — no log out, no log in',
        after.length === before + 1 && after.some((l) => l.seller === 'Cache Test Seller'),
        { before, after: after.length });

    // ── SCOPED. The app shell still caches. ──────────────────────────────
    // Forcing no-store on everything would make every page load re-download
    // the dashboard, which is a different complaint on a slow connection.
    const shell = await req('GET', '/dashboard/');
    ck('the dashboard shell is NOT forced to no-store', !/no-store/.test(shell.h['cache-control'] || ''),
        shell.h['cache-control']);
} finally { server.close(); }

// ── EVERY CLIENT ASKS FOR FRESH TOO ─────────────────────────────────────────
// Belt and braces to the server header above. The dashboard is reached
// through a Cloudflare tunnel; a client that asks for a cached read can be
// given one by anything in that path regardless of what the origin says.
//
// Checked across ALL of them, because these api() helpers are copies of one
// another — a fix applied to the one page she complained about and not the
// other seven is how this comes back on a screen nobody was looking at.
{
    const clients = [
        'dashboard/app/01-core.js', 'dashboard/documents.html', 'dashboard/outbound-loads.html',
        'dashboard/quote-requests.html', 'dashboard/contact-quote-requests.html',
        'dashboard/design-bol.html', 'dashboard/address-book.html', 'dashboard/edge-inventory.html',
        'mobile-app/www/app/02-cache-catalogue.js',
    ];
    for (const c of clients) {
        const src = fs.readFileSync(R(c), 'utf8');
        ck(`${c} asks for a fresh read`, /cache: 'no-store'/.test(src));
    }
    // BEFORE the spread, so a caller can still override it — and so that
    // ...opts does not silently blow it away on every call.
    const core = fs.readFileSync(R('dashboard/app/01-core.js'), 'utf8');
    ck('the option sits before ...opts, where it is a default and not dead',
        /cache: 'no-store'[^;]*\.\.\.opts/.test(core));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('  FAILED:'); failures.forEach((f) => console.log('   · ' + f)); }
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e && e.stack || e); process.exit(1); });
