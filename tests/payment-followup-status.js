// Apsara, 2026-11-07: (1) customers on LC terms must NOT get chase/escalate notifications ("no");
// (2) the Payment follow-ups screen shows "asked 11/07 · chased 11/14" next to each customer ("yes").
// A: the rule + statusFor. B: END TO END (CLAUDE.md §3) - real sales, a real log written the way the agent writes it,
// the real server, the route the screen reads. Nothing is mailed.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pfstatus-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = 'user-pw-aaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbb'; process.env.STAFF_PASSWORD = 'staff-pw-ccc';
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const ch = require(path.join(ROOT, 'helpers/paymentChaser'));
const sales = require(path.join(ROOT, 'helpers/sales'));
const PF = require(path.join(ROOT, 'helpers/paymentFollowups'));
const gmail = require(path.join(ROOT, 'helpers/gmail'));
const mk = async (customer, invoice_no, date, weight, price, extra = {}) =>
    (await sales.addSale({ customer, invoice_no, date, item: 'Auto Cast', weight, invoice_price: price, price_unit: 'lb', weight_unit: 'lb', ...extra })).id;
const D = (s) => Date.parse(s + 'T15:00:00Z');

(async () => {
    let mailed = 0; gmail.sendEmail = async () => { mailed++; };
    const line = (id, terms) => ({ id, invoice_no: id, container_no: id, terms, due: '2026-10-01' });
    const tt = { customer: 'A', kind: 'remittance', total: 100, count: 1, lines: [line('S1', 'TT')] };
    const lc = { customer: 'B', kind: 'remittance', total: 100, count: 1, lines: [line('S2', 'LC')] };
    const mixed = { customer: 'C', kind: 'remittance', total: 200, count: 2, lines: [line('S3', 'LC'), line('S4', 'TT')] };
    const asked = (d, at) => ({ set: ch.setKey(d), firstAt: at, lastStep: 'ask', lastAt: at, steps: { ask: at } });

    section('A. LC terms: no notification at all');
    ck('LC customer: NOT EVEN the first note (Apsara, 2026-11-07: "no")', ch.nextAction(lc, undefined, D('2026-11-07')).step === null);
    ck('a mixed LC + T/T customer is still asked', ch.nextAction(mixed, undefined, D('2026-11-07')).step === 'ask');
    ck('LC customer, 8 days after asking: NO chase', ch.nextAction(lc, asked(lc, '2026-11-07T15:00:00Z'), D('2026-11-15')).step === null);
    ck('  and not at 30 days (no escalate either)', ch.nextAction(lc, { ...asked(lc, '2026-11-07T15:00:00Z'), lastStep: 'chase', lastAt: '2026-11-14T15:00:00Z' }, D('2026-12-07')).step === null);
    ck('T/T customer, same timing: chased', ch.nextAction(tt, asked(tt, '2026-11-07T15:00:00Z'), D('2026-11-15')).step === 'chase');
    ck('T/T customer 21+ days on: escalated', ch.nextAction(tt, { ...asked(tt, '2026-11-07T15:00:00Z'), lastStep: 'chase', lastAt: '2026-11-14T15:00:00Z' }, D('2026-12-01')).step === 'escalate');
    ck('mixed LC + T/T draft is still chased (a T/T invoice is owed)', ch.nextAction(mixed, asked(mixed, '2026-11-07T15:00:00Z'), D('2026-11-15')).step === 'chase');
    ck('LC match is on the terms word, not a substring ("LCL" is not LC)', !ch.isLcDraft({ lines: [line('X', 'LCL')] }) && ch.isLcDraft({ lines: [line('X', 'lc')] }));
    ck('no lines is not LC', !ch.isLcDraft({ lines: [] }));

    section('A2. statusFor / recorded');
    let log = {};
    log = ch.recorded(log, [{ key: ch.keyOf('A'), draft: tt, step: 'ask' }], D('2026-11-07'));
    log = ch.recorded(log, [{ key: ch.keyOf('A'), draft: tt, step: 'chase' }], D('2026-11-14'));
    const st = ch.statusFor(tt, log);
    ck('asked 11/07 and chased 11/14', st.asked === '11/07' && st.chased === '11/14' && !st.escalated, JSON.stringify(st));
    ck('never told: all null', ch.statusFor(lc, log).asked === null);
    ck('an old-format log entry (no steps) still shows its last step', ch.statusFor(tt, { a: { set: ch.setKey(tt), firstAt: 'x', lastStep: 'ask', lastAt: '2026-11-07T15:00:00Z' } }).asked === '11/07');
    ck('a NEW invoice set resets the status', ch.statusFor({ ...tt, lines: [line('S1', 'TT'), line('S9', 'TT')] }, log).asked === null);
    ck('LC flag is reported', ch.statusFor(lc, {}).lc === true && ch.statusFor(tt, {}).lc === false);

    section('B. END TO END: the route the screen reads');
    await sales.addSale({ customer: 'Daekwang', invoice_no: 'EM-1', date: '2026-09-01', item: 'Auto Cast', weight: 10000, invoice_price: 1, price_unit: 'lb', weight_unit: 'lb', container_no: 'AAAA1111111', booking_no: 'BK1', terms: 'TT' });
    await sales.addSale({ customer: 'Park Trading', invoice_no: 'EM-5', date: '2026-09-04', item: 'Auto Cast', weight: 3000, invoice_price: 1, price_unit: 'lb', weight_unit: 'lb', container_no: 'EEEE5555555', terms: 'LC' });
    await sales.addSale({ customer: 'Fresh Co', invoice_no: 'EM-7', date: '2026-09-05', item: 'Auto Cast', weight: 1000, invoice_price: 1, price_unit: 'lb', weight_unit: 'lb', container_no: 'FFFF7777777', terms: 'TT' });
    const b = PF.build();
    const byName = (n) => b.drafts.find((d) => d.customer === n);
    let lg = ch.recorded({}, [{ key: ch.keyOf('Daekwang'), draft: byName('Daekwang'), step: 'ask' }], D('2026-11-07'));
    lg = ch.recorded(lg, [{ key: ch.keyOf('Daekwang'), draft: byName('Daekwang'), step: 'chase' }], D('2026-11-14'));
    lg = ch.recorded(lg, [{ key: ch.keyOf('Park Trading'), draft: byName('Park Trading'), step: 'ask' }], D('2026-11-07'));
    ch.writeLog(lg);

    const { createApi } = require(path.join(ROOT, 'api'));
    const server = await new Promise((r) => { const s = createApi().listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { sid, body } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body); const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); }); });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    const sid = (await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json.sid;
    const g = (await req('GET', '/api/payment-followups', { sid })).json;
    const f = (n) => ((g.drafts || []).find((d) => d.customer === n) || {}).followup;
    ck('Daekwang: asked 11/07, chased 11/14 comes through the route', f('Daekwang') && f('Daekwang').asked === '11/07' && f('Daekwang').chased === '11/14', JSON.stringify(f('Daekwang')));
    ck('Park Trading (LC): flagged LC', f('Park Trading') && f('Park Trading').lc === true, JSON.stringify(f('Park Trading')));
    ck('Fresh Co: never asked', f('Fresh Co') && f('Fresh Co').asked === null && f('Fresh Co').lc === false, JSON.stringify(f('Fresh Co')));
    ck('the existing fields are untouched (total, lines, body, to)', byName('Daekwang').total === g.drafts.find((d) => d.customer === 'Daekwang').total && g.drafts.every((d) => Array.isArray(d.lines) && typeof d.body === 'string'));
    fs.rmSync(process.env.DATA_DIR + '/payment_chase_log.json', { force: true });
    const g2 = (await req('GET', '/api/payment-followups', { sid })).json;
    ck('no log file: the screen still loads, status empty', g2.drafts.length === 3 && g2.drafts.every((d) => d.followup && d.followup.asked === null));
    ck('nothing was mailed', mailed === 0);
    const ui = fs.readFileSync(path.join(ROOT, 'dashboard/app/07-bills-sales.js'), 'utf8');
    ck('the screen renders d.followup', /d\.followup/.test(ui) && /pfStatus/.test(ui));
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
