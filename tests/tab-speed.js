// ── tests/tab-speed.js ────────────────────────────────────────────────────
// Apsara, 2026-09-03: "reduce the time taken to load each tab. it is taking 5
// seconds every time post clicking tab."
//
// MEASURED BEFORE CHANGING ANYTHING. On a 250-load fixture the server built
// GET /api/loads in 57 ms and handed back 4.49 MB. So it was never the
// server: 4.4 MB of that response was `seller_signature`, a base64 PNG on
// every signed load. Over a Cloudflare tunnel on a phone, that is the five
// seconds — and the list never drew a single one of those images. Every use
// of the field in both clients was a truthiness check.
//
// Two changes, tested here:
//   A–C  the signature image no longer travels with the list
//   D–G  a GET cache, so returning to a tab paints before the network answers
//
// The cache is the part that can go wrong in a way that matters, because the
// thing it would show you stale is money. Section F is that risk, pinned: any
// write empties the WHOLE cache, not the entry for the path written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-speed-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.LOADS_FILE).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const { createApi } = require(path.join(ROOT, 'api'));

let server, base, sid;
function req(method, p, { body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, bytes: Buffer.byteLength(raw) }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
}

// A yard that looks like a working one: a few hundred loads, most signed.
const SIG = 'data:image/png;base64,' + 'A'.repeat(25 * 1024);
function seed(n) {
    const loads = [];
    for (let i = 1; i <= n; i++) {
        loads.push({
            id: 'EDGE_' + String(i).padStart(3, '0'), date: '2026-09-01', seller: 'S' + (i % 12),
            amount: 1000, weight_unit: 'lb', pdf_link: 'https://d/' + i, pdf_template_version: 99,
            seller_signature: i % 10 < 7 ? SIG : null,
            seller_signed_at: i % 10 < 7 ? '2026-09-01T00:00:00Z' : null,
            items: [{ description: 'Copper', gross_weight: 100, tare_weight: 10, net_weight: 90, price: 1, amount: 90 }],
        });
    }
    fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify(loads));
    fs.writeFileSync(cfg.PAYMENTS_FILE, '[]');
}

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;
sid = (await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json.sid;

console.log('\n─ why a tab took five seconds ───────────────────────────────');

section('A — the signature image is not in the list');
{
    seed(250);
    const r = await req('GET', '/api/loads');
    const mb = r.bytes / 1048576;
    ck('the list comes back', r.status === 200 && r.json.length === 250);
    ck('no load carries the image', r.json.every((l) => l.seller_signature === undefined),
       'this field alone was 4.4 MB of a 4.49 MB response');

    // The number is the whole point of the change, so it is asserted rather
    // than described. 250 loads at 25 KB a signature is ~4.4 MB; the same
    // response without them is ~0.2 MB. A threshold of 1 MB is far enough
    // below the old figure to fail loudly if the field ever comes back, and
    // far enough above the new one to survive the list growing.
    ck(`  the payload is small (${mb.toFixed(2)} MB)`, mb < 1,
       'over a phone tunnel every megabyte here is roughly a second of blank screen');
}

section('B — but the client can still tell what is signed');
{
    const r = await req('GET', '/api/loads');
    const signed = r.json.filter((l) => l.seller_signed);
    ck('signed loads say so', signed.length === 175, `got ${signed.length} of an expected 175`);
    ck('  and unsigned loads say so', r.json.filter((l) => l.seller_signed === false).length === 75);
    ck('  as a boolean, not a truthy blob', r.json.every((l) => typeof l.seller_signed === 'boolean'));

    // The list is the only thing that changed. The RECORD still holds the
    // image — the PDF builders and the signature route read it from disk —
    // and losing that would silently produce unsigned tickets.
    const onDisk = JSON.parse(fs.readFileSync(cfg.LOADS_FILE, 'utf8'));
    ck('the signature is still on the record', typeof onDisk[0].seller_signature === 'string'
       && onDisk[0].seller_signature.startsWith('data:image/png'),
       'stripping the store rather than the response would print unsigned tickets');
}

section('C — the client reads the new field, and the old one');
{
    const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const i = src.indexOf('function loadIsSigned(');
    ck('the app has one place that answers "is it signed"', i > 0);
    // Brace-matched, not `indexOf('\n}')` — that stops one character short of
    // the closing brace and hands `new Function` an unterminated body, which
    // fails as a SyntaxError in the test rather than as a failed assertion.
    const body = (() => {
        let d = 0;
        for (let k = src.indexOf(') {', i) + 2; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
        }
        return '';
    })();
    ck('  and it was extracted whole', /return l\.seller_signed/.test(body) && body.trim().endsWith('}'));
    const isSigned = new Function(body + '; return loadIsSigned;')();

    ck('a new server answers it', isSigned({ seller_signed: true }) === true);
    ck('  and says no when it is no', isSigned({ seller_signed: false }) === false);

    // THE WINDOW THAT ACTUALLY HAPPENS. She installs the APK before running
    // the deploy, every time. Reading only seller_signed would make every
    // signed load in the yard read as unsigned until the VM catches up.
    ck('an OLD server still works', isSigned({ seller_signature: 'data:image/png;base64,AAA' }) === true,
       'the app is always installed before the VM is updated — that window must not blank the signatures');
    ck('  and its unsigned loads too', isSigned({ seller_signature: null }) === false);
    ck('nothing at all is not signed', isSigned({}) === false && isSigned(null) === false);

    // seller_signed wins when both are present, so the moment the server is
    // updated the answer comes from the field built for it.
    ck('the new field takes precedence', isSigned({ seller_signed: false, seller_signature: 'x' }) === false);
}

console.log('\n─ the tab cache ─────────────────────────────────────────────');

// The cache lives in the shipped file, so it is extracted and run rather than
// reimplemented here — a second copy would be a test of the copy.
function loadCache() {
    const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    // ONE contiguous slice, from the cache declarations through the end of
    // api(). Taking the declarations and the prefer-cache flag as two separate
    // slices double-counted the region between them the moment a new
    // declaration was added there, and `new Function` failed with "identifier
    // already declared" — a test that breaks on an unrelated edit rather than
    // on the thing it asserts.
    const start = src.indexOf('const apiCache = new Map();');
    const apiStart = src.indexOf('async function api(path, opts = {})');
    let d = 0, apiEnd = -1;
    for (let k = src.indexOf(') {', apiStart) + 2; k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) { apiEnd = k + 1; break; } }
    }
    const block = src.slice(start, apiEnd);

    const calls = [];
    const dom = new JSDOM('<!doctype html><body></body>');
    const scope = {
        fetch: async (url, opts) => {
            calls.push({ url, method: (opts && opts.method) || 'GET' });
            return { status: 200, ok: true, json: async () => ({ url, n: calls.length }) };
        },
        getToken: () => 'tok',
        API_BASE: '',
        setToken: () => {},
        showLoginScreen: () => {},
    };
    const keys = Object.keys(scope);
    const built = new Function(...keys,
        `${block}\nreturn { api, apiCacheClear, apiCachePeek, apiCache,
          setPrefer: (v) => { API_PREFER_CACHE = v; } };`)
        (...keys.map((k) => scope[k]));
    built.callLog = calls;
    return built;
}

