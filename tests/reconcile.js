// ── tests/reconcile.js ────────────────────────────────────────────────────
// Apsara, 2026-09-03: "can i link my bank account here like quickbook."
//
// The Plaid connection is plumbing. This is the part she actually wants, and
// the part that keeps its value if the Plaid application stalls or is
// refused — matching is the same work whether the rows came from an API or a
// CSV she downloaded.
//
// WHAT A RECONCILIATION MUST NEVER DO, in order:
//   1. match two records that are not the same money (section C)
//   2. let one bank row explain several payments (section D)
//   3. put cash in the "never hit the bank" column for ever (section B)
//   4. change its answer between runs on the same data (section E)
//
// The third is the one that quietly kills the feature rather than breaking
// it: a screen with a permanent list of false alarms is a screen nobody
// reads, and a reconciliation nobody reads is worse than none, because it
// looks like the checking is being done.

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const { reconcile, bookedOutflows, bankOutflows, DEFAULT_DAY_WINDOW } =
    require(path.join(ROOT, 'helpers/reconcile'));

// Plaid's convention: a POSITIVE amount is money leaving the account.
const bankTx = (o) => Object.assign(
    { transaction_id: 'tx_' + Math.random().toString(36).slice(2, 8), date: '2026-09-01', amount: 100, name: 'ZELLE PAYMENT', pending: false }, o);
const pay = (o) => Object.assign(
    { id: 'PAY_1', load_id: 'EDGE_01', load_kind: 'purchase', mode: 'Zelle', amount: 100, paid_on: '2026-09-01' }, o);
const exp = (o) => Object.assign(
    { id: 'EXP_1', description: 'fuel', payment_method: 'Card', amount: 50, date: '2026-09-01' }, o);

console.log('\n─ the bank against the books ────────────────────────────────');

section('A — a clean match');
{
    const r = reconcile({
        payments: [pay({ amount: 1200, paid_on: '2026-09-01' })],
        transactions: [bankTx({ amount: 1200, date: '2026-09-01' })],
    });
    ck('the payment is matched', r.counts.matched === 1);
    ck('  nothing is left unsettled', r.counts.unsettled === 0);
    ck('  and nothing unrecorded', r.counts.unrecorded === 0);
    ck('  the pair is reported, not just a count',
       r.matched[0].booked.id === 'PAY_1' && r.matched[0].bank.amount === 1200);
    ck('  with how far apart the dates were', r.matched[0].day_gap === 0,
       'a match at four days apart deserves more scrutiny than one on the day');
    ck('totals add up', r.totals.matched === 1200);
}

section('B — cash never appears in either column');
{
    // THE ONE THAT KILLS THE FEATURE IF WRONG. Notes handed over at the yard
    // never touch the bank, so a cash payment in "never hit the bank" is a
    // false alarm that can never be cleared — and it would appear on every
    // single cash payment, for ever.
    const r = reconcile({
        payments: [pay({ id: 'PAY_C', mode: 'Cash', amount: 400 })],
        expenses: [exp({ id: 'EXP_C', payment_method: 'Cash', amount: 60 })],
        transactions: [],
    });
    ck('a cash payment is not expected on the statement', r.counts.unsettled === 0,
       'a permanent list of false alarms is how a reconciliation screen gets ignored');
    ck('  nor a cash expense', r.totals.unsettled === 0);
    ck('  and neither counts as booked', r.counts.booked === 0);

    // An expense with NO method recorded IS included. It might have been cash,
    // and she can say so — but dropping it silently would hide a card payment
    // that never cleared, which is what this screen is for.
    const r2 = reconcile({ expenses: [exp({ id: 'EXP_U', payment_method: null, amount: 70 })], transactions: [] });
    ck('an expense with no recorded method is still expected', r2.counts.unsettled === 1,
       'silently dropping it would hide a card payment that never cleared');
}

section('C — a discrepancy is never blurred away');
{
    // Two records a dollar apart are not the same payment. Fuzzy amounts are
    // the one thing a reconciliation must not do: it makes two records agree
    // that never did.
    const r = reconcile({
        payments: [pay({ amount: 1200 })],
        transactions: [bankTx({ amount: 1199, date: '2026-09-01' })],
    });
    ck('a one-dollar difference does NOT match', r.counts.matched === 0);
    ck('  the payment is reported unsettled', r.counts.unsettled === 1);
    ck('  and the bank row unrecorded', r.counts.unrecorded === 1,
       'both sides are shown, so she can see the pair and judge it herself');

    // A cent is fine — floating point, not a discrepancy.
    const cents = reconcile({
        payments: [pay({ amount: 333.33 })],
        transactions: [bankTx({ amount: 333.33, date: '2026-09-01' })],
    });
    ck('but exact cents still match', cents.counts.matched === 1);
}

