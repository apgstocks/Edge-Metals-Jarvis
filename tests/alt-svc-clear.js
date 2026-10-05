// ── tests/alt-svc-clear.js ────────────────────────────────────────────────
// Apsara, 2026-10-05: "They tokld that it is now working in mobile data but
// not wifi." — and then: "Fix it properly this time. I dont want to face it
// again n again."
//
// ── THE FAULT, AND WHY IT OUTLIVED ITS OWN FIX ───────────────────────────
// Caddy advertised HTTP/3 over UDP 443:
//
//     alt-svc: h3=":443"; ma=2592000
//
// ma=2592000 is THIRTY DAYS, and clients cache it. Many wifi and corporate
// networks carry TCP 443 and silently drop UDP 443, so a client holding that
// advertisement keeps reaching for QUIC and fails — while mobile data, which
// carries UDP fine, works. That exact split was documented on 2026-10-02 in
// docs/cloudflare-runbook.md and it is the split she reported again today.
//
// HTTP/3 was disabled server-side on 2026-10-03 and the live server no longer
// advertises it. That stopped NEW advertisements and did nothing about the
// copies already stored, which survive until roughly 2026-11-02. So the fix
// looked like it had failed, five more theories followed, and today I threw
// the correct theory away on one contradicting data point.
//
// ── THE ERASER ───────────────────────────────────────────────────────────
// RFC 7838 section 3: the value "clear" means "any existing alternative
// services for the origin are invalidated". One header, on one response, and
// the stale entry is gone — on a device nobody has to touch, with no restart
// and no cache clear, in another country.
//
// ── WHY THIS FILE EXISTS RATHER THAN A COMMENT ───────────────────────────
// "I dont want to face it again n again". The header is one line and one line
// is easy to delete. These checks are what make its removal, or HTTP/3 coming
// back, a red test rather than a customer in six weeks.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-altsvc-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.TRUST_PROXY = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated');
    process.exit(1);
}

let server = null;

(async () => {

const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;

const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    r.on('error', reject); r.end();
});
// Through Caddy, which is how every real browser request arrives.
const viaCaddy = (p) => get(p, { Host: 'jarvis.edgemetals.com', 'X-Forwarded-Proto': 'https' });

// ── A — EVERY RESPONSE CARRIES THE ERASER ─────────────────────────────────
{
    section('A — the header that erases a stale QUIC advertisement');

    const r = await viaCaddy('/health');
    ck('a normal response carries Alt-Svc', !!r.headers['alt-svc'], JSON.stringify(r.headers['alt-svc']));
    ck('  and its value is exactly "clear" — the RFC 7838 eraser',
       r.headers['alt-svc'] === 'clear', String(r.headers['alt-svc']));
    // The value matters. "h3=..." would ADVERTISE QUIC and cause the very
    // outage being fixed; an empty string is not valid and is ignored.
    ck('  not an advertisement of any kind',
       !/h3|h2=|quic|:443/i.test(r.headers['alt-svc'] || ''), String(r.headers['alt-svc']));

    // It has to be on EVERY response, not just the lucky one. A client that
    // only ever requests an asset must still be cured.
    for (const p of ['/', '/login', '/health', '/healthz', '/api/bank/match', '/nope-404']) {
        const x = await viaCaddy(p);
        ck(`  ${p} carries it too (status ${x.status})`, x.headers['alt-svc'] === 'clear',
           `${x.status} ${x.headers['alt-svc']}`);
    }
}

// ── B — IT RUNS BEFORE ANYTHING CAN SHORT-CIRCUIT ─────────────────────────
// A client that cannot sign in is exactly the client that needs curing, so
// the header must survive a 401, a redirect and a 404.
{
    section('B — it survives the responses that end early');

    const unauth = await viaCaddy('/api/bank/match');
    ck('an unauthenticated API response still carries it',
       unauth.headers['alt-svc'] === 'clear', `${unauth.status} ${unauth.headers['alt-svc']}`);

    // The plain-HTTP redirect added earlier today ends the request itself.
    const redirected = await get('/', { Host: '35.233.131.198:8080', 'X-Forwarded-For': '203.0.113.9' });
    ck('the 8080 redirect carries it as well',
       redirected.status === 301 && redirected.headers['alt-svc'] === 'clear',
       `${redirected.status} ${redirected.headers['alt-svc']}`);
    ck('  which matters: that is the response an old bookmark gets first',
       redirected.headers.location === 'https://jarvis.edgemetals.com/',
       String(redirected.headers.location));

    const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const alt = src.indexOf("res.set('Alt-Svc', 'clear')");
    const redir = src.indexOf('const target = \'https://jarvis.edgemetals.com\'');
    ck('the eraser is installed BEFORE the redirect middleware',
       alt > -1 && redir > -1 && alt < redir,
       `alt-svc at ${alt}, redirect at ${redir} — after it, the redirect would escape uncured`);
}

// ── C — THE SERVER MUST NOT ADVERTISE HTTP/3 ANYWHERE ─────────────────────
// The eraser is pointless if something else re-advertises on the next
// response. The Caddyfile is the only thing that can, and it must agree.
{
    section('C — nothing re-advertises what we just erased');

    const caddy = fs.readFileSync(path.join(ROOT, 'Caddyfile'), 'utf8');
    const config = caddy.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    ck('the Caddyfile disables HTTP/3', /protocols\s+h1\s+h2/.test(config), config);
    ck('  and does not list h3 anywhere', !/\bh3\b/.test(config), config);
    ck('  with servers as a GLOBAL block, which is the only valid placement',
       /\{\s*servers\s*\{[\s\S]*?protocols\s+h1\s+h2/.test(config),
       'inside a site block Caddy rejects the config and the site does not start');

    // The day HTTP/3 is deliberately re-enabled, "clear" becomes wrong — it
    // would erase an advertisement we meant to make. Tying the two together
    // means that change cannot be made silently.
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const erasing = /res\.set\('Alt-Svc', 'clear'\)/.test(api);
    const http3off = /protocols\s+h1\s+h2/.test(config);
    ck('the eraser and the protocol setting agree with each other',
       erasing === http3off,
       'if HTTP/3 is ever turned back on, the Alt-Svc: clear line must go in the same change');
}

// ── D — WHAT IT COSTS, WHICH IS NOTHING ───────────────────────────────────
{
    section('D — it breaks none of the things a header could break');

    const r = await viaCaddy('/health');
    ck('the body is untouched', /"status"\s*:\s*"ok"/.test(r.body), r.body.slice(0, 80));
    ck('  the status is untouched', r.status === 200, String(r.status));
    ck('  gzip still applies', !!r.headers['content-encoding'] || r.body.length < 200,
       String(r.headers['content-encoding']));
    ck('  and CORS is untouched',
       !!r.headers['access-control-allow-methods'], JSON.stringify(r.headers['access-control-allow-methods']));

    // Exactly one Alt-Svc header. Two would be sent as a list and a client
    // may take the first, which could be an advertisement.
    const raw = r.headers['alt-svc'];
    ck('exactly one Alt-Svc value is sent, not a list',
       typeof raw === 'string' && !raw.includes(','), JSON.stringify(raw));
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { try { server && server.close(); } catch (x) {} console.error('threw:', e && e.stack); process.exit(1); });
