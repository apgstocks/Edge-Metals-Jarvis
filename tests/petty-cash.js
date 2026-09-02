// ── tests/petty-cash.js ────────────────────────────────────────────────────
// Apsara, 2026-09-02: "a new tab called Petty cash ... it is like cash reserve.
// If i click pay in load and select cash, the invoice amount should be adjusted
// against this. If cash is low while invoice amount is high --> Make it as
// partial payment and notify user."
//
// This is the only money in the system with no bank statement behind it, so
// the ledger IS the record. These tests are written around the ways it could
// go wrong rather than the happy path:
//
//   - overdrawing the box
//   - two payments racing the same balance
//   - the payment write failing after the cash was already reserved
//   - deleting a cash payment and not getting the money back
//   - deleting it twice and getting the money back twice
//   - the acknowledgement gate being bypassed
//
// Every run gets its own DATA_DIR, so nothing here can see or touch real data.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// ── isolation, before anything requires config ────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-petty-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

// Guard the guard: if DATA_DIR were ignored, this would be writing to the real
// petty_cash.json. Refuse to run rather than find out afterwards.
if (!String(cfg.PETTY_CASH_FILE).startsWith(TMP)) {
    console.error(`  ABORT  config is not isolated — PETTY_CASH_FILE is ${cfg.PETTY_CASH_FILE}`);
    process.exit(1);
}

const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const payments = require(path.join(ROOT, 'helpers/payments'));

const reset = () => {
    for (const f of [cfg.PETTY_CASH_FILE, cfg.PAYMENTS_FILE]) {
        try { fs.writeFileSync(f, '[]'); } catch (e) {}
    }
};
const money = (n) => Math.round(n * 100) / 100;

