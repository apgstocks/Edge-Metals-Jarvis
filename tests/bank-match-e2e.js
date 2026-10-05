// ── tests/bank-match-e2e.js ───────────────────────────────────────────────
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
//
// bankMatch.js has 57 checks and bankLearn.js has 45, and both could be green
// while the feature does not work at all. The gaps CLAUDE.md names live
// between them, and every one of them is live in this feature:
//
//   · the route does not forward the learned patterns to the engine;
//   · the route reads `amount` where sales.js means `receivable`;
//   · the screen posts `descriptor` and the route reads `description`;
//   · the match is proposed and confirming it changes no balance.
//
// So this starts a real server, signs in, puts a deposit where the Plaid sync
// would put one, reads the match off the route the screen actually calls,
// confirms it through the route the receipts screen actually posts to, and
// reads the balance back out. A DELTA, not an absolute — earlier sections
// write to the same store, and a check that breaks when a fixture moves is a
// check that gets deleted.

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bankmatch-e2e-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.BANK_LEARN_FILE = path.join(TMP, 'bank-learn.json');
process.env.QB_DECISIONS_FILE = path.join(TMP, 'qb-decisions.json');
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}
if (!String(cfg.BANK_TX_FILE).startsWith(TMP)) {
    console.error('  ABORT  BANK_TX_FILE is ' + cfg.BANK_TX_FILE);
    process.exit(1);
}

let server = null;

(async () => {

const { createApi } = require(path.join(ROOT, 'api'));
const app = createApi();
server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (sid) headers.Authorization = `Bearer ${sid}`;
    const r2 = http.request(base + p, { method, headers }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j, raw }); });
    });
    r2.on('error', reject); if (data) r2.write(data); r2.end();
});

const sales = require(path.join(ROOT, 'helpers/sales'));
const receipts = require(path.join(ROOT, 'helpers/salesReceipts'));

const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
const userSid = ((await req('POST', '/login', { body: { password: process.env.APP_PASSWORD } })).json || {}).sid;

// Three invoices for one customer, written through the helper the Sales form
// uses — not poked into JSON, because the point is to match against what the
// real screen would have created.
const mk = async (customer, invoice_no, date, weight, price) =>
    (await sales.addSale({ customer, invoice_no, date, item: 'Auto Cast',
        weight, invoice_price: price, price_unit: 'lb', weight_unit: 'lb' })).id;

const balanceOf = (id) => {
    const row = sales.listWithTotals().find((s) => s.id === id);
    return row ? Math.round(Number(row.balance) * 100) / 100 : null;
};

// ── DEPOSITS GO IN THE WAY THE PLAID SYNC WILL PUT THEM ──────────────────
// Through helpers/bankLedger.fromPlaid, not as raw Plaid JSON. The route
// reads bankLedger rows (spent/received/direction), and when it read raw
// signed amounts instead, every deposit was taken for a withdrawal and
// nothing matched. Writing raw rows here would hide exactly that class of
// break, which is the whole point of an end-to-end test.
const ledger = require(path.join(ROOT, 'helpers/bankLedger'));
const ACCOUNTS = [
    // swift is what identifies the institution unambiguously, and is how the
    // route guesses which account to pre-fill on the Confirm form. A guess on
    // the institution NAME put Chase on the Bank of America account.
    { id: 'bofa-1', company: 'Edge Metals INC', bank: 'Bank of America, N.A.', swift: 'BOFAUS3N' },
    { id: 'chase-1', company: 'EDGE TRADING INC', bank: 'JPMorgan Chase Bank, N.A.', swift: 'CHASUS33' },
    { id: 'wells-9', company: 'Edge Metals INC', bank: 'Wells Fargo', swift: 'WFBIUS6S' },
];
const putDeposits = (rows) => fs.writeFileSync(cfg.BANK_TX_FILE,
    JSON.stringify(rows.map((x) => ledger.fromPlaid(x, ACCOUNTS)).filter(Boolean), null, 1));

(async () => {})();

// ── A — THE ROUTE IS REACHABLE AND HONEST WHEN THERE IS NO FEED ───────────
{
    section('A — before any feed, it says so rather than showing a clean slate');

    const r = await req('GET', '/api/bank/match', { sid });
    ck('the route answers', r.status === 200, r.status + ' ' + String(r.raw).slice(0, 200));
    ck('  with no deposits', r.json.counts.deposits === 0, JSON.stringify(r.json.counts));
    ck('  and says there is no feed, not that everything reconciles',
       /none yet/.test(r.json.feed), String(r.json.feed));
    ck('  signing in is required', (await req('GET', '/api/bank/match')).status === 401,
       'the bank statement is not public');
}

