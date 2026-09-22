// ── tests/quickbooks-push-invoice.js ───────────────────────────────────────
// Guards helpers/quickbooks/pushInvoice.js buildInvoice and push.judgeExisting.
// Reference: her real invoice #38877 (TXGU8942580, 5 Aug 2026): 21.587 MT ×
// 645 = 13,923.62 + 2 MT × 985 = 1,970 → 15,893.62, Due on receipt.
// And the case that made judgeExisting search every customer: the same
// container entered under TAEWON PRECEISION while Jarvis says TAEWON AUTOMOTIVE.
const S = require('../helpers/sales');
const { buildInvoice } = require('../helpers/quickbooks/pushInvoice');
const { judgeExisting } = require('../helpers/quickbooks/push');
let pass = 0, fail = 0; const failures = [];
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const base = { customer: 'TAEWON', date: '2026-09-01', invoice_no: '260716_MC_26JY78', container_no: 'txgu8942580' };
const rows = [S.withTotals({ ...base, id: 'a', item: 'Steel combo', weight: 21.587, weight_unit: 'mt', invoice_price: 645 }),
              S.withTotals({ ...base, id: 'b', item: 'Aluminium combo', weight: 2, weight_unit: 'mt', invoice_price: 985 })];
const refs = { customerId: '9', itemIds: { 'Steel combo': '103', 'Aluminium combo': '72', Loading: '80' }, termId: '1' };
const r = buildInvoice(rows, refs);
ck('builds', r.invoice && !r.problems, JSON.stringify(r.problems));
ck('total = her real invoice 15,893.62', r.total === 15893.62);
ck('one line per grade', r.invoice.Line.length === 2);
ck('priced per MT -> Qty in MT', r.invoice.Line[0].SalesItemLineDetail.Qty === 21.587 && r.invoice.Line[0].SalesItemLineDetail.UnitPrice === 645);
ck('container on each line, upper-cased', r.invoice.Line.every((l) => l.Description === 'TXGU8942580'));
ck('Due on receipt term attached', r.invoice.SalesTermRef.value === '1');
const lb = buildInvoice([S.withTotals({ ...base, id: 'c', item: 'Steel combo', weight: 45920, invoice_price: 1.88 })], refs);
ck('priced per lb -> Qty in lbs', lb.invoice && lb.invoice.Line[0].SalesItemLineDetail.Qty === 45920 && lb.invoice.Line[0].SalesItemLineDetail.UnitPrice === 1.88);
const withIn = buildInvoice([S.withTotals({ ...base, id: 'd', item: 'Steel combo', weight: 10, weight_unit: 'mt', invoice_price: 600, charges: [{ what: 'Loading', amount: 150, direction: 'in', why: 'customer asked for extra loading' }, { what: 'Freight', amount: 300, direction: 'out', why: 'we pay the line' }] })], refs);
ck('charge the CUSTOMER pays becomes a line', withIn.invoice && withIn.invoice.Line.length === 2 && withIn.total === 6150, JSON.stringify(withIn.problems));
const cent = buildInvoice([{ ...rows[0], amount: round2c(rows[0].weight_mt * rows[0].invoice_price) + 0.01, receivable: round2c(rows[0].weight_mt * rows[0].invoice_price) + 0.01 }], refs);
ck('1-cent rounding gap -> amount only, no Qty/UnitPrice (QuickBooks 400 "Amount is not equal to UnitPrice * Qty")', cent.invoice && cent.invoice.Line[0].SalesItemLineDetail.Qty === undefined && cent.invoice.Line[0].SalesItemLineDetail.UnitPrice === undefined, JSON.stringify(cent.problems));
ck('charge WE pay is not on the invoice', !withIn.invoice.Line.some((l) => l.Amount === 300));
ck('two containers on one invoice refused', buildInvoice([rows[0], { ...rows[1], container_no: 'ABCU0000000' }], refs).problems.some((p) => /one invoice is one container/.test(p)));
ck('two customers refused', buildInvoice([rows[0], { ...rows[1], customer: 'Other' }], refs).problems.some((p) => /different customers/.test(p)));
ck('unmapped grade blocks', buildInvoice([{ ...rows[0], item: 'Mystery' }], refs).problems.some((p) => /Mystery/.test(p)));

ck('judge: nothing found -> create', Object.keys(judgeExisting([], '9', 100)).length === 0);
ck('judge: same customer + total -> sure', judgeExisting([{ Id: '1', partyId: '9', TotalAmt: 100 }], '9', 100).sure.Id === '1');
const other = judgeExisting([{ Id: '38877', partyId: '4', party: 'TAEWON PRECEISION', TotalAmt: 15893.62 }], '9', 15893.62);
ck('judge: same container under ANOTHER customer -> ask, names it', other.ask && /TAEWON PRECEISION/.test(other.why[0]));
ck('judge: amount differs -> ask', judgeExisting([{ Id: '1', partyId: '9', TotalAmt: 99 }], '9', 100).ask);
ck('judge: two hits -> ask even if one matches', judgeExisting([{ Id: '1', partyId: '9', TotalAmt: 100 }, { Id: '2', partyId: '9', TotalAmt: 50 }], '9', 100).ask);

function round2c(n){return Math.round(n*100)/100}
console.log(`\nquickbooks-push-invoice: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
