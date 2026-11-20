// ── tests/inventory-metal-split.js — Inventory split into Ferrous / Non-ferrous / Unsorted ──
//
// Apsara, 2026-11-20: "Ferrous / non-ferrous split in reports ... per day already there, just do Fe / Non Fe
// thing", for the website Inventory screen and the trial copies (same dashboard files). The website asks for
// ?split=metal; every OTHER caller (phone app, PDF / Excel exports, nightly PDF, Scout) must get exactly what it
// got before (CLAUDE.md rule 1). A name nobody has answered for is "unsorted", its own line, never ferrous.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invmetal-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || 'jarvis-pw-dddddddddddd';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config is not isolated'); process.exit(1); }

const line = (description, net, price = 0.1) => ({ description, gross_weight: net + 100, tare_weight: 100, net_weight: net, price, amount: Math.round(net * price * 100) / 100 });
const LOADS = [
    { id: 'EDGE_01', date: '2026-11-10', seller: 'Randy', net_weight: 3000, amount: 300, items: [line('Rotors', 2000), line('Copper wire', 1000, 3)] },
    { id: 'EDGE_02', date: '2026-11-10', seller: 'Fred',  net_weight: 500,  amount: 50,  items: [line('Mystery pile', 500)] },
    { id: 'EDGE_03', date: '2026-11-11', seller: 'Randy', net_weight: 4000, amount: 400, items: [line('Rotors', 4000)] },
];
const SALES = [{ id: 'OUT_01', date: '2026-11-12', buyer: 'Gulf', items: [line('Rotors', 1500)] }];
fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify(LOADS));
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, JSON.stringify(SALES));