// ── B — ONE DEPOSIT, THREE INVOICES, END TO END ───────────────────────────
let S1, S2, S3;
{
    section('B — a combined payment, found over the wire');

    S1 = await mk('Custom Alloys', 'EM-1001', '2026-08-01', 1000, 18);   // 18,000
    S2 = await mk('Custom Alloys', 'EM-1002', '2026-08-14', 1000, 22);   // 22,000
    S3 = await mk('Custom Alloys', 'EM-1003', '2026-08-20', 1000, 7);    //  7,000
    ck('three invoices exist, with the balances the Sales screen computes',
       balanceOf(S1) === 18000 && balanceOf(S2) === 22000 && balanceOf(S3) === 7000,
       [balanceOf(S1), balanceOf(S2), balanceOf(S3)].join(' / '));

    // Where the Plaid sync writes. NEGATIVE amount = money in, which is the
    // convention reconcile.js documents and which this file is the end-to-end
    // proof of: if the sign were read backwards nothing below would match.
    putDeposits([
        { transaction_id: 'TX-1', date: '2026-09-05', amount: -47000,
          name: 'WIRE IN CUSTOM-ALLOYS LLC REF 88213', account_id: 'bofa-1' },
    ]);

    let r = await req('GET', '/api/bank/match', { sid });
    const row = r.json.rows[0];
    ck('the deposit arrives on the route', r.json.counts.deposits === 1, JSON.stringify(r.json.counts));
    ck('  but the payer is not recognised yet', row.outcome === 'no_party', row.outcome);
    ck('  and the customer is offered as a SUGGESTION',
       (row.suggestions || []).some((s) => s.customer === 'Custom Alloys'),
       JSON.stringify(row.suggestions));
    ck('  which has not resolved anything on its own',
       (row.proposals || []).length === 0, 'a suggestion is not a decision');

    // She answers once. THROUGH THE ROUTE.
    const learn = await req('POST', '/api/bank/aliases', { sid,
        body: { descriptor: 'WIRE IN CUSTOM-ALLOYS LLC REF 88213', customer: 'Custom Alloys', why: 'confirmed on the review screen' } });
    ck('teaching it the name goes through the route', learn.status === 200, learn.status + ' ' + String(learn.raw).slice(0, 160));
    ck('  and a non-admin cannot teach it',
       (await req('POST', '/api/bank/aliases', { sid: userSid, body: { descriptor: 'X', customer: 'Custom Alloys' } })).status === 403,
       'an alias decides whose invoices a deposit may pay');

    r = await req('GET', '/api/bank/match', { sid });
    const now = r.json.rows[0];
    ck('after one answer the same deposit resolves', now.outcome === 'proposed', now.outcome);
    const p = (now.proposals || [])[0];
    ck('  and the combination is found across all three invoices',
       p && p.allocations.length === 3, JSON.stringify(p && p.allocations.map((a) => a.doc_id)));
    ck('  summing exactly to the deposit',
       p && Math.abs(p.allocations.reduce((t, a) => t + a.amount, 0) - 47000) < 0.005,
       JSON.stringify(p && p.allocations.map((a) => a.amount)));
    ck('  labelled with her invoice numbers, not internal ids',
       p && p.allocations.every((a) => /EM-100/.test(a.label)),
       JSON.stringify(p && p.allocations.map((a) => a.label)));
    ck('  with the reason in words', p && p.reasons.some((x) => /add up to this deposit exactly/.test(x)),
       JSON.stringify(p && p.reasons));

    // ── CONFIRM. Through the receipts route, not a second write path. ─────
    const before = [balanceOf(S1), balanceOf(S2), balanceOf(S3)];
    const post = await req('POST', '/api/sales-receipts', { sid, body: {
        date: '2026-09-05', amount: 47000, mode: 'Wire', bank: 'BofA', customer: 'Custom Alloys',
        ref: 'TX-1', allocations: p.allocations.map((a) => ({ sale_id: a.doc_id, amount: a.amount })),
    } });
    ck('confirming posts through POST /api/sales-receipts', post.status === 200,
       post.status + ' ' + String(post.raw).slice(0, 200));

    const after = [balanceOf(S1), balanceOf(S2), balanceOf(S3)];
    // DELTAS. The absolute figures depend on every fixture above.
    ck('  and all three balances move to nil',
       after.every((b) => b === 0), `${before.join('/')} -> ${after.join('/')}`);
    ck('  by exactly the deposit, in total',
       Math.abs(before.reduce((a, b) => a + b, 0) - after.reduce((a, b) => a + b, 0) - 47000) < 0.005,
       `${before.join('+')} -> ${after.join('+')}`);

    // And the deposit stops being offered, because nothing is open.
    r = await req('GET', '/api/bank/match', { sid });
    ck('the settled deposit is no longer proposed against anything',
       r.json.rows[0].outcome === 'nothing_open', r.json.rows[0].outcome);
}

