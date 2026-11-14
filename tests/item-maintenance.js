// ── tests/item-maintenance.js ───────────────────────────────────────────────
// Apsara, 2026-11-14: "reg edge yard, there should be a item maintenance, like
// clean items. i want to filter by items and then if i want to change names,
// like rotor and rotors." Chosen scope: rewrite OLD Edge Yard loads, Edge Yard
// only. Section E drives the real routes, as CLAUDE.md asks of every feature.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-itemmaint-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const { mutateJson, loadJson } = require(path.join(ROOT, 'helpers/json'));
const im = require(path.join(ROOT, 'helpers/itemMaintenance'));
const stock = require(path.join(ROOT, 'helpers/stock'));

(async () => {
const inbound = () => loadJson(cfg.LOADS_FILE, []);
const outbound = () => loadJson(cfg.OUTBOUND_LOADS_FILE, []);
const onHand = (name) => { const r = stock.stockReport(inbound(), outbound()).find((x) => x.description.toLowerCase() === name.toLowerCase()); return r ? { purchased: r.purchased, shipped: r.shipped } : null; };

await mutateJson(cfg.LOADS_FILE, [], () => [
    { id: 'EDGE_1', date: '2026-10-01', seller: 'Ramesh', status: 'paid', seller_signature: 'SIG1', pdf_link: 'http://pdf/1', amount: 500,
      items: [{ description: 'Rotor', net_weight: 1000, amount: 300 }, { description: 'Auto cast', net_weight: 500, amount: 200 }] },
    { id: 'EDGE_2', date: '2026-10-05', seller: 'Suresh', status: 'open', seller_signature: 'SIG2', pdf_link: 'http://pdf/2', amount: 250,
      items: [{ description: ' rotor ', net_weight: 800, amount: 250 }] },
    { id: 'EDGE_3', date: '2026-10-06', seller: 'Mani', status: 'open', amount: 90,
      items: [{ description: 'Rotors', net_weight: 300, amount: 90 }] },
]);
await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], () => [
    { id: 'OUT_1', date: '2026-10-10', buyer: 'Daekwang', status: 'sent', items: [{ description: 'rotor', net_weight: 400, amount: 200, draws: [{ load_id: 'EDGE_1', weight: 400 }] }] },
]);
// Edge Metals' side — must never move.
const metalsBefore = JSON.stringify({ bills: loadJson(path.join(cfg.DATA_DIR || TMP, 'bills.json'), []), sales: loadJson(path.join(TMP, 'sales.json'), []) });
fs.writeFileSync(path.join(TMP, 'bills.json'), JSON.stringify([{ id: 'B1', container_no: 'KOCU4340622', description: 'Rotor', gross: 1 }]));
fs.writeFileSync(path.join(TMP, 'sales.json'), JSON.stringify([{ id: 'S1', container_no: 'KOCU4340622', item: 'Rotor' }]));
const metals = () => fs.readFileSync(path.join(TMP, 'bills.json'), 'utf8') + fs.readFileSync(path.join(TMP, 'sales.json'), 'utf8');
const metalsSnap = metals();

section('A. filter by item');
{
    const all = im.summary({});
    ck('lists each item once, spellings merged by case/space', all.filter((x) => x.name.toLowerCase().trim() === 'rotor').length === 1, JSON.stringify(all.map((x) => x.name)));
    const f = im.summary({ q: 'rot' });
    ck('filter "rot" finds rotor and rotors, and not auto cast', f.length === 2 && !f.some((x) => /auto/i.test(x.name)), JSON.stringify(f.map((x) => x.name)));
    const r = f.find((x) => x.name.toLowerCase().trim() === 'rotor');
    ck('counts loads bought AND shipped', r.inbound.loads === 2 && r.outbound.loads === 1, JSON.stringify(r));
}

section('B. preview writes nothing');
{
    const before = JSON.stringify(inbound()) + JSON.stringify(outbound());
    const p = im.preview('Rotor', 'Rotors');
    ck('says how many lines on each side', p.stores.inbound.lines === 2 && p.stores.outbound.lines === 1 && p.total_lines === 3, JSON.stringify(p));
    ck('says it joins an item that already exists', p.merges_into_existing === true);
    ck('wrote nothing', before === JSON.stringify(inbound()) + JSON.stringify(outbound()));
    let e1 = null, e2 = null, e3 = null;
    try { im.preview('', 'x'); } catch (e) { e1 = e; }
    try { im.preview('a', ''); } catch (e) { e2 = e; }
    try { im.preview('a', 'a'); } catch (e) { e3 = e; }
    ck('blank or unchanged names are refused', !!e1 && !!e2 && !!e3);
}

