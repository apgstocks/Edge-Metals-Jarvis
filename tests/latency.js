// ── tests/latency.js ────────────────────────────────────────────────────────
// Apsara, 2026-09-19: "When i click Bill,it takes like 5 seconds to load it.
// Latency is something which i dont want".
//
// ── THE OBVIOUS SUSPECT WAS INNOCENT ────────────────────────────────────────
// Measured before changing anything, because "the table is slow" reads like
// "the arithmetic is slow" and the arithmetic is not. For 600 bills:
//
//     listWithTotals   ~3ms      duplicates   ~0.3ms
//     filterRows       ~0.3ms    summary      ~2ms
//     facets           ~0.2ms    the whole route answers in 9-21ms
//
// Twenty milliseconds. Nothing there is worth optimising, and a morning spent
// making it fifteen would have moved the five seconds by nothing at all.
//
// What the route was SENDING is where the time was:
//
//     /api/bills     552 KB  ->  30 KB gzipped   (18x)
//     /index.html    723 KB  -> 197 KB gzipped   (3.7x)
//
// Over a megabyte of text to open one tab. JSON compresses like that because
// 600 rows repeat the same 38 keys 600 times, and index.html is deliberately
// no-cache (see tests/stale-page.js), so its 723 KB is paid on EVERY load
// rather than once.
//
// ── WHY THIS FILE IS MOSTLY ABOUT WHAT IS *NOT* COMPRESSED ──────────────────
// A response middleware sits in front of every route in the app — precisely
// the shared-code shape CLAUDE.md is about. The risk is not that gzip fails;
// it is that it fires somewhere nobody was looking. So the checks that matter
// most here are the negative ones: a client that never asked, a body too
// small to be worth it, a PDF that is already compressed, a 304 with no body.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-latency-'));
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-qqqqqqqqqqq';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

// ── A LEDGER THE SIZE OF HERS ───────────────────────────────────────────────
// 600 rows, because the import put 569 on the VM and the whole point is the
// payload at her scale. A ten-row fixture would be under the threshold and
// would prove nothing.
const N = 600;
{
    const bills = [];
    for (let i = 0; i < N; i++) {
        bills.push({
            id: `BILL_${i}`, date: `09/${1 + (i % 28)}/2026`,
            supplier: ['Gomez', 'CALDERON', 'Aussins', 'Modern Enterprises'][i % 4],
            carrier: 'MSC', trucker: `Trucker ${i % 20}`,
            container_no: `ABCU${1000000 + i}`, booking_no: `DALA${800000 + i}`, seal_no: `SL${i}`,
            gross: 44000 + i, truck: 15000, container: 8500, chassis: 6600,
            supplier_price: 0.32, price_unit: 'lb', supplier_invoice_amount: 12000 + i,
            trucking: 900, items: [{ item: 'scrap auto parts', net: 20000 }],
        });
    }
    fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify(bills));
}

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

// Raw http.request, deliberately: Node does NOT add Accept-Encoding of its
// own, so this harness controls exactly what the server is told. `fetch`
// would add gzip silently and the negative cases below could not be written.
const get = (p2, { sid, encoding, headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (sid) h.Authorization = `Bearer ${sid}`;
    if (encoding) h['Accept-Encoding'] = encoding;
    const started = Date.now();
    const r = http.request(base + p2, { method, headers: h }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
            status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks),
            bytes: Buffer.concat(chunks).length, ms: Date.now() - started,
            enc: res.headers['content-encoding'] || null,
        }));
    });
    r.on('error', reject); r.end();
});

const sid = ((await post('/login', { password: 'admin-pw-qqqqqqqqqqq' })).json || {}).sid;
ck('logged in', !!sid);

