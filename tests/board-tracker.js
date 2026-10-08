// ── tests/board-tracker.js ────────────────────────────────────────────────
// Apsara, 2026-10-08: shared a tracking-dashboard reel and said "FIT INTO
// JARVIS". The mockup she okayed puts a 7-stage pipeline strip on the Board
// (count per stage, tap to filter) and a 7-dot tracker in each booking row.
//
// SCOPE: the Board screen only (renderBoardView in dashboard/index.html).
// No API change — /api/dashboard already sent stageIndex and stages. Section
// C pins that the risk filter, KPI cards and alert strip still behave as
// before, because CLAUDE.md rule 1 says the change is that screen's new shape
// and nothing else.
//
// END TO END (CLAUDE.md rule 3): a real server, a real login, bookings made
// through the route the Bookings screen posts to, workflow steps set by the
// same helper the WhatsApp flow uses, and the Board drawn by the REAL
// dashboard script from what /api/dashboard actually returns.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-board-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const { updateWorkflow } = require(path.join(ROOT, 'helpers/json'));
const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');

// Mount the real dashboard script and hand it a payload, the way the Board
// tab does: renderBoard(await api('/api/dashboard')).
function mountBoard(payload) {
    const SCRIPT = [...DASH.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const dom = new JSDOM(DASH, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.fetch = () => new Promise(() => {});   // hold boot at its first await
    w.setInterval = () => 0;
    try { w.eval(SCRIPT); } catch (e) { /* boot needs a session; renderers are defined */ }
    w.__payload = payload;
    w.eval('renderBoard(window.__payload)');
    return w;
}
const rowsOf = (d) => [...d.querySelectorAll('#viewRoot .board-stepper')].map((s) => s.closest('.card'));
const bookingNoOf = (row) => (row.textContent.match(/E2EBRD\d/) || [''])[0];

(async () => {

const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
});

try {

// ══════════════════════════════════════════════════════════════════════════
section('A — the route sends what the tracker draws from');
// ══════════════════════════════════════════════════════════════════════════
const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
ck('signed in', !!sid);

// Booking dates are stored MM/DD/YYYY — helpers/time.js daysUntil splits on
// "/" in that order. The first draft of this file wrote ISO dates, every
// deadline read as "none", nothing was high risk, and the risk-filter check
// failed for a reason that had nothing to do with the Board.
const soon = (d) => {
    const t = new Date(Date.now() + d * 86400000);
    return `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}/${t.getFullYear()}`;
};
const FIX = [
    { no: 'E2EBRD1', step: 'picked_up',       cutoff: soon(1),  idx: 5 },
    { no: 'E2EBRD2', step: 'empty_dropped',   cutoff: soon(3),  idx: 3 },
    { no: 'E2EBRD3', step: 'supplier_assigned', cutoff: soon(9), idx: 1 },
    { no: 'E2EBRD4', step: 'done',            cutoff: soon(-2), idx: 6 },
];
for (const f of FIX) {
    const r = await req('POST', '/api/bookings', { sid, body: {
        booking_number: f.no, port_of_loading: 'Los Angeles', port_of_discharge: 'Nhava Sheva', cutoff_date: f.cutoff,
    } });
    ck(`booking ${f.no} created through the route`, r.status === 200 && r.json && r.json.ok, `${r.status} ${JSON.stringify(r.json)}`);
    await updateWorkflow(f.no, { step: f.step });
}

const dash = await req('GET', '/api/dashboard', { sid });
ck('/api/dashboard answers', dash.status === 200 && dash.json && Array.isArray(dash.json.bookings), `${dash.status}`);
const payload = dash.json || { bookings: [], counts: {}, alerts: [] };
ck('it sends seven stage names', Array.isArray(payload.stages) && payload.stages.length === 7, JSON.stringify(payload.stages));
for (const f of FIX) {
    const b = payload.bookings.find((x) => x.bookingNo === f.no) || {};
    ck(`${f.no} (${f.step}) arrives as stage ${f.idx}`, b.stageIndex === f.idx, JSON.stringify(b.stageIndex));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the Board draws a tracker per row and a pipeline strip');
// ══════════════════════════════════════════════════════════════════════════
const w = mountBoard(payload);
const d = w.document;
const rows = rowsOf(d);
ck('one tracker per booking', rows.length === payload.bookings.length, `${rows.length} vs ${payload.bookings.length}`);

for (const f of FIX) {
    const row = rows.find((r) => bookingNoOf(r) === f.no);
    ck(`${f.no} has a row`, !!row);
    if (!row) continue;
    const stepper = row.querySelector('.board-stepper');
    const dots = [...stepper.children].filter((el) => /border-radius:\s*50%/.test(el.getAttribute('style') || ''));
    ck(`  ${f.no}: seven dots`, dots.length === 7, `${dots.length}`);
    const cur = stepper.querySelector('[data-step="current"]');
    if (f.step === 'done') {
        ck('  a completed booking has no "current" dot', !cur);
    } else {
        ck(`  ${f.no}: the current dot is dot ${f.idx + 1}`, cur && dots.indexOf(cur) === f.idx, cur ? `${dots.indexOf(cur)}` : 'none');
    }
    ck(`  ${f.no}: reads "${f.idx + 1}/7"`, row.textContent.includes(`${f.idx + 1}/7`));
    ck(`  ${f.no}: screen readers hear the stage`, new RegExp(`Stage ${f.idx + 1} of 7`).test(stepper.getAttribute('aria-label') || ''), stepper.getAttribute('aria-label'));
}

const stageBtns = [...d.querySelectorAll('#viewRoot .board-stage')];
ck('the pipeline has seven stage buttons', stageBtns.length === 7, `${stageBtns.length}`);
const countAt = (i) => Number((stageBtns[i] && stageBtns[i].querySelector('span') || {}).textContent);
const expectAt = (i) => payload.bookings.filter((b) => b.stageIndex === i).length;
ck('each stage shows how many bookings are there', stageBtns.every((_, i) => countAt(i) === expectAt(i)),
   stageBtns.map((_, i) => `${countAt(i)}/${expectAt(i)}`).join(' '));

// ══════════════════════════════════════════════════════════════════════════
section('C — tapping a stage filters; tapping again clears; risk still works');
// ══════════════════════════════════════════════════════════════════════════
stageBtns[3].click();
let now = rowsOf(d).map(bookingNoOf);
ck('Empty Dropped shows only E2EBRD2', now.length === 1 && now[0] === 'E2EBRD2', JSON.stringify(now));
ck('  and that button is pressed', d.querySelectorAll('#viewRoot .board-stage')[3].getAttribute('aria-pressed') === 'true');

d.querySelectorAll('#viewRoot .board-stage')[3].click();
ck('tapping it again brings every booking back', rowsOf(d).length === payload.bookings.length, `${rowsOf(d).length}`);

d.querySelectorAll('#viewRoot .board-stage')[4].click();
ck('an empty stage says so instead of a blank page', /No bookings in this view/.test(d.getElementById('viewRoot').textContent));
d.querySelectorAll('#viewRoot .board-stage')[4].click();

// Unchanged behaviour: the risk chips and KPI cards.
ck('the fixture really has a high-risk booking (cutoff tomorrow)', (payload.bookings.find((b) => b.bookingNo === 'E2EBRD1') || {}).risk === 'high',
   JSON.stringify((payload.bookings.find((b) => b.bookingNo === 'E2EBRD1') || {}).risk));
const highChip = [...d.querySelectorAll('#viewRoot .board-filter')].find((el) => el.dataset.filter === 'high');
highChip.click();
now = rowsOf(d).map(bookingNoOf);
ck('the High-risk filter still works', now.length && now.every((n) => (payload.bookings.find((b) => b.bookingNo === n) || {}).risk === 'high'), JSON.stringify(now));
ck('  and the pipeline counts follow it', [...d.querySelectorAll('#viewRoot .board-stage')].every((el, i) =>
    Number(el.querySelector('span').textContent) === payload.bookings.filter((b) => b.risk === 'high' && b.stageIndex === i).length));
ck('the KPI cards are still four', d.querySelectorAll('#viewRoot button.card.board-filter').length === 4);
ck('"Needs attention" still lists high-risk bookings', !payload.alerts.length || /Needs attention/.test(d.getElementById('viewRoot').textContent));

// Re-entering the tab starts clean, like the risk filter always has.
w.eval('renderBoard(window.__payload)');
ck('re-opening the Board clears the stage filter', rowsOf(d).length === payload.bookings.length);

// Old payloads without `stages` still draw seven named stages.
const w2 = mountBoard({ ...payload, stages: undefined });
ck('a payload without stage names still draws seven stages', w2.document.querySelectorAll('#viewRoot .board-stage').length === 7);

} finally {
    server.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
