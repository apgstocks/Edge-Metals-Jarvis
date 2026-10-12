// ── tests/qb-doc-numbers.js ───────────────────────────────────────────────
// Apsara, 2026-10-12: numbers QuickBooks made for blank invoices/bills are put
// back into Jarvis, and "I don't want to make them back to empty on daily
// sweep".
//   A  matching: SURE only on one document + same party + same total
//   B  doubt is listed, never written
//   C  apply writes the normal Invoice no. on every grade row of the invoice,
//      and never overwrites a number typed since the list was made
//   D  THE SWEEP: a filled number is not a different invoice (no duplicate, no
//      blanking), while two different numbers on one container stay separate
//   E  end to end through the real stores and runNightly, two nights running

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-qbdoc-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const q = require(path.join(ROOT, 'helpers/qbDocNumbers'));
const sync = require(path.join(ROOT, 'helpers/metalsSheetSync'));
const job = require(path.join(ROOT, 'helpers/metalsSheetSyncJob'));
const sales = require(path.join(ROOT, 'helpers/sales'));
const bills = require(path.join(ROOT, 'helpers/bills'));

(async () => {

// ── QuickBooks side: invoices and bills as the API returns them ─────────
const qbInv = (id, doc, cust, total, containers, memo = '') => ({ Id: id, DocNumber: doc, TxnDate: '2026-09-01', TotalAmt: total,
    CustomerRef: { name: cust }, PrivateNote: memo, Line: containers.map((c) => ({ Description: c })) });
const qbBill = (id, doc, vendor, total, memo) => ({ Id: id, DocNumber: doc, TxnDate: '2026-09-01', TotalAmt: total,
    VendorRef: { name: vendor }, PrivateNote: memo, Line: [] });
const docs = q.fromQuickBooks({
    invoices: [qbInv('11', '1043', 'Acme Metals', 3000, ['AAAU1111111']),
               qbInv('12', '1044', 'Acme Metals', 999, ['BBBU2222222']),
               qbInv('13', '1045', 'Acme Metals', 500, ['CCCU3333333']), qbInv('14', '1046', 'Acme Metals', 500, ['CCCU3333333']),
               qbInv('15', '', 'Acme Metals', 700, ['DDDU4444444']),
               qbInv('16', '1050', 'Other Co', 800, ['EEEU5555555']),
               qbInv('17', '1051', 'Acme Metals', 100, ['FFFU6666666', 'GGGU7777777'])],
    bills: [qbBill('21', '5001', 'Sup One', 4500, 'HHHU8888888'), qbBill('22', '5002', 'Sup One', 9000, 'JJJU1010101\n KKKU2020202')],
});

// ══════════════════════════════════════════════════════════════════════════
section('A — SURE only when one document, same party, same total');
// ══════════════════════════════════════════════════════════════════════════
const S = (id, c, cust, price, extra = {}) => ({ id, booking_no: 'BK' + c, container_no: c, customer: cust, item: 'Alternator', weight: 1000, invoice_price: price, price_unit: 'MT', weight_unit: 'MT', date: '2026-09-01', invoice_no: '', ...extra });
const mk = (rows) => rows;
// totals are injected so this part never depends on the real arithmetic
const tot = (m) => (r) => ({ amount: m[r.id] });
const salesRows = mk([S('s1', 'AAAU1111111', 'ACME METALS', 0), S('s1b', 'AAAU1111111', 'Acme Metals', 0),
    S('s2', 'BBBU2222222', 'Acme Metals', 0), S('s3', 'CCCU3333333', 'Acme Metals', 0), S('s4', 'DDDU4444444', 'Acme Metals', 0),
    S('s5', 'EEEU5555555', 'Acme Metals', 0), S('s6', 'FFFU6666666', 'Acme Metals', 0), S('s7', 'ZZZU0000000', 'Acme Metals', 0),
    S('s8', 'AAAU1111111', 'Acme Metals', 0, { invoice_no: 'HAS-ONE' })]);
const res = q.plan({ sales: salesRows, bills: [], qbDocs: docs,
    salesWithTotals: tot({ s1: 1000, s1b: 2000, s2: 1000, s3: 500, s4: 700, s5: 800, s6: 100, s7: 1 }), billsWithTotals: () => ({}) });
const by = (c) => res.find((r) => r.container === c);
ck('one invoice, same party, same total (two grades summed) -> SURE', by('AAAU1111111').status === 'sure' && by('AAAU1111111').qb.doc === '1043', JSON.stringify(by('AAAU1111111')));
ck('  both grade rows of that invoice are in the group', by('AAAU1111111').ids.sort().join() === 's1,s1b');
ck('a row that already has a number is not a candidate', !res.some((r) => r.ids.includes('s8')));

// ══════════════════════════════════════════════════════════════════════════
section('B — doubt is listed, never written');
// ══════════════════════════════════════════════════════════════════════════
ck('different total -> ASK, with both figures', by('BBBU2222222').status === 'ask' && /total differs/.test(by('BBBU2222222').why), by('BBBU2222222').why);
ck('two QuickBooks documents on the container -> ASK', by('CCCU3333333').status === 'ask' && /2 QuickBooks documents/.test(by('CCCU3333333').why));
ck('QuickBooks document with no number either -> nothing to put back', by('DDDU4444444').status === 'none', by('DDDU4444444').status);
ck('different party -> ASK', by('EEEU5555555').status === 'ask' && /party differs/.test(by('EEEU5555555').why));
ck('a document covering two containers is never SURE', by('FFFU6666666').status === 'ask' && /several containers/.test(by('FFFU6666666').why));
ck('no QuickBooks document at all -> nothing', by('ZZZU0000000').status === 'none');
const billRes = q.plan({ sales: [], bills: [{ id: 'b1', container_no: 'HHHU8888888', supplier: 'Sup One', date: '2026-09-01', invoice_no: '' }],
    qbDocs: docs, salesWithTotals: () => ({}), billsWithTotals: () => ({ net_payable: 4500, amount: 5000 }) });
ck('a bill matches on the container named in the memo, at net payable', billRes[0].status === 'sure' && billRes[0].qb.doc === '5001', JSON.stringify(billRes[0]));
const multi = q.plan({ sales: [], bills: [{ id: 'b2', container_no: 'JJJU1010101', supplier: 'Sup One', date: '2026-09-01', invoice_no: '' }],
    qbDocs: docs, salesWithTotals: () => ({}), billsWithTotals: () => ({ net_payable: 4500 }) });
ck('a bill that covers two containers (her memo lists several) is ASK, never SURE', multi[0].status === 'ask' && /several containers/.test(multi[0].why), JSON.stringify(multi[0]));

// ══════════════════════════════════════════════════════════════════════════
section('C — apply writes SURE rows only, and never over a number');
// ══════════════════════════════════════════════════════════════════════════
const edits = [];
const cur = { s1: { invoice_no: '' }, s1b: { invoice_no: 'TYPED-SINCE' }, s2: { invoice_no: '' } };
const out = await q.apply(res, { editSale: async (id, p) => edits.push([id, p]), editBill: async () => {}, getSale: (id) => cur[id], getBill: () => null });
ck('only SURE groups are written', edits.every(([id]) => ['s1', 's1b'].includes(id)), JSON.stringify(edits));
ck('  the blank row got the QuickBooks number', edits.some(([id, p]) => id === 's1' && p.invoice_no === '1043'));
ck('  a number typed since the list was made is NOT overwritten', !edits.some(([id]) => id === 's1b') && out.skipped.some((s) => s.id === 's1b'));

// ══════════════════════════════════════════════════════════════════════════
section('D — the sweep: a filled number is not a different invoice');
// ══════════════════════════════════════════════════════════════════════════
const sheet = (inv, extra = {}) => ({ date: '2026-09-01', invoice_no: inv, container_no: 'AAAU1111111', booking_no: 'BKAAAU1111111', customer: 'Acme Metals', item: 'Alternator', invoice_price: 5, ...extra });
const mine = (inv) => ({ id: 'M1', date: '2026-09-01', invoice_no: inv, container_no: 'AAAU1111111', booking_no: 'BKAAAU1111111', customer: 'Acme Metals', item: 'Alternator', invoice_price: 5 });
let r = sync.diff({ sheetSales: [sheet('')], sales: [mine('1043')] });
ck('sheet BLANK, Jarvis filled from QuickBooks -> matched, nothing queued', r.newSales.length === 0, JSON.stringify(r.newSales));
ck('  and it is not reported as a disagreement either', r.changedSales.length === 0);
r = sync.diff({ sheetSales: [sheet('INV-9')], sales: [mine('')] });
ck('sheet filled, Jarvis blank -> matched, nothing queued', r.newSales.length === 0);
r = sync.diff({ sheetSales: [sheet('INV-9')], sales: [mine('1043')] });
ck('two DIFFERENT numbers on one container + item stay separate (split billing)', r.newSales.length === 1);
r = sync.diff({ sheetSales: [sheet('INV-9', { container_no: 'NEWU0000000' })], sales: [mine('1043')] });
ck('a different container is still new', r.newSales.length === 1);
r = sync.diff({ sheetSales: [sheet('', { item: 'Starter' })], sales: [mine('1043')] });
ck('a different item on the same container is still new', r.newSales.length === 1);

// ══════════════════════════════════════════════════════════════════════════
section('E — end to end: real stores, runNightly, two nights');
// ══════════════════════════════════════════════════════════════════════════
const added = await sales.addSale({ date: '2026-09-01', customer: 'Acme Metals', container_no: 'AAAU1111111', booking_no: 'BKAAAU1111111', item: 'Alternator', weight: 10, invoice_price: 100, invoice_no: '' });
await sales.editSale(added.id, { invoice_no: '1043' });                 // what --apply does
const sheetImport = require(path.join(ROOT, 'helpers/sheetImport'));
const realRead = sheetImport.readWorkbook;
sheetImport.readWorkbook = async () => ({ bills: [], sales: [sheet('', { invoice_price: 100 })] });
process.env.SHEET_SYNC_WRITE = '1';
for (const night of [1, 2]) {
    const rr = await job.runNightly({ write: true, buffer: Buffer.from('x') });
    ck(`night ${night}: ran clean`, rr.ok && !rr.error, String(rr.error));
    ck(`night ${night}: no duplicate invoice was added`, sales.list().length === 1, String(sales.list().length));
    ck(`night ${night}: the QuickBooks number is still there, not blanked`, sales.list()[0].invoice_no === '1043', sales.list()[0].invoice_no);
}
sheetImport.readWorkbook = realRead;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
