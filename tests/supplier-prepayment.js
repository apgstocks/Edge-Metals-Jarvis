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
    // Which modes carry a bank is banks.js's MODES_WITH_BANK = ['Wire',
    // 'Bank transfer'] — and Bank transfer is not a supplier mode, so on a
    // prepayment only WIRE has a bank behind it. Zelle and Cheque are
    // REFUSED one ("Zelle has no bank behind it"), per her 2026-09 decision.
    // I had this wrong in the first version of this test and the delegation
    // to banks.js is what got it right; that is the argument for delegating.
    for (const [mode, extra, wantBank] of [
        ['Zelle',  {}, null],
        ['Cheque', {}, null],
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
        let threw = false;
        try { await pay.addPrepayment({ seller: 'ZB Co', amount: 10, mode: 'Zelle', bank: 'Chase' }); }
        catch (e) { threw = true; }
        ck('a bank on a ZELLE prepayment is refused, same as everywhere else', threw);
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

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  THREW:', e.stack || e.message); process.exit(1); });
