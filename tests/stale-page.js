// ── tests/stale-page.js ─────────────────────────────────────────────────────
// Apsara, 2026-09-19, five rounds into "undo not there in jarvis profile":
//
//     "build 9861a0d+local · 569 rows · …"
//
// The fix WAS in 9861a0d. The gate was fine — a Jarvis session is role=admin
// and super=true. The data was fine — 569 rows stamped with a batch id, and
// listBatches() on the VM returned that batch with 569 bills and 651 sales.
// The routes were fine. The markup on disk was clean at 9861a0d.
//
// The footer was not lying. It was answering a DIFFERENT QUESTION: it reads
// /api/health, which is the SERVER's commit, while the markup around it came
// from a separately cached static file. A stale tab reporting the new build is
// worse than reporting nothing, because it retires the one check that existed
// for "am I looking at the new code" — the check added on 2026-09-10 after
// that question cost two wrong diagnoses in a day.
//
// ── THE HEADER WAS NECESSARY AND NOT SUFFICIENT ─────────────────────────────
// no-cache on .html has been there since 2026-08-15, for this same symptom.
// It cannot help against a proxy, a restored tab, or a browser that ignores
// it, and none of those are fixable from the server. What IS fixable is
// making the page say which build it is, so the two can be compared.

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

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-stale-'));
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-mmmmmmmmmmm';

const ROOT = path.join(__dirname, '..');

(async () => {

const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${listener.address().port}`;

const post = (p2, body) => new Promise((resolve, reject) => {
    const d = JSON.stringify(body);
    const r = http.request(base + p2, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {}
            resolve({ status: res.statusCode, json: j, headers: res.headers }); });
    });
    r.on('error', reject); r.write(d); r.end();
});
const get = (p2, sid) => new Promise((resolve, reject) => {
    const r = http.request(base + p2, { method: 'GET',
        headers: sid ? { Authorization: `Bearer ${sid}` } : {} }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    r.on('error', reject); r.end();
});

const sid = ((await post('/login', { password: 'admin-pw-mmmmmmmmmmm' })).json || {}).sid;
ck('logged in', !!sid);

// ── A. THE PAGE SAYS WHICH BUILD IT IS ──────────────────────────────────────
section('A. the page carries its own build');
{
    const page = await get('/index.html', sid);
    ck('the dashboard is served', page.status === 200, String(page.status));

    const meta = (page.body.match(/<meta name="jarvis-build" content="([^"]*)">/) || [])[1];
    ck('  it carries a build meta', !!meta, 'nothing to compare against');
    ck('  substituted, not left as a placeholder', meta !== '{{JARVIS_BUILD}}' && !page.body.includes('{{JARVIS_BUILD}}'),
       JSON.stringify(meta));

    // It has to be the SAME value /api/health reports, or the comparison in
    // the footer fires on every load and becomes noise she learns to ignore.
    const health = await get('/api/health', sid);
    const running = (JSON.parse(health.body || '{}').version || {}).short;
    ck('  and it matches the running commit', meta === running, `${meta} vs ${running}`);

    ck('  still no-cache, which is necessary and was never sufficient',
       /no-cache/.test(page.headers['cache-control'] || ''), page.headers['cache-control']);

    // ── AND THE FOOTER COMPARES THEM ────────────────────────────────────
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('the footer reads the page\'s own build', /meta\[name="jarvis-build"\]/.test(src));
    ck('  and says RELOAD when the two disagree',
       /this page is build \$\{pageBuild\}, the server is on \$\{v\.short\} — RELOAD/.test(src),
       'a mismatch she cannot see is the situation this whole file is about');
    // An un-substituted token means the page was opened straight off disk,
    // not served — that is not staleness and must not cry wolf.
    ck('  but not when the token was never substituted',
       /pageBuild !== '\{\{JARVIS_BUILD\}\}'/.test(src),
       'opening the file directly would permanently claim to be stale');
}

// ── B. IT DOES NOT BECOME A FILE READER ─────────────────────────────────────
// The handler reads from disk by a name taken from the request, which is how
// a static route turns into a way to read /etc/passwd.
//
// ── AND THESE PROBES DO NOT EXERCISE THE GUARD ──────────────────────────────
// Worth saying, because the first version of this section claimed they did.
// A mutation deleting the containment check left every one of them green:
// Express normalises req.path before routing, so "/../package.json" arrives
// as "/package.json" and "%2f" is never decoded into a separator. Nothing can
// currently walk out of the directory, with or without the guard.
//
// So the probes stay as a regression net — if Express's normalisation ever
// changes, or someone reaches for req.url, these are what notice — and the
// guard is asserted separately, as the source line it is.
section('B. the handler stays inside the dashboard directory');
{
    for (const probe of ['/../package.json', '/../../etc/passwd', '/..%2fpackage.json',
                         '/subdir/../../config.js', '/x/..%2f..%2fapi.js.html']) {
        const r = await get(probe, sid);
        const leaked = /"dependencies"|root:x:|module\.exports/.test(r.body || '');
        ck(`  ${probe} does not leak`, !leaked, `${r.status} ${String(r.body).slice(0, 60)}`);
    }

    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('  and the containment check is there for the day it is needed',
       /if \(!file\.startsWith\(path\.join\(cfg\.ROOT, 'dashboard'\) \+ path\.sep\)\) return next\(\);/.test(api),
       'a filesystem read named by user input with nothing standing in front of it');
    ck('  labelled as a second line rather than as the protection',
       /SECOND LINE, NOT THE FIRST/.test(api),
       'defensive code that looks load-bearing is how the real protection stops being maintained');
}

// ── C. EVERY OTHER PAGE IS UNTOUCHED ────────────────────────────────────────
// The handler sits in front of express.static for ALL .html. Anything without
// the token must fall straight through — a middleware that starts serving
// pages itself is a middleware that can start serving them wrong.
section('C. pages without the token fall through');
{
    const docs = await get('/documents.html', sid);
    ck('documents.html still serves', docs.status === 200, String(docs.status));
    ck('  with its real content', /Invoice|Packing|Proforma/i.test(docs.body), docs.body.slice(0, 80));
    ck('  and no stray token', !docs.body.includes('{{JARVIS_BUILD}}'));

    const missing = await get('/no-such-page.html', sid);
    ck('a page that does not exist is still a 404, not a crash',
       missing.status === 404, String(missing.status));
}

listener.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
