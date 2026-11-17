// Apsara 2026-11-18: "when i click send to whatsapp in loads, to whatever i type 9 is getting auto appended".
// A 10-digit number used to get India's 91 put in front. She chose: add nothing. End to end + all client copies.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0; const ck = (n, c) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + n); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phone-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');
(async () => {
    const app = require(path.join(ROOT, 'api')).createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const req = (m, p, body, sid) => new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null; const h = {}; if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); } if (sid) h.Authorization = 'Bearer ' + sid; const q = http.request(`http://127.0.0.1:${server.address().port}${p}`, { method: m, headers: h }, (r) => { let raw = ''; r.on('data', (c) => raw += c); r.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} res({ status: r.statusCode, json: j }); }); }); q.on('error', rej); if (d) q.write(d); q.end(); });
    const sid = (await req('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json.sid;
    const mk = (phone) => req('POST', '/api/loads', { date: '2026-11-18', seller: 'Hugo', buyer: 'Edge Trading', seller_phone: phone, items: [{ description: 'Rotors', gross_weight: 1000, tare_weight: 0, price: 0.3, unit: 'lb' }] }, sid);
    const phoneOf = async (r) => { const id = (r.json.load || r.json).id; const all = (await req('GET', '/api/loads', null, sid)).json; return (Array.isArray(all) ? all : all.loads).find((l) => l.id === id).seller_phone; };
    ck('10 digits are saved exactly as typed (no 91 in front)', await phoneOf(await mk('8056944193')) === '8056944193');
    ck('punctuation is stripped, digits kept as typed', await phoneOf(await mk('(805) 694-4193')) === '8056944193');
    ck('a number typed with its country code is untouched', await phoneOf(await mk('+1 805 694 4193')) === '18056944193');
    ck('blank stays empty', await phoneOf(await mk('')) == null);
    server.close();
    for (const f of ['dashboard/app/01-core.js', 'mobile-app/www/app/01-core.js', 'mobile-app/android/app/src/main/assets/public/app/01-core.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const body = src.slice(src.indexOf('function normalizeSellerPhone'), src.indexOf('\n}', src.indexOf('function normalizeSellerPhone')) + 2);
        const fn = new Function(body + '; return normalizeSellerPhone;')();
        ck(f + ': 10 digits unchanged', fn('8056944193') === '8056944193' && fn('') === null);
    }
    for (const f of ['dashboard/app/13-loads-render.js', 'mobile-app/www/app/09-loads-deck.js']) ck(f + ': no "auto-added" promise left on the box', !/country code auto-added/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