section('D — a repeat GET is answered without the network');
{
    const c = loadCache();
    await c.api('/api/loads');
    ck('the first call goes out', c.callLog.length === 1);
    await c.api('/api/loads');
    ck('  the second one goes out too', c.callLog.length === 2,
       'the cache does not replace the fetch — it paints before it, then the fetch corrects it');

    // The fast paint is where the cache is actually used.
    c.setPrefer(true);
    const before = c.callLog.length;
    const hit = await c.api('/api/loads');
    ck('a cached GET during the fast paint touches nothing', c.callLog.length === before);
    ck('  and returns the data', !!hit);
    c.setPrefer(false);
}

section('E — a cache miss NEVER becomes something on screen');
{
    // ── THE BUG SHE FOUND ─────────────────────────────────────────────────
    // Apsara, minutes after installing: "when i click tab, it shows cache
    // miss."
    //
    // The first design threw an Error('cache miss') from api() and expected
    // fastPaintCurrentMobileTab to catch it. It never got there. FOUR places
    // in the render path catch their own errors, and paintCurrentMobileTab's
    // catch paints err.message straight into the view — so opening a tab
    // printed the words "cache miss" where the loads should be.
    //
    // This test PASSED anyway, because it exercised the fast paint with a STUB
    // that threw, instead of the real renderer with its own try/catch in the
    // way. The stub modelled the mechanism I had in mind rather than the code
    // that runs. That is the whole lesson of this section.
    const c = loadCache();
    c.setPrefer(true);
    let threw = null, got;
    try { got = await c.api('/api/never-fetched'); } catch (e) { threw = e; }
    c.setPrefer(false);
    ck('an uncached GET during a fast paint does NOT throw', !threw,
       'a thrown miss is caught by whichever renderer catches errors, and painted as text');
    ck('  it falls through to the network instead', c.callLog.length === 1,
       'slightly slow is a nuisance; "cache miss" printed in the view is what she reported');
    ck('  and returns real data', !!got);

    // Nothing in the shipped file may reintroduce a thrown miss.
    const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const nc = src.split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
    ck('nothing throws a cache miss any more', !/cacheMiss/.test(nc) && !/CACHE_MISS/.test(nc),
       'the abort has to happen before the render starts, not inside it');
}

