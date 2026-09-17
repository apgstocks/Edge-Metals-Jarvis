// ── tests/cash-receipts.js ────────────────────────────────────────────────
// Apsara, 2026-09-16: "also in sales-receive payment,mode should be cash/
// account transfer.if its cash-it should get added to petty cash.log them" —
// and, asked which company: "i am talking about edge yard only".
//
// EDGE YARD. Petty cash is a yard ledger and Edge Metals cash is separate —
// her decision on 2026-09-10, and section D holds it.
//
// ── WHY THIS FILE EXISTS RATHER THAN A FEW LINES IN yard-payments.js ────────
// Underneath her request was a live bug, and the reason it survived is worth
// writing down: petty cash ALREADY moved for a cash payment on a yard load —
// in one direction only. helpers/payments.js called withdrawForPayment for any
// cash payment whose kind was not Edge Metals, and a yard load can be a SALE.
// So money arriving was recorded as money leaving.
//
// tests/petty-cash.js (57 checks) and tests/yard-payments.js (44) both passed
// throughout, because every cash case either of them exercises is a PURCHASE.
// The feature was covered; the DIRECTION was not. So the assertions below are
// about sign, on both sides, on write and on delete — a suite that only ever
// pays suppliers cannot tell a deposit from a withdrawal.
//
// And it did not fail quietly. withdrawForPayment refuses when the box holds
// less than the amount, so a $5,000 cash sale against a $300 box was rejected
// outright with "Only 300.00 in petty cash" — a sale she could not record at
// all. Section A is that case.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cashrcpt-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const petty = require(path.join(ROOT, 'helpers/pettyCash'));
const pay = require(path.join(ROOT, 'helpers/payments'));
const banks = require(path.join(ROOT, 'helpers/banks'));

