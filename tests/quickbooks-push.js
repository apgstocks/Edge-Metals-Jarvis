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
const P0 = require('../helpers/quickbooks/push');
// The saved cutover (data/qb-cutover.json) now outranks .env, so these tests
// point it somewhere empty — otherwise what she last chose on the page would
// decide whether they pass.
process.env.QB_CUTOVER_FILE = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'qbcut-')), 'cutover.json');
const saved = [process.env.QB_CUTOVER_BILLS, process.env.QB_CUTOVER_INVOICES];
delete process.env.QB_CUTOVER_BILLS; delete process.env.QB_CUTOVER_INVOICES;
// Apsara, 2026-10-02: "remove that hard cutover days rules". A date was
// always a blunt stand-in — true in September, wrong by October, and on the
// VM it sat on the day it was typed while eight days of work were skipped in
// silence. What it protected against is now asked directly: is it already in
// QuickBooks, and is its cost already on a cheque with no document behind it.
ck('with no lock set, a date no longer refuses anything', beforeCutover('bill', '2026-10-01', 'production') === null);
ck('...in any environment', beforeCutover('bill', '2026-01-01', 'sandbox') === null);
ck('...but a date that cannot be read is still refused, because it cannot be reasoned about',
   /can't be read/.test(beforeCutover('bill', 'last Tuesday', 'production') || ''));
process.env.QB_CUTOVER_BILLS = '2026-09-06'; process.env.QB_CUTOVER_INVOICES = '2026-08-28';
ck('a period she LOCKS is still refused, and says she closed it deliberately',
   /locked period/.test(beforeCutover('bill', '2026-09-05', 'production') || ''));
ck('bill on 6 Sep allowed', beforeCutover('bill', '2026-09-06', 'production') === null);
ck('Jan-May bill refused (no double cost)', beforeCutover('bill', '2026-03-20', 'production') !== null);
ck('typed date 9/15/2026 is AFTER the 6 Sep cutover (was wrongly skipped)', beforeCutover('bill', '9/15/2026', 'production') === null);
ck('typed date 9/5/2026 is inside the locked period', /locked period/.test(beforeCutover('bill', '9/5/2026', 'production') || ''));
ck('unreadable date refused, not skipped', /can't be read/.test(beforeCutover('bill', 'Sept 15', 'production') || ''));
ck('isoDate normalises typed dates', require('../helpers/quickbooks/push').isoDate('9/15/2026') === '2026-09-15' && require('../helpers/quickbooks/push').isoDate('2026-09-15T00:00') === '2026-09-15');
ck('invoice on 28 Aug allowed, 27 Aug refused', beforeCutover('invoice', '2026-08-28', 'production') === null && beforeCutover('invoice', '2026-08-27', 'production') !== null);
process.env.QB_CUTOVER_BILLS = 'soon';
ck('a malformed lock date is treated as no lock, not as a refusal of everything',
   beforeCutover('bill', '2026-09-30', 'production') === null);
// ── THE ROLLING BOUNDARY (Apsara, 2026-10-02: "everyday that cut over should
// be toay") ──────────────────────────────────────────────────────────────────
// Read as a lock, "today" refuses every back-dated row — last week's bills
// included. So the boundary that is always today is the HORIZON instead: a
// document dated after today is a typo, and no setting can get it wrong.
const TODAY = P0.todayISO();
const plus = (n) => new Date(Date.parse(TODAY + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
ck('today\'s own date is readable and is a plain ISO day', /^\d{4}-\d{2}-\d{2}$/.test(TODAY), TODAY);
ck('a row dated today is entered', beforeCutover('bill', TODAY, 'production') === null);
ck('a row dated tomorrow is refused — that is a typo, not a document',
   /is in the future/.test(beforeCutover('bill', plus(1), 'production') || ''));
ck('...and so is one dated next year', /is in the future/.test(beforeCutover('invoice', plus(365), 'production') || ''));
ck('...and the refusal names today, so the message cannot go stale',
   (beforeCutover('bill', plus(1), 'production') || '').includes(TODAY));
ck('a row dated yesterday is still entered — the horizon only looks forward',
   beforeCutover('bill', plus(-1), 'production') === null);
ck('a future date is a row to FIX, not a period to respect', P0.NEEDS_FIX.test(beforeCutover('bill', plus(1), 'production')) === true);
ck('...which is the same bucket as an unreadable one', P0.NEEDS_FIX.test(beforeCutover('bill', 'last Tuesday', 'production')) === true);
ck('...and a locked period is NOT in that bucket (it is left alone, not fixed)',
   P0.NEEDS_FIX.test('bill dated 2026-01-01 is before the locked period (2026-09-06)') === false);
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
// a whole-load bill: no weight, no price, just a value (Hugo's tab)
const whole = buildBill(B.withTotals({ id: 'BILL_9_hugo', date: '2026-01-07', supplier: 'Mazariegos', invoice_no: 'HUGO-0107',
    items: [{ description: 'Auto cast', amount: 19750.6 }], supplier_invoice_amount: 19750.6 }), refs);
ck('a bill whose line only states an amount still builds', whole.bill && whole.total === 19750.6 && !whole.problems, JSON.stringify(whole.problems));
ck('...and the line carries no invented Qty or UnitPrice',
   whole.bill && whole.bill.Line[0].ItemBasedExpenseLineDetail.Qty === undefined && whole.bill.Line[0].Amount === 19750.6, JSON.stringify(whole.bill && whole.bill.Line[0]));

// ── the cutover has a home she can edit (2026-09-26) ────────────────────────
// Apsara: "I want nightly report to run everyday to upload all the bills and
// invoices." The nightly run only touches rows on or after the cutover, so the
// cutover decides what "all" means — and moving it used to mean SSH, an .env
// edit and a pm2 restart. It is now a saved setting that outranks .env.
const P = require('../helpers/quickbooks/push');
const envWas = [process.env.QB_CUTOVER_BILLS, process.env.QB_CUTOVER_INVOICES];
process.env.QB_CUTOVER_BILLS = '2026-09-24'; process.env.QB_CUTOVER_INVOICES = '2026-09-24';
ck('with nothing saved, .env is what is in force', P.cutoverFor('bill', 'production') === '2026-09-24' && P.cutoverSource('bill') === 'env');
ck('...and with nothing anywhere, there is simply no lock', (() => {
    const was = [process.env.QB_CUTOVER_BILLS, process.env.QB_CUTOVER_INVOICES];
    delete process.env.QB_CUTOVER_BILLS; delete process.env.QB_CUTOVER_INVOICES;
    const none = P.cutoverFor('bill', 'production') === null && P.cutoverSource('bill') === 'unset';
    if (was[0] !== undefined) process.env.QB_CUTOVER_BILLS = was[0];
    if (was[1] !== undefined) process.env.QB_CUTOVER_INVOICES = was[1];
    return none;
})());
P.saveCutover({ bills: '2026-09-06', invoices: '2026-08-28' }, 'test');
ck('a saved cutover outranks .env — no SSH to move the boundary',
   P.cutoverFor('bill', 'production') === '2026-09-06' && P.cutoverSource('bill') === 'setting');
ck('...the invoice side moves too', P.cutoverFor('invoice', 'production') === '2026-08-28' && P.cutoverSource('invoice') === 'setting');
ck('...and who moved it, and when, is kept', (P.cutoverStore().history || [])[0].by === 'test' && !!(P.cutoverStore().history || [])[0].at);
let junk = null;
try { P.saveCutover({ bills: 'next Tuesday' }); } catch (e) { junk = e.message; }
ck('a junk date is refused with a readable reason', /date like 2026-09-06/.test(junk || ''), junk);
ck('...and the boundary it would have replaced still stands', P.cutoverFor('bill', 'production') === '2026-09-06');
// "everyday that cut over should be toay": the word is stored as the word, so
// it means the new day tomorrow instead of the day it was typed.
P.saveCutover({ bills: 'today' }, 'test');
ck('"today" is accepted as a lock value', P.cutoverFor('bill', 'production') === P.todayISO());
ck('...and is stored as the WORD, so it moves with the day', P.cutoverStore().bills === 'today');
ck('...and the page can tell that it is rolling, not a pinned date', P.cutoverIsRolling('bill') === true);
ck('...a rolling lock does refuse yesterday — which is why the doctor shouts about it',
   /locked period/.test(beforeCutover('bill', plus(-1), 'production') || ''));
P.saveCutover({ bills: 'none' }, 'test');
ck('"none" unlocks from the page — no lock is the normal state now',
   P.cutoverFor('bill', 'production') === null, P.cutoverSource('bill'));
ck('...and it BEATS .env, so the click is not silently undone by QB_CUTOVER_BILLS',
   process.env.QB_CUTOVER_BILLS === '2026-09-24' && P.cutoverSource('bill') === 'unlocked');
ck('...and the decision is on the record like any other move',
   (P.cutoverStore().history || [])[0].bills === 'none');
ck('...and a 2026 row then goes in on evidence alone', beforeCutover('bill', '2026-02-14', 'production') === null);
P.saveCutover({ bills: '2026-09-06' }, 'test');
ck('...and a real date can be put back', P.cutoverFor('bill', 'production') === '2026-09-06' && P.cutoverIsRolling('bill') === false);
P.setCutover({ bills: '2026-01-01', invoices: '2026-01-01' });
ck('a reviewed list can lift it for that run only', P.cutoverFor('bill', 'production') === '2026-01-01' && P.cutoverSource('bill') === 'override');
P.clearCutover();
ck('...and the saved boundary comes straight back', P.cutoverFor('bill', 'production') === '2026-09-06' && P.cutoverSource('bill') === 'setting');
if (envWas[0] === undefined) delete process.env.QB_CUTOVER_BILLS; else process.env.QB_CUTOVER_BILLS = envWas[0];
if (envWas[1] === undefined) delete process.env.QB_CUTOVER_INVOICES; else process.env.QB_CUTOVER_INVOICES = envWas[1];

console.log(`\nquickbooks-push: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
