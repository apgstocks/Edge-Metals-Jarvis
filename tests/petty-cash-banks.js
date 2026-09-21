// ── tests/petty-cash-banks.js ─────────────────────────────────────────────
// Apsara, 2026-09-21: "in petty cash,two requirement.when adding cash ,ask
// its from BofA or chase bank.. show overall cash .but also keep track of
// bofacash available and chase bank.when they pay cash as mode of payment-ask
// to choose from bofa/chase.Say the bill amount is 7000.we have only 3000 in
// chase and 10000 in bofa.and user chose the mode of payment as cash and then
// chase.It should show something in terms of 3000 only avilable inc hase.want
// to borrow from bofa?On confirmaton-allow them to pay.Keep this borrowing
// tracking in petty cash as a tab inside petty cash."
//
// Her decisions, asked and answered the same day:
//   existing cash + a customer's cash -> a third bucket, named "Unassigned"
//                                        (not "Others": helpers/banks.js
//                                        already uses that word for a bank
//                                        that is not BofA or Chase)
//   a cash expense                    -> "Yes, ask — same as a payment"
//   a borrow                          -> "A Repay button I press"
//
// ── THE INVARIANT EVERYTHING ELSE RESTS ON ───────────────────────────────
// BofA + Chase + Unassigned === Cash in hand, always, through any sequence.
// Asserted as a PROPERTY after every scenario below rather than as a set of
// expected numbers, because the numbers are what a refactor changes and the
// property is what must survive it.
//
// ── AND TWO BUGS FOUND BY HAND, WHICH IS WHY THIS FILE EXISTS ────────────
// Both were found by running her worked example one step further than she
// described it, and neither would have been caught by the checks I had:
//   D — Repay moved 4,000 out of a Chase that held nothing, clearing the
//       debt by creating an overdraft. Worse than the debt, and it looked
//       like success.
//   E — an expense EDIT re-wrote the withdrawal into Unassigned when the
//       original came out of Chase, silently moving money between banks
//       while the total stayed right.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pcb-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// Before config is required — see tests/verify-to-bill.js for the session
// that skipped itself silently when these sat lower down the file.
process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const { mutateJson } = require(path.join(ROOT, 'helpers/json'));

const B = () => petty.balances();
const bucket = (s) => B().bySource[s] || 0;
const CENT = 0.005;

// THE PROPERTY, in one place, called after every scenario. A helper rather
// than a repeated expression so it cannot be written slightly differently in
// one section and quietly check something weaker.
function invariant(where) {
    const b = B();
    const sum = Object.values(b.bySource).reduce((a, c) => a + c, 0);
    ck(`  ${where}: the buckets still add up to Cash in hand`,
        Math.abs(sum - b.total) <= CENT,
        `${sum} vs ${b.total} — ${JSON.stringify(b.bySource)}`);
}

const reset = () => mutateJson(cfg.PETTY_CASH_FILE, [], () => []);

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — three buckets, and they always sum to the total');

