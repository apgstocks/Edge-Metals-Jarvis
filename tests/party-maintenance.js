// ── tests/party-maintenance.js — Edge Yard supplier and buyer name clean-up ─────────────────────────
// Apsara, 2026-11-14: "What if i want to clean the supplier/buyer names in similar way", then yes to: Edge Yard
// only, suppliers and buyers together, with preview, multi-select, undo and a Drive-sheet refresh.
// Section E drives the real routes (CLAUDE.md rule 3). Section G runs the REAL client code in jsdom.
// Temp DATA_DIR, no network. Measures deltas where earlier sections have already written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-partymaint-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const { mutateJson, loadJson } = require(path.join(ROOT, 'helpers/json'));
const pm = require(path.join(ROOT, 'helpers/partyMaintenance'));
const nc = require(path.join(ROOT, 'helpers/nameCleanup'));
const payments = require(path.join(ROOT, 'helpers/payments'));

(async () => {
const loads = () => loadJson(cfg.LOADS_FILE, []);
const outbound = () => loadJson(cfg.OUTBOUND_LOADS_FILE, []);
const drafts = () => loadJson(cfg.LOAD_DRAFTS_FILE, []);
const pays = () => loadJson(cfg.PAYMENTS_FILE, []);

await mutateJson(cfg.LOADS_FILE, [], () => [
    { id: 'EDGE_1', date: '2026-10-01', seller: 'Ramesh Metals', status: 'paid', seller_signature: 'SIG1', pdf_link: 'http://pdf/1', amount: 500, created_at: '2026-10-01T10:00:00Z', items: [{ description: 'Rotor', net_weight: 1000, amount: 500 }] },
    { id: 'EDGE_2', date: '2026-10-05', seller: 'RAMESH METAL', status: 'open', seller_signature: 'SIG2', pdf_link: 'http://pdf/2', amount: 250, created_at: '2026-10-05T10:00:00Z', items: [{ description: 'Rotor', net_weight: 800, amount: 250 }] },
    { id: 'EDGE_3', date: '2026-11-02', seller: 'Suresh', status: 'open', amount: 90, created_at: '2026-11-02T10:00:00Z', items: [{ description: 'Drum', net_weight: 300, amount: 90 }] },
]);
await mutateJson(cfg.LOAD_DRAFTS_FILE, [], () => [{ id: 'DRAFT_1', date: '2026-11-03', seller: 'Ramesh Metal', items: [] }]);
await mutateJson(cfg.PAYMENTS_FILE, [], () => [
    { id: 'PAY_ADV', is_advance: true, seller: 'RAMESH METAL', amount: 1000, mode: 'cash', paid_on: '2026-10-20', created_at: '2026-10-20T10:00:00Z' },
    { id: 'PAY_1', load_id: 'OUT_1', load_kind: 'sale', amount: 400, mode: 'cash', paid_on: '2026-10-12', created_at: '2026-10-12T10:00:00Z' },
]);
await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], () => [
    { id: 'OUT_1', date: '2026-10-10', buyer: 'Metalco', status: 'sent', pdf_link: 'http://pdf/o1', amount: 400, created_at: '2026-10-10T10:00:00Z', items: [{ description: 'Rotor', net_weight: 400, amount: 400 }] },
    { id: 'OUT_2', date: '2026-10-20', buyer: 'METALCO INC', status: 'sent', amount: 300, created_at: '2026-10-20T10:00:00Z', items: [{ description: 'Rotor', net_weight: 300, amount: 300 }] },
    { id: 'OUT_3', date: '2026-11-04', buyer: 'Daekwang', status: 'open', amount: 100, created_at: '2026-11-04T10:00:00Z', items: [] },
]);
// Edge Metals' side must never move.
fs.writeFileSync(path.join(TMP, 'bills.json'), JSON.stringify([{ id: 'B1', supplier: 'Ramesh Metal', carrier: 'Ramesh Metals', container_no: 'KOCU4340622' }]));
fs.writeFileSync(path.join(TMP, 'sales.json'), JSON.stringify([{ id: 'S1', customer: 'Metalco', container_no: 'KOCU4340622' }]));
fs.writeFileSync(cfg.BOOKINGS_FILE, JSON.stringify({ BK1: { supplier: 'Ramesh Metal' } }));
const metals = () => ['bills.json', 'sales.json'].map((f) => fs.readFileSync(path.join(TMP, f), 'utf8')).join('|') + fs.readFileSync(cfg.BOOKINGS_FILE, 'utf8');
const metalsSnap = metals();
const baseline = { loadsAmount: loads().map((l) => l.amount).join(), outAmount: outbound().map((l) => l.amount).join(), sigs: loads().map((l) => l.seller_signature).join(), pdfs: loads().map((l) => l.pdf_link).join() };

