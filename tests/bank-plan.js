// ── tests/bank-plan.js ─────────────────────────────────────────────────────
// Apsara, 2026-10-13: "plan screen should be there na?" ... "apply for jarvis only".
//
// A carrier payment on the bank line (TQL / NTG / Schneider) with no bill behind it
// used to say "Add as a carrier bill" and offer nothing. Now the row opens a plan:
// add the carrier's bill, mark it paid by this line. Anyone who is an admin may
// PREVIEW (writes nothing). Only the Jarvis profile may APPLY.
//
//   A  the row offers a plan, and a hauler outside the three does not
//   B  preview: admin may, it writes nothing, it says "cannot be undone" up front
//   C  apply: admin refused, Jarvis profile applies, the books and the queue move
//   D  the retry: the same press twice applies once
//   E  wiring: the screen has the plan block, Apply only for the Jarvis profile
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-bplan-'));
process.env.DATA_DIR = TMP; process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-tx.json');
process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json');
process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa'; process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';
const R = (p) => path.join(ROOT, p);

const row = (o) => ({ id: 'r', date: '2026-10-07', desc: 'TQL freight', party: '', spent: 1200, received: 0, amount: 1200,
    direction: 'out', bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false, matched: null, history: [], ...o });
fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify([
    row({ id: 'tql1', desc: 'WIRE OUT TQL LLC' }),
    row({ id: 'zim1', desc: 'WIRE OUT ZIMEX', spent: 800, amount: 800, date: '2026-10-06' }),
]));