// ── A. THE BILLS PAYLOAD ARRIVES COMPRESSED, AND INTACT ─────────────────────
section('A. /api/bills over the wire');
let plainBills = null;
{
    const gz = await get('/api/bills', { sid, encoding: 'gzip' });
    const plain = await get('/api/bills', { sid });
    plainBills = plain;

    ck('the route still answers', gz.status === 200 && plain.status === 200,
       `${gz.status} / ${plain.status}`);
    ck('  and it is gzipped when asked for', gz.enc === 'gzip', String(gz.enc));

    // The check that actually matters. Compression that changes the bytes is
    // not compression, it is corruption with a smaller number next to it.
    let round = null;
    try { round = zlib.gunzipSync(gz.buf); } catch (e) { round = null; }
    ck('  and decodes to EXACTLY the uncompressed body', !!round && round.equals(plain.buf),
       round ? `${round.length} vs ${plain.bytes} bytes` : 'gunzip threw');

    // And it still parses as the payload the table is built from — a
    // byte-identical body that is not valid JSON would mean the plain path
    // broke too and both checks above would happily agree with each other.
    let parsed = null;
    try { parsed = JSON.parse(round.toString('utf8')); } catch (e) {}
    ck('  and is still the payload the ledger expects',
       !!parsed && Array.isArray(parsed.bills) && parsed.bills.length === N
       && Array.isArray(parsed.columns) && !!parsed.summary,
       parsed ? `${(parsed.bills || []).length} rows` : 'did not parse');

    // Not an assertion about a particular ratio — repeated JSON keys are what
    // compress, and if that ever stops being true the number should be looked
    // at rather than silently accepted. 4x is far below the 18x measured.
    ck('  and is meaningfully smaller, not nominally',
       gz.bytes * 4 < plain.bytes,
       `${(plain.bytes / 1024).toFixed(0)} KB -> ${(gz.bytes / 1024).toFixed(0)} KB`);
    console.log(`        (${(plain.bytes / 1024).toFixed(0)} KB -> ${(gz.bytes / 1024).toFixed(0)} KB, `
              + `${(plain.bytes / gz.bytes).toFixed(1)}x)`);

    ck('  Vary: Accept-Encoding, so a cache cannot serve it to a client that did not ask',
       /accept-encoding/i.test(gz.headers.vary || ''), String(gz.headers.vary));

    // ── THIS ONE IS NOT LOAD-BEARING, AND SAYS SO ───────────────────────
    // The middleware calls removeHeader('Content-Length') before handing the
    // gzipped buffer on. Deleting that line leaves every check in this file
    // green, because express's own res.send recomputes Content-Length from
    // whatever buffer it is finally given — and by then that is the gzipped
    // one. No route in api.js sets Content-Length by hand (grepped: the only
    // occurrence is the removeHeader itself), so there is nothing stale for
    // it to clear.
    //
    // It stays as insurance against a future route that does set one, on the
    // same footing as the traversal guard in tests/stale-page.js: kept,
    // labelled, and NOT claimed as tested behaviour. The assertion below is
    // about the header being correct, which it would be either way.
    ck('  and the Content-Length describes the bytes actually sent',
       !gz.headers['content-length'] || Number(gz.headers['content-length']) === gz.bytes,
       `content-length ${gz.headers['content-length']} vs ${gz.bytes} actual`);
}

// ── B. A CLIENT THAT DID NOT ASK GETS YESTERDAY'S BYTES ─────────────────────
// The whole safety argument for putting this in front of every route. gzip is
// negotiated; anything that does not advertise it must be untouched.
section('B. nothing changes for a client that never asked');
{
    ck('no Accept-Encoding means no Content-Encoding', plainBills.enc === null, String(plainBills.enc));
    ck('  and a real Content-Length', Number(plainBills.headers['content-length']) === plainBills.bytes,
       `${plainBills.headers['content-length']} vs ${plainBills.bytes}`);

    // identity and deflate-only are both "not gzip". Getting this wrong sends
    // gzipped bytes to something that will render them as mojibake.
    for (const enc of ['identity', 'deflate', 'br', '']) {
        const r = await get('/api/bills', { sid, encoding: enc || undefined });
        ck(`  Accept-Encoding: ${enc || '(absent)'} -> plain`, r.enc === null, String(r.enc));
    }

    // And it is still gzip when gzip appears among several.
    const multi = await get('/api/bills', { sid, encoding: 'br;q=1.0, gzip;q=0.8, *;q=0.1' });
    ck('  but gzip listed among others IS honoured', multi.enc === 'gzip', String(multi.enc));
}