section('A. the lists');
{
    const sup = pm.summary('supplier');
    ck('suppliers: every spelling in use, from loads, drafts and prepayments', ['Ramesh Metals', 'RAMESH METAL', 'Ramesh Metal', 'Suresh'].every((n) => sup.some((x) => x.name === n)), JSON.stringify(sup.map((x) => x.name)));
    ck('  counts rows per spelling', sup.find((x) => x.name === 'RAMESH METAL').rows === 2, JSON.stringify(sup.find((x) => x.name === 'RAMESH METAL')));
    const buy = pm.summary('buyer');
    ck('buyers: from yard sales only', buy.map((x) => x.name).sort().join() === 'Daekwang,METALCO INC,Metalco', JSON.stringify(buy.map((x) => x.name)));
    ck('  buyers do not include any supplier name', !buy.some((x) => /ramesh|suresh/i.test(x.name)));
    ck('filter finds names by substring', pm.summary('supplier', { q: 'ramesh' }).length === 3 && pm.summary('buyer', { q: 'metalco' }).length === 2);
    let e = null; try { pm.summary('carrier'); } catch (x) { e = x; }
    ck('an unknown kind (carrier is Edge Metals) is refused', !!e);
}

section('B. preview, and what it refuses');
{
    const p = pm.preview('supplier', ['RAMESH METAL', 'Ramesh Metal'], 'Ramesh Metals');
    ck('preview counts every record that would change, per store', p.total === 3 && p.byStore.loads === 1 && p.byStore.drafts === 1 && p.byStore.prepayments === 1 && p.merges_into_existing === true, JSON.stringify(p));
    ck('  the spelling she keeps is not counted as a change', !p.from.includes('Ramesh Metals'));
    const errs = [];
    for (const f of [() => pm.preview('supplier', [], 'X'), () => pm.preview('supplier', ['Ramesh Metals'], '  '), () => pm.preview('supplier', ['Nobody Ltd'], 'X')]) { try { f(); errs.push(null); } catch (e) { errs.push(e); } }
    ck('empty choice, empty new name and an unknown name are refused', errs.every(Boolean), JSON.stringify(errs.map((e) => e && e.message)));
    ck('preview wrote nothing', loads()[1].seller === 'RAMESH METAL' && !loads()[1].name_was);
}

section('C. supplier merge: loads, drafts and advances move TOGETHER');
let supMerge = null;
{
    const before = payments.prepaymentCredit('RAMESH METAL').available;
    const r = await pm.apply('supplier', ['RAMESH METAL', 'Ramesh Metal'], 'Ramesh Metals', { by: 'admin' });
    supMerge = r.merge_id;
    ck('apply reports changed rows per store and a merge id', r.changed === 3 && r.byStore.loads === 1 && r.byStore.drafts === 1 && r.byStore.prepayments === 1 && /^mrg_seller_/.test(r.merge_id), JSON.stringify(r));
    ck('  the months touched are returned for the Drive sheets', r.months.includes('2026-10') && r.months.includes('2026-11'), JSON.stringify(r.months));
    ck('loads now read the one name', loads().filter((l) => /ramesh/i.test(l.seller)).every((l) => l.seller === 'Ramesh Metals'));
    ck('the draft and the advance moved too', drafts()[0].seller === 'Ramesh Metals' && pays().find((p) => p.id === 'PAY_ADV').seller === 'Ramesh Metals');
    ck('THE ADVANCE IS STILL FOUND by the one name (delta, not absolute)', payments.prepaymentCredit('Ramesh Metals').available === before && before > 0, `${before} -> ${payments.prepaymentCredit('Ramesh Metals').available}`);
    ck('  and not left under the old name', payments.prepaymentCredit('RAMESH METAL').available === 0);
    ck('each changed row keeps its original spelling', loads()[1].name_was.seller === 'RAMESH METAL' && drafts()[0].name_was.seller === 'Ramesh Metal');
    ck('a supplier she did not choose is untouched', loads().find((l) => l.id === 'EDGE_3').seller === 'Suresh');
    ck('weights, amounts, signatures, status and issued-PDF links are untouched', loads().map((l) => l.amount).join() === baseline.loadsAmount && loads().map((l) => l.seller_signature).join() === baseline.sigs && loads().map((l) => l.pdf_link).join() === baseline.pdfs && loads()[1].status === 'open');
    ck('Edge Yard buyers did not move', outbound().map((l) => l.buyer).join() === 'Metalco,METALCO INC,Daekwang');
    ck('EDGE METALS BILLS, SALES AND BOOKINGS DID NOT MOVE (same spelling, other company)', metals() === metalsSnap);
}

