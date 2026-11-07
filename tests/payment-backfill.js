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

    section('D2. a lump payment QuickBooks holds UNAPPLIED (Apsara: "everything is paid except the latest ones")');
    const l1 = await mk('Lump Co', 'L-1', '2026-09-01', 5000, 1, 'LLLL1111111'), l2 = await mk('Lump Co', 'L-2', '2026-09-10', 5000, 1, 'LLLL2222222'), l3 = await mk('Lump Co', 'L-3', '2026-11-06', 5000, 1, 'LLLL3333333');
    const lumpQb = { invoices: [qinv('51', 'L-1', 5000, 5000), qinv('52', 'L-2', 5000, 5000), qinv('53', 'L-3', 5000, 5000)],
        payments: [{ Id: '600', TxnDate: '2026-10-30', TotalAmt: 10000, CustomerRef: { name: 'Lump Co' }, PaymentMethodRef: { name: 'Wire' }, DepositToAccountRef: { name: 'Chase Business' }, Line: [] }] };
    const noFifo = pb.plan({ qb: lumpQb, sales: rows(), receipts: receipts.list() });
    ck('unapplied cash is LISTED, and not applied unless asked', noFifo.unappliedCash.length === 1 && noFifo.unappliedCash[0].amount === 10000 && !noFifo.proposed.some((p) => p.customer === 'Lump Co') && noFifo.totals.unappliedCash === 10000, JSON.stringify(noFifo.totals));
    const fifo = pb.plan({ qb: lumpQb, sales: rows(), receipts: receipts.list(), fifoUnapplied: true });
    const lp = fifo.proposed.find((p) => p.customer === 'Lump Co');
    ck('applied oldest invoice first: L-1 and L-2 paid, the latest L-3 stays open', lp && lp.amount === 10000 && lp.allocations.map((a) => a.sale_id).join() === [l1, l2].join() && fifo.oldestOpen.some((x) => x.invoice_no === 'L-3' && x.open === 5000) && !fifo.oldestOpen.some((x) => x.invoice_no === 'L-1'), JSON.stringify(fifo.oldestOpen));
    ck('  the note says it was an oldest-first application, bank mapped, flagged as unapplied', /unapplied/.test(lp.note) && lp.unapplied === true && lp.bank === 'Chase Bank');
    const wl = await pb.apply(fifo.proposed.filter((p) => p.customer === 'Lump Co'), { addReceipt: receipts.addReceipt });
    ck('written: Lump Co now owes only the latest $5,000', wl.written === 1 && rows().filter((s) => s.customer === 'Lump Co' && s.balance > 0.005).map((s) => s.invoice_no).join() === 'L-3');
    ck('re-planning does not apply that cash twice', pb.plan({ qb: lumpQb, sales: rows(), receipts: receipts.list(), fifoUnapplied: true }).proposed.filter((p) => p.customer === 'Lump Co').length === 0);

    section('D3. checked against the bank feed (Plaid)');
    const P = [{ ref: 'a', customer: 'X', date: '2026-10-20', amount: 15000 }, { ref: 'b', customer: 'X', date: '2026-10-21', amount: 15000 }, { ref: 'c', customer: 'Y', date: '2026-10-01', amount: 700 }, { ref: 'd', customer: 'Z', date: '2026-03-01', amount: 99 }];
    const bank = [{ id: 'b1', date: '2026-10-22', amount: 15000, direction: 'in' }, { id: 'b2', date: '2026-10-05', amount: 700, direction: 'in' }, { id: 'b3', date: '2026-10-21', amount: 15000, direction: 'out' }, { id: 'b4', date: '2026-09-15', amount: 5, direction: 'in' }];
    const v = pb.verifyWithBank(P, bank);
    const st = Object.fromEntries(v.rows.map((r) => [r.ref, r.bank_check.status]));
    ck('same amount within 10 days = verified; the deposit is used ONCE (two $15,000 receipts, one deposit)', [st.a, st.b].filter((x) => x === 'verified').length === 1, JSON.stringify(st));
    ck('  the nearer receipt gets it (b is 1 day from the deposit, a is 2)', st.b === 'verified');
    ck('money OUT never vouches for money in (the outgoing $15,000 deposit-lookalike is ignored)', pb.verifyWithBank([{ ref: 'o', customer: 'X', date: '2026-10-21', amount: 15000 }], [{ id: 'o1', date: '2026-10-21', amount: 15000, direction: 'out' }]).rows[0].bank_check.status !== 'verified');
    ck('a receipt 4 days from a matching deposit is verified', st.c === 'verified');
    ck('older than the feed is "outside-feed", not unverified', st.d === 'outside-feed' && v.coverage.from === '2026-09-15');
    ck('totals', v.totals.verified === 2 && v.totals.notFound === 1 && v.totals.outsideFeed === 1 && v.totals.verifiedMoney === 15700, JSON.stringify(v.totals));
    ck('an empty bank feed verifies nothing', pb.verifyWithBank(P, []).totals.verified === 0);
    const src1 = fs.readFileSync(path.join(ROOT, 'scripts/payments-backfill.js'), 'utf8');
    ck('the script runs the bank check and can restrict --write to verified receipts', /verifyWithBank/.test(src1) && /--bank-verified-only/.test(src1) && /status === 'verified'/.test(src1));

    section('D4. three-way check: invoiced vs QuickBooks vs bank');
    const cc = pb.crossCheck({ sales: [{ receivable: 10000, received: 0 }, { receivable: 5000, received: 0 }], qbPayments: [{ TotalAmt: 9000 }], customer: 'Rad Metal', since: '2026-01-01',
        bankRows: [{ direction: 'in', date: '2026-03-01', amount: 9000, desc: 'WIRE FROM RAD METAL INC' }, { direction: 'in', date: '2026-04-01', amount: 5000, desc: 'RADIUS SUPPLY' }, { direction: 'in', date: '2026-04-01', amount: 6000, desc: 'RAD METAL', excluded: true }, { direction: 'out', date: '2026-04-02', amount: 7000, desc: 'RAD METAL' }, { direction: 'in', date: '2025-12-01', amount: 8000, desc: 'RAD METAL' }] });
    ck('invoiced / QuickBooks / bank figures; excluded, outgoing, pre-period and look-alike (RADIUS) deposits ignored', cc.invoiced === 15000 && cc.qbPaid === 9000 && cc.bankDeposits === 1 && cc.bank === 9000, JSON.stringify(cc));
    ck('a name made only of generic words has no name signal', pb.crossCheck({ sales: [], qbPayments: [], bankRows: [], customer: 'Trading Co Inc' }).nameSignal === false);

    section('E. the script is dry by default');
    const src = fs.readFileSync(path.join(ROOT, 'scripts/payments-backfill.js'), 'utf8');
    ck('writes only behind --write', /const WRITE = process\.argv\.includes\('--write'\)/.test(src) && /if \(!WRITE\) \{[^}]*DRY RUN[^}]*return;/.test(src));
    ck('reads QuickBooks, never writes to it', !/client\.(request|post)|assertWriteAllowed|POST/.test(src.replace(/\/\/[^\n]*/g, '')));
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
