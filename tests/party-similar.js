// ── tests/party-similar.js — "did you mean ...?" while a load or sale is being entered ────────────────
// Apsara, 2026-11-15: "Spelling variants as they type ask while creating load/sales that whether they mean this?"
// Section B drives the real route (CLAUDE.md rule 3). Section C runs the REAL client code, website and phone, in jsdom.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-partysim-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const pm = require(path.join(ROOT, 'helpers/partyMaintenance'));

(async () => {
await mutateJson(cfg.LOADS_FILE, [], () => [
    { id: 'EDGE_1', date: '2026-10-01', seller: 'MAZARIEGOS', created_at: '2026-10-01T10:00:00Z', items: [] },
    { id: 'EDGE_2', date: '2026-10-02', seller: 'MAZARIEGOS', created_at: '2026-10-02T10:00:00Z', items: [] },
    { id: 'EDGE_3', date: '2026-10-03', seller: 'INESH CORES CHAPIN', created_at: '2026-10-03T10:00:00Z', items: [] },
    { id: 'EDGE_4', date: '2026-10-04', seller: 'Ramesh Metals', created_at: '2026-10-04T10:00:00Z', items: [] },
    { id: 'EDGE_5', date: '2026-10-05', seller: 'Ram', created_at: '2026-10-05T10:00:00Z', items: [] },
]);
await mutateJson(cfg.OUTBOUND_LOADS_FILE, [], () => [
    { id: 'OUT_1', date: '2026-10-10', buyer: 'Metalco Inc', created_at: '2026-10-10T10:00:00Z', items: [] },
    { id: 'OUT_2', date: '2026-10-11', buyer: 'Daekwang', created_at: '2026-10-11T10:00:00Z', items: [] },
]);
fs.writeFileSync(path.join(TMP, 'bills.json'), JSON.stringify([{ id: 'B1', supplier: 'Ramesh Metal' }]));
const metals = () => fs.readFileSync(path.join(TMP, 'bills.json'), 'utf8');
const metalsSnap = metals();
const names = (r) => r.suggestions.map((s) => s.name);

section('A. the lookup');
{
    ck('the same name with other case, spacing or punctuation is KNOWN: nothing to ask', ['mazariegos', 'Mazariegos ', 'M.A.Z.A.R.I.E.G.O.S', 'ramesh  metals'].every((n) => pm.similar('purchase', n).known === true));
    ck('a one-letter misspelling is suggested (MAZARIEGOES)', names(pm.similar('purchase', 'MAZARIEGOES')).includes('MAZARIEGOS'), JSON.stringify(pm.similar('purchase', 'MAZARIEGOES')));
    ck('the same words in another order are suggested', names(pm.similar('purchase', 'CORES CHAPIN INESH')).join() === 'INESH CORES CHAPIN');
    ck('a name that is the start of an existing one is suggested, with how many saved records use it', (() => { const r = pm.similar('sale', 'Metalco'); return r.suggestions[0].name === 'Metalco Inc' && r.suggestions[0].rows === 1; })());
    ck('an unrelated new name asks nothing', pm.similar('purchase', 'Zanzibar Scrap').suggestions.length === 0 && pm.similar('purchase', 'Zanzibar Scrap').known === false);
    ck('a three-letter existing name ("Ram") is never offered for "Rama" (too short to trust)', !names(pm.similar('purchase', 'Rama')).includes('Ram'), JSON.stringify(pm.similar('purchase', 'Rama')));
    ck('  and three letters never match by spelling', pm.similar('purchase', 'Rem').suggestions.length === 0, JSON.stringify(pm.similar('purchase', 'Rem')));
    ck('purchase looks only at sellers, sale only at buyers (no crossing)', !names(pm.similar('sale', 'MAZARIEGOES')).length && !names(pm.similar('purchase', 'Daekwangg')).length);
    ck('at most three suggestions', pm.similar('purchase', 'Ramesh').suggestions.length <= 3);
    ck('empty and blank input are "known" so nothing is asked', pm.similar('sale', '').known && pm.similar('sale', '   ').known && pm.similar('sale', null).known);
    let e = null; try { pm.similar('carrier', 'x'); } catch (x) { e = x; }
    ck('an unknown kind is refused (carriers are Edge Metals)', !!e);
    ck('a huge input does not blow up', pm.similar('purchase', 'x'.repeat(5000)).known === false);
}

section('B. END TO END, through the real route');
{
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { sid } = {}) => new Promise((resolve, reject) => {
        const headers = {}; if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r2.on('error', reject); r2.end();
    });
    const post = (p, body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body); const r2 = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ json: j }); }); }); r2.write(data); r2.end();
    });
    const admin = ((await post('/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
    const staff = ((await post('/login', { password: process.env.STAFF_PASSWORD })).json || {}).sid;
    ck('signed in as admin and as staff', !!admin && !!staff);
    const before = JSON.stringify([fs.readFileSync(cfg.LOADS_FILE, 'utf8'), fs.readFileSync(cfg.OUTBOUND_LOADS_FILE, 'utf8')]);
    const s1 = await req('GET', '/api/loads/party-similar?kind=purchase&name=MAZARIEGOES', { sid: staff });
    ck('STAFF can ask (they are the people typing the name)', s1.status === 200 && s1.json.suggestions[0].name === 'MAZARIEGOS', JSON.stringify([s1.status, s1.json]));
    const s2 = await req('GET', '/api/loads/party-similar?kind=sale&name=Metalco', { sid: admin });
    ck('the sale kind reads buyers, through the route', s2.status === 200 && s2.json.suggestions[0].name === 'Metalco Inc', JSON.stringify(s2.json));
    const s3 = await req('GET', '/api/loads/party-similar?kind=purchase&name=mazariegos', { sid: staff });
    ck('an existing name through the route is known', s3.json.known === true && !s3.json.suggestions.length);
    const s4 = await req('GET', '/api/loads/party-similar?kind=bogus&name=x', { sid: staff });
    ck('a bad kind is a 400, not a crash', s4.status === 400);
    const s5 = await req('GET', '/api/loads/party-similar?kind=purchase&name=MAZARIEGOES');
    ck('without signing in it is refused', s5.status === 401 || s5.status === 403, String(s5.status));
    ck('it is READ-ONLY: no yard record changed, and Edge Metals bytes are the same', JSON.stringify([fs.readFileSync(cfg.LOADS_FILE, 'utf8'), fs.readFileSync(cfg.OUTBOUND_LOADS_FILE, 'utf8')]) === before && metals() === metalsSnap);
    server.close();
}

section('C. the REAL client code in jsdom: website and phone');
{
    let JSDOM = null; try { ({ JSDOM } = require('jsdom')); } catch (e) { /* reported */ }
    ck('jsdom is available', !!JSDOM);
    for (const [label, file, saveFile] of [['website', 'dashboard/app/05-load-pricing.js', 'dashboard/app/13-loads-render.js'], ['phone', 'mobile-app/www/app/02-cache-catalogue.js', 'mobile-app/www/app/09-loads-deck.js']]) {
        if (!JSDOM) break;
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const i = src.indexOf('const partyAsked'), j = src.indexOf('\n}\n', src.indexOf('async function confirmPartyName')) + 3;
        const block = src.slice(i, j);
        ck(`${label}: the function is in the file`, i > 0 && j > i);
        const dom = new JSDOM('<body><input id="ld_seller"></body>', { runScripts: 'outside-only' });
        const w = dom.window;
        const calls = []; let answer = true, apiResult = { known: false, suggestions: [{ name: 'MAZARIEGOS', rows: 2, why: 'spelling' }] }, apiThrows = false, book = null;
        w.$ = (id) => w.document.getElementById(id);
        w.loadModalMode = 'purchase';
        w.addressBookExactMatch = () => book;
        w.api = async (url) => { calls.push(['api', url]); if (apiThrows) throw new Error('offline'); return apiResult; };
        w.askYesNo = async (m) => { calls.push(['ask', m]); return answer; };
        w.eval(block + '\nwindow.__c = confirmPartyName;');
        let blurred = 0; w.$('ld_seller').addEventListener('blur', () => { blurred++; });
        const run = async (value, mode) => { w.$('ld_seller').value = value; w.loadModalMode = mode || 'purchase'; calls.length = 0; await w.__c(); return w.$('ld_seller').value; };

        let v = await run('MAZARIEGOES');
        ck(`${label}: YES swaps in the existing spelling, and says how many records use it`, v === 'MAZARIEGOS' && calls.some((c) => c[0] === 'ask' && /same seller as "MAZARIEGOS"/.test(c[1]) && /2 saved records/.test(c[1])), JSON.stringify([v, calls]));
        ck(`${label}:   and re-runs the blur so a blank address fills from the address book`, blurred === 1);
        answer = false;
        v = await run('MAZARIEGUES');
        ck(`${label}: NO keeps exactly what was typed`, v === 'MAZARIEGUES');
        v = await run('MAZARIEGUES');
        ck(`${label}: the same name is not asked again this session`, !calls.length && v === 'MAZARIEGUES', JSON.stringify(calls));
        answer = true; apiResult = { known: true, suggestions: [] };
        v = await run('MAZARIEGOS Exact');
        ck(`${label}: a known name asks nothing`, !calls.some((c) => c[0] === 'ask') && v === 'MAZARIEGOS Exact');
        apiResult = { known: false, suggestions: [{ name: 'Metalco Inc', rows: 1, why: 'start' }] };
        v = await run('Metalco', 'sale');
        ck(`${label}: a sale asks the buyer question, through kind=sale`, calls.some((c) => c[0] === 'api' && /kind=sale/.test(c[1])) && calls.some((c) => c[0] === 'ask' && /same buyer as "Metalco Inc"/.test(c[1]) && /1 saved record\)\?/.test(c[1])) && v === 'Metalco Inc', JSON.stringify(calls));
        book = { aliases: ['Zed'] };
        v = await run('Zed Metals');
        ck(`${label}: a name saved in the address book on purpose is never questioned (no lookup at all)`, !calls.length && v === 'Zed Metals', JSON.stringify(calls));
        book = null; apiThrows = true;
        v = await run('Qwerty Scrap');
        ck(`${label}: a failed lookup is silent and the typed name stays`, v === 'Qwerty Scrap' && !calls.some((c) => c[0] === 'ask'));
        apiThrows = false;
        v = await run('   ');
        ck(`${label}: a blank name does nothing`, !calls.length);

        const sv = fs.readFileSync(path.join(ROOT, saveFile), 'utf8');
        const a = sv.indexOf("if (validationError) { $('loadModalErr').textContent = validationError; return; }");
        const b = sv.indexOf('await confirmPartyName();', a), c = sv.indexOf("btn.disabled = true; btn.textContent = 'Saving", a);
        ck(`${label}: the Save handler asks AFTER validation and BEFORE the button locks and the payload is read`, a > 0 && b > a && c > b, [a, b, c].join());
        ck(`${label}: it is called in exactly one place, the save (not on every keystroke, not on drafts)`, (sv.match(/confirmPartyName\(\)/g) || []).length === 1);
    }
    const pairs = [['index.html', 'mobile-app/www/index.html']];
    ck('phone assets match www for the two files changed', ['app/02-cache-catalogue.js', 'app/09-loads-deck.js'].every((f) => fs.readFileSync(path.join(ROOT, 'mobile-app/www', f), 'utf8') === fs.readFileSync(path.join(ROOT, 'mobile-app/android/app/src/main/assets/public', f), 'utf8')));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