(async () => {
    const BB = require(R('helpers/booksBuild'));
    const CI = require(R('helpers/carrierInvoices'));
    const { createApi } = require(R('api'));
    const srv = http.createServer(createApi()).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const call = (method, p2, sid, body) => new Promise((resolve, reject) => {
        const d = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (sid) headers.Authorization = `Bearer ${sid}`;
        if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
        const r = http.request({ host: '127.0.0.1', port, path: p2, method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
        });
        r.on('error', reject); if (d) r.write(d); r.end();
    });
    const login = async (pw) => ((await call('POST', '/login', null, { password: pw })).json || {}).sid;
    const admin = await login(process.env.ADMIN_PASSWORD), jarvis = await login(process.env.JARVIS_PASSWORD), user = await login(process.env.APP_PASSWORD);
    ck('three sessions: user, admin, Jarvis profile', !!admin && !!jarvis && !!user);

    const queue = async () => ((await call('GET', '/api/bank/review', admin)).json.queue.rows || []);
    const PLAN = (o = {}) => ([
        { op: 'create-carrier-invoice', carrier: 'tql', ref: 'TQL-88231', amount: 1200, invoice_date: '2026-10-07', ...o },
        { op: 'pay-carrier-invoice', carrier_invoice_id: '#1', amount: 1200, date: '2026-10-07', mode: 'Bank transfer', bank: 'BofA' },
    ]);

    section('A. the row offers a plan');
    {
        const q = await queue();
        const t = q.find((r) => r.id === 'tql1'), z = q.find((r) => r.id === 'zim1');
        ck('a TQL payment is "Add as a carrier bill"', t && t.state === 'add' && t.kind === 'carrier-bill', JSON.stringify(t));
        ck('a Zimex payment is NOT (its bill comes from the sheet)', z && z.kind === 'party-invoice' && z.state === 'ask');
        const html = fs.readFileSync(R('dashboard/bank-match.html'), 'utf8');
        ck("the screen shows the plan block for carrier-bill rows and the categoriser for the rest", /r\.kind === 'carrier-bill' \? planHtml\(r\) : categoriseHtml\(r\)/.test(html));
    }

    section('B. preview — an admin may look, and it writes nothing');
    {
        const before = JSON.stringify(CI.list());
        const bad = await call('POST', '/api/ledger/plan/preview', admin, { plan: PLAN({ ref: '' }) });
        ck('a plan with no invoice number does not verify, and says why', bad.json.ok === false && (bad.json.problems || []).length, bad.raw.slice(0, 200));
        const wrong = await call('POST', '/api/ledger/plan/preview', admin, { plan: PLAN({ carrier: 'zimex' }) });
        ck('a hauler outside the three is refused in plain words', wrong.json.ok === false && /party register|not a carrier/.test(wrong.raw), wrong.raw.slice(0, 200));
        const pre = await call('POST', '/api/ledger/plan/preview', admin, { plan: PLAN() });
        ck('an admin previews a good plan', pre.status === 200 && pre.json.ok === true, pre.raw.slice(0, 200));
        ck('  in words, step by step', (pre.json.steps || []).length === 2 && /carrier bill/.test(pre.json.steps[0].says), JSON.stringify(pre.json.steps));
        ck('  and says up front that it cannot be undone', (pre.json.undo.irreversible || []).length === 2, JSON.stringify(pre.json.undo));
        ck('  and wrote nothing', JSON.stringify(CI.list()) === before);
        ck('a plain user cannot preview', (await call('POST', '/api/ledger/plan/preview', user, { plan: PLAN() })).status === 403);
    }

    section('C. apply — the Jarvis profile only');
    let pre, planId = 'bankrow-tql1-test';
    {
        pre = (await call('POST', '/api/ledger/plan/preview', admin, { plan: PLAN() })).json;
        const body = { plan: PLAN(), planId, asked: 'test', approvedDiff: pre.approvedDiff, approvedCarrierDiff: pre.approvedCarrierDiff };
        const denied = await call('POST', '/api/ledger/plan/apply', admin, body);
        ck('an ordinary admin cannot apply', denied.status === 403 && CI.list().length === 0, `${denied.status} ${denied.raw.slice(0, 120)}`);
        const ok = await call('POST', '/api/ledger/plan/apply', jarvis, body);
        ck('the Jarvis profile applies it', ok.status === 200 && ok.json.ok, ok.raw.slice(0, 300));
        const inv = CI.list().find((c) => c.ref === 'TQL-88231');
        ck('the carrier bill exists and is paid in full', inv && inv.amount === 1200 && inv.paid === 1200, JSON.stringify(inv));
        const lines = BB.build({}).lines.filter((l) => l.source && l.source.store === 'carrier_invoices' && l.account === '1010');
        ck('the books show 1,200 leaving the bank for it', lines.some((l) => l.credit === 1200), JSON.stringify(lines));
        const q = await queue();
        const t = q.find((r) => r.id === 'tql1');
        ck("the bank line is now a Match (it found the payment you just recorded)", t && t.state === 'match', JSON.stringify(t));
        const m = await call('POST', '/api/bank/review/match', admin, { id: 'tql1' });
        ck('and Match ties it off, leaving the queue', m.status === 200 && !(await queue()).some((r) => r.id === 'tql1'), m.raw.slice(0, 200));
        const log = await call('GET', '/api/ledger/plan/log', jarvis);
        ck('the applied plan is in the log, flagged as not undoable', log.status === 200 && log.json.rows.some((x) => x.applied && (x.irreversible || []).length), log.raw.slice(0, 200));
        ck('the log is closed to an ordinary admin', (await call('GET', '/api/ledger/plan/log', admin)).status === 403);
    }

    section('D. the retry');
    {
        const again = await call('POST', '/api/ledger/plan/apply', jarvis, { plan: PLAN(), planId, asked: 'test', approvedDiff: pre.approvedDiff, approvedCarrierDiff: pre.approvedCarrierDiff });
        ck('the same press twice is refused (409), not applied twice', again.status === 409 || again.status === 400, `${again.status} ${again.raw.slice(0, 160)}`);
        ck('  and there is still exactly one bill', CI.list().filter((c) => c.ref === 'TQL-88231').length === 1);
    }

    section('E. wiring');
    {
        const html = fs.readFileSync(R('dashboard/bank-match.html'), 'utf8');
        ck('the screen has preview and apply', /data-plan-preview/.test(html) && /data-plan-apply/.test(html));
        ck('  Apply only appears for the Jarvis profile', /IS_SUPER\s*\n?\s*\? `<div class="acts"[^`]*data-plan-apply/.test(html));
        ck('  and the banner no longer says the plan screen is "not built yet"', !/not built yet, so they are listed without a button/.test(html));
        ck('  and the page asks who is signed in', /api\/me/.test(html));
    }

    srv.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