// ── C — ADVANCE, THEN BALANCE ─────────────────────────────────────────────
// Her second case, and the one the old matcher could not express at all.
{
    section('C — advance now, balance later');

    const S = await mk('Mazariegos Recycling', 'EM-2001', '2026-07-02', 1000, 95);   // 95,000
    await req('POST', '/api/bank/aliases', { sid,
        body: { descriptor: 'ZELLE MAZARIEGOS RECYCLING', customer: 'Mazariegos Recycling' } });

    putDeposits([{ transaction_id: 'TX-A', date: '2026-07-05', amount: -38000,
        name: 'ZELLE MAZARIEGOS RECYCLING', account_id: 'bofa-1' }]);

    let r = await req('GET', '/api/bank/match', { sid });
    let row = r.json.rows.find((x) => x.deposit.id === 'TX-A');
    let p = row.proposals[0];
    ck('the advance is proposed as a PART payment', p.kind === 'partial', p.kind);
    ck('  which does not clear the invoice', p.allocations[0].clears === false);
    ck('  and says exactly what would still be owed',
       p.allocations[0].leaves === 57000, String(p.allocations[0].leaves));

    const b0 = balanceOf(S);
    await req('POST', '/api/sales-receipts', { sid, body: {
        date: '2026-07-05', amount: 38000, mode: 'Zelle', bank: 'BofA', customer: 'Mazariegos Recycling',
        allocations: [{ sale_id: S, amount: 38000 }] } });
    const b1 = balanceOf(S);
    ck('  the advance moves the balance by its own amount', Math.abs((b0 - b1) - 38000) < 0.005, `${b0} -> ${b1}`);

    // THE BALANCE. The whole point: the second deposit must match the
    // REMAINDER, not the invoice, which is only true because the route feeds
    // `applied` through from what the ledger already received.
    putDeposits([{ transaction_id: 'TX-B', date: '2026-07-20', amount: -57000,
        name: 'ZELLE MAZARIEGOS RECYCLING', account_id: 'bofa-1' }]);
    r = await req('GET', '/api/bank/match', { sid });
    row = r.json.rows.find((x) => x.deposit.id === 'TX-B');
    p = row.proposals[0];
    ck('the balance payment matches the REMAINDER, not the invoice total',
       p.kind === 'exact' && p.allocations[0].amount === 57000, `${p.kind} ${p.allocations[0].amount}`);
    ck('  and clears it', p.allocations[0].clears === true);

    await req('POST', '/api/sales-receipts', { sid, body: {
        date: '2026-07-20', amount: 57000, mode: 'Zelle', bank: 'BofA', customer: 'Mazariegos Recycling',
        allocations: [{ sale_id: S, amount: 57000 }] } });
    ck('  after both, the invoice is settled', balanceOf(S) === 0, String(balanceOf(S)));
}

// ── D — WHAT IT LEARNED FROM HER CONFIRMATIONS ────────────────────────────
// Not a stored setting — measured from the receipts the sections above
// created through the real route. If the route stopped forwarding patterns to
// the engine, the combined score below would drop and this would go red.
{
    section('D — the patterns are measured from what she actually did');

    const S4 = await mk('Custom Alloys', 'EM-1004', '2026-09-01', 1000, 12);   // 12,000
    const S5 = await mk('Custom Alloys', 'EM-1005', '2026-09-02', 1000, 15);   // 15,000
    putDeposits([{ transaction_id: 'TX-C', date: '2026-09-28', amount: -27000,
        name: 'WIRE IN CUSTOM-ALLOYS LLC REF 88213', account_id: 'bofa-1' }]);

    const r = await req('GET', '/api/bank/match', { sid });
    const row = r.json.rows.find((x) => x.deposit.id === 'TX-C');
    const p = row.proposals[0];
    ck('a second combined payment from the same customer is found',
       p && p.allocations.length === 2, JSON.stringify(p && p.allocations.map((a) => a.doc_id)));
    // THE LEARNING, OVER THE WIRE. Section B taught it — by her confirming a
    // combined receipt — that this customer combines. That has to reach the
    // scorer through the route, and the reason line is the proof.
    ck('  and it now KNOWS this customer combines, because she did it in section B',
       p && p.reasons.some((x) => /has paid combined before/.test(x)),
       JSON.stringify(p && p.reasons));
    ck('  so it is confident enough to lead with',
       p && p.score >= 0.8, String(p && p.score));
    ck('  and the route reports how many names it has been taught',
       r.json.learned_names >= 2, String(r.json.learned_names));
    void S4; void S5;
}

