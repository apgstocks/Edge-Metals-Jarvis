// Ownership plan slice 1 (Apsara, 2026-11-07): QuickBooks payments -> Jarvis receipts, so the ledger stops saying a customer who
// always pays owes $4.78M. Real sales + real receipts store in a scratch DATA_DIR; a stubbed QuickBooks pull.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pbf-')); process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const sales = require(path.join(ROOT, 'helpers/sales'));
const receipts = require(path.join(ROOT, 'helpers/salesReceipts'));
const pb = require(path.join(ROOT, 'helpers/paymentBackfill'));
const pf = require(path.join(ROOT, 'helpers/paymentFollowups'));
const mk = async (customer, invoice_no, date, weight, price, container) =>
    (await sales.addSale({ customer, invoice_no, date, item: 'Copper', weight, invoice_price: price, price_unit: 'lb', weight_unit: 'lb', container_no: container, terms: 'TT' })).id;
const qinv = (Id, doc, total, balance, containers = []) => ({ Id, DocNumber: doc, TotalAmt: total, Balance: balance, Line: [{ Description: containers.join(' ') }] });
const qpay = (Id, customer, amount, lines, extra = {}) => ({ Id, TxnDate: '2026-10-20', TotalAmt: amount, CustomerRef: { name: customer }, PaymentMethodRef: { name: 'Wire' }, DepositToAccountRef: { name: 'BofA Checking 1234' },
    Line: lines.map(([inv, amt]) => ({ Amount: amt, LinkedTxn: [{ TxnId: inv, TxnType: 'Invoice' }] })), ...extra });