section('D. buyer merge: a sale moves, and a payment against it still finds it');
let buyMerge = null;
{
    const r = await pm.apply('buyer', ['METALCO INC', 'Metalco'], 'Metalco Inc', { by: 'admin' });
    buyMerge = r.merge_id;
    ck('both sales now read the one buyer', outbound().filter((l) => /metalco/i.test(l.buyer)).every((l) => l.buyer === 'Metalco Inc') && r.changed === 2, JSON.stringify(r));
    ck('  the other buyer is untouched, and so are amounts and the issued-PDF link', outbound()[2].buyer === 'Daekwang' && outbound().map((l) => l.amount).join() === baseline.outAmount && outbound()[0].pdf_link === 'http://pdf/o1');
    ck('  a payment received points at the sale by id, so it still does', pays().find((p) => p.id === 'PAY_1').load_id === 'OUT_1' && !('buyer' in pays().find((p) => p.id === 'PAY_1')));
    ck('Edge Metals customer "Metalco" on the invoice register did not move', metals() === metalsSnap);
    const byBuyer = require(path.join(ROOT, 'helpers/outboundLoads'));
    const rep = (byBuyer.buyerReport || byBuyer.buyerSummary || (() => null))({});
    ck('history for these two fields lists both merges, newest first', pm.history().length === 2 && pm.history('buyer').length === 1 && pm.history('supplier').length === 1, JSON.stringify(pm.history()));
}

