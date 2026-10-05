// ── tests/plain-http-redirect.js ──────────────────────────────────────────
// Apsara, 2026-10-05: "make it reacgable at http://35.233.131.198:8080".
//
// A customer in the US spent an afternoon on ERR_CONNECTION_TIMED_OUT at
// that address. Nothing was wrong with the server: Caddy terminates TLS on
// 443 and proxies to 127.0.0.1:8080, so port 8080 was never answering the
// outside world. The URL kept circulating because HTTPS_SETUP.md still
// states it, in the present tense, as the current address.
//
// So 8080 answers now and REDIRECTS to https. What it must never do is serve
// the app over plain HTTP — APP_PASSWORD is 4 characters, ADMIN_PASSWORD is
// 5, there is no login lockout, and the ledger behind it now carries
// Plaid-fed bank data. Section B is that guarantee.
//
// Section C is the one that would turn a URL fix into an outage if it broke:
// the VM's own health checks and anything on loopback must NOT be redirected.

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plain-http-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.TRUST_PROXY = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

let server = null;

(async () => {

const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
server = await new Promise((r) => { const s = app.listen(0, '0.0.0.0', () => r(s)); });
const port = server.address().port;

// Requests are sent to 127.0.0.1 but with whatever Host and X-Forwarded-*
// headers we choose, which is exactly how the real thing differs: Caddy adds
// X-Forwarded-Proto, a browser hitting 8080 directly does not.
const req = (p, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null,
            cache: res.headers['cache-control'] || null, body: raw }));
    });
    r.on('error', reject); r.end();
});

// A request that LOOKS like it came from outside: a non-loopback client, no
// X-Forwarded-Proto. trust proxy makes req.ip read X-Forwarded-For, which is
// how a test can stand in for a remote browser.
const outside = (p, extra = {}) => req(p, { Host: '35.233.131.198:8080',
    'X-Forwarded-For': '203.0.113.9', ...extra });
// And one that came through Caddy.
const viaCaddy = (p, extra = {}) => req(p, { Host: 'jarvis.edgemetals.com',
    'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9', ...extra });

// ── A — THE OLD URL NOW ANSWERS ───────────────────────────────────────────
{
    section('A — port 8080 answers instead of timing out');

    const r = await outside('/');
    ck('a plain-HTTP request gets a redirect, not a timeout and not a page',
       r.status === 301, String(r.status));
    ck('  to the real hostname over https',
       r.location === 'https://jarvis.edgemetals.com/', String(r.location));

    // The path and query have to survive, or a shared deep link lands on the
    // dashboard root and the person has to navigate again.
    const deep = await outside('/bank-match?from=2026-09-01&to=2026-09-30');
    ck('the path survives the redirect',
       /\/bank-match\?from=2026-09-01&to=2026-09-30$/.test(deep.location || ''), String(deep.location));
    // NOT /health — that is deliberately exempt so the load balancer's
    // probe is not redirected (section C2). This check used to use it and
    // went red the moment that exemption landed, which is the old test doing
    // its job: a behaviour change should break a check, not slip past one.
    const plain = await outside('/documents');
    ck('  and so does a plain path',
       deep.status === 301 && plain.location === 'https://jarvis.edgemetals.com/documents',
       String(plain.location));

    ck('the redirect is 301 — permanent, so the bookmark itself heals',
       r.status === 301, String(r.status));
    ck('  and it is never cached, because the next hop is a login',
       /no-store/.test(r.cache || ''), String(r.cache));
}

// ── B — IT NEVER SERVES THE APP IN CLEARTEXT ──────────────────────────────
// The whole reason this is a redirect and not an open port.
{
    section('B — no password, no page, no data over plain HTTP');

    for (const p of ['/', '/login', '/bank-match', '/api/bank/match', '/api/sales-receipts', '/documents']) {
        const r = await outside(p);
        ck(`${p} is redirected, not served`,
           r.status === 301 && /^https:\/\//.test(r.location || ''), `${r.status} ${r.location}`);
        ck(`  and its body carries nothing`,
           r.body.length < 200 && !/password|PASSWORD|<form/i.test(r.body), r.body.slice(0, 120));
    }

    // A POST of a password must not be accepted in cleartext either. The
    // redirect happens before any route, so the credential never reaches a
    // handler — but that is worth proving rather than assuming.
    const post = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ password: process.env.ADMIN_PASSWORD });
        const r = http.request({ host: '127.0.0.1', port, path: '/login', method: 'POST',
            headers: { Host: '35.233.131.198:8080', 'X-Forwarded-For': '203.0.113.9',
                'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, body: raw }));
        });
        r.on('error', reject); r.write(body); r.end();
    });
    ck('a password POSTed over plain HTTP is redirected, never authenticated',
       post.status === 301 && !/sid/.test(post.body), `${post.status} ${post.body.slice(0, 80)}`);
    ck('  and no session is handed back', !/"sid"/.test(post.body), post.body.slice(0, 80));
}

