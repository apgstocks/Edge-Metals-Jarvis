// ── tests/item-metal-maintenance.js — ferrous / non-ferrous in Item maintenance ──
// Apsara, 2026-11-18: "keep this option of ferrous / non-ferrous against each
// item in item maintenance". Each item row on the Settings → Item maintenance
// screen (website AND phone app) gets a Ferrous / Non-ferrous / Unsorted box,
// saved straight to the learned list the load forms use. Saved loads are NOT
// rewritten, so no figure and no issued ticket moves.
//   A  server, end to end through the real routes
//   B  a rename keeps her answer
//   C  both screens: the box shows the saved answer and saves what is picked
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-itemmetalm-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config not isolated'); process.exit(1); }
const M = require('../helpers/itemMetal');

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
        const rq = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
        });
        rq.on('error', reject); if (data) rq.write(data); rq.end();
    });
    const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
    const sid = await login(process.env.ADMIN_PASSWORD);
    const staff = await login(process.env.STAFF_PASSWORD);
    const item = (d, extra) => Object.assign({ description: d, gross_weight: 1000, tare_weight: 0, price: 0.3, unit: 'lb' }, extra || {});
    const mk = (items) => req('POST', '/api/loads', { sid, body: { date: '2026-11-18', seller: 'Hugo', buyer: 'Edge Trading', items, created_by: 'test' } });
    const list = async () => ((await req('GET', '/api/item-maintenance', { sid })).json || {}).items || [];
    const row = async (name) => (await list()).find((i) => i.name.toLowerCase() === name.toLowerCase()) || {};

    section('A — the route');
    {
        const made = await mk([item('Rotors', { metal_type: 'ferrous' }), item('Wire')]);
        ck('loads are on file', made.status === 200 || made.status === 201, made.raw.slice(0, 100));
        ck('the list says what was learned (Rotors: ferrous) and leaves the rest Unsorted (null)', (await row('Rotors')).metal_type === 'ferrous' && (await row('Wire')).metal_type === null);
        const before = JSON.stringify(((await req('GET', '/api/loads', { sid })).json) || []);
        const set = await req('PUT', '/api/item-maintenance/metal', { sid, body: { name: 'Wire', metal_type: 'non-ferrous' } });
        ck('setting Wire to non-ferrous answers with it', set.status === 200 && set.json.metal_type === 'non-ferrous', set.raw.slice(0, 100));
        ck('  the list now shows it', (await row('Wire')).metal_type === 'non-ferrous');
        ck('  the load forms will now be told it (the learned list the dialog reads)', ((await req('GET', '/api/loads/item-metal', { sid })).json || {}).types[M.keyOf('Wire')] === 'non-ferrous');
        ck('  and a caller that cannot ask (voice, Scout, old app) now gets it on a new line', ((((await mk([item('wire')])).json || {}).items || (((await mk([item('wire')])).json || {}).load || {}).items || [])[0] || {}).metal_type === 'non-ferrous');
        ck('saved loads were NOT rewritten (Wire on the first load is still Unsorted)', (() => { try { const all = JSON.parse(before); const l = (Array.isArray(all) ? all : all.loads).find((x) => (x.items || []).some((i) => i.description === 'Wire')); return l.items.find((i) => i.description === 'Wire').metal_type === null; } catch (e) { return false; } })());
        const clr = await req('PUT', '/api/item-maintenance/metal', { sid, body: { name: 'Wire', metal_type: null } });
        ck('choosing Unsorted takes the answer back', clr.status === 200 && (await row('Wire')).metal_type === null);
        ck('anything but ferrous / non-ferrous / empty is refused, not stored', (await req('PUT', '/api/item-maintenance/metal', { sid, body: { name: 'Wire', metal_type: 'metal' } })).status === 400 && (await row('Wire')).metal_type === null);
        ck('an item name is required', (await req('PUT', '/api/item-maintenance/metal', { sid, body: { metal_type: 'ferrous' } })).status === 400);
        ck('staff cannot use it (it lives with Item maintenance: admin only)', (await req('PUT', '/api/item-maintenance/metal', { sid: staff, body: { name: 'Wire', metal_type: 'ferrous' } })).status === 403);
    }

    section('B — a rename keeps her answer');
    {
        await req('PUT', '/api/item-maintenance/metal', { sid, body: { name: 'Rotors', metal_type: 'ferrous' } });
        const r = await req('POST', '/api/item-maintenance/apply', { sid, body: { from: 'Rotors', to: 'Rotor' } });
        ck('the rename goes through', r.status === 200, r.raw.slice(0, 120));
        ck('the new name carries ferrous', (await row('Rotor')).metal_type === 'ferrous');
        await mk([item('Pipe', { metal_type: 'ferrous' }), item('Pipes', { metal_type: 'non-ferrous' })]);
        await req('POST', '/api/item-maintenance/apply', { sid, body: { from: ['Pipe', 'Pipes'], to: 'Piping' } });
        ck('two names that DISAGREED merge to Unsorted, never to a guess', (await row('Piping')).metal_type === null);
        await req('PUT', '/api/item-maintenance/metal', { sid, body: { name: 'Gold', metal_type: 'non-ferrous' } });
        await mk([item('Gold plated')]);
        await req('PUT', '/api/item-maintenance/metal', { sid, body: { name: 'Gold plated', metal_type: 'ferrous' } });
        await req('POST', '/api/item-maintenance/apply', { sid, body: { from: 'Gold', to: 'Gold plated' } }).catch(() => {});
        ck('a rename never overwrites an answer the target already had', (await row('Gold plated')).metal_type === 'ferrous');
    }
    server.close();

    section('C — both screens');
    for (const [label, file, ids] of [
        ['website', 'dashboard/app/03-settings-contacts.js', { rows: 'imRows', hist: 'imHistory', filter: 'imFilter', bar: 'imBar' }],
        ['phone app', 'mobile-app/www/app/14-settings.js', { rows: 'as_im_rows', hist: 'as_im_history', filter: 'as_im_filter', bar: 'as_im_bar' }],
    ]) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const k = src.indexOf('async function renderItemMaintenance');
        const code = src.slice(k, src.indexOf('\n}\n', k) + 3);
        const dom = new JSDOM(`<body><div id="${ids.rows}"></div><div id="${ids.hist}"></div><input id="${ids.filter}"><div id="${ids.bar}"></div>
            <span id="imSelected"></span><span id="as_im_selected"></span><button id="imClear"></button><button id="as_im_clear"></button><button id="imRenameSelected"></button><button id="as_im_rename_selected"></button><button id="imSelectAll"></button><button id="as_im_select_all"></button></body>`, { runScripts: 'outside-only' });
        const w = dom.window; const d = w.document;
        const calls = [];
        let failNext = false;
        w.$ = (id) => d.getElementById(id);
        w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        w.imSelected = new w.Set();
        w.renameItems = async () => false; w.renderItemTypeManager = () => {}; w.loadItemTypeRows = () => {}; w.askYesNo = async () => true;
        w.alert = (m) => calls.push(['alert', m]);
        const items = [
            { name: 'Rotor', spellings: ['Rotor'], metal_type: 'ferrous', inbound: { loads: 1, lines: 1, weight: 10 }, outbound: { loads: 0, lines: 0, weight: 0 }, drafts: { loads: 0, lines: 0, weight: 0 } },
            { name: 'Wire', spellings: ['Wire'], metal_type: null, inbound: { loads: 1, lines: 1, weight: 10 }, outbound: { loads: 0, lines: 0, weight: 0 }, drafts: { loads: 0, lines: 0, weight: 0 } },
        ];
        w.api = async (p, o) => { calls.push([o && o.method || 'GET', p, o && o.body ? JSON.parse(o.body) : null]); if (failNext && /metal/.test(p)) { failNext = false; throw new Error('nope'); } return /metal/.test(p) ? { ok: true } : { items, history: [] }; };
        w.eval(code + '\nwindow.__r = renderItemMaintenance;');
        await w.__r(); await wait(30);
        const sels = [...d.querySelectorAll('select.im-metal')];
        ck(`${label}: every item row has a ferrous box`, sels.length === 2);
        ck(`${label}: it shows the saved answer (Rotor: Ferrous, Wire: Unsorted)`, sels[0].value === 'ferrous' && sels[1].value === '');
        ck(`${label}: it offers exactly Unsorted, Ferrous, Non-ferrous`, [...sels[1].options].map((o) => o.textContent).join('|') === 'Unsorted|Ferrous|Non-ferrous');
        ck(`${label}: the Rename button is still there`, d.querySelectorAll('.btn-im-rename').length === 2);
        sels[1].value = 'non-ferrous'; sels[1].dispatchEvent(new w.Event('change', { bubbles: true })); await wait(30);
        const put = calls.find((c) => c[0] === 'PUT');
        ck(`${label}: choosing Non-ferrous PUTs {name, metal_type} to the route`, put && put[1] === '/api/item-maintenance/metal' && put[2].name === 'Wire' && put[2].metal_type === 'non-ferrous', JSON.stringify(put));
        calls.length = 0;
        sels[0].value = ''; sels[0].dispatchEvent(new w.Event('change', { bubbles: true })); await wait(30);
        ck(`${label}: choosing Unsorted sends null (take the answer back)`, calls.find((c) => c[0] === 'PUT')[2].metal_type === null);
        calls.length = 0; failNext = true;
        const s2 = d.querySelectorAll('select.im-metal')[1];
        s2.value = 'ferrous'; s2.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(60);
        ck(`${label}: a failed save is shown and the list is redrawn from the server`, calls.some((c) => c[0] === 'alert') && calls.filter((c) => c[0] === 'GET').length >= 1);
    }
    ck('the Android copy of the phone screen matches', fs.readFileSync(path.join(ROOT, 'mobile-app/www/app/14-settings.js'), 'utf8') === fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/src/main/assets/public/app/14-settings.js'), 'utf8'));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
