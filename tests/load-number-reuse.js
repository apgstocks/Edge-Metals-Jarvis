// ── tests/load-number-reuse.js — what happens to a load number when a load is deleted ──
//
// Apsara, 2026-11-19: "if a load is deleted and it is the highest number in the load and no any further loads,
// then it can reset the next load no to deleted" — and asked whether a deleted MIDDLE number should be filled in:
// "No". Both are how nextLoadId / nextOutboundId already work (highest number still on file, plus one). These checks
// pin it END TO END, through the routes the website and the phone app both call, so a later change to numbering
// cannot quietly break it:
//   1. delete the newest load  -> the next load gets its number back
//   2. delete a middle load    -> the gap stays; the next load is highest + 1
//   3. the same two rules for sales (OUT_ numbers)
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-loadnum-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
const ROOT = path.join(__dirname, '..');

(async () => {
    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;
    const req = (method, p, body, sid) => new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null; const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = 'Bearer ' + sid;
        const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json, raw }); });
        });
        r.on('error', () => resolve({ status: 0 })); if (data) r.write(data); r.end();
    });
    try {
        // staff: the yard hands who create and delete loads every day
        const sid = ((await req('POST', '/login', { password: process.env.STAFF_PASSWORD })).json || {}).sid;
        ck('signed in as yard staff', !!sid);
        const item = [{ description: 'Rotors', gross_weight: 1000, tare_weight: 100, price: 0.12, unit: 'lb' }];
        const newLoad = async () => { const r = await req('POST', '/api/loads', { date: '2026-11-19', seller: 'Randy Recycling', items: item }, sid); return r.json && r.json.load && r.json.load.id; };
        const del = async (id) => (await req('DELETE', '/api/loads/' + encodeURIComponent(id), null, sid)).status;

        section('1 — loads: the newest one deleted gives its number back');
        const a = await newLoad(), b = await newLoad();
        const prefix = (a || '').replace(/\d+$/, '');
        ck('two loads in sequence', /_01$/.test(a || '') && /_02$/.test(b || ''), `${a} ${b}`);
        ck('the newest is deleted', await del(b) === 200);
        const c = await newLoad();
        ck('the next load takes the deleted number (02, not 03)', c === b, c);

        section('2 — loads: a deleted middle number stays a gap');
        const d = await newLoad();                                  // 03
        ck('a third load', d === prefix + '03', d);
        ck('the middle one (02) is deleted', await del(c) === 200);
        const e = await newLoad();
        ck('the next load is highest + 1 (04), the gap is not filled', e === prefix + '04', e);

        section('3 — sales follow the same two rules');
        const admin = ((await req('POST', '/login', { password: process.env.ADMIN_PASSWORD })).json || {}).sid;
        const newSale = async () => { const r = await req('POST', '/api/outbound-loads', { date: '2026-11-19', buyer: 'Gulf Export Co', items: item }, admin); const o = r.json && (r.json.load || r.json.outbound || r.json); return o && o.id; };
        const delSale = async (id) => (await req('DELETE', '/api/outbound-loads/' + encodeURIComponent(id), null, admin)).status;
        const s1 = await newSale(), s2 = await newSale();
        ck('two sales in sequence', /^OUT_01$/.test(s1 || '') && /^OUT_02$/.test(s2 || ''), `${s1} ${s2}`);
        ck('the newest sale is deleted', await delSale(s2) === 200);
        const s3 = await newSale();
        ck('the next sale takes the deleted number back', s3 === 'OUT_02', s3);
        const s4 = await newSale();
        ck('the newest sale after that is OUT_03', s4 === 'OUT_03', s4);
        await delSale(s3);
        const s5 = await newSale();
        ck('a deleted middle sale stays a gap (next is OUT_04)', s5 === 'OUT_04', s5);
    } finally {
        server.close();
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* runner cleans tmp */ }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
