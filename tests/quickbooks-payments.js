// ── tests/quickbooks-payments.js ───────────────────────────────────────────
// Guards the pure builders in helpers/quickbooks/pushPayments.js.
// References from her books: bill #38940 paid by two BillPayments ($40,000
// advance on 8/6, $5,100 on 8/11) from Checking (3301); 81 invoices left open
// by a bank fee. Her choice for fees: close them with a "Bank charges" credit.
const path = require('path'); const fs = require('fs'); const os = require('os');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-pay-'));
const { buildBillPayment, buildCustomerPayment } = require('../helpers/quickbooks/pushPayments');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };

console.log('\n── supplier ──');
const refs = { vendorId: '444', bankAccountId: '295', billIds: { b1: '38940', b2: '38941', b3: '38942' } };
let r = buildBillPayment({ id: 'p1', kind: 'advance', date: '2026-09-10', amount: 40000, mode: 'Wire', bank: 'BofA', allocations: [{ bill_id: 'b1', amount: 40000 }] }, refs);
ck('applied advance -> BillPayment on the bill', r.payment && r.payment.Line[0].LinkedTxn[0].TxnId === '38940' && r.total === 40000);
ck('paid by Check from the mapped bank', r.payment.PayType === 'Check' && r.payment.CheckPayment.BankAccountRef.value === '295');
ck('memo says advance + Jarvis id', /advance/.test(r.payment.PrivateNote) && /p1/.test(r.payment.PrivateNote));
ck('linked list recorded for the journal', r.linked[0].id === '38940' && r.linked[0].amount === 40000);
r = buildBillPayment({ id: 'p2', kind: 'advance', date: '2026-09-10', amount: 40000, mode: 'Wire', allocations: [] }, refs);
ck('unapplied advance waits', r.problems && /waits/.test(r.problems[0]));
r = buildBillPayment({ id: 'p3', kind: 'payment', date: '2026-09-10', amount: 90000, mode: 'Wire', allocations: [{ bill_id: 'b1', amount: 30000 }, { bill_id: 'b2', amount: 35000 }, { bill_id: 'b3', amount: 25000 }] }, refs);
ck('one wire, three containers -> one payment, three lines', r.payment && r.payment.Line.length === 3 && r.total === 90000);
r = buildBillPayment({ id: 'p4', kind: 'payment', date: '2026-09-10', amount: 50000, allocations: [{ bill_id: 'bX', amount: 50000 }] }, refs);
ck('bill not in QuickBooks yet -> blocked', r.problems && /enter the bill first/.test(r.problems[0]));
r = buildBillPayment({ id: 'p5', kind: 'payment', date: '2026-09-10', amount: 50000, allocations: [{ bill_id: 'b1', amount: 40000 }] }, refs);
ck('payment not fully allocated -> blocked', r.problems && /allocated 40000 of a 50000/.test(r.problems[0]));

console.log('\n── customer ──');
const crefs = { customerId: '453', bankAccountId: '295', invoiceIds: { s1: '38877', s2: '38877', s3: '38900' }, bankChargeItemId: '88' };
r = buildCustomerPayment({ id: 'r1', date: '2026-09-12', amount: 15868.62, mode: 'Wire', bank: 'BofA', allocations: [{ sale_id: 's1', amount: 13898.62, deduction_amount: 25, deduction_reason: 'bank_charge' }, { sale_id: 's2', amount: 1970 }] }, crefs);
ck('two grades of one invoice -> one invoice line', r.payment && r.payment.Line.length === 1, JSON.stringify(r.problems));
ck('invoice line = money + fee (closes it)', r.payment.Line[0].Amount === 15893.62);
ck('payment total = money that arrived', r.total === 15868.62 && r.payment.TotalAmt === 15868.62);
ck('one Bank charges credit memo for the fee', r.creditMemos.length === 1 && r.creditMemos[0].amount === 25 && r.creditMemos[0].memo.Line[0].SalesItemLineDetail.ItemRef.value === '88');
ck('deposited to the mapped bank', r.payment.DepositToAccountRef.value === '295');
r = buildCustomerPayment({ id: 'r2', date: '2026-09-12', amount: 900, allocations: [{ sale_id: 's3', amount: 900, deduction_amount: 100, deduction_reason: 'discount' }] }, crefs);
ck('discount is NOT posted, only noted', r.payment && r.creditMemos.length === 0 && r.payment.Line[0].Amount === 900 && /Discount 100.00/.test(r.payment.PrivateNote));
r = buildCustomerPayment({ id: 'r3', date: '2026-09-12', amount: 500, allocations: [{ sale_id: 's3', amount: 475, deduction_amount: 25, deduction_reason: 'bank_charge' }] }, { ...crefs, bankChargeItemId: null });
ck('fee but no Bank charges item -> blocked, not guessed', r.problems && /Bank charges/.test(r.problems.join()));
r = buildCustomerPayment({ id: 'r4', date: '2026-09-12', amount: 100, allocations: [{ sale_id: 'sX', amount: 100 }] }, crefs);
ck('invoice not in QuickBooks yet -> blocked', r.problems && /enter the invoice first/.test(r.problems[0]));

console.log(`\nquickbooks-payments: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
