// ── tests/ledger-plan-routes.js ───────────────────────────────────────────
// Apsara, 2026-10-08: "wire them".
//
// helpers/ledgerPlan.js and helpers/ledgerApply.js were both written today
// and reached by NOTHING — the state helpers/reconcile.js sat in from 3
// September, working perfectly, used by nobody. These two routes are what
// make them reachable, so this file is about reachability and about the
// split that makes the preview worth having.
//
// ── THE SPLIT IS THE SAFETY ─────────────────────────────────────────────
// Preview writes nothing; apply takes the diff the preview returned and
// refuses if the books moved. One route doing both would make that check
// impossible — there would be no moment at which she had seen a figure and
// not yet committed to it. Section C is that moment.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-planroute-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';
// The plan routes are SUPER only — a plan can delete a bill and move money
// between containers, which api.js already reserves for this profile.
process.env.JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || 'jarvis-pw-dddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}

(async () => {

const bills = require(path.join(ROOT, 'helpers/bills'));
await bills.addBill({ supplier: 'Hugo', date: '2025-12-30', container_no: 'TGHU1234567',
    supplier_price: 0.31 });
const made = bills.list().find((b) => b.container_no === 'TGHU1234567');

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
const superSid = await login(process.env.JARVIS_PASSWORD);
const adminSid = await login(process.env.ADMIN_PASSWORD);

// Her sentence, as a plan.
const PLAN = () => ([
    { op: 'detach-container', bill_id: made.id, container_no: 'TGHU1234567' },
    { op: 'create-bill', supplier: 'Hugo', date: '2026-01-03', container_no: 'TGHU1234567' },
]);

// ── A — WHO MAY DO THIS ──────────────────────────────────────────────────
{
    section('A — a plan is the Jarvis profile, not any admin');
    ck('signed in as super', !!superSid);
    ck('signed in as admin', !!adminSid);
    const asAdmin = await req('POST', '/api/ledger/plan/preview', { sid: adminSid, body: { plan: PLAN() } });
    ck('an ordinary admin is refused', asAdmin.status === 403, `${asAdmin.status} ${asAdmin.raw.slice(0, 120)}`);
    ck('  and told why it is reserved', /delete a bill|moves money/.test(asAdmin.raw), asAdmin.raw.slice(0, 160));
    ck('no session at all is 401', (await req('POST', '/api/ledger/plan/preview', { body: { plan: PLAN() } })).status === 401);
}

// ── B — PREVIEW WRITES NOTHING ───────────────────────────────────────────
{
    section('B — preview');
    const before = JSON.stringify(bills.list());
    const got = await req('POST', '/api/ledger/plan/preview', { sid: superSid, body: { plan: PLAN() } });
    ck('preview answers', got.status === 200, `${got.status} ${got.raw.slice(0, 160)}`);
    const d = got.json;
    ck('  it verifies', d.ok === true, JSON.stringify(d.problems));
    ck('  and reads back in words, not JSON',
       /take container TGHU1234567 off bill/.test(JSON.stringify(d.steps)), JSON.stringify(d.steps));
    ck('  with the per-supplier diff she would approve',
       Array.isArray(d.diff) && d.diff.some((r) => r.supplier === 'Hugo'), JSON.stringify(d.diff));
    ck('  and the undo, computed before anything happens', Array.isArray(d.reverse) && d.reverse.length === 2);
    ck('AND NOTHING WAS WRITTEN', JSON.stringify(bills.list()) === before);

    const bad = await req('POST', '/api/ledger/plan/preview', { sid: superSid,
        body: { plan: [{ op: 'detach-container', bill_id: 'NOPE', container_no: 'X' }] } });
    ck('a plan that does not verify comes back with problems', bad.json.ok === false
       && bad.json.problems.length > 0, JSON.stringify(bad.json));
    // A diff beside a refusal reads as something that is going to happen.
    ck('  and NO diff', bad.json.diff === null, JSON.stringify(bad.json.diff));

    // ── AND THE REFUSAL THAT HAPPENS *DURING* SIMULATION ─────────────────
    // The check above uses a plan that fails before simulation starts, so
    // there is no diff to leak and it passes however the code is written —
    // the mutation "preview hands back a diff for a plan it refused"
    // survived it, exactly as it did in tests/ledger-plan.js. This one
    // reaches a simulated world and is refused there, so a diff genuinely
    // exists and must still be withheld.
    const orphan = await req('POST', '/api/ledger/plan/preview', { sid: superSid, body: {
        plan: [{ op: 'detach-container', bill_id: made.id, container_no: 'TGHU1234567' }] } });
    ck('a plan refused DURING simulation is still refused', orphan.json.ok === false,
       JSON.stringify(orphan.json.problems));
    ck('  and still hands back no diff', orphan.json.diff === null, JSON.stringify(orphan.json.diff));
    ck('a missing plan is a 400', (await req('POST', '/api/ledger/plan/preview',
        { sid: superSid, body: {} })).status === 400);
}

// ── C — THE MOMENT BETWEEN SEEING AND COMMITTING ─────────────────────────
// The whole reason preview and apply are two routes.
{
    section('C — apply, and the world-moved check');
    const noId = await req('POST', '/api/ledger/plan/apply', { sid: superSid, body: { plan: PLAN() } });
    ck('an apply with no planId is refused', noId.status === 400, JSON.stringify(noId.json));
    // The id must come from the CLIENT so a retry of the same press carries
    // the same one. Minting it server-side would give every retry a new id
    // and defeat the check entirely.
    ck('  and says why — a retry must not apply it twice',
       /twice/.test(JSON.stringify(noId.json)), JSON.stringify(noId.json));

    const stale = [{ supplier: 'Hugo', billed: { before: 1, after: 2 }, paid: { before: 0, after: 0 },
        owed: { before: 1, after: 2 }, bills: { before: 99, after: 100 },
        containers: { before: 0, after: 0 } }];
    const moved = await req('POST', '/api/ledger/plan/apply', { sid: superSid,
        body: { plan: PLAN(), planId: 'P1', approvedDiff: stale } });
    ck('an apply against figures she never saw is refused', moved.status === 409,
       `${moved.status} ${moved.raw.slice(0, 200)}`);
    ck('  as a 409, because the request was fine and the state is not', moved.status === 409);
    ck('  and nothing was applied', moved.json.applied === false);

    // The real one: preview, then apply with exactly what the preview said.
    const pre = (await req('POST', '/api/ledger/plan/preview', { sid: superSid, body: { plan: PLAN() } })).json;
    const ok = await req('POST', '/api/ledger/plan/apply', { sid: superSid,
        body: { plan: PLAN(), planId: 'P2', asked: 'move it to a new bill on 3 Jan',
                approvedDiff: pre.approvedDiff } });
    ck('preview then apply works', ok.status === 200 && ok.json.ok === true, JSON.stringify(ok.json));
    ck('  and the container really moved',
       bills.list().filter((b) => b.container_no === 'TGHU1234567').length === 1
       && (bills.list().find((b) => b.id === made.id) || {}).container_no !== 'TGHU1234567');

    // Idempotency, through the route this time.
    const twice = await req('POST', '/api/ledger/plan/apply', { sid: superSid,
        body: { plan: PLAN(), planId: 'P2', approvedDiff: pre.approvedDiff } });
    ck('the same planId cannot be applied twice', twice.status === 409,
       `${twice.status} ${twice.raw.slice(0, 160)}`);
}

// ── D — THE LOG IS READABLE ──────────────────────────────────────────────
// Apsara: "make it log every change we are doing in qb/books so that we can
// check it later." A log nothing can read is a log nobody checks.
{
    section('D — reading the log back');
    const got = await req('GET', '/api/ledger/plan/log', { sid: superSid });
    ck('the log route answers', got.status === 200, `${got.status} ${got.raw.slice(0, 120)}`);
    const rows = (got.json || {}).rows || [];
    ck('  and the applied plan is in it', rows.some((r) => r.applied === true), JSON.stringify(rows.length));
    const applied = rows.find((r) => r.applied === true);
    ck('  carrying HER WORDS', /move it to a new bill on 3 Jan/.test(applied.asked || ''), applied.asked);
    ck('  the steps in words', Array.isArray(applied.steps) && applied.steps.length === 2);
    ck('  the figures as they were', Array.isArray(applied.diff));
    ck('  and the undo, so undoing is reading the log rather than recomputing',
       Array.isArray(applied.reverse) && applied.reverse.length === 2, JSON.stringify(applied.reverse));
    ck('an ordinary admin cannot read it either',
       (await req('GET', '/api/ledger/plan/log', { sid: adminSid })).status === 403);
}

server.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