const DASH = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'mobile-app/www/index.html'), 'utf8');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const reset = () => fs.writeFileSync(cfg.PETTY_CASH_FILE, '[]');

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the sale she could not record at all');
// ══════════════════════════════════════════════════════════════════════════
{
    reset();
    fs.writeFileSync(cfg.PAYMENTS_FILE, '[]');
    await petty.addTopUp({ amount: 300, date: '2026-09-15', note: 'float' });
    ck('the box starts with less than the sale is worth', petty.balance() === 300, String(petty.balance()));

    // THE BUG, stated as the assertion that would have caught it: this used to
    // throw PETTY_CASH_SHORT, because taking $5,000 IN was being processed as
    // paying $5,000 OUT of a box holding three hundred.
    let err = null;
    let receipt = null;
    try {
        receipt = await pay.addPayment({ load_id: 'OUT_1', load_kind: 'sale', mode: 'Cash', amount: 5000, paid_on: '2026-09-16' });
    } catch (e) { err = e; }
    ck('taking $5,000 cash for a sale is NOT refused', !err,
       err && `${err.code}: ${err.message} — cash in hand cannot overdraw a box`);
    ck('  and the box goes UP, not down', petty.balance() === 5300,
       `${petty.balance()} — 5300 means it went in, 300 means nothing happened, -4700 is the old bug`);
    ck('  recorded against the sale it came from',
       !!receipt && petty.listEntries().some((e) => e.kind === 'receipt' && e.load_id === 'OUT_1'),
       JSON.stringify(petty.listEntries().map((e) => [e.kind, e.load_id, e.amount])));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — a receipt is not a top-up');
// ══════════════════════════════════════════════════════════════════════════
{
    // Both put money in, and folding them together would be the easy thing to
    // do. It would also make the day's takings read as a float she added out
    // of her own pocket, which is the opposite of what happened.
    const rows = petty.listEntries();
    const kinds = rows.map((e) => e.kind);
    ck("the sale's cash is filed as a receipt", kinds.includes('receipt'), kinds.join(','));
    ck('  and the float she added is still a top-up', kinds.includes('topup'), kinds.join(','));
    ck('  they are different kinds', new Set(kinds).size >= 2, kinds.join(','));
    ck('"receipt" is a declared kind, not an invented string',
       petty.ENTRY_KINDS.includes('receipt'), petty.ENTRY_KINDS.join(','));

    // Both clients must label it, or the Petty cash tab shows a row that says
    // "Paid" against money that came in.
    for (const [who, src] of [['website', DASH], ['app', APP]]) {
        ck(`${who}: the Petty cash tab has a label for it`,
           /e\.kind === 'receipt' \?/.test(stripComments(src)),
           'an unlabelled kind falls through to the "Paid" default, on money that arrived');
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('C — the other direction still works');
// ══════════════════════════════════════════════════════════════════════════
{
    // The half that was already right. Asserted because the fix touches the
    // same branch, and a change that got deposits right by breaking
    // withdrawals would be no better than where it started.
    const before = petty.balance();
    const buy = await pay.addPayment({ load_id: 'LD_1', load_kind: 'purchase', mode: 'Cash', amount: 1200, paid_on: '2026-09-16' });
    ck('paying a purchase in cash still takes it OUT', petty.balance() === before - 1200,
       `${before} -> ${petty.balance()}`);

    // And the overdraft guard is still a guard. Deposits skip it deliberately;
    // withdrawals must not have been let off with them.
    let err = null;
    try { await pay.addPayment({ load_id: 'LD_2', load_kind: 'purchase', mode: 'Cash', amount: 999999, paid_on: '2026-09-16' }); }
    catch (e) { err = e; }
    ck('  and paying more cash than the box holds is still refused',
       err && err.code === 'PETTY_CASH_SHORT', err ? err.code : 'no error thrown');

    // Deleting each must undo its OWN direction. One shared reversal path that
    // assumed "payments are negative" would credit the box for a deleted sale.
    const afterBuy = petty.balance();
    await pay.deletePayment(buy.id);
    ck('deleting a cash purchase puts the money BACK', petty.balance() === afterBuy + 1200,
       `${afterBuy} -> ${petty.balance()}`);

    const sale = await pay.addPayment({ load_id: 'OUT_9', load_kind: 'sale', mode: 'Cash', amount: 250, paid_on: '2026-09-16' });
    const afterSale = petty.balance();
    await pay.deletePayment(sale.id);
    ck('deleting a cash SALE takes the money back OUT', petty.balance() === afterSale - 250,
       `${afterSale} -> ${petty.balance()} — refunding a deleted sale would invent money`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — Edge Metals cash never reaches this box');
// ══════════════════════════════════════════════════════════════════════════
{
    // Her rule since 2026-09-10, and the one this change had the most scope to
    // break: the deposit branch is new code sitting right beside the company
    // test.
    const before = petty.balance();
    for (const kind of ['bill', 'sale_cost', 'metals_trucking']) {
        await pay.addPayment({ load_id: `EM_${kind}`, load_kind: kind, mode: 'Cash', amount: 500, paid_on: '2026-09-16' });
        ck(`an Edge Metals ${kind} paid in cash leaves the yard's box alone`,
           petty.balance() === before, `${before} -> ${petty.balance()}`);
    }
    ck('  and none of them wrote a row into the yard ledger',
       !petty.listEntries().some((e) => String(e.load_id || '').startsWith('EM_')),
       JSON.stringify(petty.listEntries().filter((e) => String(e.load_id || '').startsWith('EM_'))));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — Bank transfer');
// ══════════════════════════════════════════════════════════════════════════
{
    ck('the mode exists', pay.PAYMENT_MODES.includes('Bank transfer'), pay.PAYMENT_MODES.join(','));

    // STILL KNOWN, though the yard can no longer choose them (see
    // tests/yard-payment-modes.js). Payments already on file carry Zelle, Wire
    // and Cheque; dropping them from PAYMENT_MODES would leave those rows
    // naming a mode the server no longer recognises, and the bank matcher with
    // nothing to key on.
    for (const m of ['Zelle', 'Wire', 'Cheque', 'Cash']) {
        ck(`  ${m} still known`, pay.PAYMENT_MODES.includes(m), pay.PAYMENT_MODES.join(','));
    }

    // A transfer lands in an account by definition, and that account is what
    // the bank matcher needs. Off this list, every transfer she records would
    // be unbankable — surfacing months later as a statement line with no
    // payment against it.
    ck('a transfer can carry a bank', banks.MODES_WITH_BANK.includes('Bank transfer'),
       banks.MODES_WITH_BANK.join(','));
    // paid_via since 2026-09-17: a sale received by Bank transfer records
    // which company it landed in.
    const t = await pay.addPayment({ load_id: 'OUT_3', load_kind: 'sale', mode: 'Bank transfer', paid_via: 'Edge Yard',
                                     amount: 900, paid_on: '2026-09-16', bank: 'Chase Bank' });
    ck('  and it is stored', t.bank === 'Chase Bank', JSON.stringify(t.bank));

    // Only CASH moves the box. A transfer is money in the bank, not in the
    // drawer, and crediting the cash box for one would overstate what is
    // physically there — the figure nobody can check against a statement.
    const before = petty.balance();
    await pay.addPayment({ load_id: 'OUT_4', load_kind: 'sale', mode: 'Bank transfer', paid_via: 'Edge Yard',
                           amount: 700, paid_on: '2026-09-16', bank: 'BofA' });
    ck('a transfer does NOT touch petty cash', petty.balance() === before,
       `${before} -> ${petty.balance()}`);

    // Cash still refuses a bank — "paid cash from Chase" is not a true sentence.
    let err = null;
    try { await pay.addPayment({ load_id: 'OUT_5', load_kind: 'sale', mode: 'Cash', amount: 10, paid_on: '2026-09-16', bank: 'Chase Bank' }); }
    catch (e) { err = e; }
    ck('  while cash still refuses one', !!err, 'a cash payment with a bank on it is a broken form');

    // Both clients offer it, or the server accepting the mode changes nothing.
    // That the modal offers ONLY these two is asserted in
    // tests/yard-payment-modes.js, which is where that rule lives.
    // Read out of the CODE THAT FILLS the dropdown, not out of the markup.
    // openPayModal builds the list per row since 2026-09-17 — a sale takes
    // two modes, a purchase keeps five — so <option> tags no longer exist in
    // the page for this to match. See tests/yard-payment-modes.js, where that
    // rule lives, and helpers/payments.js for why it had to become per-row.
    for (const [who, src] of [['website', DASH], ['app', APP]]) {
        const fill = (src.match(/const payModes = sale \? \[([^\]]*)\]/) || [])[1] || '';
        ck(`${who}: receiving a payment offers Bank transfer`, /'Bank transfer'/.test(fill), fill);
        ck(`  ${who}: and still offers Cash`, /'Cash'/.test(fill), fill);
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('F — what the spend report makes of it');
// ══════════════════════════════════════════════════════════════════════════
{
    // The cash block sums by SIGN rather than by kind, so a receipt lands in
    // "in" with no change needed. Asserted rather than assumed: a later
    // refactor to kind-based counting would drop receipts silently, and the
    // grand total would still look plausible — the class of bug that lasts.
    const { buildSpendReport } = require(path.join(ROOT, 'helpers/spendReport'));
    const rep = buildSpendReport({
        payments: [], expenses: [], pettyEntries: petty.listEntries(),
        from: '2026-09-16', to: '2026-09-16',
    });
    ck('a cash receipt counts as money IN', rep.cash.in > 0, JSON.stringify(rep.cash));
    ck('  and is not counted as money out',
       rep.cash.out < rep.cash.in, JSON.stringify(rep.cash));
    // ── COMPARED LIKE WITH LIKE ──────────────────────────────────────────
    // petty.balance() is ALL TIME; the report above is windowed to one day.
    // They agreed while every fixture row fell inside that day — and stopped
    // agreeing at midnight, because the reversal rows written by the delete
    // tests are stamped with TODAY (helpers/time's todayLocal), which moved
    // out of the window while nothing about the code changed.
    //
    // A test that passes only on the day it was written is a test that cries
    // wolf on an unrelated morning, which is how a real failure gets waved
    // through. The closing figure is compared against an ALL-TIME report.
    const allTime = buildSpendReport({
        payments: [], expenses: [], pettyEntries: petty.listEntries(),
    });
    ck('  closing agrees with the rows', allTime.cash.closing === petty.balance(),
       `${allTime.cash.closing} vs ${petty.balance()} — all-time against all-time`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