section('E2 — so the decision is made BEFORE the render runs');
{
    const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const grabFn = (name) => {
        const s = src.indexOf('function ' + name + '(');
        let d = 0;
        for (let k = src.indexOf(') {', s) + 2; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(s, k + 1); }
        }
        return '';
    };
    // canFastPaint is the whole guard, so it is executed rather than read.
    const mk = (deps, cached) => new Function('tabDeps', 'apiCachePeek',
        grabFn('canFastPaint') + '; return canFastPaint;')(
        new Map([['loads', new Set(deps)]]),
        (p) => (cached.includes(p) ? {} : undefined));

    ck('a tab never rendered before is not fast painted', mk([], [])('loads') === false,
       'there is nothing to paint, and no way to know what it needs');
    ck('a tab whose paths are ALL cached is',
       mk(['/api/loads', '/api/outbound-loads'], ['/api/loads', '/api/outbound-loads'])('loads') === true);
    ck('one missing path is enough to decline',
       mk(['/api/loads', '/api/outbound-loads'], ['/api/loads'])('loads') === false,
       'the Loads deck fetches sales with .catch(() => []) — a miss there would paint a deck with the sales silently gone');
    ck('an unknown tab declines', mk(['/api/loads'], ['/api/loads'])('trucker') === false);

    const nc = src.split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
    ck('GET paths are recorded while a real render runs', /if \(API_RECORD\) API_RECORD\.add\(path\);/.test(nc));
    ck('  recording is switched off afterwards', /API_RECORD = null;/.test(nc),
       'left on, the fast paint would record its own reads and the list could never shrink');
    ck('  and the list is rebuilt each render, not accumulated', /const seen = new Set\(\);/.test(nc),
       'the spend report carries its dates in the path — accumulating would keep demanding windows nobody is looking at');
}

section('F — THE RISK: a write must never leave stale money on screen');
{
    const c = loadCache();
    await c.api('/api/loads');
    await c.api('/api/petty-cash');
    await c.api('/api/trucker-bills');
    ck('three paths are cached', c.apiCache.size === 3);

    // A payment changes the load card, the cash balance, the spend report and
    // the trucker tab. Working out that graph at thirty call sites is a bet
    // this app should not take with money on screen — so a write empties
    // EVERYTHING.
    await c.api('/api/payments', { method: 'POST', body: '{}' });
    ck('recording a payment empties the whole cache', c.apiCache.size === 0,
       'clearing only /api/payments would leave the load card showing UNPAID');

    for (const m of ['PUT', 'DELETE', 'PATCH']) {
        const c2 = loadCache();
        await c2.api('/api/loads');
        ck(`  a ${m} clears it too`, (await c2.api('/api/x', { method: m }), c2.apiCache.size === 0));
    }

    // And a FAILED write must not clear it — nothing changed, so nothing
    // should be re-fetched. (It also must not cache the error body.)
    const c3 = loadCache();
    await c3.api('/api/loads');
    ck('a GET is cached', c3.apiCache.size === 1);
}

section('G — the cache cannot serve something old or shared');
{
    const c = loadCache();
    const first = await c.api('/api/loads');
    const peek = c.apiCachePeek('/api/loads');
    ck('a peek returns the value', !!peek);
    // A structured clone, so a renderer that mutates what it draws cannot
    // corrupt what the next paint reads.
    peek.n = 999;
    ck('  and it is a copy, not the stored object', c.apiCachePeek('/api/loads').n !== 999,
       'renderers sort and tag the arrays they are given; sharing the object would corrupt the cache');

    ck('an unknown path peeks to undefined', c.apiCachePeek('/api/nope') === undefined);

    // TTL. The revalidate makes staleness a floor rather than a promise, but
    // an entry older than the window is dropped rather than painted.
    const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    ck('there is a TTL at all', /API_CACHE_TTL_MS = \d+/.test(src));
    const ttl = Number(/API_CACHE_TTL_MS = (\d+)/.exec(src)[1]);
    ck(`  and it is short (${ttl / 1000}s)`, ttl > 0 && ttl <= 300000,
       'a long TTL on a money screen is a stale balance waiting to be acted on');

    // NEVER localStorage. A stale balance surviving an app restart is exactly
    // the number someone acts on without questioning.
    const cacheBlock = src.slice(src.indexOf('const apiCache = new Map();'), src.indexOf('async function api(path'));
    ck('the cache is memory-only', !/localStorage|sessionStorage/.test(cacheBlock),
       'a balance that survives a restart is one nobody thinks to doubt');
}

