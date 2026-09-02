// ── tests/spend-report.js ──────────────────────────────────────────────────
// Apsara, 2026-09-02: "if expense is added -> expense amount must be adjusted
// in petty cash as well ... A report needs to be there.. where i can track the
// monthly spent of cash/zelle/wire. date wise filter can also be there like
// quickbook."
//
// Two things, tested together because the second is only true if the first is:
// a report of cash spend is worth nothing if a cash expense never reached the
// ledger it reports on.
//
// The interesting rule here is an ASYMMETRY. A cash load payment is refused
// when the box is short; a cash expense is not. That is not an inconsistency —
// a payment is money about to be handed over, an expense is a receipt for
// money already gone, and refusing the second would not un-spend it. Several
// assertions below exist only to pin that difference in place.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-spend-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.PETTY_CASH_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}

const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const expenses = require(path.join(ROOT, 'helpers/expenses'));
const payments = require(path.join(ROOT, 'helpers/payments'));
const { buildSpendReport, UNCLASSIFIED } = require(path.join(ROOT, 'helpers/spendReport'));

const reset = () => {
    for (const f of [cfg.PETTY_CASH_FILE, cfg.PAYMENTS_FILE, cfg.EXPENSES_FILE]) {
        try { fs.writeFileSync(f, '[]'); } catch (e) {}
    }
};
const exp = (o) => Object.assign({ date: '2026-09-01', description: 'thing', amount: 100 }, o);