// ── E — THE GUARDS ────────────────────────────────────────────────────────
{
    section('E — the guards, over the wire');

    // A second customer with an invoice of an amount another customer's
    // deposit could match. The party filter is what stops it, and over the
    // wire it is the route's customer list that makes the filter possible.
    const Z = await mk('Zimex Freight', 'EM-3001', '2026-09-01', 1000, 12);   // 12,000
    putDeposits([{ transaction_id: 'TX-D', date: '2026-09-29', amount: -12000,
        name: 'WIRE IN CUSTOM-ALLOYS LLC REF 88213', account_id: 'bofa-1' }]);
    const r = await req('GET', '/api/bank/match', { sid });
    const row = r.json.rows.find((x) => x.deposit.id === 'TX-D');
    const touched = (row.proposals || []).some((p) => p.allocations.some((a) => a.doc_id === Z));
    ck('a Custom Alloys deposit never proposes a Zimex invoice', !touched,
       JSON.stringify((row.proposals || []).map((p) => p.allocations.map((a) => a.label))));

    // ── receivable, NOT amount ───────────────────────────────────────────
    // Nothing above this line distinguishes the two: a sale with no charges
    // has receivable === amount, so the route could read the wrong field and
    // every check would stay green. A sale WITH a charge is the only fixture
    // that tells them apart, and it is also her real case — freight and
    // scale charges land on invoices constantly.
    const C = await mk('Charged Customer', 'EM-4001', '2026-09-10', 1000, 20);  // goods 20,000
    await sales.editSale(C, { charges: [{ what: 'Freight', amount: 1500, direction: 'in', why: 'ocean freight billed on to the customer' }] });
    const charged = sales.listWithTotals().find((s) => s.id === C);
    ck('a sale with a charge really does have receivable != amount',
       Math.abs(Number(charged.receivable) - Number(charged.amount)) > 0.005,
       `amount ${charged.amount} / receivable ${charged.receivable} — if these are equal this check proves nothing`);

    await req('POST', '/api/bank/aliases', { sid, body: { descriptor: 'ACH CHARGED CUSTOMER', customer: 'Charged Customer' } });
    putDeposits([{ transaction_id: 'TX-E', date: '2026-09-20', amount: -Number(charged.receivable),
        name: 'ACH CHARGED CUSTOMER', account_id: 'bofa-1' }]);
    const rc = await req('GET', '/api/bank/match', { sid });
    const crow = rc.json.rows.find((x) => x.deposit.id === 'TX-E');
    ck('a deposit for the RECEIVABLE clears the invoice',
       crow.outcome === 'proposed' && crow.proposals[0].kind === 'exact'
       && crow.proposals[0].allocations[0].clears === true,
       crow.outcome + ' ' + JSON.stringify((crow.proposals || [])[0]));
    // And the converse: a deposit for the goods figure must NOT clear it,
    // because the customer still owes the charge.
    putDeposits([{ transaction_id: 'TX-F', date: '2026-09-20', amount: -Number(charged.amount),
        name: 'ACH CHARGED CUSTOMER', account_id: 'bofa-1' }]);
    const rg = await req('GET', '/api/bank/match', { sid });
    const grow = rg.json.rows.find((x) => x.deposit.id === 'TX-F');
    ck('  while a deposit for the goods figure alone does NOT',
       grow.proposals[0].kind === 'partial' && grow.proposals[0].allocations[0].clears === false,
       JSON.stringify(grow.proposals[0].allocations));
    putDeposits([{ transaction_id: 'TX-D', date: '2026-09-29', amount: -12000,
        name: 'WIRE IN CUSTOM-ALLOYS LLC REF 88213', account_id: 'bofa-1' }]);

    // sales.js computes `balance`; the route computes it from receivable minus
    // received minus deducted. They must agree, and a disagreement must be
    // REPORTED rather than silently matched against.
    const fresh = await req('GET', '/api/bank/match', { sid });
    ck('the route and sales.js agree about every balance',
       Array.isArray(fresh.json.balance_disagreements) && fresh.json.balance_disagreements.length === 0,
       JSON.stringify(fresh.json.balance_disagreements));

    // ── AND THE DETECTOR ACTUALLY DETECTS ────────────────────────────────
    // The check above passes just as happily if balance_disagreements is
    // hardcoded to []. A mutation proved exactly that, so the guard has to be
    // shown working: a row whose own `balance` contradicts its receivable
    // must be REPORTED, because a matcher quietly working from a stale idea
    // of what is owed is the two-sources-of-truth bug this repo has paid for.
    const { openReceivables } = require(path.join(ROOT, 'helpers/bankMatchRoutes'));
    const liar = openReceivables([
        { id: 'OK-1', customer: 'C', date: '2026-08-01', receivable: 10000, received: 0, deducted: 0, balance: 10000 },
        { id: 'LIES', customer: 'C', date: '2026-08-01', receivable: 10000, received: 0, deducted: 0, balance: 9000 },
    ]);
    ck('  a sale whose own balance contradicts its receivable is reported',
       liar.disagreements.length === 1 && liar.disagreements[0].id === 'LIES'
       && liar.disagreements[0].sales_js === 9000 && liar.disagreements[0].here === 10000,
       JSON.stringify(liar.disagreements));
    ck('  and the honest row beside it is not',
       !liar.disagreements.some((d) => d.id === 'OK-1'));

    // ── AND THE ROUTE FORWARDS IT ────────────────────────────────────────
    // Proving the detector works is not the same as proving the response
    // carries it. Silencing `balance_disagreements: disagreements` to `[]`
    // left every check green — the same computed-and-never-forwarded shape
    // as the fee tolerance in bankMatch and the 16 cheques in a chip.
    //
    // Stubbed at sales.listWithTotals, which the handler reaches by property
    // access on the required module (`const sales = require('./sales')`
    // INSIDE the handler), so the patch is actually hit. Restored in a
    // finally, because leaving it in place would poison every later section.
    const salesMod = require(path.join(ROOT, 'helpers/sales'));
    const realListWithTotals = salesMod.listWithTotals;
    let reported = null;
    try {
        salesMod.listWithTotals = () => ([
            { id: 'LIES-WIRE', customer: 'C', date: '2026-08-01',
              receivable: 10000, received: 0, deducted: 0, balance: 9000 },
        ]);
        reported = (await req('GET', '/api/bank/match', { sid })).json;
    } finally { salesMod.listWithTotals = realListWithTotals; }
    ck('  the route puts that disagreement in its response',
       reported && Array.isArray(reported.balance_disagreements)
       && reported.balance_disagreements.length === 1
       && reported.balance_disagreements[0].id === 'LIES-WIRE',
       JSON.stringify(reported && reported.balance_disagreements));
    ck('  with both figures, so she can see which is wrong',
       reported.balance_disagreements[0].sales_js === 9000
       && reported.balance_disagreements[0].here === 10000,
       JSON.stringify(reported.balance_disagreements[0]));
    ck('  and the stub really was restored',
       salesMod.listWithTotals === realListWithTotals && sales.listWithTotals().length > 1,
       'a leaked stub would quietly empty every section below this one');
    // What is already received AND what was written off both reduce what is
    // owed. Dropping either silently re-opens a settled invoice.
    const withDeduction = openReceivables([
        { id: 'D-1', customer: 'C', date: '2026-08-01', receivable: 10000, received: 9975, deducted: 25, balance: 0 },
    ]);
    ck('  a sale closed by money plus a bank charge counts as settled',
       withDeduction.docs.length === 0 && withDeduction.disagreements.length === 0,
       JSON.stringify(withDeduction));

    // Un-learning, over the wire.
    const del = await req('DELETE', '/api/bank/aliases', { sid,
        body: { descriptor: 'WIRE IN CUSTOM-ALLOYS LLC REF 88213' } });
    ck('a learned name can be un-learned through the route', del.status === 200, String(del.raw).slice(0, 160));
    const after = await req('GET', '/api/bank/match', { sid });
    ck('  and the deposit goes back to asking',
       after.json.rows.find((x) => x.deposit.id === 'TX-D').outcome === 'no_party',
       'a wrong alias must be reversible without editing JSON on a server');
    ck('  un-learning something never learned is a 404, not a silent ok',
       (await req('DELETE', '/api/bank/aliases', { sid, body: { descriptor: 'NEVER SEEN' } })).status === 404);
    ck('  and a non-admin cannot un-learn either',
       (await req('DELETE', '/api/bank/aliases', { sid: userSid, body: { descriptor: 'x' } })).status === 403);
}