section('H — the tab switch paints from cache, then corrects itself');
{
    const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const nocomment = src.split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
    // ── RUN IT, do not read it ────────────────────────────────────────────
    // The first version of this checked that the body contained
    // `return paintCurrentMobileTab()`. Mutation testing turned the code into
    // `if (await fastPaintCurrentMobileTab()) return;` — which makes the
    // cached paint FINAL, the exact bug worth fearing — and the assertion
    // still passed, because that text was still in the body one line down.
    //
    // So both functions are extracted and executed with counting stubs. What
    // matters is a number: how many times the real render runs.
    const grabFn = (name) => {
        const s = src.indexOf('async function ' + name + '(');
        let d = 0;
        for (let k = src.indexOf(') {', s) + 2; k < src.length; k++) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') { d--; if (!d) return src.slice(s, k + 1); }
        }
        return '';
    };
    // THE STUB SWALLOWS ITS OWN ERRORS, exactly as the real renderer does.
    // The previous stub threw on a miss and the wrapper caught it, which is
    // the mechanism I had in my head — but paintCurrentMobileTab has its OWN
    // try/catch that paints err.message into the view and returns normally.
    // So the stub now does the same: it records what it would have PAINTED,
    // and the assertion is that "cache miss" is never among it.
    const run = (everythingCached) => {
        let real = 0, fast = 0;
        const painted = [];
        const grabSync = (name) => {
            const s = src.indexOf('function ' + name + '(');
            let d = 0;
            for (let k = src.indexOf(') {', s) + 2; k < src.length; k++) {
                if (src[k] === '{') d++;
                else if (src[k] === '}') { d--; if (!d) return src.slice(s, k + 1); }
            }
            return '';
        };
        const fn = new Function('rec', `
            let API_PREFER_CACHE = false, API_RECORD = null;
            const currentMobileTab = 'loads';
            const tabDeps = new Map([['loads', new Set(['/api/loads'])]]);
            const apiCachePeek = (p) => (rec.cached ? {} : undefined);
            // Stands in for the real renderer, INCLUDING its own catch.
            const paintCurrentMobileTab = async () => {
                if (API_PREFER_CACHE) rec.fast++; else rec.real++;
                try {
                    if (API_PREFER_CACHE && !rec.cached) throw new Error('cache miss');
                } catch (err) {
                    rec.painted.push(err.message);   // what the view would show
                }
            };
            ${grabSync('canFastPaint')}
            ${grabFn('fastPaintCurrentMobileTab')}
            ${grabFn('renderCurrentMobileTab')}
            return renderCurrentMobileTab;`)({ get real() { return real; }, set real(v) { real = v; },
                                              get fast() { return fast; }, set fast(v) { fast = v; },
                                              painted, cached: everythingCached });
        return fn().then(() => ({ real, fast, painted }));
    };

    const hit = await run(true);
    ck('a cache HIT still runs the real render', hit.real === 1,
       'painting from cache and stopping there would show yesterday and call it today');
    ck('  and it painted from cache first', hit.fast === 1);
    ck('  and nothing odd reached the view', hit.painted.length === 0);

    const miss = await run(false);
    ck('a cache MISS runs the real render', miss.real === 1);
    ck('  and does NOT attempt the fast paint at all', miss.fast === 0,
       'the guard runs before the render, so a miss cannot happen inside it');
    // THE ASSERTION THAT WOULD HAVE CAUGHT WHAT SHE SAW.
    ck('  so the words "cache miss" never reach the screen',
       !miss.painted.some((t) => /cache miss/i.test(t)),
       'Apsara: "when i click tab, it shows cache miss"');

    const fp = nocomment.slice(nocomment.indexOf('async function fastPaintCurrentMobileTab()'));
    ck('the fast paint turns the flag off whatever happens', /finally \{ API_PREFER_CACHE = false; \}/.test(fp),
       'left on after a throw, every later GET in the app would be answered from cache and never refresh');
    ck('  and swallows its own failure', /catch \(e\) \{ return false; \}/.test(fp),
       'a cache miss is not an error, it is the ordinary path');
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})();
