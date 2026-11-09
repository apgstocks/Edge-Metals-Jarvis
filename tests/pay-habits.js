// tests/pay-habits.js — days-to-pay per customer; advisory only.
const fs = require('fs'), os = require('os'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
process.env.JARVIS_TEST = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ph-')); process.env.API_TOKEN = 't';
const ph = require(R('helpers/payHabits.js'));

console.log('\n=== A. the arithmetic (injected) ===');
const S = (id, customer, date, amount, balance = 0) => ({ id, customer, date, amount, balance, invoice_no: 'I' + id });
const rc = (date, ...al) => ({ date, allocations: al.map(([sale_id, amount, deduction_amount]) => ({ sale_id, amount, deduction_amount })) });
const sales = [S(1, 'Zed', '01/01/2026', 1000), S(2, 'Zed', '02/01/2026', 1000), S(3, 'Zed', '03/01/2026', 1000), S(4, 'Zed', '04/01/2026', 1000),
    S(5, 'Two', '01/01/2026', 500), S(6, 'Two', '01/05/2026', 500),
    S(7, 'Pre', '05/10/2026', 100), S(8, 'Pre', '05/10/2026', 100), S(9, 'Pre', '05/10/2026', 100),
    S(10, 'Zed', '09/01/2026', 1000, 1000), S(11, 'Zed', '06/01/2026', 1000), S(12, 'Zed', '07/01/2026', 1000, 400)];
const receipts = [rc('2026-01-11', [1, 1000]), rc('2026-02-21', [2, 1000]), rc('2026-03-31', [3, 1000]), rc('2026-04-11', [4, 1000]),
    rc('2026-01-20', [5, 500]), rc('2026-01-25', [6, 500]),
    rc('2026-05-01', [7, 100]), rc('2026-05-02', [8, 100]), rc('2026-05-03', [9, 100]),
    rc('2026-06-10', [11, 600]), rc('2026-06-20', [11, 390, 10]), rc('2026-07-10', [12, 600])];
const h = ph.build({ src: { sales: () => sales, receipts: () => receipts } });
const z = h.byCustomer.zed;
ck('Zed: 5 settled invoices (incl. one split across two payments, one with a deduction)', z && z.n === 5, JSON.stringify(z));
ck('split payment counts from the LAST payment: invoice 11 (06/01, paid 06/10 and 06/20) counts as 19 days, not 9', z && z.slowest === 30, JSON.stringify(z));
ck('median and 80th percentile', z && z.median === 19 && z.p80 === 20, JSON.stringify(z));
ck('two samples is not a habit', !h.byCustomer.two);
ck('paid before invoicing is left out, and counted', !h.byCustomer.pre && h.skipped.negative === 3, JSON.stringify(h.skipped));
ck('part-paid and unpaid are left out, and counted', h.skipped.unsettled >= 2, JSON.stringify(h.skipped));
ck('customer names match case/space-insensitively', ph.build({ src: { sales: () => sales.map((s) => Object.assign({}, s, { customer: s.customer === 'Zed' ? ' ZED  ' : s.customer })), receipts: () => receipts } }).byCustomer.zed.n === 5);

console.log('\n=== B. slower than usual ===');
const NOW = Date.UTC(2026, 8, 1) + 100 * 864e5;
const sl = ph.slow({ now: NOW, habits: h, src: { sales: () => sales } });
ck('an open invoice past the usual 80th percentile is flagged, with its age', sl.some((x) => x.invoice_no === 'I10' && x.age === 100 && x.usual === 19), JSON.stringify(sl));
const fresh = ph.slow({ now: Date.UTC(2026, 8, 1) + 5 * 864e5, habits: h, src: { sales: () => sales } });
ck('a young open invoice is not', !fresh.some((x) => x.invoice_no === 'I10'));
ck('a customer with no habit is never flagged', !ph.slow({ now: NOW, habits: h, src: { sales: () => [S(20, 'Two', '01/01/2026', 500, 500)] } }).length);

console.log('\n=== C. real stores, and the command ===');
const out = require('child_process').spawnSync(process.execPath, [R('scripts/pay-habits.js')], { encoding: 'utf8', env: process.env });
ck('empty install: prints cleanly, exits 0', out.status === 0 && /No customer has 3\+ settled invoices yet/.test(out.stdout) && /Left out:/.test(out.stdout), out.stdout + out.stderr);
const before = fs.readdirSync(process.env.DATA_DIR).sort().join();
ph.build(); ph.slow({});
ck('measuring writes nothing', fs.readdirSync(process.env.DATA_DIR).sort().join() === before);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