(async () => {

console.log('\n─ petty cash: the cash box, and what draws on it ────────────');

// ── 1. the ledger itself ──────────────────────────────────────────────────
section('A — top-ups and the balance');
{
    reset();
    ck('an empty box is zero, not null', petty.balance() === 0);

    await petty.addTopUp({ amount: 500, date: '2026-09-01', note: 'from the bank' });
    ck('a top-up moves the balance', petty.balance() === 500);
    await petty.addTopUp({ amount: 250.55 });
    ck('  and they sum', petty.balance() === 750.55);

    // Rejected rather than stored: a zero or negative "top-up" is either a
    // typo or a withdrawal wearing the wrong label, and both need saying.
    let threw = null;
    try { await petty.addTopUp({ amount: 0 }); } catch (e) { threw = e.message; }
    ck('zero is refused', !!threw && petty.balance() === 750.55);
    threw = null;
    try { await petty.addTopUp({ amount: -100 }); } catch (e) { threw = e.message; }
    ck('negative is refused', !!threw && petty.balance() === 750.55);
    threw = null;
    try { await petty.addTopUp({ amount: 'abc' }); } catch (e) { threw = e.message; }
    ck('nonsense is refused', !!threw && petty.balance() === 750.55);

    // The date defaults to the yard's local day, NOT UTC — an evening top-up
    // stamped with tomorrow is the bug that already bit payments once.
    const e = await petty.addTopUp({ amount: 10 });
    ck('the date defaults to the Brea local day',
       e.date === require(path.join(ROOT, 'helpers/time')).todayLocal());
}

// ── 2. the reported behaviour ─────────────────────────────────────────────
section('B — a cash payment is adjusted against the box');
{
    reset();
    await petty.addTopUp({ amount: 1000 });
    const p = await payments.addPayment({ load_id: 'EDGE_01', amount: 300, mode: 'Cash' });
    ck('the payment is recorded for the full amount', p.amount === 300);
    ck('and the box is drawn down', petty.balance() === 700);
    ck('the withdrawal is linked to the load', petty.listEntries().some(e => e.kind === 'payment' && e.load_id === 'EDGE_01'));
    ck('  and to the payment', petty.listEntries().some(e => e.payment_id === p.id));
    ck('  and the payment points back at the entry', !!p.petty_cash_entry_id);

    // The whole point of the feature: only CASH touches the box.
    for (const mode of ['Zelle', 'Wire', 'Cheque']) {
        const before = petty.balance();
        await payments.addPayment({ load_id: 'EDGE_02', amount: 50, mode });
        ck(`a ${mode} payment does not touch petty cash`, petty.balance() === before);
    }
}

// ── 3. the case she actually described ────────────────────────────────────
section('C — cash low, invoice high');
{
    reset();
    await petty.addTopUp({ amount: 400 });

    // WITHOUT the acknowledgement it must REFUSE, not quietly pay less. A
    // supplier being handed $400 against a $1,500 load is a decision.
    let err = null;
    try { await payments.addPayment({ load_id: 'EDGE_09', amount: 1500, mode: 'Cash' }); }
    catch (e) { err = e; }
    ck('without acknowledgement it refuses', !!err);
    ck('  with a code the client can branch on', err && err.code === 'PETTY_CASH_SHORT');
    ck('  and the figure the operator needs', err && err.available === 400);
    ck('  nothing was taken', petty.balance() === 400);
    ck('  and no payment was recorded', payments.paymentsForLoad('EDGE_09').length === 0);

    // WITH it, the payment is capped and the rest stays outstanding.
    const p = await payments.addPayment({ load_id: 'EDGE_09', amount: 1500, mode: 'Cash', allow_partial: true });
    ck('acknowledged, it pays what there is', p.amount === 400);
    ck('  the box is emptied, not overdrawn', petty.balance() === 0);
    const sum = payments.paymentSummary('EDGE_09', 1500);
    ck('  the load reads as PARTIAL', sum.status === 'partial');
    ck('  with the rest still outstanding', sum.pending === 1100);
}

// ── 4. an empty box ───────────────────────────────────────────────────────
section('D — nothing in the box');
{
    reset();
    let err = null;
    try { await payments.addPayment({ load_id: 'EDGE_10', amount: 100, mode: 'Cash' }); }
    catch (e) { err = e; }
    ck('an empty box refuses the payment', err && err.code === 'PETTY_CASH_EMPTY');

    // Even acknowledged. "Pay them nothing" is not a payment, and a $0 row on
    // the ledger would look like a receipt for nothing.
    err = null;
    try { await payments.addPayment({ load_id: 'EDGE_10', amount: 100, mode: 'Cash', allow_partial: true }); }
    catch (e) { err = e; }
    ck('  and still refuses when acknowledged — $0 is not a payment', err && err.code === 'PETTY_CASH_EMPTY');
    ck('  the balance stays at zero, never negative', petty.balance() === 0);
    ck('  no payment row was written', payments.listPayments().length === 0);
}

// ── 5. the box can never go negative ──────────────────────────────────────
section('E — the box cannot be overdrawn, however hard it is pushed');
{
    reset();
    await petty.addTopUp({ amount: 100 });
    // Ten acknowledged attempts at more than there is. The first empties it,
    // the rest must all refuse.
    let taken = 0, refused = 0;
    for (let i = 0; i < 10; i++) {
        try {
            const p = await payments.addPayment({ load_id: 'EDGE_' + i, amount: 60, mode: 'Cash', allow_partial: true });
            taken = money(taken + p.amount);
        } catch (e) { refused++; }
    }
    ck('exactly the money that was there was paid out', taken === 100);
    ck('  the rest were refused', refused === 8);
    ck('  the balance is zero', petty.balance() === 0);
    ck('  and never went below it',
       petty.listEntries().reduce((run, e, i, arr) => {
           const bal = petty.balanceOf(arr.slice(0, i + 1));
           return run && bal >= -0.005;
       }, true));
}

// ── 6. two payments racing the same balance ───────────────────────────────
section('F — concurrent payments serialise rather than both succeeding');
{
    reset();
    await petty.addTopUp({ amount: 500 });
    // Both want $400. There is $500. Exactly one should get it in full; the
    // other must either be capped to the $100 left or refused — never both
    // paid $400 out of a $500 box.
    const results = await Promise.allSettled([
        payments.addPayment({ load_id: 'RACE_A', amount: 400, mode: 'Cash', allow_partial: true }),
        payments.addPayment({ load_id: 'RACE_B', amount: 400, mode: 'Cash', allow_partial: true }),
    ]);
    const paid = results.filter(r => r.status === 'fulfilled').reduce((a, r) => a + r.value.amount, 0);
    ck('no more was paid out than was in the box', money(paid) <= 500,
       `paid ${paid} out of 500 — the balance check and the write are not under one lock`);
    ck('  and the balance agrees', money(500 - paid) === petty.balance());
    ck('  the box is not negative', petty.balance() >= 0);
}

// ── 7. undoing ────────────────────────────────────────────────────────────
section('G — deleting a cash payment puts the money back');
{
    reset();
    await petty.addTopUp({ amount: 1000 });
    const p = await payments.addPayment({ load_id: 'EDGE_20', amount: 250, mode: 'Cash' });
    ck('drawn down', petty.balance() === 750);

    await payments.deletePayment(p.id);
    ck('deleting the payment refunds the box', petty.balance() === 1000);

    // As a reversal ROW, not by deleting the withdrawal. A ledger you can
    // remove rows from is one nobody can reconcile.
    const kinds = petty.listEntries().map(e => e.kind);
    ck('  the withdrawal is still on the ledger', kinds.filter(k => k === 'payment').length === 1);
    ck('  and the refund is its own row', kinds.filter(k => k === 'reversal').length === 1);

    // Idempotent. A retry after a partial failure must not pay twice.
    await payments.deletePayment(p.id);
    ck('deleting again does not refund twice', petty.balance() === 1000);

    // ── and the guard that actually makes that true ───────────────────────
    // The assertion above passes even WITHOUT the idempotence check, because
    // the second deletePayment finds no payment and never reaches the refund.
    // Mutation-testing caught that: removing the guard left the suite green.
    // So the claim is made directly against the function that carries it —
    // this is the path a cascade delete, or a retry after a partial failure,
    // really takes.
    const bal = petty.balance();
    const entry = petty.listEntries().find(e => e.kind === 'payment');
    await petty.reverseForPayment(entry.id);
    ck('  reversing an already-reversed withdrawal is a no-op', petty.balance() === bal,
       'without this, a cascade delete after a manual one refunds the same cash twice');
    await petty.reverseForPayment(p.id);
    ck('  by payment id too', petty.balance() === bal);
    ck('  and only one reversal row exists',
       petty.listEntries().filter(e => e.kind === 'reversal').length === 1);

    // Reversing something that never drew on cash must do nothing at all,
    // rather than inventing a credit.
    await petty.reverseForPayment('NOT_A_REAL_ID');
    ck('  reversing an unknown id credits nothing', petty.balance() === bal);

    // A non-cash payment has nothing to refund.
    const z = await payments.addPayment({ load_id: 'EDGE_21', amount: 99, mode: 'Zelle' });
    await payments.deletePayment(z.id);
    ck('deleting a Zelle payment leaves the box alone', petty.balance() === 1000);
}

// ── 8. the rollback when the payment write fails ──────────────────────────
section('H — cash reserved, payment write fails');
{
    reset();
    await petty.addTopUp({ amount: 800 });

    // Break the payments file for real, so the write fails AFTER the cash has
    // been reserved. This is the window the reserve-then-write ordering was
    // chosen for.
    //
    // A REAL broken file, not a stubbed mutateJson. The first version of this
    // test reassigned helpers/json.js's export — which did nothing, because
    // helpers/payments.js destructures mutateJson at require time and holds
    // its own reference. The test failed and the CODE was fine. Replacing the
    // file with a directory of the same name cannot be no-opped by anything:
    // every write path fails on it, whatever holds which reference.
    try { fs.unlinkSync(cfg.PAYMENTS_FILE); } catch (e) {}
    fs.mkdirSync(cfg.PAYMENTS_FILE);

    let err = null;
    try { await payments.addPayment({ load_id: 'EDGE_30', amount: 300, mode: 'Cash' }); }
    catch (e) { err = e; }

    const balanceWhileBroken = petty.balance();
    fs.rmSync(cfg.PAYMENTS_FILE, { recursive: true, force: true });
    fs.writeFileSync(cfg.PAYMENTS_FILE, '[]');

    ck('the caller is told it failed', !!err,
       'a payment that did not save must never return as though it did');
    ck('  no payment was recorded', payments.paymentsForLoad('EDGE_30').length === 0);
    ck('  and the cash was put back', balanceWhileBroken === 800,
       'the reservation must be reversed, or the box shows money gone for a payment that does not exist');
    // Checked as a reversal row, not just a number: the withdrawal and its
    // refund should both be visible, so the episode is legible on the tab
    // rather than looking like it never happened.
    const rolled = petty.listEntries();
    ck('  the failed attempt left an audit pair, not a hole',
       rolled.some(e => e.kind === 'payment' && e.load_id === 'EDGE_30')
       && rolled.some(e => e.kind === 'reversal'));
}

// ── 9. deleting a top-up, and not deleting anything else ──────────────────
section('I — only a top-up can be deleted from the tab');
{
    reset();
    const t = await petty.addTopUp({ amount: 600 });
    const p = await payments.addPayment({ load_id: 'EDGE_40', amount: 100, mode: 'Cash' });
    const withdrawal = petty.listEntries().find(e => e.kind === 'payment');

    let err = null;
    try { await petty.deleteEntry(withdrawal.id); } catch (e) { err = e; }
    ck('a withdrawal cannot be deleted here', err && err.code === 'PETTY_CASH_NOT_A_TOPUP',
       'it belongs to a payment — undoing it there is what reverses it properly');
    ck('  and nothing moved', petty.balance() === 500);

    ck('a top-up CAN be deleted', await petty.deleteEntry(t.id));
    ck('  and the balance follows', petty.balance() === -100,
       'deleting the top-up that funded a payment legitimately leaves the box short — that is a real state, not a bug');
}

// ── 10. the pieces the client depends on ──────────────────────────────────
section('J — the shape the tab and the Pay form read');
{
    reset();
    await petty.addTopUp({ amount: 100, date: '2026-09-01', note: 'float' });
    await petty.addTopUp({ amount: 50, date: '2026-09-02' });
    const h = petty.history();
    ck('history is newest first', h[0].date === '2026-09-02');
    ck('  every row says what kind it is', h.every(e => petty.ENTRY_KINDS.includes(e.kind)));
    ck('  and carries a signed amount', h.every(e => typeof e.amount === 'number'));
    ck('  notes survive', h.some(e => e.note === 'float'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})();
