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

console.log(`\nquickbooks-push: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
