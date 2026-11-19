// ── tests/inventory-period-stock.js — Inventory under a date range shows Shipped and On hand too ──
//
// Apsara, 2026-11-20: with From 11/13 the website showed Rotors 51,990 lb (what came in) while the yard held
// 1,950 — a 50,040 lb sale that week was invisible. "when i give date specific, it is showing me wrong things".
// The website's Inventory tab now asks for ?stock=period and gets, per row: shipped inside the range and on hand
// at the end date. Every OTHER caller (phone app, exports, nightly PDF, Scout) must get exactly what it got before.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-invperiod-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

// Her week, in miniature: rotors bought before and after 11/13, a big sale on 11/18, an older sale, and
// copper that only shipped inside the range.
const line = (description, net, price = 0.13) => ({ description, gross_weight: net + 100, tare_weight: 100, net_weight: net, price, amount: Math.round(net * price * 100) / 100 });
const LOADS = [
    { id: 'EDGE_10', date: '2026-11-02', seller: 'Randy Recycling', items: [line('Rotors', 277515)] },
    { id: 'EDGE_20', date: '2026-11-14', seller: 'Randy Recycling', items: [line('Rotors', 30000)] },
    { id: 'EDGE_21', date: '2026-11-18', seller: 'Fred', items: [line('Rotors', 21990)] },
    { id: 'EDGE_05', date: '2026-10-20', seller: 'Fred', items: [line('Copper wire', 900, 3)] },
];
const SALES = [
    { id: 'OUT_01', date: '2026-11-05', buyer: 'Gulf Export Co', items: [line('Rotors', 277515)] },
    { id: 'OUT_02', date: '2026-11-18', buyer: 'Gulf Export Co', items: [line('Rotors', 50040)] },
    { id: 'OUT_03', date: '2026-11-15', buyer: 'Pacific Metals Buyer', items: [line('Copper wire', 400, 3)] },
];
fs.writeFileSync(cfg.LOADS_FILE, JSON.stringify(LOADS));
fs.writeFileSync(cfg.OUTBOUND_LOADS_FILE, JSON.stringify(SALES));

const { getInventoryReport, loadLoads } = require(path.join(ROOT, 'helpers', 'loads'));
const row = (rep, d) => (rep.byType || []).find((g) => g.description === d) || {};

