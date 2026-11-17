// ── tests/item-metal.js ──────────────────────────────────────────────────
// Apsara, 2026-11-17: "edge yard should able to segregate ferrous and non
// ferrous" / "when you type an item, as soon as they move to next box, ask
// them whether it is ferrous or non-ferrous". (Phone app + website, loads and
// sales, ask once per item name, must pick one.)
//
// The questions are asked by the two apps (tests/item-metal-clients.js). THIS
// file is the wire and the store, end to end through the routes the screens
// use: the type posted with an item is stored, read back out of the list the
// screen reads, learned per item NAME, filled in for a caller that cannot ask
// (voice / Scout / an old app), and — the property CLAUDE.md rule 1 exists
// for — never REQUIRED by the server, so those callers keep working.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-metal-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || 'jarvis-pw-dddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config is not isolated'); process.exit(1); }

(async () => {
const M = require(path.join(ROOT, 'helpers/itemMetal'));

section('A — the vocabulary');
ck('"ferrous" and "Non-Ferrous" and "non ferrous" and "NF" are understood',
   M.normType('ferrous') === 'ferrous' && M.normType('Non-Ferrous') === 'non-ferrous' && M.normType('non ferrous') === 'non-ferrous' && M.normType('NF') === 'non-ferrous');
ck('anything else is no type, never a guess', M.normType('metal') === null && M.normType('') === null && M.normType(null) === null && M.normType(undefined) === null);
ck('names that differ only by case, spacing and punctuation are one item', M.keyOf('Al rims (Dirty)') === M.keyOf('al rims(dirty)') && M.keyOf('HMS') !== M.keyOf('HMS 2'));

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

const item = (description, extra = {}) => ({ description, gross_weight: 50000, tare_weight: 3440, price: 0.3, unit: 'lb', ...extra });
const postLoad = (items) => req('POST', '/api/loads', { sid, body: { date: '2026-11-17', seller: 'Hugo', items, created_by: 'test' } });
const postSale = (items) => req('POST', '/api/outbound-loads', { sid, body: { date: '2026-11-17', buyer: 'Eccomelt', items, created_by: 'test' } });
const loadOf = (r) => ((r.json || {}).load || r.json || {});
const first = (r) => (loadOf(r).items || [])[0] || {};
const learned = async (who = sid) => ((await req('GET', '/api/loads/item-metal', { sid: who })).json || {}).types || {};

section('B — a load: the type is stored and read back');
{
    const r = await postLoad([item('Copper', { metal_type: 'non-ferrous' })]);
    ck('the load saves', r.status === 200 || r.status === 201, `${r.status} ${r.raw.slice(0, 160)}`);
    ck('  and the item carries non-ferrous', first(r).metal_type === 'non-ferrous', JSON.stringify(first(r)));
    const list = await req('GET', '/api/loads', { sid });
    const all = Array.isArray(list.json) ? list.json : (list.json && list.json.loads) || [];
    ck('  and the list the screen reads has it too', all.some((l) => (l.items || []).some((i) => i.description === 'Copper' && i.metal_type === 'non-ferrous')));
    ck('  the amount is untouched by the new field (50,000 - 3,440 = 46,560 lb at 0.3)', first(r).amount === 13968, String(first(r).amount));
}

section('C — learned per item NAME');
{
    const t = await learned();
    ck('the answer was remembered under the name', t[M.keyOf('Copper')] === 'non-ferrous', JSON.stringify(t));
    ck('staff can read the learned list (the people typing the items)', (await learned(staff))[M.keyOf('Copper')] === 'non-ferrous');
    const unauth = await req('GET', '/api/loads/item-metal');
    ck('but not someone who is not logged in', unauth.status === 401 || unauth.status === 403, String(unauth.status));
    const r = await postLoad([item('copper')]);
    ck('a caller that cannot ask (voice, Scout, an old app) gets the learned type: "copper" -> non-ferrous', first(r).metal_type === 'non-ferrous', JSON.stringify(first(r)));
}

section('D — the server does NOT require it (the rule-1 property)');
{
    const r = await postLoad([item('Mystery metal')]);
    ck('an item with no type and no learned type still saves', r.status === 200 || r.status === 201, `${r.status} ${r.raw.slice(0, 160)}`);
    ck('  and is stored as Unsorted (null), not as a guess', first(r).metal_type === null, JSON.stringify(first(r)));
    const bad = await postLoad([item('Odd thing', { metal_type: 'metal' })]);
    ck('an unrecognised value is dropped to Unsorted, not rejected and not stored as ferrous', (bad.status === 200 || bad.status === 201) && first(bad).metal_type === null, JSON.stringify(first(bad)));
    ck('and nothing was learned from either', !(await learned())[M.keyOf('Mystery metal')] && !(await learned())[M.keyOf('Odd thing')]);
}

section('E — a sale is the same wire');
{
    const r = await postSale([item('Steel', { metal_type: 'ferrous' })]);
    ck('a sale with a type saves and keeps it', (r.status === 200 || r.status === 201) && first(r).metal_type === 'ferrous', `${r.status} ${JSON.stringify(first(r))}`);
    ck('  and the sale taught the same shared list', (await learned())[M.keyOf('Steel')] === 'ferrous');
    const again = await postLoad([item('STEEL')]);
    ck('  so a later purchase of "STEEL" with no type is ferrous', first(again).metal_type === 'ferrous', JSON.stringify(first(again)));
    const noType = await postSale([item('Copper')]);
    ck('a sale with no type for a learned name is filled in too', first(noType).metal_type === 'non-ferrous', JSON.stringify(first(noType)));
    const unsure = await postSale([item('Brand new thing')]);
    ck('a sale with no type for a new name still saves, as Unsorted', (unsure.status === 200 || unsure.status === 201) && first(unsure).metal_type === null);
}

section('F — editing keeps it, and a correction is learned');
{
    const made = await postLoad([item('Aluminium', { metal_type: 'non-ferrous' })]);
    const id = loadOf(made).id;
    const put = await req('PUT', '/api/loads/' + id, { sid, body: { date: '2026-11-17', seller: 'Hugo', items: [item('Aluminium', { metal_type: 'non-ferrous', price: 0.5 })] } });
    ck('an edit that sends the type keeps it', (put.status === 200) && first(put).metal_type === 'non-ferrous', `${put.status} ${put.raw.slice(0, 160)}`);
    const put2 = await req('PUT', '/api/loads/' + id, { sid, body: { date: '2026-11-17', seller: 'Hugo', items: [item('Aluminium', { price: 0.5 })] } });
    ck('an edit from an old client that omits it does not erase it (filled from what was learned)', put2.status === 200 && first(put2).metal_type === 'non-ferrous', JSON.stringify(first(put2)));
    const fix = await req('PUT', '/api/loads/' + id, { sid, body: { date: '2026-11-17', seller: 'Hugo', items: [item('Aluminium', { metal_type: 'ferrous' })] } });
    ck('choosing the other answer on edit changes it and the learned list', fix.status === 200 && first(fix).metal_type === 'ferrous' && (await learned())[M.keyOf('Aluminium')] === 'ferrous', JSON.stringify(first(fix)));
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
