// ── tests/carrier-remittance.js ───────────────────────────────────────────
// NTG / TQL / Schneider send TEXT remittances, not PDFs (Apsara, 2026-10-07).
// helpers/carrierRemittance.js parses them; scripts/carrier-remittance-report.js
// reconciles them. Both are read-only — section E asserts they write nothing.
// Fixtures are inline and sanitised copies of the real layouts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const R = require('../helpers/carrierRemittance');

let pass = 0, fail = 0;
const ck = (n, c, extra) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); } };
const section = (t) => console.log('\n=== ' + t + ' ===');
const mail = (h, body) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' + body;

const tqlPay = mail({ From: 'noreply@tql.com', Subject: 'Thank you for your payment to TQL', Date: 'Fri, 11 Sep 2026 15:00:00 +0000' },
`We received your payment for $1,300.00.
The following invoices have been paid:
37612468
Your Payment Confirmation Number: 8zvh2bva
Payment processed from: Edge Metals Inc`);
const tqlInv = mail({ From: 'ar@tql.com', Subject: 'TQL Invoices for Edge Metals Inc', Date: 'Tue, 06 Oct 2026 12:00:00 +0000' },
`37359825
8/20/2026
8/5/2026
CA TO TX
$4,500.00
$4,500.00
62
7/30/2026
37909022
PO-77
9/1/2026
8/17/2026
AZ TO CA
$1,000.00
$1,000.00
50
8/10/2026`);
const ntg = (subj, date, body) => mail({ From: 'billing@ntgfreight.com', Subject: subj, Date: date }, body);
const ntgSched = ntg('Payment Scheduled', 'Thu, 16 Apr 2026 10:00:00 +0000',
 'NTG Payment Method: EDGEBOFA Payment Date: 4/16/2026 Total Amount: $3,550.00 1111111 NTG-9183459 PO1 4/1/2026 $750.00 55501501 1111111 NTG-9149789 PO2 4/2/2026 $750.00 55502502 1111111 NTG-9115736 PO3 4/3/2026 $650.00 55503503 1111111 NTG-9068406 PO4 4/4/2026 $750.00 55504504 1111111 NTG-9083932 PO5 4/5/2026 $650.00 55505505');
const ntgConf = ntg('Acct No. 1111111: Payment Confirmation', 'Fri, 17 Apr 2026 10:00:00 +0000', 'NTG Freight: your payment in the amount of $3,550.00 has been made.');
const ntgCard = ntg('Payment Processed', 'Tue, 06 Oct 2026 10:00:00 +0000',
 'NTG Payment Method: BOFA credit Payment Date: 10/6/2026 Total Amount: $1,648.00 Convenience Fee: $48.00 1111111 NTG-9618040 PO1 9/1/2026 $800.00 66601601 1111111 NTG-9615905 PO2 9/1/2026 $800.00 66602602');
const ntgOpen = ntg('Open Balance Statement', 'Mon, 05 Oct 2026 10:00:00 +0000',
 'NTG Freight POD 9621418 EDGEMETAL(8/25/2026 8/31/2026 9/10/2026 $4,900.00 $0.00 $0.00 $4,900.00 25 POD 9703547 EDGE 9/20/2026 10/20/2026 $1,100.00 $0.00 $0.00 $1,100.00 (15) FULL OPEN BALANCE $6,000.00');
const ntgPast = ntg('Past Due Statement', 'Tue, 06 Oct 2026 08:00:00 +0000',
 'NTG Freight POD 9621418 EDGE 8/31/2026 9/10/2026 $4,900.00 $0.00 $0.00 $4,900.00 26');
const ntgNotice = ntg('Invoice 9703547 From NOLAN TRANSPORTATION GROUP, LLC', 'Mon, 21 Sep 2026 10:00:00 +0000', 'Invoice attached.');
const schn = (subj, date) => mail({ From: 'matthew.whittaker@schneider.com', Subject: subj, Date: date },
 'Pay by Link\nOrder ID: 123456789012\nAmount: USD 9,700.00\nOrder Description: 5001234, 5001235');

section('A. TQL');
{
    const p = R.parseSavedEmail(tqlPay);
    ck('TQL payment: party/kind', p && p.party === 'tql' && p.kind === 'payment');
    ck('TQL payment: amount, PO, confirmation', p && p.amount === 1300 && p.refs.join() === '37612468' && p.confirmation === '8zvh2bva', JSON.stringify(p));
    ck('TQL payment: date from header', p && p.date === '2026-09-11');
    const i = R.parseSavedEmail(tqlInv);
    ck('TQL invoices: two rows', i && i.kind === 'open_invoices' && i.rows.length === 2, JSON.stringify(i));
    ck('TQL invoices: amount/lane/ref', i && i.rows[0].ref === '37359825' && i.rows[0].amount === 4500 && i.rows[0].lane === 'CA TO TX');
    ck('TQL invoices: customer PO kept when present, null when absent', i && i.rows[1].customer_po === 'PO-77' && i.rows[0].customer_po === null);
}