// ── C — LOOPBACK AND CADDY ARE UNTOUCHED ──────────────────────────────────
// If this broke, a URL fix would have become an outage: every health check,
// every `curl localhost:8080`, and every proxied request would be answered
// with a redirect to a hostname and a TLS handshake.
{
    section('C — the things that must NOT be redirected');

    const h = await req('/health');                       // loopback, no headers
    ck('a loopback request is served normally', h.status === 200, String(h.status));
    ck('  and really returns the health body', /"status"\s*:\s*"ok"/.test(h.body), h.body.slice(0, 120));

    const c = await viaCaddy('/health');
    ck('a request through Caddy is served, not redirected',
       c.status === 200 && c.location === null, `${c.status} ${c.location}`);
    ck('  because X-Forwarded-Proto says it is already https',
       /"status"\s*:\s*"ok"/.test(c.body), c.body.slice(0, 120));

    // Port 80 on the real hostname is Caddy's own redirect to do. If this
    // middleware also answered it, two redirects would fight.
    const plainHost = await req('/health', { Host: 'jarvis.edgemetals.com', 'X-Forwarded-For': '203.0.113.9' });
    ck('plain HTTP on the real hostname is left to Caddy',
       plainHost.status === 200, `${plainHost.status} ${plainHost.location}`);

    const ipv6Loop = await req('/health', { Host: '[::1]:8080' });
    ck('an IPv6 loopback client is exempt too', ipv6Loop.status === 200, String(ipv6Loop.status));
}

// ── C2 — A HEALTH CHECK IS NEVER REDIRECTED ───────────────────────────────
// Found live on 2026-10-05, minutes after the Google load balancer was
// built: its backend came up UNHEALTHY. The checker polls
// http://10.138.0.2:8080/health from Google's ranges — not loopback, no
// X-Forwarded-Proto — so this middleware answered the probe with a 301, the
// checker marked the VM dead, and the load balancer would have served 502 to
// every visitor the moment DNS moved.
//
// This is the redirect's real blast radius. The loopback exemption was
// written for `curl localhost`; a prober that is neither local nor HTTPS was
// outside what I considered, and only building the load balancer exposed it.
{
    section('C2 — the load balancer\'s health check');

    // From Google's documented health-check ranges, over plain HTTP.
    const fromGoogle = (p) => req(p, { Host: '10.138.0.2:8080', 'X-Forwarded-For': '130.211.0.5' });
    let r = await fromGoogle('/health');
    ck('a probe from Google\'s range gets 200, not a redirect',
       r.status === 200, `${r.status} ${r.location || ''}`);
    ck('  and the real health body', /"status"\s*:\s*"ok"/.test(r.body), r.body.slice(0, 100));

    r = await req('/health', { Host: '10.138.0.2:8080', 'X-Forwarded-For': '35.191.2.9' });
    ck('the second Google range is exempt too', r.status === 200, String(r.status));

    // The PATH is exempt as well, so any future checker works without
    // anyone rediscovering this.
    r = await req('/health', { Host: 'x', 'X-Forwarded-For': '203.0.113.9' });
    ck('/health answers plainly whoever asks', r.status === 200,
       `${r.status} — a health endpoint that redirects is not a health endpoint`);
    r = await req('/healthz', { Host: 'x', 'X-Forwarded-For': '203.0.113.9' });
    ck('  and so does /healthz', r.status === 200 || r.status === 503, String(r.status));

    // Everything ELSE from an ordinary address still redirects — the
    // exemption must not have become a hole.
    r = await outside('/');
    ck('an ordinary visitor is still redirected', r.status === 301, String(r.status));
    r = await outside('/bank-match');
    ck('  and so is every other path', r.status === 301, String(r.status));

    // The two ranges must match the firewall rule that admits them.
    const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('the exempt ranges are Google\'s documented two',
       /130\\\.211\\\.|130\.211\./.test(src) && /35\\\.191\\\.|35\.191\./.test(src),
       'they must be the same two the allow-lb-health firewall rule admits');
}

// ── D — THE REDIRECT RUNS BEFORE THE AUTH GATE ────────────────────────────
// Order matters. If auth ran first, an outside visitor would get a 401 at the
// old URL instead of being sent to the working one — which looks like "I do
// not have access" rather than "wrong address", and that is a worse message.
{
    section('D — it happens before anything can refuse them');

    const r = await outside('/api/bank/match');
    ck('a guarded API path still redirects rather than returning 401',
       r.status === 301, `${r.status} — a 401 here would read as a permissions problem`);

    const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const mw = src.indexOf("app.use((req, res, next) => {\n        if (req.secure) return next();");
    const trust = src.indexOf("app.set('trust proxy', hops)");
    ck('  and it sits AFTER trust proxy, or req.secure would read the raw socket',
       trust > -1 && mw > trust, `trust proxy at ${trust}, middleware at ${mw}`);
    ck('  loopback is exempted in the code, not just in the test',
       /\^\(::1\|::ffff:127\\\.\|127\\\.\)/.test(src), 'the VM talking to itself must not be redirected');
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { try { server && server.close(); } catch (x) {} console.error('threw:', e && e.stack); process.exit(1); });
