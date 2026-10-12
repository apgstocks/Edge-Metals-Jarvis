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

section('B2 — second look: same party + same total, container not named');
{
    const inv2 = q.fromQuickBooks({ invoices: [qbInv('31', '2001', 'Acme Metals', 6000, [], 'trailer load Sept')], bills: [qbBill('41', '7001', 'Sup One', 3000, 'weekly statement'), qbBill('42', '7002', 'Sup One', 3000, 'other')] });
    const rows = q.plan({ sales: [S('x1', 'XXXU0000001', 'Acme Metals', 0)], bills: [{ id: 'bx', container_no: 'YYYU0000002', supplier: 'Sup One', date: '2026-09-01', invoice_no: '' }, { id: 'bz', container_no: 'WWWU0000003', supplier: 'Sup One', date: '2026-09-01', invoice_no: '' }],
        qbDocs: inv2, salesWithTotals: () => ({ amount: 6000 }), billsWithTotals: (b) => ({ net_payable: b.id === 'bx' ? 3000 : 1234 }) });
    ck('without the second look all three are NO MATCH', rows.every((r) => r.status === 'none'));
    const second = q.byAmount(rows, inv2);
    const g = (c) => second.find((r) => r.container === c);
    ck('one invoice with the same party and total -> a lead (ASK), carrying its memo', g('XXXU0000001').status === 'ask' && /trailer load Sept/.test(g('XXXU0000001').why), g('XXXU0000001').why);
    ck('  never SURE, however clean the match', !second.some((r) => r.status === 'sure'));
    ck('two bills share the party and total -> ASK listing both numbers', g('YYYU0000002').status === 'ask' && /7001, 7002/.test(g('YYYU0000002').why), g('YYYU0000002').why);
    ck('a different total stays NO MATCH', g('WWWU0000003').status === 'none');
}

section('B3 — the real misses from the first live run');
{
    const live = q.fromQuickBooks({ bills: [
        { Id: '38598', DocNumber: 'Local_eccomelt', TxnDate: '2026-05-28', TotalAmt: 60284, VendorRef: { name: 'Mazariegos' }, PrivateNote: 'EMHU260742', Line: [] },
        { Id: '38905', DocNumber: 'EMHU273618', TxnDate: '2026-06-04', TotalAmt: 60649.2, VendorRef: { name: 'Inesh Cores Chapin' }, PrivateNote: 'EMHU273618', Line: [] },
        { Id: '50001', DocNumber: 'LOCAL-260917-03IHEF', TxnDate: '2026-09-17', TotalAmt: 10974, VendorRef: { name: 'Junk car' }, PrivateNote: '', Line: [] },
        { Id: '50002', DocNumber: 'LOCAL-260911-0MDDQY', TxnDate: '2026-09-11', TotalAmt: 10974, VendorRef: { name: 'Junk car' }, PrivateNote: '', Line: [] }] });
    const jb = [
        { id: 'x1', container_no: 'EMHU260742', supplier: 'Mazariegos', date: '2026-05-28', invoice_no: '' },
        { id: 'x2', container_no: 'EMHU273618', supplier: 'Inesh Cores Chapin', date: '2026-06-04', invoice_no: '' },
        { id: 'abc03iHEF', container_no: '4009760', supplier: 'Junk car', date: '2026-09-17', invoice_no: '' },
        { id: 'zz', container_no: '4009761', supplier: 'Junk car', date: '2026-09-18', invoice_no: '' }];
    const out = q.plan({ sales: [], bills: jb, qbDocs: live, salesWithTotals: () => ({}),
        billsWithTotals: (b) => ({ net_payable: { x1: 60284, x2: 60649.2, abc03iHEF: 10974, zz: 10664 }[b.id] }) });
    const g = (c) => out.find((r) => r.container === c);
    ck('a 6-digit container named in the memo, same party + total -> SURE', g('EMHU260742').status === 'sure' && g('EMHU260742').qb.doc === 'Local_eccomelt', JSON.stringify(g('EMHU260742').status));
    ck('  and the doc number that is just the container is taken as it is', g('EMHU273618').status === 'sure' && g('EMHU273618').qb.doc === 'EMHU273618');
    ck('Jarvis\'s own LOCAL number picks the right one of two same-total documents', g('4009760').status === 'sure' && g('4009760').qb.doc === 'LOCAL-260917-03IHEF', JSON.stringify(g('4009760')));
    ck('a bare reference number is NOT searched for in free text', g('4009761').status === 'none', g('4009761').status);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — apply writes SURE rows only, and never over a number');
// ══════════════════════════════════════════════════════════════════════════
const edits = [];
const cur = { s1: { invoice_no: '' }, s1b: { invoice_no: 'TYPED-SINCE' }, s2: { invoice_no: '' } };
const out = await q.apply(res, { editSale: async (id, p) => edits.push([id, p]), editBill: async () => {}, getSale: (id) => cur[id], getBill: () => null });
ck('only SURE groups are written', edits.every(([id]) => ['s1', 's1b'].includes(id)), JSON.stringify(edits));
ck('  the blank row got the QuickBooks number', edits.some(([id, p]) => id === 's1' && p.invoice_no === '1043'));
ck('  a number typed since the list was made is NOT overwritten', !edits.some(([id]) => id === 's1b') && out.skipped.some((s) => s.id === 's1b'));

{
    const sure = [{ status: 'sure', store: 'bills', ids: ['p1'], container: 'C1', qb: { doc: 'Local' } }, { status: 'sure', store: 'bills', ids: ['p2'], container: 'C2', qb: { doc: 'EMHU273618' } }];
    const w = [];
    const o2 = await q.apply(sure, { editSale: async () => {}, editBill: async (id, p) => w.push([id, p.invoice_no]), getSale: () => null, getBill: () => ({ invoice_no: '' }), skipLabels: true });
    ck('skipLabels leaves out "Local" and writes the real number', JSON.stringify(w) === JSON.stringify([['p2', 'EMHU273618']]) && o2.skipped.length === 1, JSON.stringify([w, o2.skipped]));
    const w2 = [];
    await q.apply(sure, { editSale: async () => {}, editBill: async (id, p) => w2.push(id), getSale: () => null, getBill: () => ({ invoice_no: '' }) });
    ck('without it, both are written (as she asked: keep it as per QuickBooks)', w2.length === 2);
}

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
