// ── tests/supplier-prepayment.js ──────────────────────────────────────────
// Apsara, 2026-10-01: "Add a supplier prepayment option in loads", scoped to
// "edge yard", with the brief "streamline the process".
//
// ── THIS IS THE SECOND ATTEMPT ────────────────────────────────────────────
// An advance feature shipped 2026-08-29 (48eddb3) and she removed it the same
// day (a4e2548, "remove that advance concept."). The ledger design in that
// commit was hers and is kept verbatim. What is NOT kept is how it moved
// cash: addAdvance wrote its own row bypassing addPayment, so a CASH advance
// never came out of the petty cash box — while deleteByLoad's reversal loop
// DID match the row (mode Cash, and load_kind absent so the Edge Metals
// allowlist test passed), and tried to return money that had never left.
//
// She pays suppliers in cash. That is her box wrong in both directions, and
// sections B and E exist because of it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.JARVIS_TEST = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prepay-'));
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const cfg = require('../config');
cfg.PAYMENTS_FILE = path.join(TMP, 'payments.json');
cfg.PETTY_CASH_FILE = path.join(TMP, 'petty_cash.json');
cfg.LOADS_FILE = path.join(TMP, 'loads.json');
fs.writeFileSync(cfg.PAYMENTS_FILE, '[]');
fs.writeFileSync(cfg.PETTY_CASH_FILE, '[]');
fs.writeFileSync(cfg.LOADS_FILE, '[]');

const pay = require('../helpers/payments');
const petty = require('../helpers/pettyCash');

const readPayments = () => JSON.parse(fs.readFileSync(cfg.PAYMENTS_FILE, 'utf8'));
const cashInHand = () => {
    const rows = JSON.parse(fs.readFileSync(cfg.PETTY_CASH_FILE, 'utf8'));
    return Math.round(rows.reduce((a, r) => a + (Number(r.amount) || 0), 0) * 100) / 100;
};