section('B. NTG parsers');
{
    const s = R.parseSavedEmail(ntgSched);
    ck('NTG scheduled: total + 5 invoices', s && s.kind === 'payment_scheduled' && s.amount === 3550 && s.invoices.length === 5, JSON.stringify(s));
    ck('NTG scheduled: method', s && s.method === 'EDGEBOFA');
    const c = R.parseSavedEmail(ntgConf);
    ck('NTG confirmation: amount only', c && c.kind === 'payment_confirmation' && c.amount === 3550 && c.invoices.length === 0, JSON.stringify(c));
    const k = R.parseSavedEmail(ntgCard);
    ck('NTG card payment: fee captured', k && k.fee === 48 && k.invoices.length === 2);
    const o = R.parseSavedEmail(ntgOpen);
    ck('NTG open statement typed open, rows anchored from the right', o && o.statement_type === 'open' && o.rows.length === 2 && o.rows[0].invoice === '9621418' && o.rows[0].open === 4900 && o.full_open_balance === 6000, JSON.stringify(o));
    ck('NTG statement: "(15)" days = -15', o && o.rows[1].days_past_due === -15);
    const pd = R.parseSavedEmail(ntgPast);
    ck('NTG past-due statement typed past_due', pd && pd.statement_type === 'past_due');
    const n = R.parseSavedEmail(ntgNotice);
    ck('NTG invoice notice', n && n.kind === 'invoice_notice' && n.invoice === '9703547');
}

section('C. NTG: one payment = up to three mails');
{
    const recs = [ntgSched, ntgConf, ntgCard].map(R.parseSavedEmail);
    const g = R.groupNtgPayments(recs);
    ck('scheduled + next-day confirmation = ONE payment', g.length === 2, JSON.stringify(g.map((x) => [x.date, x.amount])));
    ck('total not double-counted', g.reduce((a, p) => a + p.amount, 0) === 5198);
    ck('confirmation recorded on the payment', g[0].confirmed === '2026-04-17' && g[0].invoices.length === 5);
    const lone = R.groupNtgPayments([R.parseSavedEmail(ntgConf)]);
    ck('confirmation with nothing to join stands alone', lone.length === 1 && lone[0].amount === 3550 && lone[0].invoices.length === 0);
    const far = R.parseSavedEmail(ntgConf.replace('17 Apr', '30 Apr'));
    ck('same amount but >5 days apart is a different payment', R.groupNtgPayments([R.parseSavedEmail(ntgSched), far]).length === 2);
    const both = R.groupNtgPayments([R.parseSavedEmail(ntgSched), R.parseSavedEmail(ntgSched.replace('Payment Scheduled', 'Payment Processed'))]);
    ck('scheduled + processed same day = one', both.length === 1);
    ck('empty/garbage input is safe', R.groupNtgPayments(null).length === 0 && R.groupNtgPayments([null, { party: 'tql' }]).length === 0);
}

section('D. Schneider and "not my email"');
{
    const a = R.parseSavedEmail(schn('Pay by Link', 'Mon, 05 Oct 2026 10:00:00 +0000'));
    ck('Pay by Link: order, amount, loads, unpaid', a && a.order === '123456789012' && a.amount === 9700 && a.loads.length === 2 && a.paid === false, JSON.stringify(a));
    const b = R.parseSavedEmail(schn('Fwd: PAID $9700 Pay by Link', 'Tue, 06 Oct 2026 10:00:00 +0000'));
    ck('"PAID" in subject marks it paid', b && b.paid === true);
    ck('ordinary delivery mail -> null', R.parseSavedEmail(mail({ From: 'matthew.whittaker@schneider.com', Subject: 'Delivery tomorrow', Date: 'Mon, 05 Oct 2026 10:00:00 +0000' }, 'Truck arrives 8am.')) === null);
    ck('TQL payment subject without an amount -> null (no guessed number)', R.parseSavedEmail(mail({ Subject: 'Thank you for your payment to TQL', Date: 'Mon, 05 Oct 2026 10:00:00 +0000' }, 'hello')) === null);
    ck('empty input -> null', R.parseSavedEmail('') === null && R.parseSavedEmail(null) === null);
}

