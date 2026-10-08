// ── tests/bank-review-route.js ────────────────────────────────────────────
// Apsara, 2026-10-08: "i want like pending,posted transactions like qb with
// match,post".
//
// helpers/bankOut.js and helpers/bankReview.js were both written this
// morning and reached by NOTHING. helpers/reconcile.js is the precedent and
// it is not hypothetical — it worked perfectly from 3 September and had no
// screen, so nobody used it. A helper with no route is the same defect one
// step earlier.
//
// So this file is mostly about reachability, and about the one thing the
// route deliberately does NOT do: reuse /api/bank/match's handler.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-revroute-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_TX_FILE = path.join(TMP, 'bank-transactions.json');
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}

(async () => {

// A bank row that left BofA, and a supplier payment in her books for the
// same money on the same day. The queue should call that a match.
const row = {
    id: 'bk1', date: '2026-04-10', desc: 'AJ TRANSPORT LLC ACH', party: 'AJ TRANSPORT LLC',
    category: '', spent: 2180, received: 0, amount: 2180, direction: 'out',
    bank: 'BofA', company: 'Edge Metals INC', pending: false, excluded: false,
};
const orphan = { ...row, id: 'bk2', date: '2026-04-12', spent: 955, amount: 955,
    desc: 'MONTHLY MAINTENANCE FEE', party: '' };
fs.writeFileSync(process.env.BANK_TX_FILE, JSON.stringify([row, orphan], null, 2));

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

const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;

// ── A — IT IS REACHABLE AT ALL ───────────────────────────────────────────
{
    section('A — the route exists and answers');
    ck('signed in', !!sid);
    const got = await req('GET', '/api/bank/review', { sid });
    ck('the route answers 200', got.status === 200, `${got.status} ${String(got.raw).slice(0, 160)}`);
    const d = got.json || {};
    ck('  with a queue', !!d.queue && Array.isArray(d.queue.rows), JSON.stringify(Object.keys(d)));
    ck('  and a line per bank in the chart', Array.isArray(d.banks) && d.banks.length >= 2,
       JSON.stringify((d.banks || []).map((b) => b.code)));
    ck('  and it needs a session', (await req('GET', '/api/bank/review')).status === 401);
}

// ── B — MONEY OUT IS IN THE QUEUE, WHICH IS THE WHOLE POINT ─────────────
// /api/bank/match is money IN only and always has been. Both withdrawals
// above must appear, because a page with the receipts on it and the
// payments somewhere else is how half a bank goes unlooked-at.
{
    section('B — withdrawals reach her');
    const d = (await req('GET', '/api/bank/review', { sid })).json;
    const ids = d.queue.rows.map((r) => r.id);
    ck('both withdrawals are in the queue', ids.includes('bk1') && ids.includes('bk2'),
       JSON.stringify(ids));
    ck('  every row is money out, since nothing came in', d.queue.rows.every((r) => r.direction === 'out'));

    const aj = d.queue.rows.find((r) => r.id === 'bk1');
    ck('the hauler is offered as a carrier bill — her wording',
       aj.state === 'add' && aj.label === 'Add as a carrier bill', JSON.stringify(aj));
    ck('  and carries the account it would post to', aj.account === '5200', aj.account);
    const fee = d.queue.rows.find((r) => r.id === 'bk2');
    ck('the bank fee is offered as a bank charge', fee.label === 'Add as a bank charge', fee.label);
    ck('every row says why', d.queue.rows.every((r) => String(r.why || '').trim().length > 0));
}

// ── C — THE INCOMPLETE-JOURNAL RULE, CARRIED HERE TOO ───────────────────
// Same as /api/bank/reconcile: an incomplete journal makes every figure a
// floor, and a queue built on one is missing payments. Saying so is not
// optional — a short queue reads as a quiet morning.
{
    section('C — it says when the books under it are incomplete');
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, JSON.stringify([{
        id: 'BROKEN', company: 'Edge Metals', key: 'ntg:NOBANK', carrier: 'ntg', ref: 'NOBANK',
        amount: 400, paid: 400, status: 'paid', invoice_date: '2026-04-02',
        paid_dates: ['2026-04-03'], source: 'manual',
    }], null, 2));
    const d = (await req('GET', '/api/bank/review', { sid })).json;
    ck('an unpostable entry makes the journal incomplete', d.journal.complete === false,
       JSON.stringify(d.journal));
    ck('  and the route says payments may be missing from the queue',
       /may be missing/.test(d.note || ''), String(d.note));
    fs.writeFileSync(cfg.CARRIER_INVOICES_FILE, '[]');
    const clean = (await req('GET', '/api/bank/review', { sid })).json;
    ck('  and says nothing when the journal is whole', clean.note === null, String(clean.note));
}

// ── D — THE TWO ROUTES MUST NOT DRIFT ───────────────────────────────────
// /api/bank/review deliberately does NOT reuse /api/bank/match's handler:
// that handler serves a live screen, the local store is empty, and an
// extraction cannot be proven behaviour-preserving against data nobody
// here has. helpers/partyName.js's rule is that an extraction changes
// nothing AND is proven by snapshot, and the snapshot is what is missing.
//
// The cost of not extracting is drift. This is what catches it: both
// routes read the same ledger, so a row excluded for one must be excluded
// for the other, and neither may invent a row the other cannot see.
{
    section('D — the two routes read the same ledger');
    const review = (await req('GET', '/api/bank/review', { sid })).json;
    const match = (await req('GET', '/api/bank/match', { sid })).json;
    ck('both routes answer', !!review && !!match);

    const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
    const all = ledger.list();
    const outIds = ledger.worklist(all).filter((r) => r.direction === 'out').map((r) => r.id).sort();
    ck('review covers exactly the OUT rows of the worklist',
       JSON.stringify(review.queue.rows.map((r) => r.id).sort()) === JSON.stringify(outIds),
       JSON.stringify({ queue: review.queue.rows.map((r) => r.id), outIds }));
    ck('  and match covers the IN rows, so together they are the worklist',
       (match.rows || []).every((r) => (r.deposit || {}).id !== 'bk1'),
       JSON.stringify((match.rows || []).map((r) => (r.deposit || {}).id)));

    // An excluded row must vanish from BOTH. If Exclude works on one screen
    // and not the other, the button is decoration on one of them.
    const ex = await req('POST', '/api/bank/exclude', { sid, body: { id: 'bk2', reason: 'not a business cost' } });
    ck('a row can be excluded', ex.status === 200, JSON.stringify(ex.json));
    const after = (await req('GET', '/api/bank/review', { sid })).json;
    ck('  and it leaves the review queue too', !after.queue.rows.some((r) => r.id === 'bk2'),
       JSON.stringify(after.queue.rows.map((r) => r.id)));
}

// ── E — AND A HUMAN CAN REACH IT ────────────────────────────────────────
// helpers/reconcile.js is the precedent: it worked perfectly from 3
// September and had no screen, so nobody used it. A route with no client
// is the same defect one step along, and these four helpers — bankOut,
// bankReview, ledgerPlan, ledgerApply — were all written today with
// nothing calling them.
{
    section('E — the screen actually calls it');
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/bank-match.html'), 'utf8');
    ck('bank-match.html fetches the review route', page.includes("api('/api/bank/review')"));
    // Unconditional, and from load(). `if (false) renderReview()` matched a
    // looser regex happily when I made this mistake on renderReconcile.
    const loadBody = page.slice(page.indexOf('async function load()'),
                                page.indexOf('async function showAliases'));
    ck('  from load(), so it is on screen without pressing anything',
       /\n\s*renderReview\(\);/.test(loadBody), loadBody.slice(0, 400));
    ck('  and the money-out section has its own place on the page',
       /id="review"/.test(page));
    // The bulk offer must say what it does NOT cover, or it reads like
    // QuickBooks' accept-all.
    ck('  the bulk offer says it is exact matches only',
       /Only exact matches/.test(page));
    // Buttons come from the server's state vocabulary; the page must not
    // invent an action the server will not perform.
    ck('  the button label comes from the server, not the page',
       /data-reviewact=.*\$\{esc\(r\.id\)\}/.test(page) && /\$\{esc\(r\.label\)\}/.test(page));
}

server.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