(async () => {

// Float the box so a cash prepayment has somewhere to come from.
await petty.addTopUp({ amount: 10000, cash_source: 'Edge Metals', date: '2026-10-01', created_by: 't' });
ck('the box starts with 10,000', cashInHand() === 10000, `got ${cashInHand()}`);

// ══════════════════════════════════════════════════════════════════════════
section('A — recording one');

{
    const p = await pay.addPrepayment({
        seller: 'Ramesh', amount: 3000, mode: 'Cash',
        cash_source: 'Edge Metals', paid_on: '2026-10-01', created_by: 't',
    });
    ck('it is stored', !!p && !!p.id);
    ck('and carries no load_id', p.load_id === null,
       'a prepayment with a load_id is indistinguishable from an ordinary payment and would start counting against that load');
    ck('and is flagged is_advance, NOT a new field name', p.is_advance === true,
       'legacy rows on her VM carry is_advance and four code paths filter on it — a new name orphans that money');
    ck('and stamps load_kind explicitly', p.load_kind === 'purchase',
       'the old version left it undefined, so every allowlist test downstream read a missing field');
}
for (const [what, input] of [
    ['no supplier', { amount: 100, mode: 'Cash' }],
    ['no amount', { seller: 'X', mode: 'Cash' }],
    ['zero', { seller: 'X', amount: 0, mode: 'Cash' }],
    ['negative', { seller: 'X', amount: -5, mode: 'Cash' }],
    ['a made-up mode', { seller: 'X', amount: 10, mode: 'Bitcoin' }],
]) {
    let threw = false;
    try { await pay.addPrepayment(input); } catch (e) { threw = true; }
    ck(`${what} is refused`, threw);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — THE CASH ACTUALLY LEAVES THE BOX');
// ══════════════════════════════════════════════════════════════════════════
// The bug in the first version. $3,000 handed to a supplier in notes is
// $3,000 that is no longer in the drawer, whether or not a load exists yet.
{
    ck('the box is down by the cash prepayment', cashInHand() === 7000,
       `box holds ${cashInHand()}, expected 7000 — cash left the drawer and the book did not notice`);
}
{
    const before = cashInHand();
    await pay.addPrepayment({
        seller: 'Wire Co', amount: 500, mode: 'Wire',
        bank: 'Chase', paid_via: 'Edge Yard', created_by: 't',
    });
    ck('a WIRE prepayment does not touch the box', cashInHand() === before,
       'only cash comes out of the drawer');
}
{
    const p = readPayments().find((r) => r.seller === 'Ramesh');
    ck('the cash prepayment is linked to its petty cash entry', !!p.petty_cash_entry_id,
       'without the link, an undo has to guess which withdrawal to reverse');
    ck('and records what was taken', p.cash_taken === 3000);
}

// ══════════════════════════════════════════════════════════════════════════
section('B2 — ANY FORM OF PAYMENT, CARRYING WHAT THAT FORM NEEDS');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-10-01: "not only cash prepayment,advance can be in any form
// of payment na".
//
// My first cut accepted any mode and then dropped the fields the non-cash
// modes depend on — no bank, no paid_via. It would have saved a Wire
// prepayment that looked fine and was missing the two facts that make a wire
// traceable. This section is the one that would have caught that.
{
    // Which modes carry a bank is banks.js's business, not this file's, and
    // the list moved twice in two days: Zelle came OFF it on 2026-09-17 and
    // Zelle and Cheque came back on as OPTIONAL on 2026-10-01 ("Zelle/Cheque
    // also has a bank.but keep it as optional"). Both times the delegation
    // to banks.js is what kept this path correct while I had the rule wrong
    // in my head. That is the argument for delegating rather than copying a
    // list in here.
    for (const [mode, extra, wantBank] of [
        ['Zelle',  {}, null],                                     // optional, omitted
        ['Cheque', { bank: 'Chase' }, 'Chase'],                   // optional, given
        ['Wire',   { bank: 'Chase', paid_via: 'Edge Yard' }, 'Chase'],
    ]) {
        const before = cashInHand();
        const p = await pay.addPrepayment({
            seller: `Supplier ${mode}`, amount: 111, mode, ...extra, created_by: 't',
        });
        ck(`a ${mode} prepayment saves`, !!p && p.mode === mode);
        ck(`  and its bank is ${wantBank === null ? 'blank, as that mode has none' : wantBank}`,
           p.bank === wantBank,
           `bank stored as ${JSON.stringify(p.bank)}`);
        ck(`  and does not touch the petty cash box`, cashInHand() === before);
    }
    {
        // Apsara, 2026-10-01: "Zelle/Cheque also has a bank.but keep it as
        // optional". A bank on a Zelle is now KEPT — and still never
        // demanded, which is the half of the instruction a single list
        // cannot express. See helpers/banks.js.
        const p = await pay.addPrepayment({ seller: 'ZB Co', amount: 10, mode: 'Zelle', bank: 'Chase', created_by: 't' });
        ck('a bank on a ZELLE prepayment is KEPT', p.bank === 'Chase', `stored ${JSON.stringify(p.bank)}`);
        const p2 = await pay.addPrepayment({ seller: 'ZB2 Co', amount: 10, mode: 'Zelle', require_bank: true, created_by: 't' });
        ck('  and a Zelle with no bank still saves, even from a form', p2.bank === null);
    }
}
{
    // Her instruction of 2026-09-17: "in load of invoice pay-remove bank
    // transfer". Validating against the full PAYMENT_MODES list — which my
    // first cut did — would have let it back in on this one path only.
    let threw = false;
    try { await pay.addPrepayment({ seller: 'BT Co', amount: 50, mode: 'Bank transfer', bank: 'Chase' }); }
    catch (e) { threw = true; }
    ck('Bank transfer is refused on a supplier prepayment', threw,
       'she removed it from paying a supplier; this path must not reinstate it');
}
{
    // The requirement CLAUDE.md records being missed three times — a rule in
    // addPayment that a path not sharing it quietly skips. This path is the
    // new caller.
    let threw = null;
    try { await pay.addPrepayment({ seller: 'NoVia Co', amount: 50, mode: 'Wire', bank: 'Chase' }); }
    catch (e) { threw = e.message; }
    ck('a WIRE with no "Payment via" is refused', /Payment via/i.test(threw || ''),
       `threw ${JSON.stringify(threw)} — a wire with no company against it is money leaving an account with nobody named`);

    const p = await pay.addPrepayment({
        seller: 'Via Co', amount: 50, mode: 'Wire', bank: 'Chase',
        paid_via: 'Edge Yard', created_by: 't',
    });
    ck('and it is stored when answered', p.paid_via === 'Edge Yard');
}
{
    // A bank on cash is not a true sentence about where the money left —
    // banks.js refuses it, and this path has to inherit that refusal.
    let threw = false;
    try { await pay.addPrepayment({ seller: 'CashBank Co', amount: 50, mode: 'Cash', bank: 'Chase' }); }
    catch (e) { threw = true; }
    ck('a bank on a CASH prepayment is refused', threw);
}
{
    // Applying inherits the form — the transfer already happened, so asking
    // again would invite a second, different answer about one movement.
    const credit = pay.prepaymentCredit('Via Co');
    await require('../helpers/json').mutateJson(cfg.LOADS_FILE, [], (l) => {
        const list = Array.isArray(l) ? l : [];
        list.unshift({ id: 'EDGE_W', date: '2026-10-02', seller: 'Via Co', amount: 100, items: [], weight_unit: 'lb' });
        return list;
    });
    await pay.applyPrepayment({ load_id: 'EDGE_W', prepayment_id: credit.prepayments[0].id, amount: 50, created_by: 't' });
    const applied = pay.paymentsForLoad('EDGE_W')[0];
    ck('the applied row inherits the mode', applied.mode === 'Wire');
    ck('and the bank', applied.bank === 'Chase');
    ck('and the company that paid', applied.paid_via === 'Edge Yard',
       'losing paid_via on application would drop the row out of her spend-by-company report');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — it cannot make a load look part-paid');
{
    await require('../helpers/json').mutateJson(cfg.LOADS_FILE, [], (l) => {
        const list = Array.isArray(l) ? l : [];
        list.unshift({ id: 'EDGE_1', date: '2026-10-02', seller: 'Ramesh', amount: 5000, items: [], weight_unit: 'lb' });
        return list;
    });
    const rows = pay.paymentsForLoad('EDGE_1');
    ck('the load has no payments against it', rows.length === 0,
       'an unapplied prepayment appearing here would show a load as partly settled before anyone decided');
    const s = pay.paymentSummary('EDGE_1', 5000);
    // paymentSummary calls it `pending`, not `balance` — and it reports
    // status separately rather than deriving it at the call site.
    ck('and the full amount is still pending', s.pending === 5000, `pending read ${s.pending}`);
    ck('and it reads as unpaid', s.status === 'unpaid', `status ${s.status}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — credit, and applying it');
{
    const c = pay.prepaymentCredit('Ramesh');
    ck('the supplier holds 3,000', c.available === 3000, `available ${c.available}`);
    ck('and it is attributed to one prepayment', c.prepayments.length === 1);
    ck('case does not matter when looking it up', pay.prepaymentCredit('ramesh').available === 3000,
       'she types names as they come — "one supplier, one spelling" is the rule everywhere else in this file');
    ck('a supplier with none holds nothing', pay.prepaymentCredit('Nobody').available === 0);
}
{
    const advId = pay.prepaymentCredit('Ramesh').prepayments[0].id;
    let threw = null;
    try { await pay.applyPrepayment({ load_id: 'EDGE_1', prepayment_id: advId, amount: 4000 }); }
    catch (e) { threw = e.message; }
    ck('over-applying is REFUSED, not silently capped', /only has 3000/.test(threw || ''),
       `threw ${JSON.stringify(threw)} — capping quietly would leave her believing a load was settled`);

    const cashBefore = cashInHand();
    await pay.applyPrepayment({ load_id: 'EDGE_1', prepayment_id: advId, amount: 2000, created_by: 't' });

    ck('it counts against the load now', pay.paymentsForLoad('EDGE_1').length === 1);
    const s = pay.paymentSummary('EDGE_1', 5000);
    ck('and the pending amount drops', s.pending === 3000, `pending ${s.pending}`);
    ck('and the load reads as partly paid', s.status === 'partial', `status ${s.status}`);
    ck('the prepayment has 1,000 left', pay.prepaymentRemaining(advId) === 1000,
       `remaining ${pay.prepaymentRemaining(advId)}`);
    ck('remaining is DERIVED — the record stores no balance',
       readPayments().find((r) => r.id === advId).remaining === undefined,
       'a stored remaining drifts from its applications, and the drift is invisible until she is short');

    // ── APPLYING TAKES NO FURTHER CASH ────────────────────────────────────
    ck('applying does NOT take cash again', cashInHand() === cashBefore,
       `box moved from ${cashBefore} to ${cashInHand()} — the notes left when the prepayment was recorded`);

    const applied = pay.paymentsForLoad('EDGE_1')[0];
    ck('the applied row is an ordinary payment', applied.load_id === 'EDGE_1' && applied.amount === 2000);
    ck('it points back at the prepayment', applied.applied_from === advId);
    ck('and is marked as moving no cash', applied.from_prepayment === true
        && applied.petty_cash_entry_id === null && applied.cash_taken === null);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — UNDOING IT DOES NOT INVENT MONEY');
// ══════════════════════════════════════════════════════════════════════════
// The other half of the first version's bug. The applied row is Cash and
// kind purchase, so both of deletePayment's tests match it — and its
// petty_cash_entry_id is null, so `entry_id || payment_id` falls back to the
// payment id. Without the from_prepayment guard this reverses an entry that
// never existed: at best a logged failure, at worst cash credited back into a
// box that already handed it over.
{
    const applied = pay.paymentsForLoad('EDGE_1')[0];
    const advId = applied.applied_from;
    const cashBefore = cashInHand();
    const entriesBefore = JSON.parse(fs.readFileSync(cfg.PETTY_CASH_FILE, 'utf8')).length;
    await pay.deletePayment(applied.id);
    ck('the box is untouched by the undo', cashInHand() === cashBefore,
       `box moved ${cashBefore} -> ${cashInHand()} — this is money appearing out of nothing`);
    // ── AND THE BOOK GAINS NO PHANTOM ROW ─────────────────────────────────
    // The balance alone cannot catch this, and two mutations proved it:
    // deleting the from_prepayment guard, and breaking reverseForPayment's
    // own bail, BOTH left the balance correct — because reversing no matching
    // entries sums to zero. The money was never at risk. What IS at risk is
    // her petty cash book growing a zero-amount 'reversal' against a
    // withdrawal that never happened, every time an applied prepayment is
    // undone. That is an audit trail telling a story that did not occur.
    ck('and the petty cash book gains no phantom reversal',
       JSON.parse(fs.readFileSync(cfg.PETTY_CASH_FILE, 'utf8')).length === entriesBefore,
       'a zero-amount reversal of a withdrawal that never happened is a row she would have to explain');
    ck('and the prepayment is whole again', pay.prepaymentRemaining(advId) === 3000,
       `remaining ${pay.prepaymentRemaining(advId)} — removing the application IS the complete undo`);
    const back = pay.paymentSummary('EDGE_1', 5000);
    ck('the load owes the full amount again', back.pending === 5000 && back.status === 'unpaid',
       `pending ${back.pending}, status ${back.status}`);
}
{
    // Deleting the whole load, which is the other reversal path.
    const advId = pay.prepaymentCredit('Ramesh').prepayments[0].id;
    await pay.applyPrepayment({ load_id: 'EDGE_1', prepayment_id: advId, amount: 1500, created_by: 't' });
    const cashBefore = cashInHand();
    await pay.deletePaymentsForLoad('EDGE_1');
    ck('deleting the LOAD also invents no cash', cashInHand() === cashBefore,
       `box moved ${cashBefore} -> ${cashInHand()}`);
    ck('and returns the credit', pay.prepaymentRemaining(advId) === 3000);
}
{
    // An ordinary cash payment must still be reversed — the guard has to be
    // narrow, or fixing this breaks the behaviour it sits next to.
    await pay.addPayment({
        load_id: 'EDGE_1', load_kind: 'purchase', amount: 400, mode: 'Cash',
        cash_source: 'Edge Metals', paid_on: '2026-10-02', created_by: 't',
    });
    const afterPay = cashInHand();
    const ordinary = pay.paymentsForLoad('EDGE_1').find((p) => !p.from_prepayment);
    ck('an ordinary cash payment still leaves the box', afterPay === 6600, `box ${afterPay}`);
    await pay.deletePayment(ordinary.id);
    ck('and deleting it still puts the money back', cashInHand() === 7000,
       `box ${cashInHand()} — the guard must not stop ordinary reversals`);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — one save, one prepayment');
{
    const ticket = 'PREPAY_TICKET_1';
    // Zelle on purpose: it needs neither a bank nor a "Payment via", so this
    // section tests the ticket and only the ticket. The first draft used Wire
    // and threw on the missing paid_via — a real requirement firing in a test
    // that was not about it.
    const a = await pay.addPrepayment({ seller: 'Twice Co', amount: 250, mode: 'Zelle', client_request_id: ticket });
    const b = await pay.addPrepayment({ seller: 'Twice Co', amount: 250, mode: 'Zelle', client_request_id: ticket });
    ck('the second send creates nothing', a.id === b.id, `${a.id} vs ${b.id}`);
    ck('and only one row exists',
       readPayments().filter((r) => r.seller === 'Twice Co').length === 1,
       'a double-tap on a cash prepayment is money the book says left the drawer and did not');
}

// ══════════════════════════════════════════════════════════════════════════
section('G — the legacy rows stay exactly as safe as before');
// Her VM has is_advance rows from August with load_id: null. This feature
// must not resurrect them as live credit without her looking at them, and it
// must not break the filters that keep them inert.
{
    await require('../helpers/json').mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        list.push({ id: 'ADV_legacy', is_advance: true, load_id: null, seller: 'Old Co',
                    mode: 'Wire', amount: 3000, paid_on: '2026-08-18' });
        return list;
    });
    ck('a legacy row makes no load look part-paid', pay.paymentsForLoad('EDGE_1').length === 0);
    ck('and is visible rather than buried', pay.prepaymentCredit('Old Co').available === 3000,
       'money that disappears from view is worse than money with an awkward label');
}

// ══════════════════════════════════════════════════════════════════════════
section('H — END TO END, through the routes the screens will post to');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
// Every section above calls the helper directly, and all of them pass while
// a route forgets to forward a field — which is how paid_via broke live.
{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p2, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    // Record one by Wire, which is the mode that needs the most fields.
    const rec = await req('POST', '/api/prepayments', { sid, body: {
        seller: 'Route Co', amount: 2500, mode: 'Wire', bank: 'Chase', paid_via: 'Edge Yard',
        paid_on: '2026-10-01',
    } });
    ck('the route records it', rec.status === 200 && rec.json && rec.json.ok, JSON.stringify(rec.json));
    ck('  and forwards the bank', (rec.json.prepayment || {}).bank === 'Chase',
       'a wire with no bank cannot be matched to a statement');
    ck('  and the company that paid', (rec.json.prepayment || {}).paid_via === 'Edge Yard',
       'this is the field that broke live in September when a route dropped it');
    ck('  and hands back the credit', (rec.json.credit || {}).available === 2500);

    // The paid_via rule must bite at the ROUTE, not only in the helper.
    const bad = await req('POST', '/api/prepayments', { sid, body: {
        seller: 'NoVia Route', amount: 100, mode: 'Wire', bank: 'Chase',
    } });
    ck('a Wire with no "Payment via" is refused by the route', bad.status === 400
        && /Payment via/i.test((bad.json || {}).error || ''), JSON.stringify(bad.json));

    // What a supplier is holding, and the all-suppliers form the Pay modal
    // needs in ONE call.
    const one = await req('GET', '/api/prepayments/credit?seller=Route%20Co', { sid });
    ck('credit for one supplier', one.status === 200 && one.json.available === 2500);
    const all = await req('GET', '/api/prepayments/credit', { sid });
    ck('and every supplier holding something, in one call',
       all.status === 200 && (all.json.held || {})['Route Co']
       && all.json.held['Route Co'].available === 2500,
       JSON.stringify(all.json));

    // Apply it to a load, which is the Odoo "Outstanding Debits: ADD".
    await require('../helpers/json').mutateJson(cfg.LOADS_FILE, [], (l) => {
        const list = Array.isArray(l) ? l : [];
        list.unshift({ id: 'EDGE_R', date: '2026-10-02', seller: 'Route Co', amount: 4000, items: [], weight_unit: 'lb' });
        return list;
    });
    const advId = (rec.json.credit.prepayments[0] || {}).id;
    const ap = await req('POST', '/api/prepayments/apply', { sid, body: {
        load_id: 'EDGE_R', prepayment_id: advId, amount: 1500,
    } });
    ck('the apply route works', ap.status === 200 && ap.json.ok, JSON.stringify(ap.json));
    ck('  and recomputes the load from the ledger', (ap.json.summary || {}).pending === 2500,
       `pending ${(ap.json.summary || {}).pending}`);
    ck('  and says what is left on the prepayment', ap.json.remaining === 1000);
    ck('  and the applied row inherits the form',
       (ap.json.payment || {}).mode === 'Wire' && (ap.json.payment || {}).bank === 'Chase'
       && (ap.json.payment || {}).paid_via === 'Edge Yard');

    // Over-applying must be refused by the route too, with her figure in it.
    const over = await req('POST', '/api/prepayments/apply', { sid, body: {
        load_id: 'EDGE_R', prepayment_id: advId, amount: 99999,
    } });
    ck('over-applying is refused by the route', over.status === 400
        && /only has 1000/.test((over.json || {}).error || ''), JSON.stringify(over.json));

    await new Promise((r2) => server.close(r2));
}

// ══════════════════════════════════════════════════════════════════════════
section('I — AND BY TALKING, which is the caller that keeps breaking');
// ══════════════════════════════════════════════════════════════════════════
// CLAUDE.md records FOUR occasions where a requirement landed in shared
// payment code and this path was the caller that could not satisfy it,
// because it has no form to hang a field on. So the tool ships in the same
// commit as the feature, and this section is the proof it can answer
// everything addPrepayment asks for.
{
    const tools = require('../helpers/tools');
    ck('the tool is registered', tools.TOOL_NAMES.includes('record_prepayment'));

    const prop = await tools.buildWrite('record_prepayment', {
        seller: 'Spoken Co', amount: 800, mode: 'Cash', cash_source: 'Edge Metals',
    });
    ck('it proposes a sentence she can check',
       /Record a Cash prepayment of \$800\.00 to Spoken Co/.test(prop.summary), prop.summary);
    ck('  and says it is against NO load',
       (prop.warnings || []).some((w) => /not against any load/i.test(w)),
       'she is confirming without a screen; if she meant an existing load this is what catches it');
    ck('  and shows what the supplier would then hold',
       prop.details.some(([k, v]) => /Held after/.test(k) && /800/.test(v)));

    const before = readPayments().length;
    ck('proposing writes nothing', before === readPayments().length);
    const out = await prop.run();
    ck('and running it records the prepayment', out.ok && !!out.prepayment_id);
    ck('  and says the new total out loud', /holding \$800\.00/.test(out.said || ''), out.said);

    // ── REFUSED AT PROPOSE, NOT AT RUN ───────────────────────────────────
    // The exact 2026-09-17 failure: a rule that throws inside addPayment,
    // reached only after she has already said yes.
    let threw = null;
    try { await tools.buildWrite('record_prepayment', { seller: 'X', amount: 10, mode: 'Wire', bank: 'Chase' }); }
    catch (e) { threw = e.message; }
    ck('a Wire with no company is refused AT PROPOSE', /Payment via/i.test(threw || ''), String(threw));

    let threw2 = null;
    try { await tools.buildWrite('record_prepayment', { seller: 'X', amount: 10, mode: 'Bank transfer' }); }
    catch (e) { threw2 = e.message; }
    ck('and a mode she removed from supplier pay is refused too',
       /paid by/i.test(threw2 || ''), String(threw2));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
