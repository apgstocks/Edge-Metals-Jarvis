// ── tests/workspace-e2e.js ────────────────────────────────────────────────
// CLAUDE.md: "test features end to end with a real server" (paid-via.js F).
// tests/workspace.js drives the page against canned answers, which proves the
// page agrees with MY ASSUMPTIONS about the routes. This drives the page
// against the real routes, real stores and a real login, then follows one
// posting across both tabs: Banking -> Post -> the same line in Transactions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (l, ok, d) => { if (ok) { pass += 1; console.log('  PASS  ' + l); } else { fail += 1; failures.push(l); console.log('  FAIL  ' + l); if (d) console.log('        ' + d); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-wse2e-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-tx.json');
process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json');
process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const row = (o) => ({ id: 'r1', date: '2026-10-07', desc: 'External transfer fee - Next Day - 10/06/2026', party: '', spent: 5, received: 0, amount: 5,
    direction: 'out', bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false, matched: null, history: [], ...o });
fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify([
    row({ id: 'fee1' }),
    row({ id: 'owner1', date: '2026-10-06', desc: 'Zelle to owner', spent: 900, amount: 900 }),
]));
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const { JSDOM } = require('jsdom');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const raw = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let txt = ''; res.on('data', (c) => { txt += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: txt, type: res.headers['content-type'] || '' }));
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    try {
        const login = await raw('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } });
        const sid = (JSON.parse(login.text) || {}).sid;
        ck('signed in as admin', !!sid);

        section('A — the page is served');
        const pg = await raw('GET', '/workspace', { sid });
        ck('GET /workspace returns the page', pg.status === 200 && /html/.test(pg.type) && /<title>Workspace/.test(pg.text), `${pg.status} ${pg.type}`);

        const requested = [];
        const dom = new JSDOM(pg.text, { runScripts: 'dangerously', url: base + '/workspace', beforeParse: (w) => {
            w.fetch = async (u, o) => {
                requested.push(String(u).split('?')[0]);
                const r = await raw((o && o.method) || 'GET', String(u), { body: o && o.body ? JSON.parse(o.body) : null, sid });
                let j = null; try { j = JSON.parse(r.text); } catch (e) { j = { error: 'bad response' }; }
                return { ok: r.status < 400, status: r.status, json: async () => j };
            };
            w.confirm = () => true;
        } });
        await wait(400);
        const d = dom.window.document, w = dom.window;

        section('B — Banking over the real routes');
        const ids = [...d.querySelectorAll('#banking .rowwrap')].map((r) => r.dataset.id);
        ck('both seeded withdrawals are in For review', ids.includes('fee1') && ids.includes('owner1'), ids.join() + ' | ' + d.getElementById('banking').textContent.slice(0, 160));
        const box = d.querySelector('[data-id="fee1"] [data-cat]');
        ck('the fee line is offered the category box with Bank charges suggested', !!box && box.querySelector('[data-cat-sel]').value === '6200');

        // The company must come from the row ("Edge Metals INC"), so no extra question.
        box.querySelector('[data-cat-sel]').dispatchEvent(new w.Event('change', { bubbles: true }));
        await wait(200);
        ck('the REAL preview says what Post will book', /Dr 6200/.test(box.querySelector('[data-cat-effect]').textContent) && /Cr 1010/.test(box.querySelector('[data-cat-effect]').textContent), box.querySelector('[data-cat-effect]').textContent);
        box.querySelector('[data-cat-post]').click();
        await wait(500);
        const left = [...d.querySelectorAll('#banking .rowwrap')].map((r) => r.dataset.id);
        ck('after Post the line has left For review', !left.includes('fee1') && left.includes('owner1'), left.join());
        d.querySelector('[data-sub="posted"]').click();
        ck('  and is under Categorised, booked to 6200', /6200/.test(d.getElementById('banking').textContent) && /External transfer fee/.test(d.getElementById('banking').textContent), d.getElementById('banking').textContent.slice(0, 200));

        section('C — the same posting appears in Transactions (the join a mock cannot prove)');
        d.querySelector('[data-top="register"]').click();
        await wait(500);
        const co = d.getElementById('regCo');
        ck('the company list came from /api/books', co.options.length >= 2, String(co.options.length));
        co.value = 'edge-metals';
        d.getElementById('regAcct').value = '6200';
        d.getElementById('regAcct').dispatchEvent(new w.Event('change'));
        await wait(600);
        const reg = d.getElementById('register').textContent;
        ck('the Bank charges register shows the $5.00 line Post just made', /Bank charges/.test(reg) && /5\.00/.test(reg) && /bank-entry|External transfer fee/.test(reg), reg.slice(0, 300));
        ck('  closing balance is $5.00', /Closing balance\s*\$5\.00/.test(reg), reg.slice(0, 200));

        section('D — Undo takes it back out of the books');
        d.querySelector('[data-top="banking"]').click();
        d.querySelector('[data-sub="posted"]').click();
        const undo = d.querySelector('[data-uncat]');
        ck('Undo is offered on the posted line', !!undo);
        undo.click();
        await wait(500);
        d.querySelector('[data-top="register"]').click();
        d.getElementById('regAcct').dispatchEvent(new w.Event('change'));
        await wait(600);
        ck('the register no longer has the line', !/External transfer fee/.test(d.getElementById('register').textContent), d.getElementById('register').textContent.slice(0, 200));
        d.querySelector('[data-top="banking"]').click();
        d.querySelector('[data-sub="review"]').click();
        ck('the line is back in For review', !!d.querySelector('[data-id="fee1"]'));

        section('E — Exclude and Put back, for real');
        d.querySelector('[data-id="owner1"] [data-excl-why]').value = 'owner draw';
        d.querySelector('[data-id="owner1"] [data-excl-go]').click();
        await wait(500);
        ck('excluded: gone from For review', !d.querySelector('[data-id="owner1"]'));
        d.querySelector('[data-sub="aside"]').click();
        ck('  listed under Excluded with the reason', /Zelle to owner/.test(d.getElementById('banking').textContent) && /owner draw/.test(d.getElementById('banking').textContent), d.getElementById('banking').textContent.slice(0, 200));
        d.querySelector('[data-include]').click();
        await wait(500);
        d.querySelector('[data-sub="review"]').click();
        ck('Put back returns it to For review', !!d.querySelector('[data-id="owner1"]'));

        section('F — and it stayed inside its lane');
        const bad = requested.filter((u) => /quickbooks|\/api\/qb|plaid\/(exchange|sync)/i.test(u));
        ck('nothing it called is a QuickBooks or bank-link route', bad.length === 0, bad.join());
        ck('  it made real requests', requested.length > 8, String(requested.length));
        const rows = JSON.parse(fs.readFileSync(process.env.BANK_TX_FILE, 'utf8'));
        ck('the bank store has no duplicate or lost rows', rows.length === 2 && new Set(rows.map((r) => r.id)).size === 2, String(rows.length));
    } finally {
        server.close();
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) failures.forEach((f) => console.log('    · ' + f));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