// ── E2 — THE WIRE TOOK A CUT IN TRANSIT ───────────────────────────────────
// salesReceipts.js exists because of this: "sometimes there might be a
// deduction in received amount because of wire deduction by bank". The
// matcher has to agree with that ledger about what is left owing, and the
// `deducted` half of `applied` is what makes it. Mutating that half away left
// every other check in this file green, which is why this section exists.
{
    section('E2 — a wire that arrived short, and what is owed after it');

    const W = await mk('Daekwang Metals', 'EM-5001', '2026-09-01', 1000, 40);   // 40,000
    await req('POST', '/api/bank/aliases', { sid, body: { descriptor: 'WIRE DAEKWANG METALS', customer: 'Daekwang Metals' } });

    // 19,975 lands against a 20,000 part, the intermediary bank having taken 25.
    const b0 = balanceOf(W);
    const post = await req('POST', '/api/sales-receipts', { sid, body: {
        date: '2026-09-04', amount: 19975, mode: 'Wire', bank: 'BofA', customer: 'Daekwang Metals',
        allocations: [{ sale_id: W, amount: 19975, deduction_amount: 25, deduction_reason: 'bank_charge' }] } });
    ck('a short wire is recorded as money plus a bank charge', post.status === 200,
       post.status + ' ' + String(post.raw).slice(0, 180));
    const b1 = balanceOf(W);
    ck('  and it reduces what is owed by BOTH, not just the money',
       Math.abs((b0 - b1) - 20000) < 0.005, `${b0} -> ${b1} (expected a 20,000 move, not 19,975)`);

    // Now the rest. It must match 20,000 — the remainder after money AND the
    // charge — not 20,025, which is what it would be if `deducted` were
    // dropped from `applied`.
    putDeposits([{ transaction_id: 'TX-W', date: '2026-09-25', amount: -20000,
        name: 'WIRE DAEKWANG METALS', account_id: 'bofa-1' }]);
    const r = await req('GET', '/api/bank/match', { sid });
    const row = r.json.rows.find((x) => x.deposit.id === 'TX-W');
    ck('the rest of the invoice matches the remainder after the charge',
       row.outcome === 'proposed' && row.proposals[0].kind === 'exact'
       && row.proposals[0].allocations[0].clears === true,
       row.outcome + ' ' + JSON.stringify((row.proposals || [])[0] && row.proposals[0].allocations));
    ck('  for exactly what is left', row.proposals[0].allocations[0].amount === 20000,
       String(row.proposals[0].allocations[0].amount));

    // The learning side of the same fact: that charge is now a per-customer
    // fee allowance, measured from her own confirmation.
    const L = require(path.join(ROOT, 'helpers/bankLearn'));
    const salesById = new Map(sales.listWithTotals().map((s) => [s.id, { date: s.date, amount: Number(s.receivable) }]));
    const pats = L.patternsFromHistory(receipts.list(), salesById);
    ck('  and the bank charge becomes this customer\'s fee allowance',
       pats['Daekwang Metals'] && pats['Daekwang Metals'].feeAllowance === 25,
       JSON.stringify(pats['Daekwang Metals']));
}

