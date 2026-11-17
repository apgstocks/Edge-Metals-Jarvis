// ── tests/po-tab.js — the PO tab beside BOL in the Edge Yard app ──────────
// Apsara, 2026-11-17: "PO not there in docs of mobile app". Same fields as the
// website's Documents → Purchase order tab; nothing saved; PO-YYMMDD-001 per
// company. Sections:
//   A  the server prints the SAME sheet the website form prints, input for input
//   B  end to end: real server, real login, the routes the tab calls
//   C  the tab itself: it renders, it sends what was typed, it shows the answer
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-potab-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config not isolated'); process.exit(1); }

const S = require('../helpers/poSheet');
const F = require('../helpers/poForm');
const SIG = require('../helpers/signature').signatureDataUrl();
const ACCOUNTS = [
    { id: 'edge-metals-bofa', company: 'Edge Metals INC', address: '14750 Devonshire Ln, Frisco, TX 75035', accountNumber: 'X' },
    { id: 'edge-trading-chase', company: 'EDGE TRADING INC', address: '2453 E 25th Street, Los Angeles, CA 90058', accountNumber: 'Y' },
];

(async () => {
    // ═════════ A ═════════
    section('A — the phone route prints the website\'s sheet');
    {
        const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'dashboard', 'documents.html'), 'utf8'), {
            runScripts: 'dangerously', url: 'http://localhost/',
            beforeParse(w) {
                w.fetch = (u) => {
                    const k = String(u).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
                    const body = k === '/api/bank-accounts' ? { accounts: ACCOUNTS } : k === '/api/po/signature' ? { signature: SIG } : k === '/api/address-book' ? [] : { ok: true };
                    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
                };
                w.alert = () => {}; w.confirm = () => true; w.HTMLElement.prototype.scrollIntoView = () => {};
            },
        });
        await wait(700);
        const w = dom.window; const d = w.document; const $ = (id) => d.getElementById(id);
        const set = (id, v, ev) => { $(id).value = v; $(id).dispatchEvent(new w.Event(ev || 'input', { bubbles: true })); };
        d.querySelector('.subtab-btn[data-subtab="po"]').click(); await wait(200);
        const cases = [
            { name: 'one price, freight, Edge Trading', f: { company_id: 'edge-trading-chase', supplier: 'Ray Scrap Co', supplier_address: 'Ray Scrap Co\n12 Yard Rd\nBrea CA', number: 'PO-261117-001', date: '2026-11-17', required: '2026-11-30', terms: 'Net 7', deliver: 'edge-trading-chase', other: '150.5', notes: 'Call first', signer: 'Chandra Bose', two: false,
                lines: [{ desc: 'Copper birch/cliff', qty: '12.345', unit: 'MT', price: '$1,234.5678' }, { desc: 'Brass', qty: '1000', unit: 'LB', price: '1.005' }] } },
            { name: 'two prices, Edge Metals, Chandra signs', f: { company_id: 'edge-metals-bofa', supplier: 'MK Metal', supplier_address: 'MK Metal\n5 Foundry', number: 'PO-261117-002', date: '2026-11-17', required: '', terms: '', deliver: 'edge-metals-bofa', other: '', notes: '', signer: 'Chandra Bose', two: true, label_a: 'Clean', label_b: 'Dirty',
                lines: [{ desc: 'Aluminium', qty: '20', unit: 'Gross ton', price: '1000', price2: '900' }] } },
            { name: 'a deduction, other address', f: { company_id: 'edge-trading-chase', supplier: 'Zed', supplier_address: '', number: 'PO-261117-003', date: '2026-11-17', required: '', terms: 'Net 30', deliver: 'other', ship_to: 'Zed Dock\n1 Pier Rd', other: '-$5', notes: '', signer: 'Someone Else', two: false,
                lines: [{ desc: 'Iron', qty: '3', unit: 'PCS', price: '10' }] } },
        ];
        for (const c of cases) {
            const f = c.f;
            d.querySelector('#poClear') && d.querySelector('#poClear').click();
            set('po_company', f.company_id, 'change');
            set('po_supplier', f.supplier); set('po_supplier_address', f.supplier_address);
            set('po_number', f.number);
            const us = (iso) => (iso ? iso.slice(5, 7) + '/' + iso.slice(8) + '/' + iso.slice(0, 4) : '');
            set('po_date', us(f.date)); set('po_required', us(f.required)); set('po_terms', f.terms);
            set('po_deliver', f.deliver, 'change');
            if (f.deliver === 'other') set('po_shipto', f.ship_to);
            const shipTo = $('po_shipto').value;
            set('po_other', f.other); set('po_notes', f.notes); set('po_signer', f.signer);
            if (f.two) { $('po_two').checked = true; $('po_two').dispatchEvent(new w.Event('change', { bubbles: true })); set('po_label_a', f.label_a); set('po_label_b', f.label_b); }
            else if ($('po_two').checked) { $('po_two').checked = false; $('po_two').dispatchEvent(new w.Event('change', { bubbles: true })); }
            const rows = () => d.querySelectorAll('#poLines .po-line');
            while (rows().length > 1) rows()[rows().length - 1].querySelector('[data-f="remove"]').click();
            f.lines.forEach((l, i) => {
                if (i >= rows().length) w.eval('poAddLine()');
                const row = rows()[i];
                const sf = (k, v) => { const el = row.querySelector(`[data-f="${k}"]`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
                sf('desc', l.desc); sf('qty', l.qty); sf('price', l.price);
                if (f.two) sf('price2', l.price2);
                const u = row.querySelector('[data-f="unit"]'); u.value = l.unit; u.dispatchEvent(new w.Event('change', { bubbles: true }));
            });
            await wait(30);
            const web = w.eval('poSheetHtml(poCollect())');
            const r = F.buildPoFromForm(Object.assign({}, f, { ship_to: shipTo }), ACCOUNTS, SIG);
            ck(`${c.name}: no problems on the server`, r.problems.length === 0, r.problems.join(' | '));
            ck(`${c.name}: the same sheet, byte for byte`, S.poSheetHtml(r.d) === web, '');
        }
        ck('a bad date, no items and no company are all reported', (() => {
            const p = F.buildPoFromForm({ date: '13/45/2026', lines: [{ desc: '', qty: '', price: '' }] }, ACCOUNTS, '').problems.join('|');
            return /issuing/.test(p) && /supplier/i.test(p) && /real date/.test(p) && /at least one item/.test(p) && /delivered/.test(p);
        })());
        ck('a half-filled item is named, not dropped', /Item 1 needs/.test(F.buildPoFromForm({ company_id: 'edge-metals-bofa', supplier: 'x', number: 'n', date: '2026-11-17', ship_to: 'y', lines: [{ desc: 'Cu', qty: '5', price: '' }] }, ACCOUNTS, '').problems.join('|')));
        ck('freight that is not a number is reported, not read as zero', /not a number/.test(F.buildPoFromForm({ other: 'abc', lines: [] }, ACCOUNTS, '').problems.join('|')));
    }

    // ═════════ B ═════════
    section('B — end to end through the routes the tab calls');
    const pdfHtml = [];
    const fakePage = new Proxy({}, { get: (t, k) => (k === 'setContent' ? async (h) => { pdfHtml.push(h); }
        : k === 'pdf' ? async () => new Uint8Array(Buffer.from('%PDF-1.4 fake')) : k === 'then' ? undefined : async () => {}) });
    require('../helpers/pdfBrowser').init({ getBrowser: () => ({ isConnected: () => true, newPage: async () => fakePage }) });
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
            const ch = []; res.on('data', (c) => ch.push(c));
            res.on('end', () => { const raw = Buffer.concat(ch); let j = null; try { j = JSON.parse(raw.toString()); } catch (e) {} resolve({ status: res.statusCode, json: j, raw, headers: res.headers }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const login = async (pw) => ((await req('POST', '/login', { body: { password: pw } })).json || {}).sid;
    const sid = await login(process.env.ADMIN_PASSWORD);
    const staff = await login(process.env.STAFF_PASSWORD);
    {
        const opt = await req('GET', '/api/po/options', { sid });
        ck('options: both companies, both delivery places, the units, the signer', opt.status === 200 && opt.json.companies.length === 2 && opt.json.deliver.some((x) => x.label === 'Edge Yard') && opt.json.units.includes('Gross ton') && opt.json.signer === 'Chandra Bose', JSON.stringify(opt.json).slice(0, 200));
        ck('options never carry account numbers', !/accountNumber|wireRouting|swift/i.test(JSON.stringify(opt.json)));
        const sug = await req('GET', '/api/po/next-number?company_id=edge-metals-bofa&date=2026-11-17', { sid });
        ck('the suggested number is PO-YYMMDD-001 for that day', sug.json && sug.json.number === 'PO-261117-001', JSON.stringify(sug.json));
        ck('an unknown company is a 404', (await req('GET', '/api/po/next-number?company_id=nope&date=2026-11-17', { sid })).status === 404);
        const form = (o) => Object.assign({ company_id: 'edge-metals-bofa', supplier: 'Ramesh Metals', supplier_address: 'Ramesh Metals\n5 Foundry Ave', number: '', date: '2026-11-17', required: '2026-11-30', terms: 'Net 7', ship_to: 'Edge Yard\n2453 E 25th Street, Los Angeles, CA 90058',
            lines: [{ desc: 'Copper', qty: '10', unit: 'MT', price: '2500' }], two: false, other: '', notes: '', signer: 'Chandra Bose' }, o);
        const bad = await req('POST', '/api/po/generate', { sid, body: form({ supplier: '' }) });
        ck('a missing supplier is refused with the sentence to fix', bad.status === 400 && /supplier/i.test(bad.json.error));
        const still = await req('GET', '/api/po/next-number?company_id=edge-metals-bofa&date=2026-11-17', { sid });
        ck('and a refused PO spends no number', still.json.number === 'PO-261117-001', still.json.number);
        const ok = await req('POST', '/api/po/generate', { sid, body: form({}) });
        ck('a blank number is reserved and the PDF comes back', ok.status === 200 && ok.raw.slice(0, 4).toString() === '%PDF' && ok.headers['x-po-number'] === 'PO-261117-001', `${ok.status} ${ok.headers['x-po-number']}`);
        const html = pdfHtml[pdfHtml.length - 1] || '';
        ck('the sheet has the supplier, the number, the total and Chandra\'s signature', /Ramesh Metals/.test(html) && html.includes('PO-261117-001') && html.includes('$25,000.00') && /<img src="data:image\/png/.test(html));
        const two = await req('POST', '/api/po/generate', { sid, body: form({}) });
        ck('the next one is -002', two.headers['x-po-number'] === 'PO-261117-002', two.headers['x-po-number']);
        const typed = await req('POST', '/api/po/generate', { sid, body: form({ number: 'PO-261117-007' }) });
        ck('a number she typed is kept', typed.headers['x-po-number'] === 'PO-261117-007');
        const after = await req('GET', '/api/po/next-number?company_id=edge-metals-bofa&date=2026-11-17', { sid });
        ck('and the count moves past it', after.json.number === 'PO-261117-008', after.json.number);
        const yard = await req('GET', '/api/po/next-number?company_id=edge-trading-chase&date=2026-11-17', { sid });
        ck('the other company still starts at 001', yard.json.number === 'PO-261117-001', yard.json.number);
        const twoP = await req('POST', '/api/po/generate', { sid, body: form({ company_id: 'edge-trading-chase', two: true, label_a: 'Clean', label_b: 'Dirty', lines: [{ desc: 'Alu', qty: '2', unit: 'LB', price: '3', price2: '2' }] }) });
        ck('two prices print both totals, and no signature image for Edge Trading', twoP.status === 200 && /Total if Clean/.test(pdfHtml[pdfHtml.length - 1]) && /Total if Dirty/.test(pdfHtml[pdfHtml.length - 1]) && !/<img src="data:image\/png/.test(pdfHtml[pdfHtml.length - 1]));
        ck('staff are refused on every PO route', (await req('GET', '/api/po/options', { sid: staff })).status === 403 && (await req('POST', '/api/po/generate', { sid: staff, body: form({}) })).status === 403 && (await req('GET', '/api/po/next-number?company_id=edge-metals-bofa', { sid: staff })).status === 403);
        const left = fs.readdirSync(cfg.DATA_DIR).filter((f) => /po/i.test(f) && !/counters/.test(f));
        ck('nothing but the counter was saved', left.length === 0, left.join(','));
    }

    // ═════════ C ═════════
    section('C — the tab in the app');
    {
        const SRC = fs.readFileSync(path.join(ROOT, 'mobile-app/www/app/15-documents.js'), 'utf8');
        ck('PO is a tab beside BOL', /\['bol', 'BOL'\], \['po', 'PO'\]/.test(SRC) && /docsSubTab === 'po'\) renderPoForm\(\)/.test(SRC));
        ck('the Android copy matches', SRC === fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/src/main/assets/public/app/15-documents.js'), 'utf8'));
        const dom = new JSDOM('<body><div id="docBody"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
        const w = dom.window; const d = w.document;
        const calls = []; const delivered = [];
        w.eval('var docsAddressBook = []; var docSearchAddressBook = function () { return []; }; var docEntryLabel = function () { return ""; }; var docConsigneeName = function (e) { return e.name; };');
        w.$ = (id) => d.getElementById(id);
        w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        w.API_BASE = 'https://api.test'; w.getToken = () => 'TOK';
        w.api = async (p) => { calls.push(p); return p.startsWith('/api/po/options') ? { companies: ACCOUNTS.map((a) => ({ id: a.id, company: a.company, address: a.address })), deliver: F.deliverOptions(ACCOUNTS), units: F.UNITS, signer: 'Chandra Bose' } : { number: 'PO-261117-001', company: 'x' }; };
        let posted = null; let answer = { ok: true };
        w.fetch = async (u, o) => { posted = { u, o, body: JSON.parse(o.body) }; return answer.ok ? { ok: true, headers: { get: () => 'PO-261117-001' }, blob: async () => ({ size: 9 }), json: async () => ({}) } : { ok: false, status: 400, json: async () => ({ error: 'Enter the supplier.', problems: ['Enter the supplier.', 'Add at least one item.'] }) }; };
        w.deliverExportedFile = async (b, n, e) => { delivered.push([n, e]); };
        w.eval(SRC.slice(SRC.indexOf('function wireDocTypeahead'), SRC.indexOf('// ── BILL OF LADING')) + SRC.slice(SRC.indexOf('// ── PURCHASE ORDER (Apsara')) + '\nwindow.__r = renderPoForm;');
        await w.__r(); await wait(50);
        const $ = (id) => d.getElementById(id);
        ck('the form renders with every field the website has', ['pow_company', 'pow_supplier', 'pow_supplier_address', 'pow_number', 'pow_date', 'pow_required', 'pow_terms', 'pow_deliver', 'pow_shipto', 'pow_two', 'pow_other', 'pow_notes', 'pow_signer'].every((id) => $(id)));
        ck('nothing is pre-selected for the issuing company', $('pow_company').value === '');
        ck('the date starts as today', /^\d{4}-\d{2}-\d{2}$/.test($('pow_date').value));
        const type = (id, v, ev) => { $(id).value = v; $(id).dispatchEvent(new w.Event(ev || 'input', { bubbles: true })); };
        type('pow_company', 'edge-metals-bofa', 'change'); await wait(50);
        ck('choosing a company fetches that company\'s next number', calls.some((c) => /next-number\?company_id=edge-metals-bofa&date=/.test(c)) && $('pow_number').value === 'PO-261117-001');
        type('pow_deliver', 'edge-trading-chase', 'change');
        ck('choosing Edge Yard fills its address', /^Edge Yard\n2453 E 25th/.test($('pow_shipto').value));
        type('pow_shipto', 'Somewhere else');
        ck('typing over it makes it Other', $('pow_deliver').value === 'other');
        type('pow_supplier', 'Ramesh Metals');
        d.querySelector('#powLines [data-f="desc"]').value = 'Copper';
        d.querySelector('#powLines [data-f="qty"]').value = '10';
        d.querySelector('#powLines [data-f="price"]').value = '2500';
        $('powAddLine').click(); await wait(20);
        ck('Add item adds a card and keeps what was typed', d.querySelectorAll('#powLines .pow-line').length === 2 && d.querySelector('#powLines [data-f="desc"]').value === 'Copper');
        [...d.querySelectorAll('.pow-rm')].pop().click(); await wait(20);
        ck('Remove item takes one away', d.querySelectorAll('#powLines .pow-line').length === 1);
        $('pow_two').checked = true; $('pow_two').dispatchEvent(new w.Event('change', { bubbles: true })); await wait(20);
        ck('"price depends on condition" adds a second price box', !!d.querySelector('#powLines [data-f="price2"]') && $('pow_label_a').value === 'Clean');
        $('pow_two').checked = false; $('pow_two').dispatchEvent(new w.Event('change', { bubbles: true })); await wait(20);
        $('powGo').click(); await wait(80);
        ck('Generate posts to /api/po/generate with the Bearer token', posted && posted.u === 'https://api.test/api/po/generate' && posted.o.headers.Authorization === 'Bearer TOK');
        const b = posted.body;
        ck('it sends what was typed', b.company_id === 'edge-metals-bofa' && b.supplier === 'Ramesh Metals' && b.number === 'PO-261117-001' && b.lines[0].desc === 'Copper' && b.lines[0].qty === '10' && b.lines[0].price === '2500' && /Somewhere else/.test(b.ship_to) && b.signer === 'Chandra Bose', JSON.stringify(b));
        ck('the PDF is handed over under its number', delivered.some((x) => x[0] === 'PO-261117-001.pdf' && x[1] === 'pdf'));
        ck('and it says nothing was saved', /Nothing was saved/.test($('powStatus').textContent));
        answer = { ok: false };
        $('powGo').click(); await wait(80);
        ck('a refusal shows every sentence the server gave', /Enter the supplier\./.test($('powStatus').textContent) && /Add at least one item\./.test($('powStatus').textContent));
        ck('and the button comes back', $('powGo').disabled === false);
    }

    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