section('E. Report end to end (real script, saved-email folder, read-only)');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-rem-'));
    const put = (party, name, txt) => { fs.mkdirSync(path.join(dir, party, 'emails'), { recursive: true }); fs.writeFileSync(path.join(dir, party, 'emails', name), txt); };
    put('tql', 'a.txt', tqlPay); put('tql', 'b.txt', tqlInv);
    put('ntg', 'a.txt', ntgSched); put('ntg', 'b.txt', ntgConf); put('ntg', 'c.txt', ntgOpen); put('ntg', 'd.txt', ntgCard);
    put('schneider', 'a.txt', schn('Pay by Link', 'Mon, 05 Oct 2026 10:00:00 +0000'));
    const before = fs.readdirSync(dir, { recursive: true }).sort().join();
    const out = execFileSync('node', [path.join(__dirname, '../scripts/carrier-remittance-report.js'), '--detail'], { env: { ...process.env, CARRIER_EMAIL_DIR: dir }, encoding: 'utf8' });
    ck('NTG total counts the 4/16 payment once: 2 payments, $5,198', /NTG — 2 distinct payment\(s\), \$5,198\.00/.test(out), out.split('\n').find((l) => l.startsWith('NTG')));
    ck('TQL: paid PO matched, unpaid PO flagged', /PO 37909022[^\n]*no payment mail seen/.test(out) && /PO 37359825[^\n]*no payment mail seen/.test(out));
    ck('NTG: invoice on open statement not paid is flagged', /NTG-9621418[^\n]*open on the 2026-10-05 statement/.test(out));
    ck('NTG: paid invoices absent from every statement are called out, not hidden', /Paid invoices that never appeared on a saved statement: 7[^\n]*9183459/.test(out), out.split('\n').find((l) => /never appeared/.test(l)));
    ck('Schneider: unpaid order listed', /order 123456789012[^\n]*no "PAID" mail seen/.test(out));
    ck('report says nothing was written', /Nothing was written/.test(out));
    ck('report wrote nothing to the folder', fs.readdirSync(dir, { recursive: true }).sort().join() === before);
    fs.rmSync(dir, { recursive: true, force: true });
}

section('F. Import rows (buildCarrierRows) + importer end to end');
{
    const recs = [tqlPay, tqlInv, ntgSched, ntgConf, ntgOpen, ntgCard, schn('Pay by Link', 'Mon, 05 Oct 2026 10:00:00 +0000')].map(R.parseSavedEmail);
    const { rows, skipped } = R.buildCarrierRows(recs);
    const f = (c, r) => rows.find((x) => x.carrier === c && x.ref === r);
    ck('TQL unpaid PO: open, outstanding = amount', f('tql', '37359825') && f('tql', '37359825').paid === 0);
    ck('TQL paid PO not on a reminder is skipped, not invented', skipped.some((s) => s.ref === '37612468') && !f('tql', '37612468'));
    ck('NTG invoice on open statement, unpaid', f('ntg', '9621418') && f('ntg', '9621418').paid === 0 && f('ntg', '9621418').amount === 4900);
    ck('NTG invoice paid via payment mail, not on a statement, gets its own row', f('ntg', '9183459') && f('ntg', '9183459').paid === 750);
    ck('NTG paid is counted once despite confirmation mail', rows.filter((x) => x.carrier === 'ntg').reduce((a, x) => a + x.paid, 0) === 3550 + 1600);
    ck('Schneider unpaid order: paid 0', f('schneider', '123456789012') && f('schneider', '123456789012').paid === 0);
    ck('buildCarrierRows(null) is safe', R.buildCarrierRows(null).rows.length === 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-imp-')), data = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-data-'));
    const put = (party, name, txt) => { fs.mkdirSync(path.join(dir, party, 'emails'), { recursive: true }); fs.writeFileSync(path.join(dir, party, 'emails', name), txt); };
    put('tql', 'b.txt', tqlInv); put('ntg', 'c.txt', ntgOpen);
    const run = (...a) => execFileSync('node', [path.join(__dirname, '../scripts/carrier-invoices-import.js'), ...a], { env: { ...process.env, CARRIER_EMAIL_DIR: dir, DATA_DIR: data, JARVIS_TEST: '1' }, encoding: 'utf8' });
    const file = path.join(data, 'carrier_invoices.json');
    const dry = run();
    ck('dry run writes nothing', /DRY RUN/.test(dry) && !fs.existsSync(file));
    run('--write');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    ck('--write saves 4 Edge Metals rows', saved.length === 4 && saved.every((r) => r.company === 'Edge Metals'), String(saved.length));
    run('--write');
    ck('second --write adds no duplicates', JSON.parse(fs.readFileSync(file, 'utf8')).length === 4);
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