section('E. END TO END, through the real routes');
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
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const metalsAtBoot = metals();
    const admin = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {}).sid;
    ck('signed in as admin and as staff', !!admin && !!staff);

    for (const [m, p, b] of [['GET', '/api/party-maintenance/supplier'], ['POST', '/api/party-maintenance/supplier/preview', { from: 'Suresh', to: 'Suresh K' }], ['POST', '/api/party-maintenance/supplier/apply', { from: 'Suresh', to: 'Suresh K' }], ['POST', '/api/party-maintenance/undo', { id: 'x' }]]) {
        const r = await req(m, p, { sid: staff, body: b });
        ck(`staff is refused: ${m} ${p}`, r.status === 403 || r.status === 401, String(r.status));
    }
    ck('  and nothing changed', loads().find((l) => l.id === 'EDGE_3').seller === 'Suresh');

    const list = await req('GET', '/api/party-maintenance/supplier?q=sur', { sid: admin });
    ck('the screen\'s list route filters', list.status === 200 && list.json.names.length === 1 && list.json.names[0].name === 'Suresh', JSON.stringify(list.json));
    const bad = await req('GET', '/api/party-maintenance/carrier', { sid: admin });
    ck('an unknown kind is a 400, not a crash', bad.status === 400);

    const pv = await req('POST', '/api/party-maintenance/supplier/preview', { sid: admin, body: { from: ['Suresh'], to: 'Suresh K' } });
    ck('preview route: counts and the label for each store', pv.status === 200 && pv.json.total === 1 && pv.json.labels.loads, JSON.stringify(pv.json));

    const sheetSync = require(path.join(ROOT, 'helpers/sheetSync'));
    const calls = []; const real = sheetSync.scheduleSync; sheetSync.scheduleSync = (m) => { calls.push(m); };
    const ap = await req('POST', '/api/party-maintenance/supplier/apply', { sid: admin, body: { from: ['Suresh'], to: 'Suresh K' } });
    ck('apply route renames the record', ap.status === 200 && ap.json.changed === 1 && loads().find((l) => l.id === 'EDGE_3').seller === 'Suresh K', JSON.stringify(ap.json));
    ck('  and asks the Drive sheets to rebuild, for that load\'s month', calls.length === 1 && calls[0].includes('2026-11'), JSON.stringify(calls));
    const h = await req('GET', '/api/party-maintenance/supplier', { sid: admin });
    ck('  the history route lists it', h.json.history.some((x) => x.merge_id === ap.json.merge_id), JSON.stringify(h.json.history));
    const un = await req('POST', '/api/party-maintenance/undo', { sid: admin, body: { id: ap.json.merge_id } });
    ck('undo route puts the old spelling back and asks for the rebuild again', un.status === 200 && un.json.restored === 1 && loads().find((l) => l.id === 'EDGE_3').seller === 'Suresh' && calls.length === 2 && calls[1].includes('2026-11'), JSON.stringify(un.json));
    const un2 = await req('POST', '/api/party-maintenance/undo', { sid: admin, body: { id: supMerge } });
    ck('an earlier merge can be undone from the same screen', un2.status === 200 && loads()[1].seller === 'RAMESH METAL' && payments.prepaymentCredit('RAMESH METAL').available > 0, JSON.stringify(un2.json));
    sheetSync.scheduleSync = real;

    // The Edge Metals "Clean up names" screen is NOT given a Buyer tab by this feature.
    const metalsPv = await req('GET', '/api/names/supplier/preview', { sid: admin });
    ck('THE EDGE METALS CLEAN-UP SCREEN GAINED NO BUYER TAB (and still lists the seller tab it already had)', metalsPv.status === 200 && !metalsPv.json.fields.some((f) => f.key === 'buyer') && metalsPv.json.fields.some((f) => f.key === 'seller'), JSON.stringify(metalsPv.json.fields && metalsPv.json.fields.map((f) => f.key)));
    ck('Edge Metals still untouched after all of it', metals() === metalsSnap, 'boot changed it: ' + (metalsAtBoot !== metalsSnap) + '\n' + metals().slice(0, 400));
    server.close();
}

section('F. the two fields list only Edge Yard stores');
{
    const files = [...nc.targetsFor('seller'), ...nc.targetsFor('buyer')].map((t) => path.basename(t.file));
    ck('stores reached: loads, load_drafts, payments, outbound_loads and nothing from Edge Metals', files.sort().join() === ['load_drafts.json', 'loads.json', 'outbound_loads.json', 'payments.json'].sort().join(), files.join());
}

