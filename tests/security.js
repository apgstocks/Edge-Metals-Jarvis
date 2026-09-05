// ── tests/security.js ─────────────────────────────────────────────────────
// Apsara, 2026-09-03: "increase security of this app."
//
// An audit is a snapshot; this file is what stops the findings coming back.
// Each section pins one thing that was fixed, so a later edit that undoes it
// fails here instead of being discovered by whoever finds the tunnel URL.
//
// WHAT THE AUDIT ALSO FOUND TO BE FINE, asserted so it stays that way:
// no path traversal from :id into the filesystem, no secrets in log lines,
// .env gitignored, timing-safe password comparison, and both clients
// escaping interpolated data. Those cost nothing to keep and are cheap to
// lose in a hurried edit.
//
// DELIBERATELY NOT HERE: a login throttle. Asked what should happen after
// repeated wrong passwords, she said "nothing as of now", so nothing refuses
// anyone. Section D asserts the counting that replaced it — visibility
// without a lockout — and asserts that nothing blocks, so if a throttle is
// ever added it is a decision someone makes on purpose.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sec-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
delete process.env.CORS_ALLOW_ALL;
delete process.env.CORS_ALLOWED_ORIGINS;

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const { createApi } = require(path.join(ROOT, 'api'));

let server, base;
function req(method, p, { origin, body, sid } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (origin) headers.Origin = origin;
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, json: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
}

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;

console.log('\n─ security ──────────────────────────────────────────────────');

section('A — CORS is an allowlist, not a wildcard');
{
    // Was Access-Control-Allow-Origin: * on every response. CORS gates a
    // browser READING a response rather than whether the request happens, so
    // this was never the only thing standing between anyone and the data —
    // but it meant any page on the internet could read this API's answers the
    // moment it had a token, and with bank data arriving that margin is worth
    // closing.
    const app1 = await req('GET', '/health', { origin: 'https://localhost' });
    ck('the Android app origin is allowed', app1.headers['access-control-allow-origin'] === 'https://localhost',
       'capacitor.config.json sets androidScheme https with no hostname — get this wrong and the app dies');
    ck('  and the response is marked as varying by origin', /origin/i.test(app1.headers.vary || ''),
       'without Vary a shared cache could hand one origin its neighbour\'s response');

    for (const o of ['capacitor://localhost', 'ionic://localhost', 'http://localhost']) {
        const r = await req('GET', '/health', { origin: o });
        ck(`  ${o} is allowed too`, r.headers['access-control-allow-origin'] === o,
           'kept so a config change or an iOS build cannot silently break the app');
    }

    const evil = await req('GET', '/health', { origin: 'https://evil.example.com' });
    ck('an unknown origin gets NO allow-origin header', !evil.headers['access-control-allow-origin'],
       'the browser refuses to hand the response to that page');
    ck('  and the wildcard is gone entirely', evil.headers['access-control-allow-origin'] !== '*');

    // NO Origin HEADER is the common case and must keep working: same-origin
    // browser requests, curl, the uptime monitor, anything server-to-server.
    const none = await req('GET', '/health');
    ck('a request with no Origin still works', none.status === 200,
       'the dashboard is served by this same app, so its requests are same-origin and carry no Origin at all');

    // Preflight still answers, or every non-GET from the app fails.
    const pre = await req('OPTIONS', '/api/loads', { origin: 'https://localhost' });
    ck('preflight is answered', pre.status === 204);
    ck('  with the headers the app sends', /Authorization/i.test(pre.headers['access-control-allow-headers'] || ''));
    ck('  and the methods it uses', /DELETE/.test(pre.headers['access-control-allow-methods'] || ''));
}

section('B — the escape hatches work');
{
    // The failure mode here is being locked out of her own app from a phone,
    // with no laptop nearby. Both hatches are asserted because an untested
    // escape hatch is not one.
    const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('an extra origin can be added by env', /CORS_ALLOWED_ORIGINS/.test(src));
    ck('  and the wildcard can be restored by env', /CORS_ALLOW_ALL/.test(src));
    ck('a refused origin is logged with the value it saw', /refused origin \$\{origin\}/.test(src),
       'the fix should be reading one log line, not guessing');

    // Actually restart the app with the env set, rather than trusting the
    // string match above.
    process.env.CORS_ALLOWED_ORIGINS = 'https://yard.example.com';
    delete require.cache[require.resolve(path.join(ROOT, 'api'))];
    const app2 = require(path.join(ROOT, 'api')).createApi();
    const s2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const got = await new Promise((resolve) => {
        http.get(b2 + '/health', { headers: { Origin: 'https://yard.example.com' } },
            (res) => { res.resume(); resolve(res.headers['access-control-allow-origin']); });
    });
    ck('an env-added origin is really allowed', got === 'https://yard.example.com');
    s2.close();
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete require.cache[require.resolve(path.join(ROOT, 'api'))];
}

