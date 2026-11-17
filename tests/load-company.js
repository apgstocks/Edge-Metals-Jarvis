// ── tests/load-company.js — which of her companies is on a load or sale ───
// Apsara, 2026-11-17: pick the BUYER on a purchase and the SELLER on a sale,
// from Edge Trading / Edge Metals / AAA Investment. Then: "Money moving between
// companies is for another day. For now, loads/sales only."
// So this is a LABEL. The properties that matter, in order:
//   A  the vocabulary, and a select can never be handed a value outside its list
//   B  purchase: saved, read back, and an OLD client's edit cannot undo it
//   C  sale: same, on seller_company
//   D  NOTHING ELSE MOVED: books/ledger, stock and payments read the record as before
//   E  the PO prints the picked company
//   F  both clients carry the picker
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-loadco-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('ABORT config not isolated'); process.exit(1); }
const LC = require('../helpers/loadCompany');

(async () => {
    section('A — the vocabulary');
    ck('the three companies, Edge Trading first (the default)', LC.COMPANIES.join('|') === 'Edge Trading|Edge Metals|AAA Investment' && LC.DEFAULT_COMPANY === 'Edge Trading');
    ck('her other names for them are understood', LC.canon('EDGE TRADING INC') === 'Edge Trading' && LC.canon('Edge Yard') === 'Edge Trading' && LC.canon('edge metal') === 'Edge Metals' && LC.canon('Edge Metals Inc.') === 'Edge Metals' && LC.canon('AAA Investment') === 'AAA Investment');
    ck('anything else is no company, never a guess', LC.canon('Eccomelt') === null && LC.canon('') === null && LC.canon(null) === null);
    ck('a picked company wins over the old fixed buyer', LC.chooseBuyer({ buyer: 'Edge Trading', buyer_company: 'Edge Metals' }, 'Edge Trading') === 'Edge Metals');
    ck('a caller that says nothing keeps an Edge Metals purchase as it was', LC.chooseBuyer({ buyer: 'Edge Trading' }, 'Edge Metals') === 'Edge Metals');
    ck('a caller that says Edge Trading explicitly changes it back', LC.chooseBuyer({ buyer: 'Edge Trading', buyer_company: 'Edge Trading' }, 'Edge Metals') === 'Edge Trading');
    ck('a new record with no picker is what it always was', LC.chooseBuyer({ buyer: 'Edge Trading' }, null) === 'Edge Trading' && LC.chooseBuyer({}, null) === null);

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
    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    const rec = (r) => ((r.json || {}).load || r.json || {});
    const item = (d) => ({ description: d, gross_weight: 50000, tare_weight: 3440, price: 0.3, unit: 'lb', metal_type: 'ferrous' });
    const getLoads = async () => { const r = await req('GET', '/api/loads', { sid }); return Array.isArray(r.json) ? r.json : (r.json && r.json.loads) || []; };
    const getSales = async () => { const r = await req('GET', '/api/outbound-loads', { sid }); return Array.isArray(r.json) ? r.json : (r.json && (r.json.loads || r.json.outbound_loads)) || []; };

    section('B — a purchase: the buyer');
    let loadId;
    {
        const mk = await req('POST', '/api/loads', { sid, body: { date: '2026-11-17', seller: 'Hugo', buyer: 'Edge Trading', buyer_company: 'Edge Metals', items: [item('Steel A')], created_by: 'test' } });
        ck('a purchase picked as Edge Metals saves', mk.status === 200 || mk.status === 201, `${mk.status} ${mk.raw.slice(0, 120)}`);
        loadId = rec(mk).id;
        ck('  and the buyer on the record is Edge Metals', rec(mk).buyer === 'Edge Metals', String(rec(mk).buyer));
        ck('  and the list the screen reads says so too', ((await getLoads()).find((l) => l.id === loadId) || {}).buyer === 'Edge Metals');
        const plain = await req('POST', '/api/loads', { sid, body: { date: '2026-11-17', seller: 'Hugo', buyer: 'Edge Trading', items: [item('Steel B')], created_by: 'test' } });
        ck('a purchase from a client that never heard of the picker is Edge Trading, as always', rec(plain).buyer === 'Edge Trading');
        const aaa = await req('POST', '/api/loads', { sid, body: { date: '2026-11-17', seller: 'Hugo', buyer: 'Edge Trading', buyer_company: 'AAA Investment', items: [item('Steel C')], created_by: 'test' } });
        ck('AAA Investment can be the buyer', rec(aaa).buyer === 'AAA Investment');
        // the APK already on her phone: edits with the fixed buyer and no picker at all
        const old = await req('PUT', `/api/loads/${loadId}`, { sid, body: { date: '2026-11-17', seller: 'Hugo', buyer: 'Edge Trading', items: [item('Steel A')] } });
        ck('an edit from the OLD app does not turn it back into Edge Trading', (old.status === 200) && ((await getLoads()).find((l) => l.id === loadId) || {}).buyer === 'Edge Metals', `${old.status} ${old.raw.slice(0, 120)}`);
        const chg = await req('PUT', `/api/loads/${loadId}`, { sid, body: { date: '2026-11-17', seller: 'Hugo', buyer: 'Edge Trading', buyer_company: 'AAA Investment', items: [item('Steel A')] } });
        ck('an edit that picks another company changes it', ((await getLoads()).find((l) => l.id === loadId) || {}).buyer === 'AAA Investment', chg.raw.slice(0, 120));
        await req('PUT', `/api/loads/${loadId}`, { sid, body: { date: '2026-11-17', seller: 'Hugo', buyer: 'Edge Trading', buyer_company: 'Edge Trading', items: [item('Steel A')] } });
        ck('and back to Edge Trading when that is picked', ((await getLoads()).find((l) => l.id === loadId) || {}).buyer === 'Edge Trading');
    }

    section('C — a sale: the seller');
    let saleId;
    {
        const mk = await req('POST', '/api/outbound-loads', { sid, body: { date: '2026-11-17', buyer: 'Eccomelt', seller_company: 'Edge Metals', items: [item('Steel A')], created_by: 'test' } });
        ck('a sale picked as sold by Edge Metals saves', mk.status === 200 || mk.status === 201, `${mk.status} ${mk.raw.slice(0, 160)}`);
        saleId = rec(mk).id;
        ck('  and the seller company is on the record', rec(mk).seller_company === 'Edge Metals', String(rec(mk).seller_company));
        ck('  the buyer (the customer) is untouched', rec(mk).buyer === 'Eccomelt');
        ck('  and the list reads it back', ((await getSales()).find((s) => s.id === saleId) || {}).seller_company === 'Edge Metals');
        const plain = await req('POST', '/api/outbound-loads', { sid, body: { date: '2026-11-17', buyer: 'Eccomelt', items: [item('Steel A')], created_by: 'test' } });
        ck('a sale with no picker has no company (= Edge Trading, as every sale before today)', rec(plain).seller_company === null);
        const old = await req('PUT', `/api/outbound-loads/${saleId}`, { sid, body: { date: '2026-11-17', buyer: 'Eccomelt', items: [item('Steel A')] } });
        ck('an edit from the OLD app does not blank it', old.status === 200 && ((await getSales()).find((s) => s.id === saleId) || {}).seller_company === 'Edge Metals', `${old.status} ${old.raw.slice(0, 160)}`);
        await req('PUT', `/api/outbound-loads/${saleId}`, { sid, body: { date: '2026-11-17', buyer: 'Eccomelt', seller_company: 'AAA Investment', items: [item('Steel A')] } });
        ck('an edit that picks another company changes it', ((await getSales()).find((s) => s.id === saleId) || {}).seller_company === 'AAA Investment');
        await req('PUT', `/api/outbound-loads/${saleId}`, { sid, body: { date: '2026-11-17', buyer: 'Eccomelt', seller_company: 'nonsense', items: [item('Steel A')] } });
        ck('a value that is not one of the three is stored as no company, not as that text', ((await getSales()).find((s) => s.id === saleId) || {}).seller_company === null);
    }

    section('D — nothing else moved');
    {
        const E = require('../helpers/entities');
        const loads = await getLoads(); const sales = await getSales();
        const metalsLoad = { ...loads[0], buyer: 'Edge Metals' };
        ck('the books still place a purchase by STORE, whatever its buyer says', E.of('loads', metalsLoad).ledger === E.of('loads', { ...metalsLoad, buyer: 'Edge Trading' }).ledger);
        const sold = { ...sales[0], seller_company: 'Edge Metals' };
        ck('and a sale likewise, whatever its seller company says', E.of('outbound_loads', sold).ledger === E.of('outbound_loads', { ...sold, seller_company: null }).ledger);
        const inv = () => require('../helpers/loads').getInventoryReport(require('../helpers/loads').loadLoads());
        const before = JSON.stringify(inv());
        await req('PUT', `/api/loads/${loadId}`, { sid, body: { date: '2026-11-17', seller: 'Hugo', buyer: 'Edge Trading', buyer_company: 'Edge Metals', items: [item('Steel A')] } });
        ck('stock is the same whichever company is picked on a purchase', JSON.stringify(inv()) === before);
        await req('PUT', `/api/outbound-loads/${saleId}`, { sid, body: { date: '2026-11-17', buyer: 'Eccomelt', seller_company: 'Edge Metals', items: [item('Steel A')] } });
        ck('and on a sale', JSON.stringify(inv()) === before);
        const l = (await getLoads()).find((x) => x.id === loadId);
        ck('amounts are untouched', l.amount === 13968, String(l.amount));
    }

    section('E — the PO prints the picked company');
    {
        const R = require('../helpers/poFromRecord');
        const A = [{ id: 'edge-metals-bofa', company: 'Edge Metals INC', address: 'Frisco' }, { id: 'edge-trading-chase', company: 'EDGE TRADING INC', address: 'LA' }];
        const l = (await getLoads()).find((x) => x.id === loadId);
        ck('a purchase bought by Edge Metals is issued by Edge Metals', R.buildPoData('purchase', l, A).company === 'Edge Metals INC');
        ck('bought by AAA Investment: issued by name, no borrowed address', (() => { const d = R.buildPoData('purchase', { ...l, buyer: 'AAA Investment' }, A); return d.company === 'AAA Investment' && d.companyAddress === ''; })());
        const s = (await getSales()).find((x) => x.id === saleId);
        ck('a sale sold by Edge Metals names Edge Metals as the vendor', R.buildPoData('sale', { ...s, seller_company: 'Edge Metals' }, A).supplier === 'Edge Metals INC');
        ck('and with no company, Edge Trading, as before', R.buildPoData('sale', { ...s, seller_company: null }, A).supplier === 'EDGE TRADING INC');
    }
    server.close();

    section('F — both clients');
    {
        const sites = [
            { name: 'website', modal: 'dashboard/app/13-loads-render.js', mode: 'dashboard/app/05-load-pricing.js' },
            { name: 'phone app', modal: 'mobile-app/www/app/09-loads-deck.js', mode: 'mobile-app/www/app/08-load-modal.js' },
        ];
        for (const s of sites) {
            const m = fs.readFileSync(path.join(ROOT, s.modal), 'utf8');
            const d = fs.readFileSync(path.join(ROOT, s.mode), 'utf8');
            ck(`${s.name}: the form offers exactly the three companies, Edge Trading first`, /<select id="ld_company"[^>]*><option value="Edge Trading">Edge Trading<\/option><option value="Edge Metals">Edge Metals<\/option><option value="AAA Investment">AAA Investment<\/option><\/select>/.test(m));
            ck(`${s.name}: the save sends the pick for purchases and for sales`, /buyer_company: \$\('ld_company'\)/.test(m) && /seller_company: payload\.seller_company/.test(m));
            ck(`${s.name}: the label follows the mode (buyer on a purchase, seller on a sale)`, /sale \? 'Seller \(our company\)' : 'Buyer \(our company\)'/.test(d));
            ck(`${s.name}: opening a load puts the SAVED company back`, /setLoadCompany\(loadModalMode === 'sale' \? load\.seller_company : load\.buyer\)/.test(d));
            const helper = m.slice(m.indexOf('function loadCompanyValue'));
            const els = { ld_company: { value: '' } };
            const f = new Function('$', helper + '\nreturn { loadCompanyValue, setLoadCompany };')((id) => els[id] || null);
            ck(`${s.name}: every saved value lands on one of the three (a select given anything else goes blank)`, ['Edge Trading', 'EDGE TRADING INC', 'Edge Yard', 'Edge Metals', 'Edge Metals INC', 'AAA Investment', '', null, undefined, 'Eccomelt'].every((v) => LC.COMPANIES.includes(f.loadCompanyValue(v))));
            f.setLoadCompany('Edge Metals INC');
            ck(`${s.name}: and Edge Metals INC selects "Edge Metals"`, els.ld_company.value === 'Edge Metals');
        }
        ck('the Android copies match', ['08-load-modal.js', '09-loads-deck.js'].every((n) => fs.readFileSync(path.join(ROOT, 'mobile-app/www/app', n), 'utf8') === fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/src/main/assets/public/app', n), 'utf8')));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