(async () => {

console.log('\n─ expenses against the cash box, and the spend report ───────');

// ── 1. the method became a fixed list ─────────────────────────────────────
section('A — how an expense was paid is now one of a known set');
{
    reset();
    ck('the list spans both sides of the report',
       ['Cash', 'Zelle', 'Wire', 'Cheque'].every(m => expenses.EXPENSE_METHODS.includes(m)),
       'a load payment and an expense paid the same way must land in the same column');
    ck('  plus Card and Other, which loads do not have',
       expenses.EXPENSE_METHODS.includes('Card') && expenses.EXPENSE_METHODS.includes('Other'));

    ck('a method is canonicalised', expenses.normalizeMethod('cash') === 'Cash');
    ck('  whatever the case', expenses.normalizeMethod('ZELLE') === 'Zelle');
    ck('  and whitespace', expenses.normalizeMethod('  Wire ') === 'Wire');

    // Legacy free text is NOT coerced. Her choice was to leave old entries
    // blank rather than guess, and "cash app" is not Cash.
    ck('an unrecognised value becomes null, not "Other"', expenses.normalizeMethod('cash app') === null,
       'calling it Other would assert a fact about how that money moved that nobody recorded');
    ck('  empty stays null', expenses.normalizeMethod('') === null);

    const e = await expenses.addExpense(exp({ payment_method: 'card' }));
    ck('the stored value is canonical', e.payment_method === 'Card');
}

// ── 2. a cash expense comes out of the box ────────────────────────────────
section('B — cash expenses adjust petty cash, others do not');
{
    reset();
    await petty.addTopUp({ amount: 1000 });

    await expenses.addExpense(exp({ amount: 150, payment_method: 'Cash', description: 'fuel' }));
    ck('a cash expense draws the box down', petty.balance() === 850);
    ck('  and the withdrawal is linked to the expense',
       petty.listEntries().some(en => en.kind === 'expense' && en.expense_id != null));

    for (const m of ['Card', 'Zelle', 'Wire', 'Cheque', 'Other']) {
        const before = petty.balance();
        await expenses.addExpense(exp({ amount: 50, payment_method: m }));
        ck(`a ${m} expense leaves the box alone`, petty.balance() === before,
           'it never touched the drawer — deducting it would stop the balance matching the notes');
    }
    // No method at all: unclassified, so it cannot be assumed to be cash.
    const before = petty.balance();
    await expenses.addExpense(exp({ amount: 70 }));
    ck('an expense with no method leaves the box alone', petty.balance() === before);
}

// ── 3. THE ASYMMETRY ──────────────────────────────────────────────────────
section('C — an expense is never refused, a payment is');
{
    reset();
    await petty.addTopUp({ amount: 100 });

    // A payment for more than there is: refused (tested fully in
    // tests/petty-cash.js — repeated here because the contrast IS the rule).
    let payErr = null;
    try { await payments.addPayment({ load_id: 'L1', amount: 500, mode: 'Cash' }); } catch (e) { payErr = e; }
    ck('a cash PAYMENT beyond the balance is refused', payErr && payErr.code === 'PETTY_CASH_SHORT');

    // The same shortfall as an expense: recorded anyway.
    const e = await expenses.addExpense(exp({ amount: 500, payment_method: 'Cash', description: 'parts' }));
    ck('a cash EXPENSE beyond the balance is recorded', !!e && e.amount === 500,
       'refusing would not un-spend the money, it would only stop the record being made');
    ck('  and the box goes negative', petty.balance() === -400);
    ck('  the shortfall is reported so the screen can say so', e.cash_shortfall === 400,
       'Apsara: "If expense is more but petty cash is less, notify user"');

    // A negative balance is information, not corruption: it means cash left
    // the drawer that was never entered here.
    await petty.addTopUp({ amount: 400 });
    ck('topping up clears it', petty.balance() === 0);
}

// ── 4. editing and deleting keep the ledger honest ────────────────────────
section('D — an edited or deleted cash expense adjusts the box');
{
    reset();
    await petty.addTopUp({ amount: 1000 });
    const e = await expenses.addExpense(exp({ amount: 200, payment_method: 'Cash' }));
    ck('drawn down', petty.balance() === 800);

    await expenses.editExpense(e.id, exp({ amount: 300, payment_method: 'Cash' }));
    ck('raising the amount takes the difference', petty.balance() === 700,
       'reverse-then-retake, so the ledger shows what it used to say as well as what it says now');

    await expenses.editExpense(e.id, exp({ amount: 300, payment_method: 'Card' }));
    ck('switching away from Cash refunds it in full', petty.balance() === 1000);

    await expenses.editExpense(e.id, exp({ amount: 300, payment_method: 'Cash' }));
    ck('switching back takes it again', petty.balance() === 700);

    // A no-op edit must not litter the ledger — routine typo fixes happen far
    // more often than amount changes.
    const rowsBefore = petty.listEntries().length;
    await expenses.editExpense(e.id, exp({ amount: 300, payment_method: 'Cash', description: 'renamed' }));
    ck('an edit that changes neither amount nor method writes nothing',
       petty.listEntries().length === rowsBefore && petty.balance() === 700);

    await expenses.deleteExpense(e.id);
    ck('deleting refunds it', petty.balance() === 1000);
    await expenses.deleteExpense(e.id);
    ck('  and deleting again does not refund twice', petty.balance() === 1000);

    // A non-cash expense has nothing to give back.
    const c = await expenses.addExpense(exp({ amount: 90, payment_method: 'Card' }));
    await expenses.deleteExpense(c.id);
    ck('deleting a Card expense leaves the box alone', petty.balance() === 1000);
}

// ── 5. the report ─────────────────────────────────────────────────────────
section('E — monthly spend by method, across both sources');
{
    const rep = buildSpendReport({
        payments: [
            { id: 'P1', load_id: 'EDGE_01', mode: 'Cash',  amount: 300, paid_on: '2026-08-10' },
            { id: 'P2', load_id: 'EDGE_02', mode: 'Zelle', amount: 700, paid_on: '2026-08-20' },
            { id: 'P3', load_id: 'EDGE_03', mode: 'Wire',  amount: 500, paid_on: '2026-09-02' },
        ],
        expenses: [
            { id: 'E1', description: 'fuel',  payment_method: 'Cash',     amount: 100, date: '2026-08-11' },
            { id: 'E2', description: 'parts', payment_method: 'Card',     amount: 250, date: '2026-09-01' },
            { id: 'E3', description: 'old',   payment_method: 'cash app', amount: 40,  date: '2026-09-01' },
        ],
        pettyEntries: [],
    });

    ck('both sources are counted', rep.total === 1890);
    ck('  split by where it went', rep.loadTotal === 1500 && rep.expenseTotal === 390);
    ck('the three methods she named each total correctly',
       rep.byMethod.Cash === 400 && rep.byMethod.Zelle === 700 && rep.byMethod.Wire === 500);
    ck('  Card too', rep.byMethod.Card === 250);

    // The legacy value is counted but not guessed into a column.
    ck('an unrecognised method is Unclassified, not Cash', rep.byMethod[UNCLASSIFIED] === 40,
       'filing "cash app" under Cash would be a guess about money');
    ck('  but it is still in the total', rep.total === 1890);

    ck('months are newest first', rep.months[0].month === '2026-09');
    const aug = rep.months.find(m => m.month === '2026-08');
    ck('August adds up', aug.Cash === 400 && aug.Zelle === 700 && aug.total === 1100);
    const sep = rep.months.find(m => m.month === '2026-09');
    ck('September adds up', sep.Wire === 500 && sep.Card === 250 && sep[UNCLASSIFIED] === 40 && sep.total === 790);
    ck('the month totals equal the grand total',
       rep.months.reduce((a, m) => a + m.total, 0) === rep.total);

    ck('every row is available to drill into', rep.rows.length === 6 && rep.count === 6);
    ck('  each says which side it came from', rep.rows.every(r => r.kind === 'load' || r.kind === 'expense'));
}

// ── 6. the date filter ────────────────────────────────────────────────────
section('F — date-wise filter');
{
    const data = {
        payments: [
            { id: 'P1', load_id: 'A', mode: 'Cash', amount: 100, paid_on: '2026-07-31' },
            { id: 'P2', load_id: 'B', mode: 'Cash', amount: 200, paid_on: '2026-08-01' },
            { id: 'P3', load_id: 'C', mode: 'Cash', amount: 400, paid_on: '2026-08-31' },
            { id: 'P4', load_id: 'D', mode: 'Cash', amount: 800, paid_on: '2026-09-01' },
        ],
        expenses: [], pettyEntries: [],
    };
    const aug = buildSpendReport({ ...data, from: '2026-08-01', to: '2026-08-31' });
    ck('the range is INCLUSIVE at both ends', aug.total === 600,
       'an exclusive end silently drops the last day of the month, which is a payday');
    ck('  nothing outside it is counted', aug.count === 2);
    ck('all-time is the default', buildSpendReport(data).total === 1500);
    ck('an open-ended start works', buildSpendReport({ ...data, to: '2026-08-01' }).total === 300);
    ck('an open-ended end works', buildSpendReport({ ...data, from: '2026-08-31' }).total === 1200);
    ck('a range with nothing in it is empty, not broken',
       buildSpendReport({ ...data, from: '2020-01-01', to: '2020-12-31' }).total === 0);
}

// ── 7. cash in, as well as out ────────────────────────────────────────────
section('G — the cash box reconciles inside the window');
{
    const entries = [
        { id: 'a', kind: 'topup',   date: '2026-07-20', amount: 1000 },
        { id: 'b', kind: 'payment', date: '2026-08-05', amount: -300 },
        { id: 'c', kind: 'topup',   date: '2026-08-10', amount: 500 },
        { id: 'd', kind: 'expense', date: '2026-08-12', amount: -150 },
        { id: 'e', kind: 'topup',   date: '2026-09-01', amount: 200 },
    ];
    const r = buildSpendReport({ payments: [], expenses: [], pettyEntries: entries, from: '2026-08-01', to: '2026-08-31' });
    ck('opening is everything before the window', r.cash.opening === 1000);
    ck('cash in during the window', r.cash.in === 500);
    ck('cash out during the window', r.cash.out === 450);
    ck('closing is the balance at the end of it', r.cash.closing === 1050);
    ck('  and the four numbers agree',
       r.cash.opening + r.cash.in - r.cash.out === r.cash.closing,
       'closing is computed independently, so a mismatch here means one of them is wrong');
    // September's top-up is after the window and must not leak in.
    ck('nothing after the window is counted', r.cash.closing !== 1250);
}

// ── 8. it never disagrees with the ledger it came from ────────────────────
section('H — computed live, never cached');
{
    reset();
    await petty.addTopUp({ amount: 5000 });
    const p = await payments.addPayment({ load_id: 'EDGE_50', amount: 400, mode: 'Cash', paid_on: '2026-09-02' });
    const build = () => buildSpendReport({
        payments: payments.listPayments(), expenses: expenses.loadExpenses(), pettyEntries: petty.listEntries(),
    });
    ck('the payment shows up', build().byMethod.Cash === 400);
    await payments.deletePayment(p.id);
    ck('and deleting it removes it on the very next call', build().byMethod.Cash === 0,
       'a report with its own stored totals would still be showing the deleted payment');
    ck('  the refund shows as cash back in', build().cash.closing === 5000);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})();
