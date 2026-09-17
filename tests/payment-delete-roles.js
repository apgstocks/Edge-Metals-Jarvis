// ── tests/payment-delete-roles.js ─────────────────────────────────────────
// Apsara, 2026-09-16: "also in receive payment-what if i mistakenly added
// something-->give delete partial payment to admin..all types to jarvis
// profile".
//
// Asked what "partial payment" meant she chose "one payment out of several";
// asked which types Jarvis should own, "the Edge Metals ledgers too"; asked
// whether an admin deletion should be logged, "Log every deletion".
//
// ── WHAT THIS TURNED OUT TO BE ──────────────────────────────────────────
// The delete already existed. What did not exist was any permission on it:
// DELETE /api/payments/:id had NO gate at all, so the plain 'user' role could
// remove a payment from either client, and the ✕ was drawn for everyone who
// could open the box. Staff were stopped only because the whole /api/payments
// path is off their allowlist — which is a different mechanism that happens
// to cover one role. So this file is mostly about a hole that was already
// open, not a feature that was added.
//
// Driven over REAL HTTP against a real session for each role. A source grep
// would prove the middleware is written; only a request proves it runs, and
// route gating is exactly the kind of thing that reads correct and is wired
// to nothing.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-paydel-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD    = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD  = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD  = 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }
const { createApi } = require(path.join(ROOT, 'api'));

let server, base;
function req(method, p, { body, sid } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
}
const login = async (pw) => (await req('POST', '/login', { body: { password: pw } })).json;