section('D — one bank row cannot explain three payments');
{
    // Without one-to-one consumption, a single 500 withdrawal would settle
    // every 500 payment in the window and all three would look paid.
    const r = reconcile({
        payments: [
            pay({ id: 'P1', load_id: 'EDGE_01', amount: 500, paid_on: '2026-09-01' }),
            pay({ id: 'P2', load_id: 'EDGE_02', amount: 500, paid_on: '2026-09-01' }),
            pay({ id: 'P3', load_id: 'EDGE_03', amount: 500, paid_on: '2026-09-01' }),
        ],
        transactions: [bankTx({ transaction_id: 'tx_one', amount: 500, date: '2026-09-01' })],
    });
    ck('exactly one is matched', r.counts.matched === 1);
    ck('  the other two are unsettled', r.counts.unsettled === 2,
       'three payments settled by one withdrawal is 1,000 of missing money reported as fine');
    ck('  and the bank row is used once', r.counts.unrecorded === 0);

    // The mirror: three identical bank rows, one payment.
    const r2 = reconcile({
        payments: [pay({ id: 'P1', amount: 500 })],
        transactions: [
            bankTx({ transaction_id: 'a', amount: 500, date: '2026-09-01' }),
            bankTx({ transaction_id: 'b', amount: 500, date: '2026-09-01' }),
            bankTx({ transaction_id: 'c', amount: 500, date: '2026-09-01' }),
        ],
    });
    ck('and two unclaimed bank rows are reported', r2.counts.unrecorded === 2,
       'paying the same seller three times when it should have been once is exactly what this finds');
}

section('E — the same data gives the same answer twice');
{
    // Two candidates equally close in date. Without a deterministic tiebreak
    // the pairing flips between runs and the screen changes under her while
    // she is reading it.
    // SAME DATE, not merely equal distance. The first version of this used
    // 09-09 and 09-11 around a payment on the 10th — equal gaps, but the sort
    // by date already put one first deterministically, so removing the id
    // tiebreak changed nothing and the mutation went undetected. A real tie
    // needs the sort key to be identical too.
    const build = () => ({
        payments: [pay({ id: 'P1', amount: 750, paid_on: '2026-09-10' })],
        transactions: [
            bankTx({ transaction_id: 'zzz', amount: 750, date: '2026-09-10' }),
            bankTx({ transaction_id: 'aaa', amount: 750, date: '2026-09-10' }),
        ],
    });
    const a = reconcile(build());
    const b = reconcile(build());
    ck('the same pair is chosen both times', a.matched[0].bank.id === b.matched[0].bank.id);
    ck('  and it is the lower id on a tie', a.matched[0].bank.id === 'aaa',
       'without a tiebreak the answer depends on array order, which depends on sync order');

    // Order of the inputs must not change the outcome either. This is the
    // assertion that actually bites: sort is stable, so with the tiebreak gone
    // the winner follows the input order and reversing flips it.
    const shuffled = build();
    shuffled.transactions.reverse();
    ck('reversing the bank rows changes nothing',
       reconcile(shuffled).matched[0].bank.id === 'aaa',
       'the screen must not change under her between two syncs of the same data');
}

section('F — a payment that clears late still matches');
{
    // She records the date she PAID; the bank records the day it cleared. A
    // wire sent Thursday lands Monday.
    for (const [gap, date] of [[0, '2026-09-01'], [1, '2026-09-02'], [4, '2026-09-05']]) {
        const r = reconcile({ payments: [pay({ amount: 900, paid_on: '2026-09-01' })],
                              transactions: [bankTx({ amount: 900, date })] });
        ck(`${gap} day(s) later still matches`, r.counts.matched === 1);
    }
    const far = reconcile({ payments: [pay({ amount: 900, paid_on: '2026-09-01' })],
                            transactions: [bankTx({ amount: 900, date: '2026-09-20' })] });
    ck('nineteen days apart does not', far.counts.matched === 0,
       'wide enough and coincidental same-amount matches outnumber real ones');
    ck('  the window is stated, not hidden', far.day_window === DEFAULT_DAY_WINDOW);
    ck('  and it can be narrowed', reconcile({
        payments: [pay({ amount: 900, paid_on: '2026-09-01' })],
        transactions: [bankTx({ amount: 900, date: '2026-09-03' })], dayWindow: 1 }).counts.matched === 0);
}