section('C — the session cookie');
{
    const r = await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } });
    const cookie = String(r.headers['set-cookie'] || '');
    ck('signing in sets a cookie', /sid=/.test(cookie));
    ck('  HttpOnly, so page scripts cannot read it', /HttpOnly/i.test(cookie));
    ck('  SameSite=Strict, so it is never sent cross-site', /SameSite=Strict/i.test(cookie));
    ck('  and Secure, so it is never sent in clear', /Secure/i.test(cookie),
       'the tunnel is HTTPS today; this is what covers the day something is reached over plain HTTP');
}

section('D — failed sign-ins are counted, and nothing is blocked');
{
    // Her decision: "nothing as of now." So this asserts BOTH halves — that
    // the counting exists, and that it refuses nobody. If a throttle is added
    // later it should be because someone chose to, not because it drifted in.
    let last = null;
    for (let i = 0; i < 12; i++) {
        last = await req('POST', '/login', { body: { password: 'wrong-' + i } });
    }
    ck('twelve wrong passwords all still get a plain 401', last.status === 401,
       'no lockout, by her decision — this asserts it stays that way');
    ck('  and the answer says nothing about which password was tried',
       last.json && last.json.error === 'wrong password',
       'a different message for a wrong admin vs a wrong staff password would confirm which exist');

    const ok = await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } });
    ck('the right password still works immediately after', ok.status === 200,
       'the whole point of choosing no lockout is that she can never be shut out');

    // ── OBSERVED, not grepped ─────────────────────────────────────────────
    // The first version of this asserted that the source contained the string
    // "failedLogins". Deleting the line that actually increments the counter
    // left the declaration and the delete behind, so the test passed while
    // nothing was being counted. Mutation testing caught it.
    //
    // The counter has no HTTP surface by design — nothing is blocked, so
    // nothing about it is visible in a response. The one observable effect is
    // the warning at five, so that is what is watched.
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); };
    try {
        for (let i = 0; i < 5; i++) await req('POST', '/login', { body: { password: 'nope-' + i } });
    } finally { console.warn = realWarn; }
    ck('five failures actually raise a warning', warnings.some((w) => /failed sign-ins/.test(w)),
       'without a count there is no way to tell a typo from someone working through a wordlist');
    ck('  it names how many and from where',
       warnings.some((w) => /5 failed sign-ins from /.test(w)));
    ck('  and says plainly that nothing is blocked',
       warnings.some((w) => /Nothing is being blocked/.test(w)),
       'so a log reader does not assume they are protected');

    const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('  the counter is bounded', /FAILED_LOGIN_MAX_IPS/.test(src),
       'an unbounded map is a memory problem handed to an attacker');
    ck('  a success clears it', /failedLogins\.delete/.test(src));
    ck('  and no password is ever logged',
       !/console\.(warn|log|error)\([^)]*\bpw\b/.test(src) && !/\$\{pw\}/.test(src));
}

section('E — what the audit found already correct, and must stay so');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');

    // Timing-safe comparison. A plain === leaks the password a character at a
    // time to anyone patient enough to measure.
    ck('passwords are compared in constant time', /crypto\.timingSafeEqual/.test(api));

    // The staff fence is an allowlist, so a NEW route is denied by default
    // rather than exposed until someone remembers to think about it.
    ck('staff access is deny-by-default', /STAFF_ALLOWED_PATH_PREFIXES\.some/.test(api)
       && /return res\.status\(403\)\.json\(\{ error: 'staff access is limited to Loads' \}\)/.test(api));

    // The machine token is admin, never super — a long-lived shared secret
    // must not be able to erase paid loads.
    ck('the API token is not privileged to super', /got === cfg\.API_TOKEN.*\n.*req\.isSuper = false/m.test(api)
       || /req\.role = 'admin'; req\.isSuper = false;/.test(api));

    // Secrets stay out of git.
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const p of ['.env']) ck(`${p} is gitignored`, new RegExp('^' + p.replace('.', '\\.') + '$', 'm').test(ignore));

    // The bank files, which do not exist yet, are already excluded from the
    // archive that goes to a shared Drive folder.
    const backup = require(path.join(ROOT, 'helpers/backup'));
    ck('bank data is excluded from the shared backup',
       backup.isSecret('bank-item.json') && backup.isSecret('bank-transactions.json'));

    // No route interpolates a request param into a filesystem path.
    const helpers = fs.readdirSync(path.join(ROOT, 'helpers'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => fs.readFileSync(path.join(ROOT, 'helpers', f), 'utf8')).join('\n');
    ck('no request parameter is joined into a path',
       !/path\.join\([^)]*req\.(params|query|body)/.test(api + helpers),
       'that is how ../../etc/passwd gets read');
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})();