section('C. apply: names only, both sides, stock unchanged');
let renId;
{
    const s0 = onHand('rotor');
    const r = await im.apply('Rotor', 'Rotors', { by: 'admin' });
    renId = r.id;
    ck('three lines renamed', r.lines === 3, JSON.stringify(r));
    ck('no line still reads rotor', ![...inbound(), ...outbound()].some((l) => l.items.some((i) => i.description.trim().toLowerCase() === 'rotor')));
    ck('every renamed line reads exactly Rotors', inbound()[1].items[0].description === 'Rotors' && outbound()[0].items[0].description === 'Rotors');
    const s1 = onHand('rotors');
    ck('stock: bought and shipped totals are the old rotor+rotors totals together', s1 && s1.purchased === s0.purchased + 300 && s1.shipped === s0.shipped, JSON.stringify([s0, s1]));
    const l1 = inbound()[0], l2 = inbound()[1];
    ck('status, signature, pdf link and amount are untouched', l1.status === 'paid' && l1.seller_signature === 'SIG1' && l1.pdf_link === 'http://pdf/1' && l1.amount === 500 && l2.seller_signature === 'SIG2' && l2.pdf_link === 'http://pdf/2', JSON.stringify(l1));
    ck('weights, prices and draws are untouched', l1.items[0].net_weight === 1000 && l1.items[0].amount === 300 && outbound()[0].items[0].draws[0].weight === 400);
    ck('other items untouched', l1.items[1].description === 'Auto cast');
    ck('Edge Metals bills and sales untouched', metals() === metalsSnap);
}

section('D. undo');
{
    await mutateJson(cfg.LOADS_FILE, [], (d) => { d[1].items[0].description = 'Rotors (heavy)'; return d; });
    const u = await im.undo(renId);
    ck('restores the lines still reading Rotors, skips the one she edited since', u.restored === 2 && u.skipped === 1, JSON.stringify(u));
    ck('  Rotor is back where it was', inbound()[0].items[0].description === 'Rotor' && outbound()[0].items[0].description === 'rotor');
    ck('  a line she edited since is not overwritten', inbound()[1].items[0].description === 'Rotors (heavy)' && inbound()[2].items[0].description === 'Rotors');
    let again = null; try { await im.undo(renId); } catch (e) { again = e; }
    ck('  undo twice is refused', !!again);
    await mutateJson(cfg.LOADS_FILE, [], (d) => { d[1].items[0].description = ' rotor '; return d; });  // reset for section E
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
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });
    const admin = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {}).sid;
    ck('signed in as admin and as staff', !!admin && !!staff);

    const staffTry = await req('POST', '/api/item-maintenance/apply', { sid: staff, body: { from: 'Rotor', to: 'Rotors' } });
    ck('staff cannot rename saved loads', staffTry.status === 403 || staffTry.status === 401, String(staffTry.status));
    ck('  and nothing changed', inbound()[0].items[0].description === 'Rotor');

    const list = await req('GET', '/api/item-maintenance?q=rot', { sid: admin });
    ck('the screen\'s list route filters by item', list.status === 200 && list.json.items.length === 2, JSON.stringify(list.json));

    const pv = await req('POST', '/api/item-maintenance/preview', { sid: admin, body: { from: 'Rotor', to: 'Rotors' } });
    ck('the preview route reports the same counts', pv.status === 200 && pv.json.total_lines === 3, JSON.stringify(pv.json));

    const s0 = onHand('rotors'), r0 = onHand('rotor');
    const ap = await req('POST', '/api/item-maintenance/apply', { sid: admin, body: { from: 'Rotor', to: 'Rotors' } });
    ck('apply route renames the loads', ap.status === 200 && ap.json.lines === 3, JSON.stringify(ap.json));
    const after = onHand('rotors');
    ck('  the stock figure read back is the two merged (delta, not absolute)', after.purchased === (s0 ? s0.purchased : 0) + (r0 ? r0.purchased : 0) && after.shipped === (r0 ? r0.shipped : 0) + (s0 ? s0.shipped : 0), JSON.stringify([s0, r0, after]));
    const hist = await req('GET', '/api/item-maintenance', { sid: admin });
    ck('  history lists it', hist.json.history.some((h) => h.id === ap.json.id && !h.undone), JSON.stringify(hist.json.history));
    const un = await req('POST', '/api/item-maintenance/undo', { sid: admin, body: { id: ap.json.id } });
    ck('undo route puts Rotor back', un.status === 200 && inbound()[0].items[0].description === 'Rotor', JSON.stringify(un.json));
    ck('Edge Metals bills and sales still untouched', metals() === metalsSnap);
    server.close();
}

section('F. the screen posts what the routes read');
{
    const src = fs.readFileSync(path.join(ROOT, 'mobile-app/www/app/14-settings.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
    ck('screen calls all four routes', ['/api/item-maintenance/preview', '/api/item-maintenance/apply', '/api/item-maintenance/undo'].every((r) => src.includes(r)) && /api\('\/api\/item-maintenance'/.test(src));
    ck('  and sends {from, to} / {id}, the keys the routes read', /preview'[^)]*JSON\.stringify\(\{ from, to:/.test(src) && /apply'[^)]*JSON\.stringify\(\{ from, to:/.test(src) && /undo'[^)]*JSON\.stringify\(\{ id:/.test(src));
    ck('  the panel is in the ADMIN modal only (staff cannot rewrite loads)', /id="as_im_rows"/.test(html) && !/id="ss_im_/.test(html));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