section('G — money coming IN is not money going out');
{
    // Plaid: positive is money out. A deposit is negative and must never be
    // treated as an outflow, or every sale would cancel a purchase.
    const r = reconcile({
        payments: [pay({ id: 'SALE', load_kind: 'sale', amount: 40000 })],
        transactions: [bankTx({ amount: -40000, date: '2026-09-01', name: 'INCOMING WIRE' })],
    });
    ck('a sale payment is not expected as an outflow', r.counts.booked === 0,
       'it is money received — matching it against a withdrawal would be nonsense');
    ck('  and a deposit is not an unrecorded withdrawal', r.counts.unrecorded === 0);

    ck('bankOutflows drops deposits', bankOutflows([bankTx({ amount: -50 })]).length === 0);
    ck('  and pending rows', bankOutflows([bankTx({ amount: 50, pending: true })]).length === 0,
       'a pending row can change amount or vanish; matching it would settle a payment against something that never happened');
}

section('H — trucker bills reconcile too, and say whose they are');
{
    const r = reconcile({
        payments: [pay({ id: 'PT', load_id: 'TRK_001', load_kind: 'trucker', mode: 'Wire', amount: 800 })],
        bills: [{ id: 'TRK_001', company: 'Ace Haulage', amount: 800, date: '2026-09-01' }],
        transactions: [bankTx({ amount: 800, date: '2026-09-02', name: 'WIRE OUT' })],
    });
    ck('a trucker payment is matched', r.counts.matched === 1);
    ck('  labelled with the company, not the bill id', /Ace Haulage/.test(r.matched[0].booked.label),
       '"TRK_001" means nothing next to a bank line reading WIRE OUT');
    ck('  and tagged as haulage', r.matched[0].booked.kind === 'trucker');

    // A bill that has no matching record still degrades to the id rather than
    // throwing or printing "undefined".
    const noBill = reconcile({
        payments: [pay({ id: 'PT', load_id: 'TRK_099', load_kind: 'trucker', amount: 10 })],
        bills: [], transactions: [] });
    ck('a payment whose bill is gone still names something', /TRK_099/.test(noBill.unsettled[0].label));
}

section('I — the window clips the books, not the explanation');
{
    // A payment on the 30th clears on the 2nd. If the bank side were clipped
    // to the same window, every month boundary would invent a discrepancy.
    const r = reconcile({
        payments: [pay({ amount: 600, paid_on: '2026-09-30' })],
        transactions: [bankTx({ amount: 600, date: '2026-10-02' })],
        from: '2026-09-01', to: '2026-09-30',
    });
    ck('a payment clearing after the window still matches', r.counts.matched === 1,
       'clipping both sides would report a false discrepancy at every month end');
    ck('  and it is not reported as unsettled', r.counts.unsettled === 0);

    // But an unmatched bank row from outside the window is not news.
    const outside = reconcile({
        payments: [], transactions: [bankTx({ amount: 99, date: '2026-03-03' })],
        from: '2026-09-01', to: '2026-09-30',
    });
    ck('an old unmatched bank row is not dragged in', outside.counts.unrecorded === 0);
}

section('J — it reports, it never writes');
{
    // A wrong automatic match makes two records agree that never did. If this
    // ever starts writing it should be a decision with her name on it, not a
    // convenience someone added.
    const mod = require(path.join(ROOT, 'helpers/reconcile'));
    const names = Object.keys(mod);
    ck('nothing here is named like a write',
       !names.some((n) => /^(save|write|apply|mark|create|update|delete|auto)/i.test(n)),
       `exports: ${names.join(', ')}`);
    const src = require('fs').readFileSync(path.join(ROOT, 'helpers/reconcile.js'), 'utf8');
    ck('  and it does not touch any store', !/mutateJson|writeFileSync|require\('\.\/json'\)/.test(src),
       'a reconciliation that edits the books is no longer an independent check of them');
    ck('  nor know Plaid exists', !/plaid/i.test(src.replace(/\/\/.*$/gm, '')),
       'the matching has to survive the Plaid application being refused');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  Failed:'); failures.forEach((f) => console.log('   - ' + f)); }
process.exit(fail ? 1 : 0);