// ── C. SMALL BODIES ARE LEFT ALONE ──────────────────────────────────────────
// Below about a kilobyte the gzip header and the extra round of framing cost
// more than the saving. Compressing a 200-byte {"ok":true} makes it bigger.
section('C. a small response is not worth compressing');
{
    const health = await get('/api/health', { sid, encoding: 'gzip' });
    ck('/api/health is small', health.bytes < 1024, `${health.bytes} bytes`);
    ck('  and therefore not gzipped', health.enc === null, String(health.enc));
    ck('  and still valid JSON', (() => { try { JSON.parse(health.buf.toString()); return true; } catch (e) { return false; } })());
}

// ── D. THE PAGE ITSELF ──────────────────────────────────────────────────────
// index.html is 723 KB and deliberately no-cache, so unlike everything else
// it is re-sent in full on every single load. It is the larger half of the
// five seconds, and it is served by the build-token handler (res.send), not
// by express.static — which is why compressing res.send reaches it at all.
section('D. index.html, which is re-sent on every load by design');
{
    const gz = await get('/index.html', { sid, encoding: 'gzip' });
    const plain = await get('/index.html', { sid });

    ck('the dashboard still serves', gz.status === 200, String(gz.status));
    ck('  gzipped', gz.enc === 'gzip', String(gz.enc));

    let round = null;
    try { round = zlib.gunzipSync(gz.buf); } catch (e) {}
    ck('  and decodes to exactly the plain page', !!round && round.equals(plain.buf),
       round ? `${round.length} vs ${plain.bytes}` : 'gunzip threw');
    console.log(`        (${(plain.bytes / 1024).toFixed(0)} KB -> ${(gz.bytes / 1024).toFixed(0)} KB, `
              + `${(plain.bytes / gz.bytes).toFixed(1)}x)`);

    // ── THE TWO THINGS THE PAGE MUST STILL DO ───────────────────────────
    // Compression sits between the build-token substitution and the wire. If
    // it ever broke either of these, the stale-page check she reads in the
    // footer would quietly stop working and nobody would notice until the
    // next "the fix is not there" conversation.
    const html = round ? round.toString('utf8') : '';
    ck('  the build token is still substituted', !html.includes('{{JARVIS_BUILD}}')
       && /<meta name="jarvis-build" content="[^"]+">/.test(html));
    ck('  and it is still no-cache', /no-cache/.test(gz.headers['cache-control'] || ''),
       String(gz.headers['cache-control']));
}