// ── E3 — RULE 5, AND AN EXCLUSION THAT ACTUALLY EXCLUDES ──────────────────
// Edge Metals and Edge Trading are different companies. The receivables in
// sales.json are Edge Metals'; a deposit into the Edge Trading account must
// never be offered against them, however neatly the amount fits.
{
    section('E3 — the other company, and the Exclude button');

    const S = await mk('Rule Five Customer', 'EM-6001', '2026-09-01', 1000, 33);   // 33,000
    await req('POST', '/api/bank/aliases', { sid, body: { descriptor: 'WIRE RULE FIVE', customer: 'Rule Five Customer' } });

    // The SAME descriptor and the SAME amount, once per company.
    putDeposits([
        { transaction_id: 'TX-METALS', date: '2026-09-22', amount: -33000, name: 'WIRE RULE FIVE', account_id: 'bofa-1' },
        { transaction_id: 'TX-TRADING', date: '2026-09-22', amount: -33000, name: 'WIRE RULE FIVE', account_id: 'chase-1' },
    ]);
    let r = await req('GET', '/api/bank/match', { sid });
    const metals = r.json.rows.find((x) => x.deposit.id === 'TX-METALS');
    ck('the Edge Metals deposit is matched', metals && metals.outcome === 'proposed',
       metals && metals.outcome);
    ck('  and the Edge Trading one is NOT even considered',
       !r.json.rows.some((x) => x.deposit.id === 'TX-TRADING'),
       JSON.stringify(r.json.rows.map((x) => x.deposit.id)));
    ck('  but it is NAMED rather than silently dropped',
       (r.json.other_company || []).some((x) => x.id === 'TX-TRADING' && /TRADING/i.test(x.company)),
       JSON.stringify(r.json.other_company));

    // The ledger summary reaches the screen, so the counts she reads are the
    // ledger's own rather than a second tally.
    ck('the ledger summary comes through', r.json.ledger && r.json.ledger.rows === 2,
       JSON.stringify(r.json.ledger));

    // EXCLUDE IT THROUGH THE ROUTE the screen posts to, not the helper.
    const noReason = await req('POST', '/api/bank/exclude', { sid, body: { id: 'TX-METALS' } });
    ck('excluding without a reason is refused', noReason.status === 400
       && /unexplainable at tax time/.test((noReason.json || {}).error || ''),
       noReason.status + ' ' + String(noReason.raw).slice(0, 160));
    ck('  and a non-admin cannot exclude at all',
       (await req('POST', '/api/bank/exclude', { sid: userSid, body: { id: 'TX-METALS', reason: 'x' } })).status === 403,
       'excluding decides what she never sees again');
    ck('  nor can a row that does not exist be excluded',
       (await req('POST', '/api/bank/exclude', { sid, body: { id: 'NOPE', reason: 'x' } })).status === 404);

    const exc = await req('POST', '/api/bank/exclude', { sid,
        body: { id: 'TX-METALS', reason: 'duplicate of a wire already recorded' } });
    ck('excluding with a reason works', exc.status === 200, String(exc.raw).slice(0, 160));
    ck('  and the reason is on the row with who did it',
       exc.json.row && exc.json.row.excluded_reason === 'duplicate of a wire already recorded'
       && (exc.json.row.history || []).length === 1,
       JSON.stringify(exc.json.row && exc.json.row.history));
    r = await req('GET', '/api/bank/match', { sid });
    ck('an excluded deposit is no longer proposed against anything',
       !r.json.rows.some((x) => x.deposit.id === 'TX-METALS'),
       JSON.stringify(r.json.rows.map((x) => x.deposit.id)));
    ck('  but it is still counted, with its money',
       r.json.ledger.excluded.count === 1 && r.json.ledger.excluded.money === 33000,
       JSON.stringify(r.json.ledger.excluded));

    // And back again, also through the route.
    const inc = await req('POST', '/api/bank/include', { sid, body: { id: 'TX-METALS' } });
    ck('putting it back works through the route', inc.status === 200, String(inc.raw).slice(0, 140));
    ck('  and both acts are in the history, not just the latest',
       (inc.json.row.history || []).length === 2,
       JSON.stringify((inc.json.row.history || []).map((h) => h.what)));
    r = await req('GET', '/api/bank/match', { sid });
    ck('un-excluding brings it back as a proposal',
       r.json.rows.some((x) => x.deposit.id === 'TX-METALS' && x.outcome === 'proposed'),
       JSON.stringify(r.json.rows.map((x) => [x.deposit.id, x.outcome])));
    void S;
}

