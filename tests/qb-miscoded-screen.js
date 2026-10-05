// ── tests/qb-miscoded-screen.js ───────────────────────────────────────────
// Apsara, 2026-10-05: "Improve jarvis specifically in qb area as of now".
//
// ── SIXTEEN CHEQUES, COMPUTED EVERY MORNING AND THROWN AWAY ──────────────
// agent.js's miscodedCheques() has, since it was written, returned a row per
// cheque that went straight to cost of goods sold: id, date, payee, amount,
// and the container numbers named on it. On 4 October that was 16 cheques and
// $411,276.27.
//
// The page did one thing with all of it:
//
//     ['Miscoded', money(i.miscoded && i.miscoded.number), 'warn'],
//
// A number in a chip. Meanwhile the morning mail said "Re-coding moves money
// out of cost of goods sold and changes reported profit. One approval, never
// silent" — promising an approval that existed nowhere. The same shape as the
// guarded route with no button and the telemetry with no client: the work was
// done and there was no way to see it.
//
// ── THIS IS THE READ-ONLY HALF, AND ONLY THAT ────────────────────────────
// Re-coding is a WRITE against her books that changes reported profit. It is
// not built here and must not be: that is a decision she has not made. What
// is built is the list, so the number stops being unactionable.
//
// The route is driven through a real server with QuickBooks stubbed at
// agent.miscodedCheques — the one seam that keeps the test off her live
// books. Her 4 October figures are the fixture.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qb-miscoded-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-bbb';
process.env.APP_PASSWORD = 'user-pw-aaa';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

// ── THE ONE STUB ─────────────────────────────────────────────────────────
// Replaced on the module object, and the route reaches it by property access
// (`require('./agent').miscodedCheques(...)`) — which is the seam that
// actually works. A stub on something the caller holds as a local would do
// nothing, which is how a test of mine ran against her live Google sheet two
// days ago.
const agent = require(path.join(ROOT, 'helpers/quickbooks/agent'));
let asked = null;
const OCT4 = {
    number: 411276.27, count: 16,
    span: ['2026-01-14', '2026-09-30'],
    fixable: { count: 7, money: 145757.93, rows: [
        { id: '1', date: '2026-03-02', payee: 'Mazariegos Recycling', amount: 51000, containers: ['MSDU1111111'] },
        { id: '2', date: '2026-05-11', payee: 'Calderon Cores', amount: 44757.93, containers: [] },
        { id: '3', date: '2026-01-14', payee: 'Junk Car', amount: 50000, containers: ['TCLU6619618', 'HMMU4741911'] },
    ] },
    noPayee: { count: 9, money: 265518.34, rows: [
        { id: '4', date: '2026-09-30', payee: null, amount: 200000, containers: [] },
        { id: '5', date: '2026-07-02', payee: null, amount: 65518.34, containers: ['GLDU9573030'] },
    ] },
};
agent.miscodedCheques = async (year, env) => { asked = { year, env }; return OCT4; };

const { createApi } = require(path.join(ROOT, 'api'));
let server, base;
function req(method, urlPath, { sid } = {}) {
    return new Promise((resolve, reject) => {
        const headers = sid ? { Authorization: `Bearer ${sid}` } : {};
        const r = http.request(base + urlPath, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json, raw }); });
        });
        r.on('error', reject);
        r.end();
    });
}

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;
const sid = (await req('POST', '/login')).json ? null : null;
// login properly
const login = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ password: 'jarvis-pw-ddd' });
    const r = http.request(base + '/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.write(body); r.end();
});
void sid;

// ── A — THE ROUTE EXISTS AND ANSWERS ──────────────────────────────────────
let body = null;
{
    section('A — the cheques, over the wire');

    const r = await req('GET', '/api/qb/miscoded', { sid: login.sid });
    ck('the route answers', r.status === 200, r.status + ' ' + r.raw.slice(0, 180));
    body = r.json;

    ck('  it asked QuickBooks for this year', asked && asked.year === new Date().getFullYear(),
       JSON.stringify(asked));
    ck('  and reports the total and the count',
       body.total === 411276.27 && body.count === 16, JSON.stringify({ t: body.total, c: body.count }));
    ck('  with the span, so she knows how far back this goes',
       Array.isArray(body.span) && body.span[0] === '2026-01-14', JSON.stringify(body.span));
}