(async () => {
    section('A — every other caller is unchanged');
    const whole = getInventoryReport(loadLoads(), {});
    ck('whole history: rotors 329,505 in, 327,555 shipped, 1,950 on hand', row(whole, 'Rotors').net === 329505 && row(whole, 'Rotors').shipped === 327555 && row(whole, 'Rotors').onHand === 1950, JSON.stringify(row(whole, 'Rotors')));
    ck('whole history does not claim to be a period', whole.periodAvailable === false && whole.onHandAvailable === true);
    const plain = getInventoryReport(loadLoads(), { from: '2026-11-13' });
    ck('a date range WITHOUT the flag: net in only, as before', row(plain, 'Rotors').net === 51990 && row(plain, 'Rotors').shipped === undefined && row(plain, 'Rotors').onHand === undefined);
    ck('…and says no on-hand, as before', plain.onHandAvailable === false && plain.periodAvailable === false);
    ck('…and no row for a material that only shipped (unchanged)', !plain.byType.some((g) => g.description === 'Copper wire'));

    section('B — the website\'s date range (periodStock)');
    const p = getInventoryReport(loadLoads(), { from: '2026-11-13', periodStock: true });
    const r = row(p, 'Rotors');
    ck('rotors since 11/13: 51,990 came in (unchanged figure)', r.net === 51990, r.net);
    ck('…50,040 shipped in those dates', r.shipped === 50040, r.shipped);
    ck('…and 1,950 on hand today, same as the undated screen', r.onHand === 1950, r.onHand);
    ck('the report says it is a period, ending today', p.periodAvailable === true && p.periodEnd === null && p.onHandAvailable === false);
    const c = row(p, 'Copper wire');
    ck('a material that only SHIPPED in the range gets a row (sale not hidden)', c.net === 0 && c.shipped === 400 && c.onHand === 500, JSON.stringify(c));
    const q = getInventoryReport(loadLoads(), { from: '2026-11-13', to: '2026-11-15', periodStock: true });
    const r2 = row(q, 'Rotors');
    ck('with an end date (11/15): only the 11/14 purchase came in', r2.net === 30000, r2.net);
    ck('…nothing of rotors shipped inside 11/13–11/15', r2.shipped === 0, r2.shipped);
    ck('…on hand ON 11/15 = bought to then minus sold to then (307,515 − 277,515 = 30,000)', r2.onHand === 30000, r2.onHand);
    ck('…and the end date is reported', q.periodEnd === '2026-11-15');
    const undated = JSON.parse(JSON.stringify(LOADS)); undated.push({ id: 'EDGE_30', date: null, seller: 'X', items: [line('Rotors', 1000)] });
    ck('an undated purchase counts toward today\'s on hand…', row(getInventoryReport(undated, { from: '2026-11-13', periodStock: true }), 'Rotors').onHand === 2950);
    ck('…but not toward a past end date (nobody can say it happened before it)', row(getInventoryReport(undated, { from: '2026-11-13', to: '2026-11-15', periodStock: true }), 'Rotors').onHand === 30000);

    section('C — the screens');
    const web = fs.readFileSync(path.join(ROOT, 'dashboard', 'app', '02-dashboard-bookings.js'), 'utf8');
    const render = web.slice(web.indexOf('async function renderInventory'), web.indexOf('async function renderInventory') + 900);
    ck('the website Inventory tab asks for stock=period when dates are set', /if \(invFrom \|\| invTo\) params\.set\('stock', 'period'\)/.test(render));
    const auto = web.slice(web.indexOf('async function inventoryAutoRefresh'), web.indexOf('async function inventoryAutoRefresh') + 900);
    ck('…and so does its 30-second refresh (or the tab would repaint every 30 s)', /params\.set\('stock', 'period'\)/.test(auto));
    ck('the table shows Shipped and On hand for a period', /const stockCols = !!\(data\.onHandAvailable \|\| data\.periodAvailable\)/.test(web) && /\$\{stockCols \?/.test(web));
    const phone = ['13-inventory.js', '11-reports.js'].map((f) => fs.readFileSync(path.join(ROOT, 'mobile-app', 'www', 'app', f), 'utf8')).join('\n');
    ck('the phone app does not ask (website only, as agreed)', !/stock=period|'stock', 'period'/.test(phone));

    section('D — END TO END through the route the website calls');
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((res) => { const s = createApi().listen(0, '127.0.0.1', () => res(s)); });
    const port = server.address().port;
    const req = (method, p2, body, sid) => new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null; const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = 'Bearer ' + sid;
        const rq = http.request({ host: '127.0.0.1', port, path: p2, method, headers }, (x) => { let raw = ''; x.on('data', (ch) => { raw += ch; }); x.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { /* */ } resolve({ status: x.statusCode, json }); }); });
        rq.on('error', () => resolve({ status: 0 })); if (data) rq.write(data); rq.end();
    });
    try {
        const sid = ((await req('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
        ck('signed in', !!sid);
        const withFlag = (await req('GET', '/api/loads/inventory?from=2026-11-13&stock=period', null, sid)).json || {};
        const rr = row(withFlag, 'Rotors');
        ck('the website\'s request: 51,990 in · 50,040 shipped · 1,950 on hand', rr.net === 51990 && rr.shipped === 50040 && rr.onHand === 1950, JSON.stringify(rr));
        const noFlag = (await req('GET', '/api/loads/inventory?from=2026-11-13', null, sid)).json || {};
        ck('the phone app\'s request (no flag) is unchanged', row(noFlag, 'Rotors').net === 51990 && row(noFlag, 'Rotors').onHand === undefined && noFlag.periodAvailable === false);
        const all = (await req('GET', '/api/loads/inventory', null, sid)).json || {};
        ck('no dates: unchanged, 1,950 on hand', row(all, 'Rotors').onHand === 1950 && all.onHandAvailable === true);
    } finally { server.close(); }

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* runner cleans tmp */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