(async () => {

const app = createApi();
await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
base = `http://127.0.0.1:${server.address().port}`;

const jarvis = await login(process.env.JARVIS_PASSWORD);
const admin  = await login(process.env.ADMIN_PASSWORD);
const user   = await login(process.env.APP_PASSWORD);
const staff  = await login(process.env.STAFF_PASSWORD);
const sid = (s) => (s && (s.session_id || s.sid || s.token)) || null;

section('A — the four profiles are what they claim to be');
{
    const me = async (s) => (await req('GET', '/api/me', { sid: sid(s) })).json || {};
    const mj = await me(jarvis), ma = await me(admin), mu = await me(user), ms = await me(staff);
    ck('jarvis is an admin session carrying super', mj.role === 'admin' && mj.super === true,
       JSON.stringify(mj) + ' — Jarvis is not a fourth role, it is admin + a flag');
    ck('  admin is admin WITHOUT super', ma.role === 'admin' && ma.super !== true, JSON.stringify(ma));
    ck('  user is user', mu.role === 'user' && mu.super !== true, JSON.stringify(mu));
    ck('  staff is staff', ms.role === 'staff', JSON.stringify(ms));
}

// A real load with a real payment, so the deletes below act on something.
async function makePaidLoad(as) {
    const load = (await req('POST', '/api/loads', { sid: sid(as), body: {
        date: '2026-09-14', seller: 'Ramesh', buyer: 'Edge Trading', weight_unit: 'lb',
        items: [{ description: 'Al combo', gross_weight: 1000, tare_weight: 0, price: 1 }],
    } })).json;
    const id = load && (load.id || (load.load && load.load.id));
    // Two payments, so removing one leaves the load PARTLY paid — her case,
    // in her words: "one payment out of several".
    const pay = async (amount) => (await req('POST', '/api/payments', { sid: sid(as), body: {
        // 'Bank transfer', not 'Wire' — a YARD purchase takes Cash or Bank
        // transfer only since 2026-09-16 (YARD_LOAD_MODES). What this file
        // tests is who may DELETE a payment, which is unchanged.
        load_id: id, load_kind: 'purchase', mode: 'Bank transfer', bank: 'Chase Bank', amount, paid_on: '2026-09-14',
        // 2026-09-17: a yard purchase by Bank transfer records whose money.
        paid_via: 'Edge Yard',
    } })).json;
    const p1 = await pay(400), p2 = await pay(300);
    return { loadId: id, p1: p1 && (p1.id || (p1.payment && p1.payment.id)), p2: p2 && (p2.id || (p2.payment && p2.payment.id)) };
}

section('B — a yard payment: admin may, user may not');
{
    const { loadId, p1, p2 } = await makePaidLoad(admin);
    ck('the fixture built a load with two payments', !!loadId && !!p1 && !!p2,
       JSON.stringify({ loadId, p1, p2 }));

    // ── THE HOLE THIS CLOSED ─────────────────────────────────────────────
    // Before 2026-09-16 this route had no gate whatsoever. 'user' is a real
    // sign-in tier in this app, so this was not theoretical.
    const asUser = await req('DELETE', `/api/payments/${p1}`, { sid: sid(user) });
    ck('a plain user is REFUSED', asUser.status === 403,
       `got ${asUser.status} ${JSON.stringify(asUser.json)} — this route had no gate at all until today`);

    const asStaff = await req('DELETE', `/api/payments/${p1}`, { sid: sid(staff) });
    ck('  staff are refused too', asStaff.status === 403, `got ${asStaff.status}`);

    const asAdmin = await req('DELETE', `/api/payments/${p1}`, { sid: sid(admin) });
    ck('  an admin may remove one payment of several', asAdmin.status === 200 && asAdmin.json && asAdmin.json.removed,
       `got ${asAdmin.status} ${JSON.stringify(asAdmin.json)}`);

    // The point of removing it: the money is owed again.
    const after = (await req('GET', '/api/loads', { sid: sid(admin) })).json || [];
    const row = (Array.isArray(after) ? after : []).find((l) => l.id === loadId);
    ck('  and the load goes back to owing that money',
       row && row.payment && Math.abs(row.payment.paid - 300) < 0.005,
       JSON.stringify(row && row.payment));
    ck('  the OTHER payment is untouched', row && row.payment && (row.payment.payments || []).length === 1,
       'deleting one entry must not take its neighbours with it');

    const asJarvis = await req('DELETE', `/api/payments/${p2}`, { sid: sid(jarvis) });
    ck('  and Jarvis may too', asJarvis.status === 200, `got ${asJarvis.status}`);
}

section('C — the Edge Metals ledgers are Jarvis-only');
{
    // Her answer when asked which types: "The Edge Metals ledgers too".
    // A supplier bill payment or a customer receipt does not just remove a
    // row — it moves a supplier's running account, reopens containers, or
    // moves a customer's balance. Those are the books the business is judged
    // on, which is why the line is drawn by BOOK rather than by amount.
    const paths = ['/api/bill-payments/BPAY_x', '/api/sales-receipts/RCPT_x',
                   '/api/sales-settlements/STL_x', '/api/metals-trucking/MT_x'];
    for (const p of paths) {
        const a = await req('DELETE', p, { sid: sid(admin) });
        ck(`admin is refused ${p.split('/')[2]}`, a.status === 403,
           `got ${a.status} ${JSON.stringify(a.json)}`);
        ck(`  and the refusal says what to do about it`,
           a.json && a.json.code === 'JARVIS_PROFILE_REQUIRED' && /Jarvis profile/i.test(a.json.error || ''),
           JSON.stringify(a.json) + ' — "403" alone tells her nothing she can act on');
        const u = await req('DELETE', p, { sid: sid(user) });
        ck(`  a plain user too`, u.status === 403, `got ${u.status}`);

        // Jarvis gets PAST the gate. The id is invented, so the route answers
        // 404/200/500 depending on the handler — what matters is that it is
        // no longer 403, i.e. the gate is what changed and nothing else.
        const j = await req('DELETE', p, { sid: sid(jarvis) });
        ck(`  Jarvis is let through`, j.status !== 403,
           `got ${j.status} — the id is invented, so anything but 403 means the gate opened`);
    }
}

section('D — every deletion is written down, not just Jarvis\'s');
{
    // This was wrapped in `if (isSuper(req))`, so an ADMIN removing a payment
    // left no trace at all — money could leave the books with nothing saying
    // who took it out. Asked directly, she chose to log every deletion.
    const { p1 } = await makePaidLoad(admin);
    await req('DELETE', `/api/payments/${p1}`, { sid: sid(admin) });

    const audit = require(path.join(ROOT, 'helpers/audit'));
    const rows = audit.listEntries() || [];
    const mine = rows.filter((r) => r && r.action === 'delete-payment' && r.subject === String(p1));
    ck('an ADMIN deletion is in the audit log', mine.length >= 1,
       `${rows.length} audit rows, ${mine.length} for this payment`);
    const e = mine[0] || {};
    ck('  naming the role that did it', e.role === 'admin', JSON.stringify({ role: e.role, actor: e.actor }));
    ck('  and it is not attributed to jarvis', e.actor !== 'jarvis',
       'actorOf() returns "jarvis" only for a super session — an admin deletion must not read as one');
    ck('  with the load, the amount and the mode on the row',
       e.detail && e.detail.load_id && e.detail.amount === 400 && e.detail.mode === 'Bank transfer',
       JSON.stringify(e.detail) + ' — "something was deleted" is not an audit trail');
    ck('  and the row is stamped as completed', e.outcome === 'done' && !!e.completed_at,
       JSON.stringify({ outcome: e.outcome, completed_at: e.completed_at }) +
       ' — recorded BEFORE the delete and stamped after, so a crash between the two still leaves a row');

    // ── THE ATTEMPT THAT FOUND NOTHING ───────────────────────────────────
    // Only the happy path was checked at first, and a mutation returning
    // early when the payment did not exist survived: the audit row sat at
    // 'started' for ever, which is indistinguishable in the log from a crash
    // mid-delete. A deletion attempt against an id that is not there is not
    // an error worth hiding — it is someone double-tapping, or a stale screen,
    // and the log should say plainly that nothing was removed.
    const ghost = await req('DELETE', '/api/payments/PAY_does_not_exist', { sid: sid(admin) });
    ck('an attempt on a payment that is not there still answers', ghost.status === 200,
       `got ${ghost.status} ${JSON.stringify(ghost.json)}`);
    ck('  reporting that nothing was removed', ghost.json && ghost.json.removed === false,
       JSON.stringify(ghost.json));
    const ghostRows = (audit.listEntries() || []).filter((r) => r && r.subject === 'PAY_does_not_exist');
    ck('  and it is logged, not swallowed', ghostRows.length >= 1,
       'an attempt to delete money is worth a line whether or not it found anything');
    ck('  with the row CLOSED as failed, never left at "started"',
       ghostRows[0] && ghostRows[0].outcome === 'failed' && !!ghostRows[0].completed_at,
       JSON.stringify(ghostRows[0] && { outcome: ghostRows[0].outcome, completed_at: ghostRows[0].completed_at }) +
       ' — a row stuck at "started" reads exactly like a crash mid-delete');
}

section('E — the buttons match the rules');
{
    // UI guards, not security — every one of these hits a route that rechecks.
    // Asserted so a button is not offered that the server will refuse, which
    // reads to her as the app being broken.
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    const app2 = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');

    for (const [label, src] of [['website', web], ['app', app2]]) {
        ck(`${label}: the ✕ on a payment is admin-only`,
           /payCanDelete\(\) \? `<button class="btn btn-danger btn-del-pay"/.test(src),
           'it was drawn for everyone who could open the Receive payment box');
        ck(`${label}:   and payCanDelete asks the role`,
           /function payCanDelete\(\)\s*\{\s*return ROLE === 'admin';/.test(src.replace(/\n\s*/g, ' ')),
           'a stricter or looser rule here silently disagrees with the server');
    }
    ck('website: the supplier-payment Delete is Jarvis-only',
       /metalsCanDelete\(\) \? `<button class="bpDel"/.test(web));
    ck('  and so is the customer-receipt Delete',
       /metalsCanDelete\(\) \? `<button class="rcpt-del"/.test(web));
    ck('  with metalsCanDelete reading the super flag',
       /function metalsCanDelete\(\)\s*\{\s*return IS_SUPER === true;/.test(web.replace(/\n\s*/g, ' ')));
    // Hiding it is not enough on its own: she has to know why it is gone.
    ck('  and a hidden Delete says how to get it back',
       /Jarvis profile to remove a receipt/.test(web) && /Jarvis profile to remove a supplier payment/.test(web),
       'a button that simply vanishes reads as a bug, not as a rule');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
server.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); try { server.close(); } catch {} process.exit(1); });