// ── E. WHAT IS DELIBERATELY NOT COMPRESSED ──────────────────────────────────
// The seven res.sendFile / res.download routes serve generated PDFs and xlsx
// workbooks. Both are already-compressed containers: gzipping them spends CPU
// to make the file marginally BIGGER. They do not go through res.send and
// must stay that way.
//
// ── AND THE CONTENT-TYPE GUARD IS LOAD-BEARING, NOT DEFENSIVE ───────────────
// Worth being exact about, because the first version of this section asserted
// the guard as a SOURCE LINE and a mutation deleting it stayed green. That
// reading was wrong. Ten routes in api.js set a binary Content-Type and then
// call res.send with a Buffer — PDFs at 3971, 5611, 5750, 6084 and 6406,
// xlsx at 1502 and 3982, audio/wav at 2026 and 3326. Every one of them goes
// through this middleware. The guard is the only thing keeping her ledger
// export out of gzip, so it is exercised here as a real request, not grepped.
section('E. binaries stay out of it');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');

    ck('res.sendFile and res.download are not wrapped',
       !/res\.(sendFile|download)\s*=/.test(api),
       'wrapping them would gzip PDFs and xlsx, which are already zip containers');

    // ── THE EXPORT SHE ACTUALLY CLICKS ──────────────────────────────────
    // ⋮ -> Excel, on the Bills ledger. An xlsx IS a zip: gzipping it spends
    // CPU to make the file very slightly larger, and labels a download with
    // an encoding it does not need. xlsx rather than pdf on purpose — the PDF
    // path goes through puppeteer and would make this suite a minute slower
    // to assert the same branch.
    const xlsx = await get('/api/bills/export?format=xlsx', { sid, encoding: 'gzip' });
    ck('the Excel export still downloads', xlsx.status === 200, String(xlsx.status));
    ck('  and is a real workbook', xlsx.buf.slice(0, 2).toString('latin1') === 'PK',
       `starts with ${JSON.stringify(xlsx.buf.slice(0, 4).toString('latin1'))} — a zip begins PK`);
    ck('  and is NOT gzipped, though gzip was offered', xlsx.enc === null,
       `Content-Encoding: ${xlsx.enc} — an xlsx is already a zip container`);
    ck('  and keeps its attachment filename',
       /attachment; filename=/.test(xlsx.headers['content-disposition'] || ''),
       String(xlsx.headers['content-disposition']));

    ck('  the type guard the above depends on is still there',
       /if \(!COMPRESSIBLE\.test\(type\)\) return sendRaw\(body\);/.test(api),
       'an unknown content type must fall through rather than be guessed at');

    // A body that is already encoded must not be encoded twice — the shape of
    // bug that produces a file no client on earth can open.
    ck('  and never double-encodes',
       /if \(res\.getHeader\('Content-Encoding'\)\) return sendRaw\(body\);/.test(api));

    // Bodies with no content to encode.
    ck('  and skips HEAD, 204 and 304',
       /req\.method === 'HEAD' \|\| res\.statusCode === 204 \|\| res\.statusCode === 304/.test(api));

    // Not a dependency. Deploying here is `git pull && pm2 restart` with no
    // npm install in the sequence — a require of a package the VM does not
    // have takes the whole site down on restart, which is a worse outcome
    // than the latency this is fixing.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ck('  and adds no dependency to install on the VM',
       !pkg.dependencies.compression && /const zlib = require\('zlib'\);/.test(api),
       'git pull + pm2 restart has no npm install step');
}

// ── F. A THROW IN COMPRESSION STILL DELIVERS THE RESPONSE ───────────────────
// It is an optimisation. A blank screen is infinitely worse than a slow one,
// so the failure path has to hand back the original body.
section('F. it cannot take a response down with it');
{
    const api = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const block = api.slice(api.indexOf('const COMPRESSIBLE'), api.indexOf('const COMPRESSIBLE') + 3000);
    ck('the wrapper catches and falls back to the plain body',
       /catch \(e\) \{[\s\S]{0,400}return sendRaw\(body\);/.test(block),
       'an optimisation that can 500 a route is not an optimisation');
    ck('  and clears the header it may already have set',
       /res\.removeHeader\('Content-Encoding'\)/.test(block),
       'a plain body labelled gzip is unreadable — worse than either alone');
}

// ── G. THE SERVER WAS NEVER THE SLOW PART ───────────────────────────────────
// Recorded as a check, not a comment, so the next person to read "Bills is
// slow" does not start by rewriting the arithmetic. Generous ceilings: this
// is a regression net for something going quadratic, not a benchmark.
section('G. the arithmetic, for the record');
{
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const t = (f) => { const s = process.hrtime.bigint(); const r = f();
                       return [Number(process.hrtime.bigint() - s) / 1e6, r]; };
    t(() => bills.listWithTotals());                       // warm
    const [msList, all] = t(() => bills.listWithTotals());
    const [msFilter] = t(() => bills.filterRows(all, {}));
    const [msSum] = t(() => bills.summary(all));
    const [msFacets] = t(() => bills.facets(all));
    const [msDupes] = t(() => bills.duplicates(all));
    const total = msList + msFilter + msSum + msFacets + msDupes;
    console.log(`        list ${msList.toFixed(1)}  filter ${msFilter.toFixed(1)}  summary ${msSum.toFixed(1)}`
              + `  facets ${msFacets.toFixed(1)}  dupes ${msDupes.toFixed(1)}  = ${total.toFixed(1)}ms`);
    ck(`${N} bills compute end to end in well under a quarter second`, total < 250,
       `${total.toFixed(0)}ms — something here has gone quadratic`);

    const r = await get('/api/bills', { sid, encoding: 'gzip' });
    ck('  and the route answers in well under a second on loopback', r.ms < 1000, `${r.ms}ms`);
}

listener.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
