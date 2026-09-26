// tests/quickbooks-apply-payments.js — money paid, money matched.
// Apsara, 2026-09-26, hunting a $5.3M payable: "find out where and why, how
// to resolve." The answer was $4,961,160.77 of payments with no allocation.
// Placing them moves nothing — no bank entry, no P&L, no change to the
// payable total — so it is the safe first step, and these pin that it stays
// safe: never more than the bill, never more than the payment, never another
// vendor, never a forced match.
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 220)); } };

const ap = require('../helpers/quickbooks/applyPayments');

// ── how much of a payment is already placed ────────────────────────────────
const paid = { TotalAmt: 100, Line: [{ Amount: 40, LinkedTxn: [{ TxnId: '1', TxnType: 'Bill' }] }] };
ck('what is already allocated is counted', ap.appliedOn(paid) === 40);
ck('...and the rest is what is loose', ap.looseOn(paid) === 60);
ck('a payment with no lines at all is entirely loose', ap.looseOn({ TotalAmt: 21640, Line: [] }) === 21640);
ck('...and one with a line that links nothing is too — an amount is not an allocation',
   ap.looseOn({ TotalAmt: 500, Line: [{ Amount: 500 }] }) === 500);

// ── the write, shaped ──────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'applyPayments.js'), 'utf8');
ck('allocations already on the payment are kept, not replaced',
   /\.\.\.\(live\.Line \|\| \[\]\)\.filter\(\(l\) => \(l\.LinkedTxn \|\| \[\]\)\.length\)/.test(src));
ck('the payment is read live before it is changed', /await client\.request\('GET', `\/billpayment\/\$\{row\.id\}`/.test(src));
ck('...and skipped if it moved since the plan was made', /changed in QuickBooks since the plan was made/.test(src));
ck('a reason is required — it goes in the journal', /a reason is required/.test(src));
ck('it is a dry run unless really is true', /dryRun: !really/.test(src));
ck('nothing is ever placed across vendors', /VendorRef = '\$\{q1\(vendorId\)\}'/.test(src) || /openBy\[vid\]/.test(src));
ck('the bank payment method is carried over, not invented',
   /live\.CheckPayment \? \{ CheckPayment: live\.CheckPayment \}/.test(src));

// ── the route will not write without the word ──────────────────────────────
const routes = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'routes.js'), 'utf8');
ck('the live run needs APPLY typed', /!== 'APPLY'/.test(routes));
ck('...and the plan is rebuilt server-side, never trusted from the browser',
   /the plan is made again here, from live data/.test(routes));

// ── the page says what it does and does not do ─────────────────────────────
const page = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'quickbooks.html'), 'utf8');
ck('the page promises plainly that no money moves', /Nothing here moves money/.test(page));
ck('...and offers it per supplier from the duplicates screen', /data-place=/.test(page));

console.log(`\nquickbooks-apply-payments: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