// ── E4 — THE PAGE IS SERVED, AND THE FORM IS PRE-FILLED CORRECTLY ─────────
{
    section('E4 — the screen, and the account it pre-fills');

    const page = await new Promise((resolve, reject) => {
        const rq = http.request(base + '/bank-match', { method: 'GET',
            headers: { Authorization: `Bearer ${sid}` } }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, raw }));
        });
        rq.on('error', reject); rq.end();
    });
    ck('/bank-match serves the page', page.status === 200, String(page.status));
    ck('  and it is the matching screen', /Bank matching/.test(page.raw) && /api\/bank\/match/.test(page.raw),
       page.raw.slice(0, 120));

    putDeposits([
        { transaction_id: 'TX-G1', date: '2026-09-23', amount: -500, name: 'WIRE X', account_id: 'bofa-1' },
        { transaction_id: 'TX-G2', date: '2026-09-23', amount: -500, name: 'WIRE Y', account_id: 'wells-9' },
    ]);
    const r = await req('GET', '/api/bank/match', { sid });
    const g1 = r.json.rows.find((x) => x.deposit.id === 'TX-G1');
    const g2 = r.json.rows.find((x) => x.deposit.id === 'TX-G2');
    // The bank label is resolved at INGEST by bankLedger.bankOf and stored
    // on the row, the same single lookup that sets company — so what the
    // route pre-fills is what the fixture's accounts say. It used to be a
    // second, independent lookup at request time, which meant the company on
    // a row and the bank on the same row came from different places and one
    // could work while the other silently returned nothing.
    ck('a BofA deposit pre-fills BofA, not the other bank',
       g1 && g1.deposit.bank_guess === 'BofA', g1 && String(g1.deposit.bank_guess));
    ck('  and an institution Jarvis does not know pre-fills NOTHING',
       g2 && g2.deposit.bank_guess === null, g2 && String(g2.deposit.bank_guess));
    ck('  which is the point: a name-based guess put Chase on the BofA account',
       ledger.bankOf('wells-9', ACCOUNTS) === null
       && ledger.bankOf('bofa-1', ACCOUNTS) === 'BofA'
       && ledger.bankOf('chase-1', ACCOUNTS) === 'Chase Bank',
       JSON.stringify(['bofa-1', 'chase-1', 'wells-9'].map((x) => ledger.bankOf(x, ACCOUNTS))));

    // ── AN UNMAPPED ACCOUNT IS NOT MATCHED ───────────────────────────────
    // An account_id the accounts file does not know gives company === null,
    // and that must NOT fall through as "probably Edge Metals". My first
    // filter was `!d.company || d.company === METALS`, which reads as
    // cautious and is the opposite — in production, where bank-accounts.json
    // carries no plaid_account_id at all, it would have matched every Edge
    // Trading deposit against Edge Metals invoices.
    putDeposits([
        { transaction_id: 'TX-G1', date: '2026-09-23', amount: -500, name: 'WIRE X', account_id: 'bofa-1' },
        { transaction_id: 'TX-G3', date: '2026-09-23', amount: -500, name: 'WIRE Z', account_id: 'unmapped-77' },
    ]);
    const r2 = await req('GET', '/api/bank/match', { sid });
    ck('a deposit from an unmapped account is not matched at all',
       !r2.json.rows.some((x) => x.deposit.id === 'TX-G3'),
       JSON.stringify(r2.json.rows.map((x) => x.deposit.id)));
    ck('  it is listed as an unknown account instead',
       (r2.json.unknown_account || []).some((x) => x.id === 'TX-G3'),
       JSON.stringify(r2.json.unknown_account));
    ck('  with the one-line fix named',
       /plaid_account_id/.test(r2.json.unknown_account_fix || ''), String(r2.json.unknown_account_fix));
    ck('  while the mapped one still is matched',
       r2.json.rows.some((x) => x.deposit.id === 'TX-G1'),
       JSON.stringify(r2.json.rows.map((x) => x.deposit.id)));

    ck('the form options come from the server',
       (r.json.modes || []).includes('Wire') && (r.json.banks || []).includes('BofA'),
       JSON.stringify({ modes: r.json.modes, banks: r.json.banks }));
    ck('  and every pre-filled bank is one the receipts route accepts',
       r.json.rows.every((x) => !x.deposit.bank_guess || r.json.banks.includes(x.deposit.bank_guess)),
       JSON.stringify(r.json.rows.map((x) => x.deposit.bank_guess)));
}