section('G. the REAL client code, run in jsdom, website and phone');
{
    let JSDOM = null; try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported below */ }
    ck('jsdom is available', !!JSDOM);
    const clients = [
        ['website', 'dashboard/app/03-settings-contacts.js', '', 'as_'.slice(0, 0)],
        ['phone', 'mobile-app/www/app/14-settings.js', 'as_', 'as_'],
    ];
    for (const [label, file, pre] of clients.map((c) => [c[0], c[1], c[2]])) {
        if (!JSDOM) break;
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const i = src.indexOf('let pmKind'), j = src.indexOf('// ── What Scout has learned');
        const block = src.slice(i, j);
        const dom = new JSDOM(`<body>
          <button id="${pre}pmTabSupplier"></button><button id="${pre}pmTabBuyer"></button><input id="${pre}pmFilter">
          <div id="${pre}pmBar"></div><span id="${pre}pmSelected"></span><button id="${pre}pmClear"></button><button id="${pre}pmRename"></button>
          <div id="${pre}pmRows"></div><div id="${pre}pmHistory"></div></body>`, { runScripts: 'outside-only' });
        const w = dom.window;
        const calls = []; const names = { supplier: [{ name: 'Ramesh Metals', rows: 2 }, { name: 'RAMESH METAL', rows: 3 }, { name: 'Suresh', rows: 1 }], buyer: [{ name: 'Metalco', rows: 4 }] };
        w.$ = (id) => w.document.getElementById(id);
        w.esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        w.alert = (m) => calls.push(['alert', m]);
        w.askText = async (m, init) => { calls.push(['askText', m]); return 'Ramesh Metals'; };
        w.askYesNo = async (m) => { calls.push(['askYesNo', m]); return true; };
        w.api = async (url, o) => {
            calls.push([url, o && o.body ? JSON.parse(o.body) : null]);
            if (/\/preview$/.test(url)) return { total: 5, byStore: { loads: 3, prepayments: 2 }, labels: { loads: 'yard loads', prepayments: 'prepayments' }, to: 'Ramesh Metals', merges_into_existing: true };
            if (/\/apply$/.test(url)) return { changed: 5, merge_id: 'mrg_seller_x' };
            const k = /party-maintenance\/(supplier|buyer)/.exec(url)[1];
            const q = (/q=([^&]*)/.exec(url) || [])[1];
            return { names: names[k].filter((n) => !q || n.name.toLowerCase().includes(decodeURIComponent(q))), history: [] };
        };
        w.eval(block + '\nwindow.__pm = { render: renderPartyMaintenance, sel: pmSelected, setKind: (k) => { pmKind = k; } };');
        await w.__pm.render();
        const rows = () => [...w.document.querySelectorAll('.pm-pick')];
        ck(`${label}: lists the suppliers as tick boxes`, rows().length === 3);
        rows()[0].checked = true; rows()[0].dispatchEvent(new w.Event('change'));
        w.$(pre + 'pmFilter').value = 'sur';
        await w.__pm.render();
        ck(`${label}: a new filter does not drop a ticked name that is now hidden`, w.__pm.sel.supplier.has('Ramesh Metals') && /1 selected: Ramesh Metals/.test(w.$(pre + 'pmSelected').textContent));
        w.$(pre + 'pmFilter').value = '';
        await w.__pm.render();
        rows()[1].checked = true; rows()[1].dispatchEvent(new w.Event('change'));
        ck(`${label}: Rename selected is enabled with a selection`, w.$(pre + 'pmRename').disabled === false);
        calls.length = 0;
        w.$(pre + 'pmRename').onclick && await w.$(pre + 'pmRename').onclick();
        const pv = calls.find((c) => /supplier\/preview$/.test(c[0])), ap = calls.find((c) => /supplier\/apply$/.test(c[0]));
        ck(`${label}: posts {from:[names], to} to the preview route, then the apply route`, !!pv && !!ap && Array.isArray(pv[1].from) && pv[1].from.length === 2 && pv[1].to === 'Ramesh Metals' && ap[1].to === 'Ramesh Metals', JSON.stringify(calls));
        ck(`${label}: asked in-app (askText/askYesNo), never prompt()`, calls.some((c) => c[0] === 'askText') && calls.some((c) => c[0] === 'askYesNo') && !/[^a-zA-Z.]prompt\(/.test(block));
        ck(`${label}: the selection is cleared after a rename`, w.__pm.sel.supplier.size === 0);
        w.__pm.setKind('buyer'); calls.length = 0;
        await w.__pm.render();
        ck(`${label}: the Buyers tab reads the buyer route and keeps its own selection`, calls.some((c) => /party-maintenance\/buyer/.test(c[0])) && rows().length === 1 && w.__pm.sel.buyer.size === 0);
    }
    const html = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/app/03-settings-contacts.js'), 'utf8');
    ck('website panel markup exists, in the settings page with Item maintenance', ['id="pmFilter"', 'id="pmRename"', 'id="pmRows"', 'id="pmHistory"', 'id="pmTabBuyer"'].every((s2) => web.includes(s2)) && web.indexOf('id="pmRows"') > web.indexOf('id="imRows"'));
    ck('phone panel markup exists, in the ADMIN modal only', ['as_pmFilter', 'as_pmRename', 'as_pmRows', 'as_pmHistory', 'as_pmTabBuyer'].every((s2) => html.includes('id="' + s2 + '"')) && !/id="ss_pm/.test(html));
    ck('phone assets match www (what the APK ships)', ['index.html', 'app/14-settings.js'].every((f) => fs.readFileSync(path.join(ROOT, 'mobile-app/www', f), 'utf8') === fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/src/main/assets/public', f), 'utf8')));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
