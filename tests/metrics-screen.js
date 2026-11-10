// tests/metrics-screen.js — the Metrics screen END TO END (CLAUDE.md rule 3): stores written the way the app writes them, a real server, the
// real page in JSDOM whose fetch goes to that server, the figures read back off the screen. Read-only; admin only; hostile text is escaped.
const fs = require('fs'), os = require('os'), http = require('http'), path = require('path');
const { JSDOM } = require('jsdom');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-metscreen-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc'; process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config is not isolated'); process.exit(1); }
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const J = (f, o) => fs.writeFileSync(path.join(TMP, f), JSON.stringify(o));
(async () => {
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); }); });
        r2.on('error', reject); if (data) r2.write(data); r2.end(); });
    const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
    const adminSid = await login(process.env.ADMIN_PASSWORD), userSid = await login(process.env.APP_PASSWORD);
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/metrics.html'), 'utf8');
    const open = async (sid) => { const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + '/metrics', beforeParse: (w) => {
        w.fetch = async (u, o) => fetch(base + u, { ...(o || {}), headers: { ...((o || {}).headers || {}), Authorization: `Bearer ${sid}` } }); } });
        await settle(400); return dom; };

    console.log('\n=== nothing saved yet ===');
    let dom = await open(adminSid), doc = dom.window.document;
    ck('the page is served', (await req('GET', '/metrics', { sid: adminSid })).status === 200);
    ck('four cards render even with nothing recorded', doc.querySelectorAll('.card').length === 4, String(doc.querySelectorAll('.card').length));
    ck('learner off is said, not shown as 0%', /off/.test(doc.querySelector('.card .big').textContent) && !/0%/.test(doc.querySelector('.card .big').textContent));
    ck('no history: the table is empty and the "no saved days" note shows', doc.querySelectorAll('#rows tr').length === 0 && doc.getElementById('empty').style.display !== 'none');

    console.log('\n=== with stores and history ===');
    J('auto_applied.json', { entries: [{ depositId: 'a', placedBy: 'jarvis-auto', undone: null }, { depositId: 'b', placedBy: 'jarvis-auto', undone: { at: 'x' } }], blocks: [],
        asks: [{ id: 1, answer: { kind: 'yes' } }, { id: 2, answer: { kind: 'no' } }, { id: 3, answer: null }] });
    J('price_watch.json', { seen: {}, asks: [{ id: 1, answer: { kind: 'normal' } }, { id: 2, answer: { kind: 'check' } }, { id: 3, answer: null }] });
    const line = (day, agr, hostile) => JSON.stringify({ day: hostile || day, at: day, learner: agr == null ? null : { judged: 10, abstained: 2, abstain_pct: 20, compared: 8, agree: 6, agreement_pct: agr },
        deposits: { undo_pct: 50 }, prices: { check_pct: 50 }, ai: { day, calls: 4, failed: 1, fail_pct: 25, usd_est: 0.01 } });
    fs.writeFileSync(path.join(TMP, 'metrics.jsonl'), [line('2026-11-08', 70), line('2026-11-09', 80), line('2026-11-10', null, '<img src=x onerror=window.__pwned=1>')].join('\n') + '\n');
    dom = await open(adminSid); doc = dom.window.document;
    const cards = [...doc.querySelectorAll('.card')].map((c) => c.textContent);
    ck('deposits card: 2 answered, 1 yes, 1 no, 1 waiting, auto-placed 2, undone 1', /2 answered/.test(cards[1]) && /1 yes, 1 no, 1 waiting/.test(cards[1]) && /auto-placed 2, you undid 1/.test(cards[1]), cards[1]);
    ck('prices card: 2 answered, 1 normal, 1 check, 1 waiting', /2 answered/.test(cards[2]) && /1 normal, 1 check, 1 waiting/.test(cards[2]), cards[2]);
    const rows = [...doc.querySelectorAll('#rows tr')];
    ck('three saved days, newest first', rows.length === 3 && /^<img/.test(rows[0].cells[0].textContent) && rows[2].cells[0].textContent === '2026-11-08');
    ck('the change in agreement is shown with its sign (+10)', rows[1].cells[2].textContent === '+10', rows[1].cells[2].textContent);
    ck('the oldest day has no change (n/a), and a learner-off day shows n/a not 0%', rows[2].cells[2].textContent === 'n/a' && rows[0].cells[1].textContent === 'n/a');
    ck('a hostile day string is text, not markup, and nothing ran', !doc.querySelector('#rows img') && !dom.window.__pwned && rows[0].cells[0].textContent.includes('onerror'));
    ck('the empty-history note is hidden once there is history', doc.getElementById('empty').style.display === 'none');

    console.log('\n=== admin only ===');
    dom = await open(userSid); doc = dom.window.document;
    ck('a non-admin sees an error chip and no figures', /only an admin/.test(doc.getElementById('chip').textContent) && doc.querySelectorAll('.card').length === 0, doc.getElementById('chip').textContent);

    console.log('\n=== read-only ===');
    const files = ['auto_applied.json', 'price_watch.json', 'metrics.jsonl'], b4 = files.map((f) => fs.readFileSync(path.join(TMP, f), 'utf8'));
    await open(adminSid); await req('GET', '/api/metrics', { sid: adminSid });
    ck('opening the screen wrote nothing', files.every((f, i) => fs.readFileSync(path.join(TMP, f), 'utf8') === b4[i]));
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
