// ── tests/quickbooks-push.js ───────────────────────────────────────────────
// Guards helpers/quickbooks/push.js buildBill — the shape a Jarvis bill takes
// in her books. The reference is a REAL bill read from Edge Metals Inc on
// 2026-09-21 (Mazariegos, SEKU4687753): AUTO CAST 45,000 lb × 1.02 = 45,900,
// Trucking −800, total 45,100. If the builder drifts from that, every bill it
// enters looks different from the 7,000 her accountant already entered.
const B = require('../helpers/bills');
const { buildBill, DOC_MAX } = require('../helpers/quickbooks/push');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const refs = { vendorId: '444', itemIds: { 'Auto cast': '71', 'AL COMBO': '72' }, truckingAccountId: '374' };
const real = B.withTotals({ id: 'b1', supplier: 'Mazariegos', date: '2026-08-05', invoice_no: ' 260716_AC_26RMT48', booking_no: '274991940', container_no: 'seku4687753', seal_no: '0009455', description: 'Auto cast', gross: 73600, truck: 28600, container: 0, chassis: 0, boxes: 0, supplier_price: 1.02, trucking_amount: 800, advance: 40000 });
const r = buildBill(real, refs);
ck('builds', r.bill && !r.problems, JSON.stringify(r.problems));
ck('total = her real bill 45,100', r.total === 45100);
ck('grade line 45,900 on AUTO CAST', r.bill.Line[0].Amount === 45900 && r.bill.Line[0].ItemBasedExpenseLineDetail.ItemRef.value === '71');
ck('qty = net lbs, price per lb', r.bill.Line[0].ItemBasedExpenseLineDetail.Qty === 45000 && r.bill.Line[0].ItemBasedExpenseLineDetail.UnitPrice === 1.02);
ck('trucking is a NEGATIVE line on the Trucking account', r.bill.Line[1].Amount === -800 && r.bill.Line[1].AccountBasedExpenseLineDetail.AccountRef.value === '374');
ck('container number on every line, upper-cased', r.bill.Line.every((l) => l.Description === 'SEKU4687753'));
ck('DocNumber = Edge invoice no, trimmed', r.bill.DocNumber === '260716_AC_26RMT48');
ck('advance is NOT a bill line', !r.bill.Line.some((l) => Math.abs(l.Amount) === 40000));
ck('memo carries container, booking, seal, Jarvis id', /SEKU4687753/.test(r.bill.PrivateNote) && /274991940/.test(r.bill.PrivateNote) && /b1/.test(r.bill.PrivateNote));
ck('no trucking -> no trucking line', buildBill(B.withTotals({ ...real, trucking_amount: 0 }), refs).bill.Line.length === 1);

const two = B.withTotals({ id: 'b2', supplier: 'X', date: '2026-08-01', invoice_no: 'INV2', container_no: 'ABCU1234567', items: [{ description: 'Auto cast', weight: 20000, price: 1 }, { description: 'AL COMBO', weight: 10000, price: 0.8 }], trucking_amount: 500 });
const r2 = buildBill(two, refs);
ck('two grades -> two item lines + trucking', r2.bill && r2.bill.Line.length === 3, JSON.stringify(r2.problems));
ck('two grades total = net payable', r2.total === two.net_payable, `${r2.total} vs ${two.net_payable}`);

const miss = buildBill(B.withTotals({ ...real, description: 'Mystery grade' }), refs);
ck('unmapped grade blocks, says which', miss.problems && miss.problems.some((p) => /Mystery grade/.test(p)));
ck('no invoice no blocks', buildBill(B.withTotals({ ...real, invoice_no: '' }), refs).problems.some((p) => /invoice number/.test(p)));
ck('too-long invoice no blocks', buildBill(B.withTotals({ ...real, invoice_no: 'X'.repeat(DOC_MAX + 1) }), refs).problems.length > 0);
ck('no price/amount blocks', buildBill(B.withTotals({ ...real, supplier_price: null }), refs).problems.some((p) => /amount/.test(p)));
ck('trucking without a Trucking account blocks', buildBill(real, { ...refs, truckingAccountId: null }).problems.some((p) => /Trucking/.test(p)));