{
    await reset();
    ck('an empty box is zero everywhere', B().total === 0 && bucket('Edge Metals') === 0);
    // Five since 2026-09-21: BofA split into an Edge Metals account and an
    // AAA Investment one, and plain BofA stayed because her old rows say it.
    ck('the sources come from ONE list', Array.isArray(petty.SOURCES) && petty.SOURCES.length === 4,
        JSON.stringify(petty.SOURCES));
    // She first chose to keep a plain 'Edge Metals' bucket and reassign as she went,
    // then on 2026-09-22 chose the migration instead ("for previous cash").
    // So there is no unsplit bucket left to offer.
    ck('  and BofA is not among them any more',
        !petty.SOURCES.includes('BofA'),
        'scripts/migrate-bofa-to-edge-metals.js moves those rows to Edge Metals');
    // NOTHING CAN BE LOST BY THAT, and this is the check that says so: a row
    // still naming BofA — because the migration has not run yet — keeps its
    // money visible instead of vanishing from every bucket while still
    // counting in the total.
    ck('  but un-migrated BofA money still shows, rather than disappearing',
        petty.balanceBySource([{ cash_source: 'BofA', amount: 6000 }]).BofA === 6000,
        'sourceOf keeps an unrecognised name as typed, for exactly this window');
    // "Others" is banks.js's word for a bank that is not BofA or Chase. Two
    // meanings for one word on adjacent screens is the trap she avoided.
    ck('and the third bucket is NOT called Others', !petty.SOURCES.includes('Others'));

    await petty.addTopUp({ amount: 3000, cash_source: 'Chase Bank', date: '2026-09-21' });
    await petty.addTopUp({ amount: 10000, cash_source: 'Edge Metals', date: '2026-09-21' });
    ck('each top-up lands in the bank she named', bucket('Chase Bank') === 3000 && bucket('Edge Metals') === 10000);
    ck('and Cash in hand is their sum', B().total === 13000);
    invariant('after two top-ups');

    // A name that is not a source would become a fourth bucket nobody asked
    // for, and the three figures on screen would stop adding up.
    let threw = null;
    try { await petty.addTopUp({ amount: 100, cash_source: 'Wells Fargo' }); } catch (e) { threw = e; }
    ck('an unknown bank is refused, not filed somewhere', !!threw && /not one of/.test(threw.message), String(threw));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — cash with no bank behind it');
// ══════════════════════════════════════════════════════════════════════════
// Her answer: existing cash and a customer's cash go to a third bucket, and
// she can put a bank behind it later.

{
    await reset();
    // A row written before this feature existed has no cash_source AT ALL.
    // It must read as Unassigned rather than as nothing — a row that answered
    // null would vanish from every bucket while still counting in the total,
    // and the invariant would stop holding on her real, historical data.
    await mutateJson(cfg.PETTY_CASH_FILE, [], () => ([
        { id: 'OLD_1', kind: 'topup', date: '2026-08-01', amount: 2500, created_at: '2026-08-01T00:00:00Z' },
    ]));
    ck('a row from before this feature reads as Unassigned', bucket('Unassigned') === 2500,
        JSON.stringify(B().bySource));
    ck('  and still counts in Cash in hand', B().total === 2500);
    invariant('with only the opening float');

    // A customer's cash never came out of a bank.
    await petty.depositForPayment({ amount: 5000, loadId: 'SALE_1', date: '2026-09-21' });
    ck('a cash SALE lands in Unassigned, not in a bank', bucket('Unassigned') === 7500);
    ck('  and no bank was credited with money it never provided',
        bucket('Edge Metals') === 0 && bucket('Chase Bank') === 0);
    invariant('after a cash sale');

    // "Give them an option to add from which bank later."
    await petty.transfer({ from: 'Unassigned', to: 'Chase Bank', amount: 5000, reason: 'reassign', date: '2026-09-21' });
    ck('she can put a bank behind it afterwards', bucket('Chase Bank') === 5000 && bucket('Unassigned') === 2500);
    // A DATED MOVE, not an edit of the old rows — or last month's Chase
    // figure changes after she has read it and decided on it.
    const rows = petty.listEntries();
    ck('  recorded as a dated move, not by rewriting history',
        rows.filter((e) => e.kind === 'transfer').length === 2, JSON.stringify(rows.map((e) => e.kind)));
    ck('  and the opening row still says what it always said',
        rows.find((e) => e.id === 'OLD_1').amount === 2500);
    ck('  Cash in hand is untouched by a move', B().total === 7500);
    invariant('after reassigning');
}

// ══════════════════════════════════════════════════════════════════════════
section('C — HER WORKED EXAMPLE: 3,000 in Chase, 10,000 in BofA, a 7,000 bill');
// ══════════════════════════════════════════════════════════════════════════

{
    await reset();
    await petty.addTopUp({ amount: 3000, cash_source: 'Chase Bank', date: '2026-09-21' });
    await petty.addTopUp({ amount: 10000, cash_source: 'Edge Metals', date: '2026-09-21' });

    // "It should show something in terms of 3000 only avilable in chase.want
    // to borrow from bofa?" — REFUSED FIRST, with the figures, so the
    // question can be put to her before anything moves.
    let err = null;
    try {
        await petty.withdrawForPayment({ amount: 7000, loadId: 'L1', cashSource: 'Chase Bank' });
    } catch (e) { err = e; }
    ck('it refuses rather than quietly borrowing', !!err, 'the whole point is that she is asked');
    ck('  with its own code, not the empty-box one', err && err.code === 'PETTY_CASH_BUCKET_SHORT', err && err.code);
    ck('  naming the bucket', err && err.bucket === 'Chase Bank');
    ck('  what is in it', err && err.bucket_available === 3000);
    ck('  and what is short', err && err.shortfall === 4000);
    ck('  and who could cover it', err && err.lenders && err.lenders[0].source === 'Edge Metals'
        && err.lenders[0].available === 10000, JSON.stringify(err && err.lenders));
    ck('  nothing moved on the refusal', B().total === 13000 && bucket('Chase Bank') === 3000);
    invariant('after the refusal');

    // "On confirmaton-allow them to pay."
    const res = await petty.withdrawForPayment({ amount: 7000, loadId: 'L1', cashSource: 'Chase Bank', allowBorrow: true });
    ck('on her yes it pays in full', res.taken === 7000 && !res.capped);
    ck('  Chase is emptied, not overdrawn', bucket('Chase Bank') === 0, String(bucket('Chase Bank')));
    ck('  BofA gave up exactly the shortfall', bucket('Edge Metals') === 6000, String(bucket('Edge Metals')));
    ck('  and Cash in hand fell by the payment, no more and no less', B().total === 6000);
    invariant('after borrowing and paying');

    // "Keep this borrowing tracking in petty cash."
    const owed = petty.borrowings();
    ck('the debt is recorded, in the right direction',
        owed.length === 1 && owed[0].owes === 'Chase Bank' && owed[0].to === 'Edge Metals' && owed[0].amount === 4000,
        JSON.stringify(owed));
    ck('  and the movement behind it is on the list', petty.transfers().some((t) => t.reason === 'borrow' && t.amount === 4000));

    // ONE payment row, not two. reverseForPayment and stampPaymentId both
    // assume one withdrawal per payment; splitting it would break undo.
    const payRows = petty.listEntries().filter((e) => e.kind === 'payment');
    ck('the payment is ONE row, not one per bucket', payRows.length === 1, String(payRows.length));
    ck('  carrying the bucket she nominated', payRows[0].cash_source === 'Chase Bank');
}

// ══════════════════════════════════════════════════════════════════════════
section('C2 — a shortfall that spans TWO lenders');
// ══════════════════════════════════════════════════════════════════════════
// A mutation that reversed the lender ordering SURVIVED the first version of
// this file, because every scenario above had only one bucket with money in
// it and a sort of one element is a sort either way.
//
// The order is not arbitrary and it is not invisible: it decides which bank
// is recorded as the lender, and for how much, on the Borrowing tab she
// reads. Fullest first, so the fewest banks are drawn into one haul.

{
    await reset();
    await petty.addTopUp({ amount: 1000, cash_source: 'Chase Bank', date: '2026-09-21' });
    await petty.addTopUp({ amount: 3000, cash_source: 'Edge Metals', date: '2026-09-21' });
    await petty.depositForPayment({ amount: 5000, loadId: 'SALE_X', date: '2026-09-21' });   // Unassigned
    ck('three buckets with money in them', bucket('Chase Bank') === 1000
        && bucket('Edge Metals') === 3000 && bucket('Unassigned') === 5000, JSON.stringify(B().bySource));

    // 7,000 out of a Chase holding 1,000: 6,000 short, and no single other
    // bucket covers it.
    await petty.withdrawForPayment({ amount: 7000, loadId: 'L2', cashSource: 'Chase Bank', allowBorrow: true });
    ck('it pays in full anyway', B().total === 2000, String(B().total));
    ck('  Chase is emptied, not overdrawn', bucket('Chase Bank') === 0);
    invariant('after a two-lender borrow');

    const owed = petty.borrowings();
    const from = (who) => (owed.find((b) => b.to === who) || {}).amount || 0;
    ck('both lenders are recorded', owed.length === 2, JSON.stringify(owed));
    ck('  and every debt is Chase\'s', owed.every((b) => b.owes === 'Chase Bank'), JSON.stringify(owed));
    // THE ORDERING, PINNED. Fullest first: Unassigned holds 5,000 so it is
    // drawn dry, and Edge Metals covers the last 1,000. Reversed, Edge Metals
    // would be emptied for 3,000 and Unassigned would lend 3,000 — a
    // different pair of debts on her screen for the same haul.
    ck('  the fullest bucket lends first', from('Unassigned') === 5000 && from('Edge Metals') === 1000,
        JSON.stringify(owed));
    ck('  and the two debts add up to the shortfall',
        Math.abs(from('Unassigned') + from('Edge Metals') - 6000) <= CENT);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — Repay cannot invent an overdraft');
// ══════════════════════════════════════════════════════════════════════════
// FOUND BY HAND, running her example one step past where she described it.
// After the borrow Chase holds nothing, and pressing Repay moved 4,000 out
// of it anyway — the debt cleared and a MINUS 4,000 appeared in its place.
// A worse position than the one she started in, reported as success.

{
    // Its own setup. It used to lean on the state section C left behind, and
    // C2 now sits between them — a test that breaks when a section is
    // inserted above it is a test that gets deleted rather than fixed.
    await reset();
    await petty.addTopUp({ amount: 3000, cash_source: 'Chase Bank', date: '2026-09-21' });
    await petty.addTopUp({ amount: 10000, cash_source: 'Edge Metals', date: '2026-09-21' });
    await petty.withdrawForPayment({ amount: 7000, loadId: 'L1', cashSource: 'Chase Bank', allowBorrow: true });
    ck('Chase is empty going in', bucket('Chase Bank') === 0);
    let err = null;
    try { await petty.transfer({ from: 'Chase Bank', to: 'Edge Metals', amount: 4000, reason: 'repay' }); }
    catch (e) { err = e; }
    ck('repaying from an empty bucket is refused', !!err && err.code === 'PETTY_CASH_TRANSFER_SHORT', err && err.code);
    ck('  and says what to do instead', err && /Add cash to Chase Bank first/.test(err.message), err && err.message);
    ck('  Chase did NOT go negative', bucket('Chase Bank') === 0, String(bucket('Chase Bank')));
    ck('  and the debt is still owed', petty.borrowings().length === 1);
    invariant('after the refused repay');

    // The real sequence: put the cash back, then settle.
    await petty.addTopUp({ amount: 4000, cash_source: 'Chase Bank', date: '2026-09-22' });
    await petty.transfer({ from: 'Chase Bank', to: 'Edge Metals', amount: 4000, reason: 'repay', date: '2026-09-22' });
    ck('once Chase has the money, Repay works', bucket('Chase Bank') === 0 && bucket('Edge Metals') === 10000,
        JSON.stringify(B().bySource));
    ck('  and the debt is cleared', petty.borrowings().length === 0, JSON.stringify(petty.borrowings()));
    ck('  Cash in hand is unchanged by the repayment', B().total === 10000);
    invariant('after repaying properly');

    // A borrow is only ever created by a payment that needed one. A debt with
    // no payment behind it is a debt from nowhere.
    let partial = null;
    try { await petty.transfer({ from: 'Edge Metals', to: 'Chase Bank', amount: 1000, reason: 'repay', date: '2026-09-22' }); }
    catch (e) { partial = e; }
    ck('a repayment with nothing owed still moves the cash', !partial, partial && partial.message);
    // ── THE DIRECTION, AND I HAD IT BACKWARDS FIRST TIME ─────────────────
    // I asserted BofA would end up owed FROM, reasoning that BofA "over-paid".
    // Wrong, and the code was right: BofA handed Chase 1,000 against no debt,
    // so BofA is out of pocket and CHASE is sitting on its money. Chase owes
    // BofA. Written out because it is the kind of thing that reads either way
    // at a glance and only one way once you follow the cash.
    const over = petty.borrowings();
    ck('  the bucket now HOLDING the money is the one that owes it',
        over.length === 1 && over[0].owes === 'Chase Bank' && over[0].to === 'Edge Metals' && over[0].amount === 1000,
        JSON.stringify(over));
    // Whatever the direction, it is never reported as a negative debt — that
    // would be two sentences facing each other for one fact.
    ck('  and never as a negative amount', over.every((b) => b.amount > 0), JSON.stringify(over));
    invariant('after an over-repayment');
}

// ══════════════════════════════════════════════════════════════════════════
section('E — money goes back where it came from');
// ══════════════════════════════════════════════════════════════════════════
// THE SECOND BUG FOUND BY HAND. A reversal that lands in Unassigned while the
// withdrawal came out of Chase moves money between banks — and the TOTAL
// stays right, which is exactly why nobody would notice.

{
    await reset();
    await petty.addTopUp({ amount: 5000, cash_source: 'Chase Bank', date: '2026-09-21' });

    const p = await petty.withdrawForPayment({ amount: 1200, loadId: 'L9', paymentId: 'PAY_9', cashSource: 'Chase Bank' });
    ck('the payment came out of Chase', bucket('Chase Bank') === 3800 && bucket('Unassigned') === 0);
    await petty.reverseForPayment('PAY_9', {});
    ck('undoing it puts the money back in CHASE', bucket('Chase Bank') === 5000, JSON.stringify(B().bySource));
    ck('  and not into Unassigned', bucket('Unassigned') === 0,
        'a refund in the wrong bucket moves money between banks with the total still correct');
    invariant('after reversing a payment');

    // An expense names its bucket, and keeps its existing permission to
    // overdraw — that rule predates this feature and removing it would change
    // a screen she uses daily.
    const ex = require(path.join(ROOT, 'helpers/expenses'));
    const e1 = await ex.addExpense({ date: '2026-09-21', description: 'Diesel', vendor: 'Fuel',
        amount: 200, payment_method: 'Cash', cash_source: 'Chase Bank' });
    ck('a cash expense comes out of the bucket named', bucket('Chase Bank') === 4800, String(bucket('Chase Bank')));

    // THE EDIT. The form has no reason to resend cash_source when only the
    // amount changed, so the new withdrawal has to inherit the bucket of the
    // one it replaces.
    await ex.editExpense(e1.id, { date: '2026-09-21', description: 'Diesel', vendor: 'Fuel',
        amount: 300, payment_method: 'Cash' });
    ck('editing it WITHOUT resending the bank keeps it in Chase', bucket('Chase Bank') === 4700,
        JSON.stringify(B().bySource));
    ck('  and nothing leaked into Unassigned', bucket('Unassigned') === 0);
    invariant('after editing an expense');

    // Allowed to overdraw, deliberately — the money already left the drawer.
    await ex.addExpense({ date: '2026-09-21', description: 'Parts', vendor: 'Shop',
        amount: 9000, payment_method: 'Cash', cash_source: 'Chase Bank' });
    ck('an expense may still take a bucket negative', bucket('Chase Bank') < 0, String(bucket('Chase Bank')));
    invariant('with a bucket overdrawn');
}

// ══════════════════════════════════════════════════════════════════════════
section('F — END TO END, through the real routes');
// ══════════════════════════════════════════════════════════════════════════
// The helpers can all be right and the feature still not work: the route may
// not forward cash_source, the error may lose the figures the prompt needs,
// the tab may not return the buckets. So: a real server, her numbers, and a
// payment posted the way the Pay sheet posts it.

{
    const http = require('http');
    await reset();

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    await req('POST', '/api/petty-cash', { sid, body: { amount: 3000, cash_source: 'Chase Bank', date: '2026-09-21' } });
    await req('POST', '/api/petty-cash', { sid, body: { amount: 10000, cash_source: 'Edge Metals', date: '2026-09-21' } });

    const tab = await req('GET', '/api/petty-cash', { sid });
    ck('the tab returns Cash in hand', tab.json && tab.json.balance === 13000);
    ck('  and each bucket', tab.json.by_source && tab.json.by_source['Chase Bank'] === 3000
        && tab.json.by_source['Edge Metals'] === 10000, JSON.stringify(tab.json.by_source));
    // THE PROPERTY, not a count: the route serves the SAME list the helper
    // holds. `=== 3` was here, and it went red the day BofA split in two —
    // for a change that is exactly what this check wants to be true.
    ck('  and the source list, so the client need not hardcode one',
        Array.isArray(tab.json.sources)
        && tab.json.sources.join('|') === petty.SOURCES.join('|'),
        JSON.stringify(tab.json.sources));
    ck('  with the company behind each bucket, where she has said one',
        tab.json.company_of && tab.json.company_of['AAA Investment'] === 'AAA Investment'
        && tab.json.company_of['Chase Bank'] === tab.json.company_unknown,
        JSON.stringify(tab.json.company_of));

    const { addLoad } = require(path.join(ROOT, 'helpers/loads'));
    const load = await addLoad({ date: '2026-09-21', seller: 'Ramesh',
        items: [{ description: 'HMS', gross_weight: 8000, tare_weight: 1000, price: 1, unit: 'lb' }] });

    const pay = (extra) => req('POST', '/api/payments', { sid, body: {
        load_id: load.id, load_kind: 'purchase', amount: 7000, mode: 'Cash',
        paid_on: '2026-09-21', cash_source: 'Chase Bank', ...extra } });

    const first = await pay({});
    ck('the route refuses the first attempt', first.status === 400);
    // THE GAP THIS SECTION EXISTS FOR. The route flattens the error to a few
    // named fields; the bucket ones were being dropped, so the Pay sheet had
    // the question and none of the figures to ask it with.
    ck('  and the prompt gets every figure it needs',
        first.json.code === 'PETTY_CASH_BUCKET_SHORT' && first.json.bucket === 'Chase Bank'
        && first.json.bucket_available === 3000 && first.json.shortfall === 4000
        && Array.isArray(first.json.lenders) && first.json.lenders[0].source === 'Edge Metals',
        JSON.stringify(first.json));

    const second = await pay({ allow_borrow: true });
    ck('and pays on her confirmation', second.status === 200 && second.json.ok);

    const after = await req('GET', '/api/petty-cash', { sid });
    ck('the tab shows the borrow', after.json.by_source['Chase Bank'] === 0
        && after.json.by_source['Edge Metals'] === 6000,
        JSON.stringify(after.json.by_source));
    ck('  and what is owed', after.json.borrowings.length === 1
        && after.json.borrowings[0].owes === 'Chase Bank' && after.json.borrowings[0].amount === 4000,
        JSON.stringify(after.json.borrowings));
    const sum = Object.values(after.json.by_source).reduce((a, c) => a + c, 0);
    ck('  and the buckets the ROUTE returns add up to the balance it returns',
        Math.abs(sum - after.json.balance) <= CENT, `${sum} vs ${after.json.balance}`);

    // Repay, through the route the button uses.
    const early = await req('POST', '/api/petty-cash/transfer', { sid,
        body: { from: 'Chase Bank', to: 'Edge Metals', amount: 4000, reason: 'repay' } });
    ck('the route refuses a repay the bucket cannot fund', early.status === 400
        && early.json.code === 'PETTY_CASH_TRANSFER_SHORT', JSON.stringify(early.json));

    // A borrow has to come from a payment. One raised on its own is a debt
    // from nowhere.
    const naked = await req('POST', '/api/petty-cash/transfer', { sid,
        body: { from: 'Edge Metals', to: 'Chase Bank', amount: 100, reason: 'borrow' } });
    ck('the route refuses a borrow with no payment behind it', naked.status === 400, String(naked.status));

    await req('POST', '/api/petty-cash', { sid, body: { amount: 4000, cash_source: 'Chase Bank', date: '2026-09-22' } });
    const settled = await req('POST', '/api/petty-cash/transfer', { sid,
        body: { from: 'Chase Bank', to: 'Edge Metals', amount: 4000, reason: 'repay', date: '2026-09-22' } });
    ck('and settles it once Chase has the cash', settled.status === 200
        && settled.json.borrowings.length === 0, JSON.stringify(settled.json && settled.json.borrowings));

    // Staff read the balance; they do not move money between her accounts.
    const staffSid = ((await req('POST', '/login', { body: { password: process.env.STAFF_PASSWORD } })).json || {}).sid;
    ck('a staff session can be opened, or the next check proves nothing', !!staffSid);
    const denied = await req('POST', '/api/petty-cash/transfer', { sid: staffSid,
        body: { from: 'Edge Metals', to: 'Chase Bank', amount: 10, reason: 'reassign' } });
    ck('staff cannot move cash between accounts', denied.status === 403, String(denied.status));

    // ── THE OLDER APK ────────────────────────────────────────────────────
    // The build on her phone predates this field. A top-up that names no bank
    // must still be accepted — refusing would mean she cannot add cash from
    // her phone at all, which is the mistake CLAUDE.md records twice.
    const oldClient = await req('POST', '/api/petty-cash', { sid, body: { amount: 500, date: '2026-09-22' } });
    ck('a top-up from a client that does not know about banks still works', oldClient.status === 200,
        JSON.stringify(oldClient.json));
    const last = await req('GET', '/api/petty-cash', { sid });
    ck('  and lands in Unassigned rather than a guess', last.json.by_source.Unassigned === 500,
        JSON.stringify(last.json.by_source));

    await new Promise((r) => server.close(r));
}

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
section('H — BofA is two accounts, and they belong to two companies');
// Apsara, 2026-09-21: "In petty cash ,add bofa/AAA investments" → "Under
// BofA. 1.Edge Metals 2.AAA Investment" → and AAA Investment is "Yes — a
// third company". CLAUDE.md rule 5 is about exactly that separation.
{
    await reset();
    await petty.addTopUp({ amount: 6000, cash_source: 'Chase Bank', date: '2026-09-21' });
    await petty.addTopUp({ amount: 4000, cash_source: 'Edge Metals', date: '2026-09-21' });
    await petty.addTopUp({ amount: 2500, cash_source: 'AAA Investment', date: '2026-09-21' });
    await petty.addTopUp({ amount: 1500, cash_source: 'Chase Bank', date: '2026-09-21' });

    ck('the two new buckets hold what was put in them',
        bucket('Edge Metals') === 4000 && bucket('AAA Investment') === 2500,
        `${bucket('Edge Metals')} / ${bucket('AAA Investment')}`);
    ck('  and Chase is untouched by either', bucket('Chase Bank') === 7500, String(bucket('Chase Bank')));
    invariant('after topping up four buckets');

    // ── HER ANSWER: ONE TOTAL, THE SPLIT BELOW IT ────────────────────────
    const co = petty.balanceByCompany(petty.listEntries());
    ck('cash in hand is still every row added up', B().total === 14000, String(B().total));
    ck('  Edge Metals and AAA Investment are separate figures',
        co['Edge Metals'] === 4000 && co['AAA Investment'] === 2500, JSON.stringify(co));
    // THE PROPERTY, not the shape: the company split cannot drift from the
    // total, because it is folded from the buckets rather than counted again.
    ck('  and the company figures sum to the same total',
        Math.abs(Object.values(co).reduce((a, b) => a + b, 0) - B().total) < 0.005,
        `${JSON.stringify(co)} vs ${B().total}`);

    // ── WHAT SHE HAS NOT SAID IS NOT GUESSED ─────────────────────────────
    // Plain BofA is a mix, and she has never said whose Chase is. Assigning
    // either to Edge Metals because it is the bigger company would print a
    // per-company figure that reads as fact.
    ck('money whose company she has not stated says so',
        co[petty.COMPANY_UNKNOWN] === 7500, JSON.stringify(co));
    ck('  no unstated money is quietly filed under Edge Metals',
        co['Edge Metals'] === 4000,
        'plain BofA and Chase must not be swept into the company she trades most under');

    // ── THE CALLER WITHOUT A DROPDOWN ────────────────────────────────────
    // helpers/tools.js is how she records a payment by TALKING to Jarvis. It
    // has no select to pick a slash from, and it is the caller this repo has
    // broken three times by adding a requirement it could not meet.
    // The account IS the name she would say. Nothing is inferred from a
    // partial one — an earlier version named these 'BofA/Edge Metals' and
    // then had to guess a bare "AAA Investment" back onto it. She rejected
    // the name; the guessing went with it.
    ck('the name she would say is the name it is stored under',
        petty.cleanSource('AAA Investment') === 'AAA Investment'
        && petty.cleanSource('edge metals') === 'Edge Metals');
    ck('  case and stray spaces are tolerated, nothing else is',
        petty.cleanSource('  aaa   investment ') === 'AAA Investment');
    // 'Edge Metals' is now ambiguous between two companies' accounts, so it is
    // refused rather than resolved to either one.
    let legacy = null;
    try { petty.cleanSource('BofA'); } catch (e) { legacy = e; }
    ck('  "BofA" is refused, because it could mean either company now',
        !!legacy && /Edge Metals/.test(String(legacy.message)),
        String(legacy && legacy.message));
    let partial = null;
    try { petty.cleanSource('AAA'); } catch (e) { partial = e; }
    ck('  and half a name is refused rather than guessed', !!partial,
        'guessing between two companies is the thing rule 5 exists to stop');

    // ── AND THE BANK EACH ONE SITS IN ────────────────────────────────────
    // Her shape: "Under BofA. 1.Edge Metals 2.AAA Investment". The bank is a
    // FACT ABOUT the account, not part of its name, and the screens group by
    // it. Unassigned has no bank — that is what the bucket means.
    ck('the two accounts are under BofA',
        petty.bankOf('Edge Metals') === 'BofA' && petty.bankOf('AAA Investment') === 'BofA',
        JSON.stringify(petty.SOURCES.map((x) => [x, petty.bankOf(x)])));
    // The condition that produced "Chase Bank / NOT YET SPLIT" was an account
    // named after its own bank WHILE OTHER ACCOUNTS SHARED THAT BANK — the
    // reader then has to guess which of them the bank's own name refers to.
    // Chase is named after its bank and that is fine: it is the only account
    // there, so the name is unambiguous. My first version of this check said
    // "no account is named after its own bank", which was simply false and
    // went red immediately.
    ck('  an account named after its bank is the only account there',
        petty.SOURCES.every((s) => petty.bankOf(s) !== s
            || petty.SOURCES.filter((x) => petty.bankOf(x) === petty.bankOf(s)).length === 1),
        JSON.stringify(petty.SOURCES.map((s) => [s, petty.bankOf(s)])));
    ck('  Chase Bank is its own', petty.bankOf('Chase Bank') === 'Chase Bank');
    ck('  and unbanked cash says it has no bank rather than naming one',
        petty.bankOf('Unassigned') === null, String(petty.bankOf('Unassigned')));
    let refused = null;
    try { petty.cleanSource('Wells Fargo'); } catch (e) { refused = e; }
    ck('  and a name that is not a bucket is still refused', !!refused);

    // ── BORROWING ACROSS THE LINE: ALLOWED, AND SAID OUT LOUD ────────────
    // Her choice of three: "Allow it, record it as owed."
    // Only two buckets, so the lender is not a question. The first attempt at
    // this check left plain BofA holding the most, the borrow came from THERE,
    // and intercompany was correctly false — the code was right and the
    // fixture was wrong. A test whose answer depends on which bucket happens
    // to be fullest is a test that goes red when an unrelated figure moves.
    await reset();
    await petty.addTopUp({ amount: 4000, cash_source: 'Edge Metals', date: '2026-09-21' });
    await petty.addTopUp({ amount: 2500, cash_source: 'AAA Investment', date: '2026-09-21' });
    await petty.withdrawForPayment({ amount: 3000, loadId: 'L_AAA',
        cashSource: 'AAA Investment', allowBorrow: true });
    const owed = petty.borrowings();
    const cross = owed.find((b) => b.owes === 'AAA Investment');
    ck('a short bucket still borrows rather than refusing', !!cross,
        JSON.stringify(owed));
    ck('  and the balance is flagged as between two companies',
        !!cross && cross.intercompany === true
        && cross.owes_company === 'AAA Investment' && cross.to_company !== 'AAA Investment',
        JSON.stringify(cross));
    invariant('after a cross-company borrow');

    // Two buckets with no stated company are not "the same company" — an
    // absence of an answer must not be asserted as a match.
    const plain = petty.borrowings([
        { kind: 'transfer', transfer_reason: 'borrow', cash_source: 'Edge Metals',
          transfer_to: 'Chase Bank', amount: -500 },
    ])[0];
    ck('two buckets with no company stated are not called intercompany',
        !!plain && plain.intercompany === false, JSON.stringify(plain));
    // AND THE ONE THAT MATTERS MORE, which the check above cannot catch:
    // 'Company not stated' differs from 'Edge Metals' as a STRING, so a rule
    // written as "the two labels differ" calls this intercompany. It is not.
    // Nobody has said whose Chase Bank is, and a balance cannot be declared
    // to cross a line that has not been drawn.
    const half = petty.borrowings([
        { kind: 'transfer', transfer_reason: 'borrow', cash_source: 'Edge Metals',
          transfer_to: 'Chase Bank', amount: -500 },
    ])[0];
    ck('  nor is a named company against an unnamed one',
        !!half && half.intercompany === false, JSON.stringify(half));

    // ── AND NO NAME CAN BE REACHED BY SAYING ANOTHER ────────────────────
    // Only exact names resolve now, so this is about the LIST rather than the
    // matcher: if an account is ever added called "Edge Metals Two", saying
    // "Edge Metals" stops being unambiguous in the head of whoever is typing
    // it, whatever the code does. This goes red the day that happens.
    ck('no account name is a prefix or suffix of another',
        petty.SOURCES.every((a) => petty.SOURCES.every((b) => a === b
            || !(b.toLowerCase().startsWith(a.toLowerCase() + ' ')
                 || b.toLowerCase().endsWith(' ' + a.toLowerCase())))),
        JSON.stringify(petty.SOURCES));

    // ── AND THE COPIES OF THE LIST IN THE TWO CLIENTS ────────────────────
    // Both screens build their dropdown from the server, but each keeps a
    // fallback for the moment before the first response lands. A stale
    // fallback would offer 'Edge Metals' as though it were the only BofA account.
    // Built FROM SOURCES rather than spelled out, so renaming an account
    // updates this check instead of breaking it. The first version of this
    // hardcoded the names and went red an hour later when she renamed them —
    // the same mistake as the `sources.length === 3` check above.
    const EXPECTED = '[' + petty.SOURCES.map((s) => `'${s}'`).join(', ') + ']';
    for (const f of ['dashboard/index.html', 'mobile-app/www/index.html']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const copies = (src.match(/pettyCash\.sources[\s\S]{0,160}?\[[^\]]*'Unassigned'\]/g) || []);
        ck(`${f}: every petty-cash fallback matches SOURCES`,
            copies.length > 0 && copies.every((c) => c.includes(EXPECTED)),
            `${copies.length} fallback(s) vs ${EXPECTED}: ${JSON.stringify(copies.map((c) => c.slice(-90)))}`);
    }
    // ── WHAT THE BUILT APP LOOKED LIKE ───────────────────────────────────
    // Apsara, 2026-09-22, on the release: "it looks ugly", then "all three
    // bofa should be in one line". Three of the four faults were taste; one
    // was a lie on screen, and NOTHING in this file would have caught it.
    //
    // "not yet split" was chosen by `name === its own bank`. That is true of
    // Chase Bank as well as of the legacy BofA bucket, so the phone printed
    // "Chase Bank / NOT YET SPLIT" — Chase has nothing to be split into.
    // The rule now requires the bank to HAVE other accounts, and the check
    // below is written against that property rather than against either name.
    for (const f of ['mobile-app/www/index.html', 'dashboard/index.html']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const inCode = src.split('\n').filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
        ck(`  ${f}: a lone account under a bank prints no bank heading`,
            /items\.length < 2/.test(inCode),
            '"No bank behind it" sat directly above "Unassigned" — one thing, named twice');
        ck(`  ${f}: the company sub-label under each account is gone`,
            !/company_unknown;[\s\S]{0,400}?\$\{esc\(co\)\}<\/div>`\s*:\s*''\}/.test(inCode),
            'every account is named for its company, so it printed the same words twice');
    }
    // Her instruction, and the only thing that makes three cells hold one
    // line at phone width: equal thirds that are allowed to shrink.
    const mob2 = fs.readFileSync(path.join(__dirname, '..', 'mobile-app/www/index.html'), 'utf8');
    ck('the accounts under one bank share the line instead of wrapping',
        /flex:\$\{share \? '1 1 0' : '0 0 auto'\}; min-width:0/.test(mob2),
        'all three BofA accounts on one line — without min-width:0 the third wraps');

    // ── AND THE COMPANY FIGURE THAT ONLY REPEATED THE TOTAL ──────────────
    // With every row unbanked it rendered "COMPANY NOT STATED $22,441.03"
    // directly under "CASH IN HAND $22,441.03".
    const dash2 = fs.readFileSync(path.join(__dirname, '..', 'dashboard/index.html'), 'utf8');
    ck('one company holding everything prints no company line',
        /if \(withMoney\.length < 2\) return \[\];/.test(dash2),
        'a company figure earns its place by DIVIDING the total, not restating it');

    // ── AND THE ONE THIS SCREEN IS FOR ───────────────────────────────────
    // Whatever is hidden for looking ugly, the accounts must still be
    // reachable as reassignment destinations — that is the whole argument
    // for listing empty ones. They come from `sources`, which is untouched.
    ck('every account is still offered as a destination, empty or not',
        petty.SOURCES.length === 4,
        'the panel may hide a heading; the dropdown must not hide an account');

    // ── AND THE WHOLE SCRIPT STILL PARSES ────────────────────────────────
    // Written after breaking it. An HTML comment inside a JS template literal
    // is not a comment to the JS parser — it is text inside a string — so a
    // BACKTICK in one CLOSES the template literal and everything after it
    // becomes garbage. I put `name ===` in a comment explaining the Chase
    // Bank label bug, and the phone's entire script stopped parsing.
    //
    // It cost three unrelated suites (bol, app-reports,
    // address-refresh-bol-delete) which eval this file, and I did not see it
    // because I re-ran the suites I remembered — petty cash and ledger-render
    // — rather than the whole set. CLAUDE.md rule 2, exactly.
    //
    // Cheap to check, and checked for BOTH clients: a syntax error here takes
    // out every screen at once, not just petty cash.
    for (const f of ['mobile-app/www/index.html', 'dashboard/index.html']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const blocks = src.match(/<script>[\s\S]*?<\/script>/g) || [];
        const js = blocks.map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, '')).join('\n');
        let bad = null;
        try { new (require('vm').Script)(js); } catch (e) { bad = e; }
        ck(`${f}: the whole page script parses`, !bad, bad && bad.message);
        // And the reason it stopped: say it by name, so the next person
        // reading a red line here knows where to look first.
        const comments = (src.match(/<!--[\s\S]*?-->/g) || []).filter((c) => c.includes('`'));
        ck(`  ${f}: no backtick inside an HTML comment`, comments.length === 0,
            'inside a template literal that closes the string — ' + comments.map((c) => c.slice(0, 60)).join(' | '));
    }

    // ── THE SPLIT BUTTON ─────────────────────────────────────────────────
    // Apsara, 2026-09-22: "now add a split as edge metals/aaa". It is the
    // reassign with both ends pre-chosen. Asserted as SOURCE on both clients
    // because what matters is that it goes through the existing transfer —
    // a second way to move money is a second way to move it wrongly — and
    // the transfer itself is already exercised end to end in section F.
    for (const f of ['mobile-app/www/index.html', 'dashboard/index.html']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        ck(`${f}: Split moves Edge Metals to AAA Investment`,
            /SPLIT_FROM = 'Edge Metals', SPLIT_TO = 'AAA Investment'/.test(src));
        ck(`  ${f}: through the reassign transfer, not a new path`,
            /movePettyCash\(\{ from: SPLIT_FROM, to: SPLIT_TO, amount: amt, reason: 'reassign' \}\)/.test(src),
            'so it inherits the short-bucket refusal and the dated row pair');
    }
    // And the move it performs really is refused when the source is short —
    // exercised, not assumed, because that refusal is the whole reason for
    // reusing the transfer instead of writing a second mover.
    await reset();
    await petty.addTopUp({ amount: 300, cash_source: 'Edge Metals', date: '2026-09-22' });
    let shortSplit = null;
    try {
        await petty.transfer({ from: 'Edge Metals', to: 'AAA Investment', amount: 1000,
                               reason: 'reassign', date: '2026-09-22' });
    } catch (e) { shortSplit = e; }
    ck('a split larger than the account holds is refused', !!shortSplit,
        String(shortSplit && shortSplit.message));
    await petty.transfer({ from: 'Edge Metals', to: 'AAA Investment', amount: 200,
                           reason: 'reassign', date: '2026-09-22' });
    ck('  and a split it can afford moves the money',
        bucket('Edge Metals') === 100 && bucket('AAA Investment') === 200,
        JSON.stringify(B().bySource));
    ck('  without changing cash in hand', B().total === 300, String(B().total));
    // A reassign is not a loan. If this ever shows up on the Borrowing tab,
    // she would be told AAA Investment owes Edge Metals for its own money.
    ck('  and a split creates no debt between the two companies',
        petty.borrowings().length === 0, JSON.stringify(petty.borrowings()));

    // ── AND THE NUMBERED PROMPT, ON BOTH SCREENS ─────────────────────────
    // This check read the PHONE only. It passed, I said "the phone no longer
    // tells her to type 1 or 2", and the website went on saying exactly that
    // — I had fixed one of the two files and written a check shaped around
    // the file I fixed. Found by unzipping the built APK and grepping it,
    // which is the sort of thing that should not be what catches this.
    //
    // Now: both files, and the string is matched OUT of any comment, so a
    // note explaining the fix cannot satisfy the check that the fix happened.
    for (const f of ['mobile-app/www/index.html', 'dashboard/index.html']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const inCode = src.split('\n')
            .filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l))
            .join('\n');
        ck(`${f}: the add-cash prompt does not name a range it no longer has`,
            !/Type 1 or 2/.test(inCode),
            'four accounts now; a prompt saying "1 or 2" is how a wrong one gets picked');
        ck(`  ${f}: it computes the range from the list instead`,
            /Type 1\$\{banks\.length > 1/.test(inCode),
            'so it cannot go stale again the next time an account is added');
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  CRASH  ', e && e.stack || e); process.exit(1); });