(async () => {
    const r1 = await mk('Rad Metal', 'R-1', '2026-09-01', 10000, 1, 'RRRR1111111');    // $10,000
    const r2 = await mk('Rad Metal', 'R-2', '2026-09-05', 5000, 1, 'RRRR2222222');     // $5,000
    const d1 = await mk('Daekwang', 'D-1', '2026-09-01', 4000, 1, 'DDDD1111111');      // $4,000 - customer really has NOT paid
    const e1 = await mk('Eccomelt', 'E-1', '2026-09-01', 3000, 1, 'EEEE1111111');      // bundle: one QuickBooks invoice, two Jarvis sales
    const e2 = await mk('Eccomelt', 'E-2', '2026-09-02', 2000, 1, 'EEEE2222222');
    const g1 = await mk('Ghost Co', 'G-1', '2026-09-01', 900, 1, 'GGGG1111111');
    const qb = { invoices: [
        qinv('11', 'R-1', 10000, 0), qinv('12', 'R-2', 5000, 0), qinv('13', 'D-1', 4000, 4000),
        qinv('14', 'ECCO-BUNDLE-1', 5000, 0, ['EEEE1111111', 'EEEE2222222']), qinv('99', 'X-NOT-IN-JARVIS', 700, 0),
    ], payments: [
        qpay('201', 'Rad Metal', 15000, [['11', 10000], ['12', 5000]]),
        qpay('202', 'Eccomelt', 5000, [['14', 5000]], { PaymentMethodRef: { name: 'Zelle' } }),
        qpay('203', 'Somebody', 700, [['99', 700]]),
        qpay('204', 'Rad Metal', 100, [['11', 100]], { PaymentMethodRef: null }),              // more than R-1 had left
    ] };
    const rows = () => sales.listWithTotals();

    section('A. plan (pure, writes nothing)');
    const plan = pb.plan({ qb, sales: rows(), receipts: [] });
    const rad = plan.proposed.find((p) => p.qb_payment === '201');
    ck('Rad Metal: one receipt, $15,000, allocated across both sales', rad && rad.amount === 15000 && rad.allocations.length === 2 && rad.customer === 'Rad Metal', JSON.stringify(rad));
    ck('  mode Wire, bank "BofA" mapped from the QuickBooks account', rad.mode === 'Wire' && rad.bank === 'BofA' && /QuickBooks payment 201/.test(rad.note));
    const ecc = plan.proposed.find((p) => p.qb_payment === '202');
    ck('a bundled QuickBooks invoice is spread over its Jarvis sales, oldest first', ecc && ecc.amount === 5000 && ecc.allocations.length === 2 && ecc.allocations[0].sale_id === e1 && ecc.allocations[0].amount === 3000 && ecc.allocations[1].amount === 2000, JSON.stringify(ecc));
    ck('  Zelle mode kept', ecc.mode === 'Zelle');
    ck('a payment on an invoice Jarvis has no sale for is LISTED, not guessed', plan.unmatched.some((u) => u.doc === 'X-NOT-IN-JARVIS' && u.amount === 700) && !plan.proposed.some((p) => p.qb_payment === '203'));
    ck('a payment bigger than the sale still shows outstanding is capped, the rest listed', !plan.proposed.some((p) => p.qb_payment === '204') && plan.leftover.some((l) => l.amount === 100), JSON.stringify(plan.leftover));
    ck('Daekwang (genuinely unpaid in QuickBooks) gets no receipt', !plan.proposed.some((p) => p.customer === 'Daekwang') && !plan.proposed.some((p) => p.allocations.some((a) => a.sale_id === d1)));
    ck('nothing was written by plan()', receipts.list().length === 0);
    ck('totals add up', plan.totals.receipts === 2 && plan.totals.money === 20000 && plan.totals.customers === 2 && plan.totals.unmatched === 700 && plan.totals.leftover === 100, JSON.stringify(plan.totals));
    ck('an unnamed payment method is a flagged guess', pb.modeOf(null).guessed === true && pb.modeOf('Zelle').mode === 'Zelle' && pb.modeOf('Check').mode === 'Cheque' && pb.modeOf('Cash').mode === 'Cash');
    ck('banks: Chase and unknown accounts mapped sensibly', pb.bankOf('Chase Business') === 'Chase Bank' && pb.bankOf('Wells Fargo') === 'Wells Fargo' && pb.bankOf(null) === 'Others');

    ck('after the plan, what is STILL open is classified: Daekwang = QuickBooks agrees unpaid; Ghost Co = not in QuickBooks', plan.remaining.qbOpen.n === 1 && plan.remaining.qbOpen.amount === 4000 && plan.remaining.notInQuickbooks.n === 1 && plan.remaining.notInQuickbooks.amount === 900 && plan.remaining.notInQuickbooksList[0].invoice_no === 'G-1', JSON.stringify(plan.remaining));
    const src0 = fs.readFileSync(path.join(ROOT, 'scripts/payments-backfill.js'), 'utf8');
    ck('--customer also scopes the QuickBooks side (other customers\' payments are not "unplaced")', /inScope\(p\.CustomerRef\)/.test(src0) && /inScope\(i\.CustomerRef\)/.test(src0));

    section('B. apply: real receipts, real balances');
    const before = rows().find((s) => s.id === r1).balance;
    const out = await pb.apply(plan.proposed, { addReceipt: receipts.addReceipt });
    ck('both receipts written, none failed', out.written === 2 && out.failed.length === 0, JSON.stringify(out));
    const after = rows();
    ck('Rad Metal sales now have zero balance (was $10,000)', before === 10000 && after.find((s) => s.id === r1).balance === 0 && after.find((s) => s.id === r2).balance === 0);
    ck('Eccomelt bundle closed on both sales', after.find((s) => s.id === e1).balance === 0 && after.find((s) => s.id === e2).balance === 0);
    ck('Daekwang and Ghost Co untouched', after.find((s) => s.id === d1).balance === 4000 && after.find((s) => s.id === g1).balance === 900);
    ck('the receipts carry the QuickBooks reference and who created them', receipts.list().every((r) => /^QB:\d+:/.test(r.ref) && r.created_by === 'qb-backfill'));
    const again = pb.plan({ qb, sales: rows(), receipts: receipts.list() });
    ck('IDEMPOTENT: planning again proposes nothing', again.proposed.length === 0 && again.totals.alreadyImported === 2, JSON.stringify(again.totals));
    const out2 = await pb.apply(pb.plan({ qb, sales: rows(), receipts: [] }).proposed, { addReceipt: receipts.addReceipt, existingRefs: new Set(receipts.list().map((r) => r.ref)) });
    ck('  and apply() with the refs already present writes nothing', out2.written === 0 && out2.skipped >= 0 && receipts.list().length === 2, JSON.stringify(out2));

    section('C. the point of it: the follow-up list is no longer lying');
    const drafts = pf.build({ salesRows: rows(), terms: pf.loadTerms(), resolve: () => null, bookings: {}, now: Date.UTC(2026, 10, 7) }).drafts.map((d) => d.customer).sort();
    ck('Rad Metal and Eccomelt are gone from the payment follow-ups; Daekwang and Ghost Co remain', drafts.join() === 'Daekwang,Ghost Co', drafts.join());

    section('D. a failed row does not stop the rest');
    const bad = { ref: 'QB:1:X', customer: 'Nobody', date: '2026-10-01', amount: 5, mode: 'Wire', bank: 'BofA', allocations: [{ sale_id: 'NOPE', amount: 5 }], note: 'x' };
    const good = pb.plan({ qb: { invoices: [qinv('13', 'D-1', 4000, 0)], payments: [qpay('300', 'Daekwang', 4000, [['13', 4000]])] }, sales: rows(), receipts: receipts.list() }).proposed;
    const o3 = await pb.apply([bad, ...good], { addReceipt: receipts.addReceipt });
    ck('the bad row is reported, the good one is written', o3.failed.length === 1 && /no sale/.test(o3.failed[0].why) && o3.written === 1 && rows().find((s) => s.id === d1).balance === 0, JSON.stringify(o3));

    section('E. the script is dry by default');
    const src = fs.readFileSync(path.join(ROOT, 'scripts/payments-backfill.js'), 'utf8');
    ck('writes only behind --write', /const WRITE = process\.argv\.includes\('--write'\)/.test(src) && /if \(!WRITE\) \{[^}]*DRY RUN[^}]*return;/.test(src));
    ck('reads QuickBooks, never writes to it', !/client\.(request|post)|assertWriteAllowed|POST/.test(src.replace(/\/\/[^\n]*/g, '')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