// ── F — THERE IS NO SECOND WAY TO MARK AN INVOICE PAID ────────────────────
// The rule this feature is built on. If an apply route ever appears here,
// there are two places that can settle an invoice and the newer one will miss
// whichever rule is added next.
{
    section('F — one write path, and it is not this one');

    const src = fs.readFileSync(path.join(ROOT, 'helpers/bankMatchRoutes.js'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // ── THE INVARIANT IS ABOUT MONEY, NOT ABOUT ROUTE NAMES ──────────────
    // My first version demanded every write here mention 'aliases', which
    // went red the moment exclude/include landed — and those are legitimate:
    // they change which rows are OFFERED, never what an invoice has been
    // paid. The property worth guarding is that nothing here settles an
    // invoice, so that is what is checked.
    const writes = (code.match(/app\.(post|put|patch|delete)\('(\/api\/bank\/[a-z-]+)'/g) || []);
    const ALLOWED = ['aliases', 'exclude', 'include'];
    ck('every write here is about a name or the worklist, never about money',
       writes.every((w) => ALLOWED.some((a) => w.includes(a))), writes.join(' '));
    ck('  nothing here calls addReceipt', !/addReceipt/.test(code),
       'confirming goes through POST /api/sales-receipts so there is one validation path');
    ck('  and nothing here writes a store directly',
       !/mutateJson|writeFileSync/.test(code), 'the learning store is bankLearn\'s own job');
}

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { try { server && server.close(); } catch (x) {} console.error('threw:', e && e.stack); process.exit(1); });