// ── B — NAMED AND NAMELESS ARE DIFFERENT PILES ────────────────────────────
// The distinction the mail already draws and the page could not: 7 have a
// payee and can be traced; 9 do not and never will be guessed.
{
    section('B — the two piles');

    ck('the ones with a payee are their own group',
       body.named.count === 7 && body.named.money === 145757.93,
       JSON.stringify({ c: body.named.count, m: body.named.money }));
    ck('  and the nameless ones theirs',
       body.nameless.count === 9 && body.nameless.money === 265518.34,
       JSON.stringify({ c: body.nameless.count, m: body.nameless.money }));

    // The nameless pile is the BIGGER one. It must not be presented as the
    // job, because nothing can be done with it — the actionable pile is
    // smaller and goes first.
    ck('  the nameless pile is the bigger one, and that is the point',
       body.nameless.money > body.named.money,
       'the pile she can act on is the smaller one');

    ck('every named row carries a payee', body.named.rows.every((r) => !!r.payee),
       JSON.stringify(body.named.rows.map((r) => r.payee)));
    ck('  and no nameless row claims one', body.nameless.rows.every((r) => !r.payee),
       JSON.stringify(body.nameless.rows.map((r) => r.payee)));

    // Biggest first inside each pile — a list she reads top-down should start
    // with the money that matters.
    ck('  each pile is sorted biggest first',
       body.named.rows[0].amount === 51000 && body.nameless.rows[0].amount === 200000,
       `${body.named.rows[0].amount} / ${body.nameless.rows[0].amount}`);

    // The containers are the only thread back on a nameless cheque, so they
    // must survive the trip.
    // FOUND BY NAME, NOT BY POSITION. My first version indexed rows[2] and
    // failed — the sort above had already moved it, which is precisely the
    // brittleness a positional index has. A check that breaks when an
    // unrelated amount changes is a check that gets deleted.
    const junk = body.named.rows.find((r) => r.payee === 'Junk Car');
    ck('  the containers named on a cheque come through',
       !!junk && junk.containers.join(',') === 'TCLU6619618,HMMU4741911',
       JSON.stringify(junk && junk.containers));
    ck('  and a cheque that names none says so rather than inventing one',
       (body.named.rows.find((r) => r.payee === 'Calderon Cores') || {}).containers.length === 0,
       'the only thread back is whatever the cheque itself mentions');
}

// ── C — IT WRITES NOTHING ─────────────────────────────────────────────────
// Re-coding changes reported profit. The route must be a read, and the page
// must not offer a button that implies otherwise.
{
    section('C — read-only, and provably so');

    const routes = fs.readFileSync(path.join(ROOT, 'helpers/quickbooks/routes.js'), 'utf8');
    const i = routes.indexOf("app.get('/api/qb/miscoded'");
    const block = routes.slice(i, routes.indexOf('});', i));
    ck('the handler is a GET', i > -1);
    ck('  and does not write, post or update anything',
       !/\b(post|update|create|void|delete|sparse)\b/i.test(block.replace(/\/\/.*$/gm, '')),
       block.slice(0, 200));

    const html = fs.readFileSync(path.join(ROOT, 'dashboard/quickbooks.html'), 'utf8');
    const j = html.indexOf('async function loadMiscoded');
    const fn = html.slice(j, html.indexOf('\n}', j));
    ck('the screen only reads too',
       !/method:\s*'(POST|PUT|DELETE)'/.test(fn), 'no write from this screen');
    ck('  and offers no re-code button',
       !/re-?code/i.test(fn.replace(/\/\*[\s\S]*?\*\//g, '')),
       'that is a write against her books and a decision she has not made');
}

// ── D — THE SCREEN IS REACHABLE ───────────────────────────────────────────
// The failure this whole piece of work is about: something computed with
// nowhere to see it. Three things have to line up or it is invisible again.
{
    section('D — you can actually get to it');

    const html = fs.readFileSync(path.join(ROOT, 'dashboard/quickbooks.html'), 'utf8');
    ck('there is a chip for it', /data-miscoded="1"/.test(html));
    ck('  the chip is dispatched', /chip\.dataset\.miscoded\) loadMiscoded\(\)/.test(html));
    ck('  the loader calls the route', /api\('\/api\/qb\/miscoded'\)/.test(html));
    ck('  and the route exists', /app\.get\('\/api\/qb\/miscoded'/.test(
        fs.readFileSync(path.join(ROOT, 'helpers/quickbooks/routes.js'), 'utf8')));

    // Names and container numbers are her typing, and go into innerHTML.
    const j = html.indexOf('async function loadMiscoded');
    const fn = html.slice(j, html.indexOf('\n}', j));
    // encodeURIComponent COUNTS. It percent-encodes quotes and angle
    // brackets, so a name inside data-open="vendor|${encodeURIComponent(..)}"
    // is safe — and it is the idiom every other table on this page already
    // uses. My first version demanded esc() everywhere and flagged that line,
    // which would have meant double-encoding the name the click handler then
    // decodes. A check that forces a bug is worse than no check.
    const interp = [...fn.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    const risky = interp.filter((x) => /\br\.(payee|date)\b|r\.containers|e\.message/.test(x)
        && !/esc\(/.test(x) && !/encodeURIComponent\(/.test(x));
    ck('every field of hers is escaped for the context it lands in',
       risky.length === 0, risky.join(' | '));
    ck('  the visible cells use esc()',
       /<td>\$\{nameless \? [^}]*: esc\(r\.payee\)\}/.test(fn)
       && /esc\(\(r\.containers \|\| \[\]\)\.join/.test(fn),
       'innerHTML is the dangerous one, and "Carlos G & C" is why');
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { try { server.close(); } catch (x) {} console.error('threw:', e && e.stack); process.exit(1); });
