// ── tests/po-print.js — Print PO from a load or a sale ────────────────────
// Apsara, 2026-11-17: "for now print it in load/sale" (phone app AND website).
// Nothing is saved but the PO counter. Sections:
//   A  the server's sheet is the website's sheet (generated copy cannot drift)
//   B  the record -> PO mapping (units, amounts, sale reads the other way)
//   C  numbering: PO-YYMMDD-001, counted per issuing company
//   D  end to end: real server, login, the routes the buttons call
//   E  both clients: the button is there and the click does the right thing
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-poprint-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config not isolated'); process.exit(1); }

const S = require('../helpers/poSheet');
const R = require('../helpers/poFromRecord');
const N = require('../helpers/poNumbers');
const ACCOUNTS = [
    { id: 'edge-metals-bofa', company: 'Edge Metals INC', address: '14750 Devonshire Ln, Frisco, TX 75035' },
    { id: 'edge-trading-chase', company: 'EDGE TRADING INC', address: '2453 E 25th Street, Los Angeles, CA 90058' },
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    // ═════════ A ═════════
    section('A — the server sheet is the website sheet');
    {
        const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'dashboard', 'documents.html'), 'utf8'), {
            runScripts: 'dangerously', url: 'http://localhost/',
            beforeParse(w) { w.fetch = () => new Promise(() => {}); w.alert = () => {}; w.confirm = () => true; },
        });
        await wait(300);
        const w = dom.window;
        const line = (o) => Object.assign({ n: 1, desc: 'Copper birch/cliff', qty: 12.3456, unit: 'MT', price: 1.5, price2: 1.2, ok: true, amountCents: 1852, amount2Cents: 1481 }, o);
        const base = { company: 'Edge Metals INC', companyAddress: '14750 Devonshire Ln, Frisco, TX', supplier: 'Ray <b>Scrap</b>', supplierAddress: 'Ray <b>Scrap</b>\n12 Yard Rd', shipTo: 'Edge Yard\n2453 E 25th Street',
            number: 'PO-261117-001', date: '11/17/2026', required: '11/30/2026', terms: 'Net 7', otherCents: 500, otherText: '5', notes: 'Call first', signer: 'Chandra Bose', signatureImg: 'data:image/png;base64,AAAA',
            lines: [line(), line({ n: 2, desc: 'Brass', qty: 1000, unit: 'LB' })], subtotalCents: 3704, totalCents: 4204, two: false, labelA: 'Clean', labelB: 'Dirty', subtotal2Cents: 2962, total2Cents: 3462 };
        const cases = { 'single price': base, 'two prices': Object.assign({}, base, { two: true }), 'no signature, other company': Object.assign({}, base, { company: 'EDGE TRADING INC', signatureImg: '' }), 'empty': Object.assign({}, base, { lines: [], supplier: '', company: '' }) };
        for (const [name, d] of Object.entries(cases)) {
            w.__d = JSON.parse(JSON.stringify(d));
            ck(`${name}: same HTML`, w.eval('poSheetHtml(__d)') === S.poSheetHtml(d));
        }
        ck('same CSS', w.eval('poSheetCss()') === S.poSheetCss());
        ck('same money / price / qty formatting', w.eval('[poMoney(123456), poPrice(1.5), poQty(12.3456)].join("|")') === [S.poMoney(123456), S.poPrice(1.5), S.poQty(12.3456)].join('|'));
        ck('a typed < is escaped on the server sheet', !/Ray <b>/.test(S.poSheetHtml(base)) && /Ray &lt;b&gt;/.test(S.poSheetHtml(base)));
    }

    // ═════════ B ═════════
    section('B — a load or sale becomes a PO');
    {
        const item = (o) => Object.assign({ description: 'Copper', net_weight: 22046.2, price: 3, unit: '', amount: 66138.6, pieces: null }, o);
        const load = { id: 'L1', date: '2026-11-17', seller: 'Ray Scrap', seller_address: 'Ray Scrap\n12 Yard Rd', buyer: 'Edge Trading', items: [
            item({}), item({ description: 'Alu', unit: 'mt', net_weight: 22046.2, price: 2000, amount: 20000 }), item({ description: 'Steel', unit: 'nt', net_weight: 4000, price: 100, amount: 200 }),
            item({ description: 'Iron', unit: 'gt', net_weight: 4480, price: 50, amount: 100 }), item({ description: 'Motor', unit: 'piece', net_weight: 0, pieces: 7, price: 10, amount: 70 }), item({ description: 'Unpriced', price: null, amount: null })] };
        const d = R.buildPoData('purchase', load, ACCOUNTS, { number: 'PO-261117-001', signatureImg: 'SIG' });
        ck('issuer is Edge Trading with its Bank-tab address', d.company === 'EDGE TRADING INC' && /2453 E 25th/.test(d.companyAddress));
        ck('vendor is the seller', d.supplier === 'Ray Scrap' && /12 Yard Rd/.test(d.supplierAddress));
        ck('delivered to the yard', /^Edge Yard\n2453 E 25th/.test(d.shipTo));
        ck('an unpriced row is left off', d.lines.length === 5, String(d.lines.length));
        ck('per lb: qty is the net pounds, unit LB', d.lines[0].unit === 'LB' && d.lines[0].qty === 22046.2);
        ck('per MT: qty in MT', d.lines[1].unit === 'MT' && Math.abs(d.lines[1].qty - 10) < 1e-6, String(d.lines[1].qty));
        ck('per net ton: qty / 2000', d.lines[2].unit === 'Net ton' && d.lines[2].qty === 2);
        ck('per gross ton: qty / 2240', d.lines[3].unit === 'Gross ton' && d.lines[3].qty === 2);
        ck('per piece: the count', d.lines[4].unit === 'PCS' && d.lines[4].qty === 7);
        ck('amounts are the record\'s own, in cents', d.lines[0].amountCents === 6613860 && d.totalCents === 6613860 + 2000000 + 20000 + 10000 + 7000, String(d.totalCents));
        ck('no signature image for Edge Trading', d.signatureImg === '');
        const em = R.buildPoData('purchase', Object.assign({}, load, { buyer: 'Edge Metals' }), ACCOUNTS, { signatureImg: 'SIG' });
        ck('an Edge Metals purchase uses Edge Metals and Chandra\'s signature', em.company === 'Edge Metals INC' && em.signatureImg === 'SIG');
        const sale = R.buildPoData('sale', { id: 'S1', date: '2026-11-17', buyer: 'Eccomelt', buyer_address: '1 Port Rd', items: [item({})] }, ACCOUNTS, {});
        ck('a sale reads the other way: issuer is the buyer, vendor is Edge Trading', sale.company === 'Eccomelt' && /EDGE TRADING/.test(sale.supplier) && /Eccomelt/.test(sale.shipTo));
        ck('and prints no signature image', sale.signatureImg === '');
        ck('the sheet renders from it', /Ray Scrap/.test(S.poSheetHtml(d)) && /PO-261117-001/.test(S.poSheetHtml(d)));
    }

    // ═════════ C ═════════
    section('C — PO-YYMMDD-001, per company');
    {
        ck('format', N.suggest('Edge Metals INC', '2026-11-17') === 'PO-261117-001');
        ck('reserving steps the count', (await N.reserve('Edge Metals INC', '2026-11-17')) === 'PO-261117-001' && (await N.reserve('Edge Metals', '2026-11-17')) === 'PO-261117-002');
        ck('another company counts apart', N.suggest('EDGE TRADING INC', '2026-11-17') === 'PO-261117-001');
        ck('Edge Yard and Edge Trading are one company, one count', (await N.reserve('Edge Yard', '2026-11-17')) === 'PO-261117-001' && N.suggest('EDGE TRADING INC', '2026-11-17') === 'PO-261117-002');
        ck('a new day starts again at 001', N.suggest('Edge Metals INC', '2026-11-18') === 'PO-261118-001');
        ck('suggesting reserves nothing', N.suggest('Edge Metals INC', '2026-11-17') === 'PO-261117-003' && N.suggest('Edge Metals INC', '2026-11-17') === 'PO-261117-003');
        await N.noteUsed('Edge Metals INC', 'PO-261117-009');
        ck('a number she typed ahead of the count moves the count', N.suggest('Edge Metals INC', '2026-11-17') === 'PO-261117-010');
        await N.noteUsed('Edge Metals INC', 'PO-261117-004');
        ck('and one behind it never moves it back', N.suggest('Edge Metals INC', '2026-11-17') === 'PO-261117-010');
        const ids = await Promise.all(Array.from({ length: 8 }, () => N.reserve('AAA Investment', '2026-11-20')));
        ck('eight at once, eight different numbers', new Set(ids).size === 8, ids.join(','));
    }

    // ═════════ D ═════════
    section('D — end to end through the routes the buttons call');
    const pdfHtml = [];
    const fakePage = new Proxy({}, { get: (t, k) => (k === 'setContent' ? async (h) => { pdfHtml.push(h); }
        : k === 'pdf' ? async () => new Uint8Array(Buffer.from('%PDF-1.4 fake')) : k === 'then' ? undefined : async () => {}) });
    require('../helpers/pdfBrowser').init({ getBrowser: () => ({ isConnected: () => true, newPage: async () => fakePage }) });
    {
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
                const chunks = []; res.on('data', (c) => chunks.push(c));
                res.on('end', () => { const raw = Buffer.concat(chunks); let j = null; try { j = JSON.parse(raw.toString()); } catch (e) {} resolve({ status: res.statusCode, json: j, raw, headers: res.headers }); });
            });
            r2.on('error', reject); if (data) r2.write(data); r2.end();
        });
        const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
        const sid = await login(process.env.ADMIN_PASSWORD);
        const staff = await login(process.env.STAFF_PASSWORD);
        ck('signed in', !!sid && !!staff);

        const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
        await mutateJson(cfg.LOADS_FILE, [], (l) => { const a = Array.isArray(l) ? l : []; a.unshift({ id: 'PO_E2E', date: '2026-11-17', seller: 'Ramesh Metals', seller_address: 'Ramesh Metals\n5 Foundry Ave', buyer: 'Edge Trading',
            items: [{ description: 'Copper', net_weight: 22046.2, price: 3, unit: 'mt', amount: 30000.0 }], amount: 30000 }); return a; });
        await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], (l) => { const a = Array.isArray(l) ? l : []; a.unshift({ id: 'PO_SALE', date: '2026-11-17', buyer: 'Eccomelt', buyer_address: '1 Port Rd',
            items: [{ description: 'Brass', net_weight: 1000, price: 2, unit: '', amount: 2000 }] }); return a; });

        const sug = await req('GET', '/api/po/next-number?kind=purchase&id=PO_E2E', { sid });
        ck('next-number answers with a PO number and the issuing company', sug.status === 200 && /^PO-\d{6}-\d{3}$/.test(sug.json.number) && /EDGE TRADING/.test(sug.json.company), JSON.stringify(sug.json));
        const again = await req('GET', '/api/po/next-number?kind=purchase&id=PO_E2E', { sid });
        ck('asking twice reserves nothing', again.json.number === sug.json.number);
        const gen = await req('POST', '/api/po/from-record', { sid, body: { kind: 'purchase', id: 'PO_E2E', number: sug.json.number } });
        ck('from-record returns a PDF', gen.status === 200 && /application\/pdf/.test(gen.headers['content-type']) && gen.raw.slice(0, 4).toString() === '%PDF', `${gen.status} ${gen.raw.toString().slice(0, 80)}`);
        ck('it names the number in a header', gen.headers['x-po-number'] === sug.json.number);
        const html = pdfHtml[pdfHtml.length - 1] || '';
        ck('the sheet carries the seller, the number and the MT quantity', /Ramesh Metals/.test(html) && html.includes(sug.json.number) && /<td class="r">10<\/td><td>MT<\/td>/.test(html));
        const next = await req('GET', '/api/po/next-number?kind=purchase&id=PO_E2E', { sid });
        ck('using the number moved the count on', next.json.number !== sug.json.number);
        const auto = await req('POST', '/api/po/from-record', { sid, body: { kind: 'purchase', id: 'PO_E2E' } });
        ck('with no number typed the server reserves the next one', auto.status === 200 && auto.headers['x-po-number'] === next.json.number, String(auto.headers['x-po-number']));
        const sale = await req('POST', '/api/po/from-record', { sid, body: { kind: 'sale', id: 'PO_SALE' } });
        ck('a sale prints too, from the outbound store', sale.status === 200 && /Eccomelt/.test(pdfHtml[pdfHtml.length - 1]), String(sale.status));
        ck('unknown load: 404', (await req('POST', '/api/po/from-record', { sid, body: { kind: 'purchase', id: 'NOPE' } })).status === 404);
        ck('staff login is refused (admin only, like the BOL)', (await req('POST', '/api/po/from-record', { sid: staff, body: { kind: 'purchase', id: 'PO_E2E' } })).status === 403);
        const files = fs.readdirSync(cfg.DATA_DIR).filter((f) => /po/i.test(f) && !/counters/.test(f) && !/outbound|loads|^po_/i.test(f));
        ck('nothing but the counter was saved', files.length === 0, files.join(','));
        server.close();
    }

    // ═════════ E ═════════
    section('E — both clients');
    {
        const sites = [
            { name: 'website', btn: 'dashboard/app/05-load-pricing.js', code: 'dashboard/app/13-loads-render.js' },
            { name: 'phone app', btn: 'mobile-app/www/app/08-load-modal.js', code: 'mobile-app/www/app/09-loads-deck.js' },
        ];
        for (const s of sites) {
            const btn = fs.readFileSync(path.join(ROOT, s.btn), 'utf8');
            const code = fs.readFileSync(path.join(ROOT, s.code), 'utf8');
            // Apsara 2026-11-19: "remove print po option in loads" (website + phone app).
            // The card must not offer the button; the printing code below is kept.
            ck(`${s.name}: load/sale cards no longer show a Print PO button`, !/btn-print-po"/.test(btn) && !/>Print PO</.test(btn));
            const src = code.slice(code.indexOf('async function printPoFor'));
            const calls = [];
            const delivered = [];
            const b = { dataset: { kind: 'sale', id: 'S9' }, textContent: 'Print PO', disabled: false };
            const env = {
                API_BASE: 'https://api.test', getToken: () => 'TOK', esc: (x) => x,
                api: async (p) => { calls.push(['api', p]); return { number: 'PO-261117-001', company: 'EDGE TRADING INC' }; },
                askText: async (msg, init) => { calls.push(['ask', init]); return 'PO-261117-005'; },
                fetch: async (u, o) => { calls.push(['fetch', u, JSON.parse(o.body), (o.headers || {}).Authorization || null]); return { ok: true, headers: { get: () => 'PO-261117-005' }, blob: async () => ({ size: 9 }), json: async () => ({}) }; },
                deliverExportedFile: async (blob, name, ext) => { delivered.push([name, ext]); },
                alert: (m) => { delivered.push(['ALERT', m]); },
                URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
                document: { createElement: () => ({ click() { delivered.push(['download']); }, remove() {} }), body: { appendChild() {} } },
                setTimeout: () => 0,
            };
            const fn = new Function(...Object.keys(env), src + '\nreturn printPoFor;')(...Object.values(env));
            await fn(b);
            const f = calls.find((c) => c[0] === 'fetch');
            ck(`${s.name}: it asks for the suggested number for THIS record`, calls[0][1] === '/api/po/next-number?kind=sale&id=S9', String(calls[0][1]));
            ck(`${s.name}: the typed number is what is posted, with kind and id`, f && f[2].number === 'PO-261117-005' && f[2].kind === 'sale' && f[2].id === 'S9');
            ck(`${s.name}: it posts to the route`, f && /\/api\/po\/from-record$/.test(f[1]));
            ck(`${s.name}: ${s.name === 'phone app' ? 'goes through API_BASE with the Bearer token' : 'uses the session (no base, no token)'}`, s.name === 'phone app' ? (f[1].startsWith('https://api.test') && f[3] === 'Bearer TOK') : (!f[1].startsWith('http') && f[3] === null));
            ck(`${s.name}: the file is handed over`, s.name === 'phone app' ? delivered.some((x) => x[0] === 'PO-261117-005.pdf' && x[1] === 'pdf') : delivered.some((x) => x[0] === 'download'));
            ck(`${s.name}: the button is back to normal`, b.disabled === false && b.textContent === 'Print PO');
            // cancelling asks for nothing
            calls.length = 0;
            env.askText = async () => null;
            const fn2 = new Function(...Object.keys(env), src + '\nreturn printPoFor;')(...Object.keys(env).map((k) => (k === 'askText' ? async () => null : env[k])));
            await fn2(b);
            ck(`${s.name}: Cancel makes no PDF and reserves nothing`, !calls.some((c) => c[0] === 'fetch'));
        }
        const a = fs.readFileSync(path.join(ROOT, 'mobile-app/www/app/09-loads-deck.js'), 'utf8');
        const b2 = fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/src/main/assets/public/app/09-loads-deck.js'), 'utf8');
        const c = fs.readFileSync(path.join(ROOT, 'mobile-app/www/app/08-load-modal.js'), 'utf8');
        const d2 = fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/src/main/assets/public/app/08-load-modal.js'), 'utf8');
        ck('the Android copies match', a === b2 && c === d2);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