(async () => {
    const IM = require(path.join(ROOT, 'helpers', 'itemMetal'));
    await IM.remember('Rotors', 'ferrous');
    await IM.remember('Copper wire', 'non-ferrous');           // "Mystery pile" is left unanswered on purpose
    const { getInventoryReport, loadLoads } = require(path.join(ROOT, 'helpers', 'loads'));
    const row = (rep, d) => (rep.byType || []).find((g) => g.description === d) || {};

    section('A — every other caller is unchanged');
    const plain = getInventoryReport(loadLoads(), {});
    const split = getInventoryReport(loadLoads(), { metalSplit: true });
    ck('without the flag there is no metal field anywhere', plain.metalAvailable === undefined && plain.byMetal === undefined && plain.byType.every((g) => g.metal === undefined) && plain.byDay.every((d) => d.metal === undefined));
    const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.metalAvailable; delete c.byMetal; c.byType.forEach((g) => { delete g.metal; }); c.byDay.forEach((d) => { delete d.metal; }); return c; };
    let same = true; try { assert.deepStrictEqual(strip(split), strip(plain)); } catch (e) { same = false; }   // both through JSON, so a key set to undefined is not a difference
    ck('with the flag, everything ELSE in the report is identical (flag only adds)', same);
    const planRange = getInventoryReport(loadLoads(), { from: '2026-11-10', to: '2026-11-10' });
    ck('a date range without the flag: still no metal fields', planRange.byMetal === undefined && planRange.byType.every((g) => g.metal === undefined));

    section('B — rows and totals');
    ck('Rotors is ferrous, Copper wire non-ferrous', row(split, 'Rotors').metal === 'ferrous' && row(split, 'Copper wire').metal === 'non-ferrous');
    ck('a name nobody answered for is UNSORTED, never ferrous', row(split, 'Mystery pile').metal === 'unsorted');
    ck('whole history: ferrous 6,000 in, 1,500 shipped, 4,500 on hand', split.byMetal.ferrous.net === 6000 && split.byMetal.ferrous.shipped === 1500 && split.byMetal.ferrous.onHand === 4500, JSON.stringify(split.byMetal.ferrous));
    ck('non-ferrous 1,000 in; unsorted 500 in', split.byMetal['non-ferrous'].net === 1000 && split.byMetal.unsorted.net === 500, JSON.stringify(split.byMetal));
    ck('the three lines add up to the whole', split.byMetal.ferrous.net + split.byMetal['non-ferrous'].net + split.byMetal.unsorted.net === split.byType.reduce((t, g) => t + g.net, 0));
    ck('amount splits too (ferrous 600, non-ferrous 3,000)', split.byMetal.ferrous.amount === 600 && split.byMetal['non-ferrous'].amount === 3000, JSON.stringify([split.byMetal.ferrous.amount, split.byMetal['non-ferrous'].amount]));
    const dated = getInventoryReport(loadLoads(), { from: '2026-11-10', to: '2026-11-11', periodStock: true, metalSplit: true });
    ck('with a date range and stock: ferrous shipped is 0 inside 11/10–11/11 and on hand is 6,000', dated.byMetal.ferrous.shipped === 0 && dated.byMetal.ferrous.onHand === 6000, JSON.stringify(dated.byMetal.ferrous));
    await IM.remember('Mystery pile', 'ferrous');
    ck('answering for it later moves it: 500 leaves unsorted and joins ferrous', (() => { const r = getInventoryReport(loadLoads(), { metalSplit: true }); return r.byMetal.unsorted.net === 0 && r.byMetal.ferrous.net === 6500; })());
    await IM.forget('Mystery pile');
    ck('Unsorted again when the answer is taken back', getInventoryReport(loadLoads(), { metalSplit: true }).byMetal.unsorted.net === 500);
    await IM.remember('ROTORS!', 'ferrous');
    ck('a spelling that differs only by case or punctuation is the same item', IM.keyOf('ROTORS!') === IM.keyOf('Rotors'));

    section('C — per day');
    const d10 = split.byDay.find((d) => d.date === '2026-11-10'), d11 = split.byDay.find((d) => d.date === '2026-11-11');
    ck('11/10: ferrous 2,000 · non-ferrous 1,000 · unsorted 500', d10.metal.ferrous === 2000 && d10.metal['non-ferrous'] === 1000 && d10.metal.unsorted === 500, JSON.stringify(d10));
    ck('11/11: ferrous 4,000 only', d11.metal.ferrous === 4000 && d11.metal['non-ferrous'] === 0 && d11.metal.unsorted === 0, JSON.stringify(d11));
    ck('the existing per-day figures did not move', d10.net === 3500 && d10.loadCount === 2 && d11.net === 4000);

    section('D — the screens');
    const web = fs.readFileSync(path.join(ROOT, 'dashboard', 'app', '02-dashboard-bookings.js'), 'utf8');
    const render = web.slice(web.indexOf('async function renderInventory'), web.indexOf('async function renderInventory') + 900);
    ck('the website Inventory tab asks for split=metal', /params\.set\('split', 'metal'\)/.test(render));
    const auto = web.slice(web.indexOf('async function inventoryAutoRefresh'), web.indexOf('async function inventoryAutoRefresh') + 1000);
    ck('…and so does its 30-second refresh (or the tab would repaint every 30 s)', /params\.set\('split', 'metal'\)/.test(auto));
    ck('the Type column and the Ferrous / Non-ferrous / Unsorted per-day columns only show when the report has them', /data\.metalAvailable \? '<th[^']*>Type<\/th>'/.test(web) && /data\.metalAvailable \? '<th[^']*>Ferrous<\/th>/.test(web));
    ck('the open-a-row line count follows the extra column', /\(stockCols \? 9 : 7\) \+ \(data\.metalAvailable \? 1 : 0\)/.test(web));
    const phone = ['13-inventory.js', '11-reports.js'].map((f) => fs.readFileSync(path.join(ROOT, 'mobile-app', 'www', 'app', f), 'utf8')).join('\n');
    ck('the phone app does not ask (website only)', !/split=metal|'split', 'metal'/.test(phone));
    const routes = fs.readFileSync(path.join(ROOT, 'routes', 'loads.js'), 'utf8');
    const exportSrc = routes.slice(routes.indexOf("'/api/loads/inventory/export.xlsx'"), routes.indexOf("'/api/loads/inventory/export.pdf'") + 700);
    ck('the Excel and PDF exports do not ask for it', !/metalSplit/.test(exportSrc));

    section('E — END TO END through the routes the screen uses');
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((res) => { const s = createApi().listen(0, '127.0.0.1', () => res(s)); });
    const port = server.address().port;
    const req = (method, p2, body, sid) => new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null; const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = 'Bearer ' + sid;
        const rq = http.request({ host: '127.0.0.1', port, path: p2, method, headers }, (x) => { let raw = ''; x.on('data', (ch) => { raw += ch; }); x.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { /* */ } resolve({ status: x.statusCode, json, raw }); }); });
        rq.on('error', () => resolve({ status: 0 })); if (data) rq.write(data); rq.end();
    });
    try {
        const login = async (pw) => ((await req('POST', '/login', { password: pw })).json || {}).sid;
        const sid = await login(process.env.ADMIN_PASSWORD), staff = await login(process.env.STAFF_PASSWORD);
        ck('signed in as manager and as staff', !!sid && !!staff);
        const get = (q, who = sid) => req('GET', '/api/loads/inventory' + q, null, who).then((r) => r.json || {});
        const before = await get('?split=metal');
        const mk = (items) => req('POST', '/api/loads', { date: '2026-11-13', seller: 'E2E', items, created_by: 'test' }, sid);
        const it = (description, extra = {}) => ({ description, gross_weight: 10100, tare_weight: 100, price: 0.2, unit: 'lb', ...extra });
        await mk([it('Rotors', { metal_type: 'ferrous' })]);
        await mk([it('Brass keys', { metal_type: 'non-ferrous' })]);
        await mk([it('Odd lot')]);                                   // a caller with no type, name never answered
        const after = await get('?split=metal');
        const d = (k) => (after.byMetal[k].net - before.byMetal[k].net);
        ck('a ferrous load moves ONLY ferrous (+10,000)', d('ferrous') === 10000, d('ferrous'));
        ck('a non-ferrous load moves ONLY non-ferrous (+10,000)', d('non-ferrous') === 10000, d('non-ferrous'));
        ck('a load with no type lands in Unsorted (+10,000), not in either metal', d('unsorted') === 10000, d('unsorted'));
        ck('the new day shows 10,000 in each of the three', (() => { const x = (after.byDay.find((y) => y.date === '2026-11-13') || {}).metal || {}; return x.ferrous === 10000 && x['non-ferrous'] === 10000 && x.unsorted === 10000; })());
        const set = await req('PUT', '/api/item-maintenance/metal', { name: 'Odd lot', metal_type: 'non-ferrous' }, sid);
        ck('Item maintenance answers for it', set.status === 200);
        const moved = await get('?split=metal');
        ck('…and the SCREEN\'S figure moves it from Unsorted to non-ferrous', moved.byMetal.unsorted.net === after.byMetal.unsorted.net - 10000 && moved.byMetal['non-ferrous'].net === after.byMetal['non-ferrous'].net + 10000);
        const asked = await get('?split=metal&from=2026-11-13&to=2026-11-13&stock=period');
        ck('with the dates and stock the screen sends, the split is there', asked.metalAvailable === true && asked.periodAvailable === true && asked.byMetal.ferrous.net === 10000, JSON.stringify(asked.byMetal));
        const asStaff = await get('?split=metal', staff);
        ck('staff can read it (same reach as the rest of Inventory)', asStaff.metalAvailable === true);
        const phoneLike = await get('');
        ck('the phone app\'s request (no flag) has no split', phoneLike.metalAvailable === undefined && phoneLike.byMetal === undefined);
        const xlsx = await new Promise((resolve) => { const rq = http.request({ host: '127.0.0.1', port, path: '/api/loads/inventory/export.xlsx?split=metal', method: 'GET', headers: { Authorization: 'Bearer ' + sid } }, (x) => { x.resume(); x.on('end', () => resolve(x.statusCode)); }); rq.on('error', () => resolve(0)); rq.end(); });
        ck('the Excel export still downloads when the flag is passed to it', xlsx === 200, xlsx);
    } finally { server.close(); }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* runner cleans tmp */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