const { beforeCutover } = require('../helpers/quickbooks/push');
const saved = [process.env.QB_CUTOVER_BILLS, process.env.QB_CUTOVER_INVOICES];
delete process.env.QB_CUTOVER_BILLS; delete process.env.QB_CUTOVER_INVOICES;
ck('production with no cutover refuses', /no bill cutover/.test(beforeCutover('bill', '2026-10-01', 'production')));
ck('sandbox with no cutover allows', beforeCutover('bill', '2026-01-01', 'sandbox') === null);
process.env.QB_CUTOVER_BILLS = '2026-09-06'; process.env.QB_CUTOVER_INVOICES = '2026-08-28';
ck('bill on 5 Sep (already hand-entered) refused', /before the cutover/.test(beforeCutover('bill', '2026-09-05', 'production')));
ck('bill on 6 Sep allowed', beforeCutover('bill', '2026-09-06', 'production') === null);
ck('Jan-May bill refused (no double cost)', beforeCutover('bill', '2026-03-20', 'production') !== null);
ck('typed date 9/15/2026 is AFTER the 6 Sep cutover (was wrongly skipped)', beforeCutover('bill', '9/15/2026', 'production') === null);
ck('typed date 9/5/2026 is before the cutover', /before the cutover/.test(beforeCutover('bill', '9/5/2026', 'production') || ''));
ck('unreadable date refused, not skipped', /can't be read/.test(beforeCutover('bill', 'Sept 15', 'production') || ''));
ck('isoDate normalises typed dates', require('../helpers/quickbooks/push').isoDate('9/15/2026') === '2026-09-15' && require('../helpers/quickbooks/push').isoDate('2026-09-15T00:00') === '2026-09-15');
ck('invoice on 28 Aug allowed, 27 Aug refused', beforeCutover('invoice', '2026-08-28', 'production') === null && beforeCutover('invoice', '2026-08-27', 'production') !== null);
process.env.QB_CUTOVER_BILLS = 'soon';
ck('a malformed cutover is treated as unset (refuse)', beforeCutover('bill', '2026-12-01', 'production') !== null);
if (saved[0] === undefined) delete process.env.QB_CUTOVER_BILLS; else process.env.QB_CUTOVER_BILLS = saved[0];
if (saved[1] === undefined) delete process.env.QB_CUTOVER_INVOICES; else process.env.QB_CUTOVER_INVOICES = saved[1];
const { docNumberFor } = require('../helpers/quickbooks/push');
ck('local delivery (no container, no inv no) gets a LOCAL number', docNumberFor({ id: 'BILL_17900_ab12cd', date: '2026-09-08' }) === 'LOCAL-260908-AB12CD');
ck('...the same number every time', docNumberFor({ id: 'BILL_17900_ab12cd', date: '2026-09-08' }) === docNumberFor({ id: 'BILL_17900_ab12cd', date: '2026-09-08', supplier: 'x' }));
ck('...within the QuickBooks 21-character limit', docNumberFor({ id: 'BILL_17900_ab12cd', date: '2026-09-08' }).length <= DOC_MAX);
ck('a real invoice number always wins', docNumberFor({ id: 'x1', invoice_no: ' 260831_AC_26MT15 ', date: '2026-09-08' }) === '260831_AC_26MT15');
ck('container but no invoice number is NOT a local delivery -> stays blank (blocked)', docNumberFor({ id: 'x1', container_no: 'HMMU1234567', date: '2026-09-08' }) === '');
const local = buildBill(B.withTotals({ ...real, id: 'BILL_1_zz9999', invoice_no: '', container_no: '' }), refs);
ck('a local bill builds with its LOCAL number', local.bill && local.bill.DocNumber === 'LOCAL-260805-ZZ9999', JSON.stringify(local.problems));
console.log(`\nquickbooks-push: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
