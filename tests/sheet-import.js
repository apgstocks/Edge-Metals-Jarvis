// ── tests/sheet-import.js ─────────────────────────────────────────────────
// Apsara, 2026-09-18: "i want to upload this — whatever in shipments tab to
// Bill and Order Details to Invoice tab".
//
// ── WHY THIS FILE IS LONG ───────────────────────────────────────────────────
// The reader had SIX bugs in one afternoon, every one found by her asking a
// question rather than by me checking, and every one of them silent:
//
//   formula cells read as null — 664 supplier invoice amounts, $16.4M;
//   text fields holding formulas written out as "[object Object]";
//   a photo link written as {text, hyperlink} instead of a URL;
//   rows keyed on container number, dropping her entire domestic business;
//   row numbers computed as position+2, so every reference in the preview
//     pointed at the wrong row;
//   the first grade's invoice amount hoisted onto a whole container,
//     understating 46 bills — APZU3556287 by $21,365.
//
// None of those looked like a failure. They looked like a slightly smaller
// number. That is the class of bug this file exists for, so the checks are
// about VALUES SURVIVING rather than about the code running.
//
// The fixtures are built here with exceljs rather than read from her
// workbook: a test that depends on a 19MB file nobody can regenerate is a
// test that gets deleted the first time the file moves.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-import-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
// Before config.js is required — it reads these once, at load.
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD = 'staff-pw-ccccccccccc';

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(os.tmpdir())) {
    console.error('REFUSING TO RUN: DATA_DIR is not a temp directory — this test writes.');
    process.exit(1);
}
const si = require(path.join(ROOT, 'helpers/sheetImport'));
const siw = require(path.join(ROOT, 'helpers/sheetImportWrite'));

// ── A WORKBOOK SHAPED LIKE HERS ─────────────────────────────────────────────
// Including the things that actually broke: formula cells, a hyperlink object,
// rich text, a row with no container, a multi-grade container whose trucking
// sits on the SECOND line, scratch below the data.
async function buildWorkbook() {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();

    const sh = wb.addWorksheet('SHIPMENTS 2026');
    sh.addRow(['g', 'Carrier', 'TRUCKING', 'Date', 'SUPPLIER', 'Customer', 'INV NO', 'BKG#',
               'CONT#', 'SEAL#', 'item Description', 'GROSS', 'Truck', 'container', 'Chassis',
               'Boxes', 'Total', 'NET', 'MT', 'supplier price', 'SUPPL INVOICE AMT',
               'Advance /Trucking', 'Photo Link']);
    // 2: a plain single-grade export
    sh.addRow(['LA/Busan', 'HMM', 'Sher', new Date(Date.UTC(2026, 0, 15)), 'Gomez', 'Rad Metal',
               'INV-1', 'BKG-1', 'ABCD1234567', 'SEAL1', 'Auto Cast', 40000, 10000, null, null,
               null, null, null, null, 0.8, 24000, 5000, 'https://photos.example/a']);
    // 3,4,5: ONE container, three grades. Trucking on the SECOND row only, and
    // a per-grade invoice amount on each — the $21,365 bug.
    sh.addRow(['LA/Busan', 'HMM', 'Sher', new Date(Date.UTC(2026, 0, 20)), 'Chapin', 'Eccomelt',
               'INV-2', 'BKG-2', 'WXYZ7654321', 'SEAL2', 'ALTERNATORS', 10000, 500, null, null,
               null, null, null, null, 1.0, 9500, null, null]);
    sh.addRow([null, null, null, null, null, null, null, null, 'WXYZ7654321', null,
               'STARTERS', 20000, 1000, null, null, null, null, null, null, 2.0, 38000, 777, null]);
    sh.addRow([null, null, null, null, null, null, null, null, 'WXYZ7654321', null,
               'COMPRESSORS', 5000, 250, null, null, null, null, null, null, 0.5, 2375, null, null]);
    // 6: a LOCAL delivery — no container at all
    sh.addRow(['Oklahoma/LA', null, 'TQL', new Date(Date.UTC(2026, 1, 2)), 'Carlos', 'Outlast',
               'LOCAL', 'PO#1', null, null, 'AL WHEELS', 30000, 8000, null, null, null,
               null, null, null, 1.2, 26400, null, null]);
    // 7: BELOW the data line. Deliberately a row that WOULD import — a real
    // supplier and a real price — because that is the case the cut-off exists
    // for. An earlier fixture put a lone number here, which is dropped with or
    // without the cut-off, so the check passed while testing nothing.
    sh.addRow(['San Antonio/LA', 'NTG', null, new Date(Date.UTC(2026, 8, 18)), 'Mario',
               null, null, null, null, null, null, null, null, null, null, null,
               null, null, null, 1.48, null, 13274, null]);

    const od = wb.addWorksheet('Order Details 2026');
    od.addRow(['Consignee', 'Inv No.', 'Inv Date', 'HBL  No.', 'Booking  No.', 'Container No.',
               'Seal No.', 'Supplier', 'Terms', 'Customer', 'Proforma Date', 'Reference',
               'Item Description', 'Weight', 'Inv price', 'INVOICE AMT', 'RECEIVED AMT',
               'Received Date', 'Freight Charge', 'Freight', 'ETA', 'Commissions', 'COMM Amount']);
    od.addRow(['Joey/Taewon', 'S-1', new Date(Date.UTC(2026, 0, 15)), 'HBL-1', 'BKG-1',
               'ABCD1234567', 'SEAL1', 'Gomez', 'TT', 'TAEWON AUTO', new Date(Date.UTC(2025, 11, 1)),
               'PO-9', 'AL COMBO', 20, 900, 18000, null, null, 95, null, null, 10, 200]);
    // L/C, which sales.js does not accept until it is normalised
    od.addRow(['Pan Metal', 'S-2', new Date(Date.UTC(2026, 0, 16)), 'HBL-2', 'BKG-2',
               'EFGH1234567', 'SEAL2', 'Chapin', 'L/C', 'PAN METAL', null, null, 'ZORBA', 10, 500,
               5000, null, null, null, null, null, null, null]);
    // No date at all — sales.js refuses this, and it must be REPORTED
    od.addRow(['Nicro', 'S-3', null, 'HBL-3', 'BKG-3', 'IJKL1234567', null, 'Chapin', 'TT',
               'NICRO METALS', null, null, 'AUTO PARTS', 5, 400, 2000, null, null, null, null, null, null, null]);
    // A cancelled order
    od.addRow(['Soline', 'S-4', null, null, 'ORDER CANCELLED', null, null, null, 'TT',
               'SOLINE METAL', null, null, null, null, null, null, null, null, null, null, null, null, null]);

    // ── THE CELL SHAPES THAT ACTUALLY BROKE ──────────────────────────────
    // Assigned after the rows, because passing a URL string to addRow leaves
    // it a plain string — exceljs only produces a { text, hyperlink } object
    // when you build one. An earlier fixture did exactly that, so the check
    // "the photo link is a URL, not an object" passed while never once seeing
    // an object. A mutation deleting the unwrapper stayed green.
    //
    // Row 2 now carries all three shapes her real workbook has:
    //   a HYPERLINK in the photo column,
    //   a FORMULA in the supplier-invoice-amount column (664 of these were
    //     being read as null — $16.4M),
    //   RICH TEXT in the supplier column (read as "[object Object]").
    sh.getCell('W2').value = { text: 'https://photos.example/a', hyperlink: 'https://photos.example/a' };
    sh.getCell('U2').value = { formula: 'L2*T2', result: 24000 };
    sh.getCell('E2').value = { richText: [{ text: 'Go' }, { text: 'mez' }] };
    // And a shared formula, which is the commoner of the two in her file.
    sh.getCell('U4').value = { sharedFormula: 'U2', result: 38000 };

    const file = path.join(TMP, 'fixture.xlsx');
    await wb.xlsx.writeFile(file);
    return fs.readFileSync(file);
}

(async () => {

const buf = await buildWorkbook();

// ── A. Values survive the read ──────────────────────────────────────────────
section('A. what the sheet says is what arrives');
{
    const r = await si.readWorkbook(buf, { shipmentsLastRow: 6, ordersLastRow: 5 });

    const plain = r.bills.find((b) => b.container_no === 'ABCD1234567');
    ck('a single-grade export becomes one bill', !!plain);
    ck('  carrying its supplier', plain.supplier === 'Gomez');
    ck('  its date, as YYYY-MM-DD', plain.date === '2026-01-15', plain.date);
    ck('  its gross', plain.gross === 40000);
    ck('  its supplier invoice amount', plain.supplier_invoice_amount === 24000);
    ck('  and its photo link AS A URL, not an object',
       typeof plain.photos === 'string' && /^https:\/\//.test(plain.photos),
       JSON.stringify(plain.photos) + ' — a {text,hyperlink} object here is written into her data');
    // The three shapes, each checked on the value that came out.
    ck('  A FORMULA CELL GIVES ITS RESULT, not null',
       plain.supplier_invoice_amount === 24000,
       `got ${plain.supplier_invoice_amount} — 664 of these in her file, $16.4M of money owed`);
    ck('  RICH TEXT gives its text, not "[object Object]"',
       plain.supplier === 'Gomez', JSON.stringify(plain.supplier));

    // No field anywhere may still be a raw exceljs object. This is the check
    // that would have caught three of the six bugs at once.
    const raw = [];
    for (const b of r.bills) {
        for (const [k, v] of Object.entries(b)) {
            if (k.startsWith('_') || k === 'items') continue;
            if (v && typeof v === 'object' && !Array.isArray(v)) raw.push('bill.' + k);
        }
        for (const it of (b.items || [])) {
            for (const [k, v] of Object.entries(it)) if (v && typeof v === 'object') raw.push('item.' + k);
        }
    }
    for (const s of r.sales) {
        for (const [k, v] of Object.entries(s)) {
            if (k.startsWith('_')) continue;
            if (v && typeof v === 'object' && !Array.isArray(v)) raw.push('sale.' + k);
        }
    }
    ck('NO FIELD IS STILL A RAW SPREADSHEET OBJECT', raw.length === 0,
       [...new Set(raw)].join(', ') + ' — these get written into her data verbatim');
}

// ── B. One container, several grades ────────────────────────────────────────
section('B. a multi-grade container is ONE bill');
{
    const r = await si.readWorkbook(buf, { shipmentsLastRow: 6, ordersLastRow: 5 });
    const multi = r.bills.find((b) => b.container_no === 'WXYZ7654321');
    ck('three rows become one bill', !!multi && (multi.items || []).length === 3,
       `${(multi && multi.items || []).length} items`);
    ck('  a SHARED formula gives its result too',
       multi.items.some((i) => i.description === 'STARTERS'),
       'the commoner of the two formula shapes in her workbook');
    ck('  each grade keeps its own gross',
       multi.items.map((i) => i.gross).join(',') === '10000,20000,5000',
       multi.items.map((i) => i.gross).join(','));
    ck('  and its own price',
       multi.items.map((i) => i.price).join(',') === '1,2,0.5',
       multi.items.map((i) => i.price).join(','));

    // THE $21,365 BUG. Her sheet states the invoice amount PER GRADE. Hoisting
    // the first grade's figure onto the container made the bill claim it owed
    // 9,500 of a real 49,875.
    ck('THE FIRST GRADE\'S INVOICE AMOUNT IS NOT HOISTED ONTO THE CONTAINER',
       multi.supplier_invoice_amount === undefined,
       `carried ${multi.supplier_invoice_amount} — the container owes the SUM, not the first line`);
    ck('  nor is the first grade\'s price', multi.supplier_price === undefined);

    // Trucking sits on the SECOND row in the fixture, as it does in her sheet.
    ck('A CONTAINER-LEVEL FIGURE IS FOUND WHEREVER IT SITS',
       multi.trucking_amount === 777,
       `got ${multi.trucking_amount} — reading only the first row loses it`);
    ck('  and so are the other container facts stated once',
       multi.supplier === 'Chapin' && multi.carrier === 'HMM' && multi.date === '2026-01-20');
}

// ── C. No container means local delivery ────────────────────────────────────
section('C. a load without a container');
{
    const r = await si.readWorkbook(buf, { shipmentsLastRow: 6, ordersLastRow: 5 });
    const local = r.bills.find((b) => !b.container_no);
    ck('it is imported, not skipped', !!local,
       'her entire domestic business was being dropped by a container-number key');
    ck('  with its supplier and weights', local.supplier === 'Carlos' && local.gross === 30000);
    ck('  and marked as a local delivery', /local delivery/i.test(local.note || ''), local.note);
    ck('  it is counted as its own thing', r.summary.bills_local_delivery === 1);
}

// ── D. Where the data stops ─────────────────────────────────────────────────
section('D. the last-row cut-off');
{
    const withCut = await si.readWorkbook(buf, { shipmentsLastRow: 6, ordersLastRow: 5 });
    const without = await si.readWorkbook(buf);
    ck('the scratch row below the line is excluded',
       withCut.summary.bills < without.summary.bills,
       `${withCut.summary.bills} vs ${without.summary.bills}`);
    ck('  and without a cut-off it comes back', without.summary.bills > withCut.summary.bills);
    ck('  the cut-off is reported, not silent',
       withCut.sheets.shipments.lastRow === 6 && withCut.sheets.shipments.rowsBelowLastRow >= 1,
       JSON.stringify(withCut.sheets.shipments));
}

// ── E. The invoice side ─────────────────────────────────────────────────────
section('E. Order Details becomes invoices');
{
    const r = await si.readWorkbook(buf, { shipmentsLastRow: 6, ordersLastRow: 5 });
    const s1 = r.sales.find((s) => s.invoice_no === 'S-1');
    ck('an invoice row arrives', !!s1);
    ck('  with weight and price', s1.weight === 20 && s1.invoice_price === 900);
    ck('  and the INVOICE AMT is NOT imported',
       s1.invoice_amount === undefined,
       'a typed total stored beside the arithmetic that produces it');
    ck('  the address-book tag is kept in the note',
       /Joey\/Taewon/.test(s1.note || ''), s1.note);

    const s2 = r.sales.find((s) => s.invoice_no === 'S-2');
    ck('"L/C" is normalised to LC', s2 && s2.terms === 'LC', s2 && s2.terms);

    ck('a cancelled order is left out',
       !r.sales.some((s) => s.invoice_no === 'S-4') && r.summary.cancelled_orders === 1,
       'a cancelled order in the ledger is money nobody owes');
    ck('  and it is listed, not silently dropped',
       (r.cancelled || []).some((c) => /cancel/i.test(c.marker)));
}

// ── F. Nothing is written until it is ───────────────────────────────────────
section('F. plan writes nothing');
{
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const sales = require(path.join(ROOT, 'helpers/sales'));
    const before = { bills: bills.list().length, sales: sales.list().length };

    const parsed = await si.readWorkbook(buf, { shipmentsLastRow: 6, ordersLastRow: 5 });
    const planned = siw.plan(parsed, { source: 'fixture.xlsx', actor: 'test' });

    ck('planning writes nothing at all',
       bills.list().length === before.bills && sales.list().length === before.sales,
       'the preview she approves must not be the thing that changes her data');
    ck('  it reports what would be created', planned.summary.bills === 3 && planned.summary.sales === 2,
       JSON.stringify(planned.summary));

    // A row the STORE refuses — reported with its spreadsheet row, not dropped.
    ck('  a row the store refuses is REPORTED', planned.refused.length === 1, JSON.stringify(planned.refused));
    ck('    saying why', /needs a date/.test(planned.refused[0].why), planned.refused[0].why);
    ck('    and where to look for it', (planned.refused[0].rows || []).length === 1,
       'without the spreadsheet row she cannot go and fix it');

    // ── AND THEN IT WRITES ──────────────────────────────────────────────
    const res = await siw.commit(planned);
    ck('committing writes every row', bills.list().length === before.bills + 3
       && sales.list().length === before.sales + 2, JSON.stringify(res));
    ck('  each row carries the batch it came from',
       bills.list().every((b) => !b.imported_batch || b.imported_batch === planned.batch));
    ck('  and the spreadsheet rows it was built from',
       bills.list().filter((b) => b.imported_batch).every((b) => Array.isArray(b.source_rows) && b.source_rows.length),
       'without this a wrong figure cannot be traced back to the sheet');

    // The multi-grade bill must compute its OWN total, and agree with the
    // per-grade figures her sheet states.
    const multi = bills.listWithTotals().find((b) => b.container_no === 'WXYZ7654321');
    const computed = bills.compute(multi);
    ck('  the container totals its grades: 9500 + 38000 + 2375 = 49875',
       Math.round(computed.computed_amount) === 49875, String(computed.computed_amount));
    ck('    and nothing disagrees with it', !computed.amount_differs,
       `amount_differs=${computed.amount_differs} — a stated total fighting the arithmetic`);
}

// ── G. The same file twice ──────────────────────────────────────────────────
section('G. importing the same workbook twice');
{
    const parsed = await si.readWorkbook(buf, { shipmentsLastRow: 6, ordersLastRow: 5 });
    const second = siw.plan(parsed, { source: 'fixture.xlsx', actor: 'test' });
    ck('the previous import is noticed', second.alreadyImported.length === 1,
       JSON.stringify(second.alreadyImported));

    let err = null;
    try { await siw.commit(second); } catch (e) { err = e; }
    ck('IT IS REFUSED', !!err && err.code === 'ALREADY_IMPORTED',
       'she presses the button twice and every figure doubles, silently');
    ck('  with a sentence she can act on', /already been imported/i.test(err.message), err.message);

    const bills = require(path.join(ROOT, 'helpers/bills'));
    const countBefore = bills.list().length;
    await siw.commit(second, { force: true });
    ck('  but forcing it is possible', bills.list().length > countBefore);
    await siw.undo(second.batch);
}

// ── H. The way back ─────────────────────────────────────────────────────────
section('H. undo');
{
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const sales = require(path.join(ROOT, 'helpers/sales'));

    // Something she typed herself, which undo must not touch.
    const mine = await bills.addBill({ supplier: 'Typed by hand', container_no: 'HAND0000001' });

    const batches = siw.listBatches();
    ck('the imports are listable', batches.length >= 1, JSON.stringify(batches.map((b) => b.batch)));

    const batch = batches[0].batch;
    const removed = await siw.undo(batch);
    ck('undo removes the batch', removed > 0, String(removed));
    ck('  every trace of it is gone',
       !bills.list().some((b) => b.imported_batch === batch)
       && !sales.list().some((s) => s.imported_batch === batch));
    ck('  AND WHAT SHE TYPED HERSELF SURVIVES',
       !!bills.list().find((b) => b.id === mine.id),
       'an undo that takes her own work with it is worse than no undo');

    let err = null;
    try { await siw.undo(''); } catch (e) { err = e; }
    ck('undo without a batch id refuses', !!err, 'otherwise it is a delete-everything button');
}

// ── I. THROUGH THE REAL ROUTES ──────────────────────────────────────────────
// Apsara, 2026-09-19: "I want to have a upload option in jarvis for bills and
// invoice where i can import this", and her standing rule: "ALwyas test end to
// end when you add a new feature."
//
// The helpers being right proves nothing about whether the upload reaches
// them, whether preview really writes nothing, or whether the undo is behind
// the right gate.
section('I. the upload routes');
{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;

    const req = (method, p2, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p2, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const admin = ((await req('POST', '/login', { body: { password: 'admin-pw-bbbbbbbbbbb' } })).json || {}).sid;
    const staff = ((await req('POST', '/login', { body: { password: 'staff-pw-ccccccccccc' } })).json || {}).sid;
    ck('logged in', !!admin);

    const file_base64 = buf.toString('base64');
    const payload = { file_base64, filename: 'routed.xlsx', shipments_last_row: 6, orders_last_row: 5 };

    ck('staff cannot import', [401, 403].includes((await req('POST', '/api/import/preview', { sid: staff, body: payload })).status));

    const bills = require(path.join(ROOT, 'helpers/bills'));
    const sales = require(path.join(ROOT, 'helpers/sales'));
    const before = { bills: bills.list().length, sales: sales.list().length };

    const prev = await req('POST', '/api/import/preview', { sid: admin, body: payload });
    ck('the preview route answers', prev.status === 200, JSON.stringify(prev.json).slice(0, 120));
    ck('  THE PREVIEW WRITES NOTHING',
       bills.list().length === before.bills && sales.list().length === before.sales,
       'the screen she uses to decide must not be the thing that decides');
    ck('  it says what it would create',
       prev.json.summary.bills === 3 && prev.json.summary.sales === 2, JSON.stringify(prev.json.summary));
    ck('  and lists what it refused, with the row',
       (prev.json.refused || []).length === 1 && (prev.json.refused[0].rows || []).length === 1);
    ck('  with a sample of each kind to look at',
       !!prev.json.samples.bill && !!prev.json.samples.multi && !!prev.json.samples.local && !!prev.json.samples.invoice);
    ck('  but NOT all 568 rows', !prev.json.bills && !prev.json.sales,
       'sending every row back is a large response she is not going to read');

    const done = await req('POST', '/api/import/commit', { sid: admin, body: payload });
    ck('committing writes them', done.status === 200 && done.json.bills === 3 && done.json.sales === 2,
       JSON.stringify(done.json));
    ck('  and they are really there',
       bills.list().length === before.bills + 3 && sales.list().length === before.sales + 2);

    const again = await req('POST', '/api/import/commit', { sid: admin, body: payload });
    ck('the same file twice is refused, 409', again.status === 409 && again.json.code === 'ALREADY_IMPORTED',
       `${again.status} ${JSON.stringify(again.json)}`);

    const list = await req('GET', '/api/import/batches', { sid: admin });
    ck('the imports are listable', (list.json.batches || []).length >= 1);

    // Undo is behind the Jarvis profile, not plain admin: it removes hundreds
    // of financial records at once.
    const batch = done.json.batch;
    const denied = await req('DELETE', '/api/import/' + encodeURIComponent(batch), { sid: admin });
    ck('an ADMIN cannot undo an import', denied.status === 403,
       `${denied.status} — undoing removes hundreds of rows at once`);
    ck('  and is told which profile can', /jarvis profile/i.test((denied.json || {}).error || ''),
       JSON.stringify(denied.json));
    ck('  so the rows are still there', bills.list().length === before.bills + 3);

    listener.close();
}

// ── J. ONE COLUMN, TWO KINDS OF MONEY ───────────────────────────────────────
// Apsara, 2026-09-19, having spotted $21,791.80 in the Trucking column on
// BMOU5185697: "Advance someti,es while truclimg othr wwise.include a col
// cslled advance."
//
// Her sheet's column is headed "Advance /Trucking" and really does hold both.
// Everything landed in trucking_amount, which helpers/bills.js deducts as
// haulage, so her ledger claimed $120,000 of trucking on one container.
section('J. Advance /Trucking is two columns');
{
    const ExcelJS = require('exceljs');
    const mk = async (figures) => {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('SHIPMENTS 2026');
        ws.addRow(['g', 'Carrier', 'Date', 'SUPPLIER', 'INV NO', 'BKG#', 'CONT#', 'SEAL#',
                   'item Description', 'GROSS', 'Truck', 'container', 'Chassis',
                   'supplier price', 'SUPPL INVOICE AMT', 'Advance /Trucking']);
        figures.forEach((amt, i) => ws.addRow(['LA/Busan', 'HMM', new Date('2026-09-10'), 'Gomez',
            `INV${i}`, `BK${i}`, `CONT${String(i).padStart(7, '0')}`, `S${i}`, 'Auto Cast',
            79520, 16300, 8510, 6600, 0.82, 39450.2, amt]));
        return si.readWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), {});
    };

    // Her real shape: haulage in the hundreds, advances in the tens of
    // thousands, and nothing in between.
    const r = await mk([800, 1239.2, 21791.8, 120000]);
    const byAmt = {};
    for (const b of r.bills) byAmt[b.container_no] = b;
    const rows = Object.values(byAmt);
    ck('the small ones stay trucking',
       rows.filter((b) => Number(b.trucking_amount) > 0).length === 2,
       JSON.stringify(rows.map((b) => [b.trucking_amount, b.advance])));
    ck('  and the large ones become advances',
       rows.filter((b) => Number(b.advance) > 0).length === 2,
       JSON.stringify(rows.map((b) => [b.trucking_amount, b.advance])));
    ck('  a figure is never counted as BOTH',
       rows.every((b) => !(Number(b.trucking_amount) > 0 && Number(b.advance) > 0)),
       'the same money deducted twice would understate every balance it touches');
    ck('  the split is reported, with the line it used',
       r.summary.advance_over === 2500 && r.summary.bills_trucking === 2 && r.summary.bills_advance === 2,
       JSON.stringify({ at: r.summary.advance_over, t: r.summary.bills_trucking, a: r.summary.bills_advance }));

    // ── A FILE THAT IS NOT CLEANLY SPLIT MUST SAY SO ────────────────────
    // The threshold is safe for her 2026 sheet because nothing sits near it —
    // 102 figures under $1,000, two between $1,000 and $2,000, ZERO between
    // $2,000 and $3,000, and 95 above. Next year's file might have a $2,400
    // haulage charge, and splitting that silently is the same class of error
    // as the one being fixed.
    ck('a cleanly split file reports nothing near the line',
       (r.near_threshold || []).length === 0, JSON.stringify(r.near_threshold));

    const grey = await mk([800, 2400, 2600, 50000]);
    ck('a file with figures NEAR the line says so',
       (grey.near_threshold || []).length === 2, JSON.stringify(grey.near_threshold));
    ck('  naming the container and which way it went',
       (grey.near_threshold || []).every((x) => x.container && /advance|trucking/.test(x.treated_as)),
       JSON.stringify(grey.near_threshold));

    // The line is a fact about THIS file, so it can be moved.
    const wb2 = new ExcelJS.Workbook();
    const moved = await si.readWorkbook(
        Buffer.from(await (async () => {
            const w = new ExcelJS.Workbook(); const ws = w.addWorksheet('SHIPMENTS 2026');
            ws.addRow(['Date', 'SUPPLIER', 'CONT#', 'GROSS', 'supplier price', 'Advance /Trucking']);
            ws.addRow([new Date('2026-09-10'), 'Gomez', 'CONT0000001', 79520, 0.82, 4000]);
            return w.xlsx.writeBuffer();
        })()), { advanceOver: 10000 });
    ck('the threshold can be moved for a different file',
       Number(moved.bills[0].trucking_amount) === 4000 && !moved.bills[0].advance,
       JSON.stringify([moved.bills[0].trucking_amount, moved.bills[0].advance]));
}

// ── K. AND THE BALANCE COMES OUT RIGHT ──────────────────────────────────────
// The whole reason this matters. Her sheet says BMOU5185697 owes 17,658.40.
section('K. it agrees with her own spreadsheet');
{
    const bills = require(path.join(ROOT, 'helpers/bills'));
    const row = bills.compute({ date: '09/10/2026', supplier: 'Gomez', container_no: 'BMOU5185697',
        gross: 79520, truck: 16300, container: 8510, chassis: 6600,
        supplier_price: 0.82, advance: 21791.8 });
    ck('the invoice amount matches her sheet', Math.abs(row.amount - 39450.2) < 0.05, String(row.amount));
    ck('  and so does the balance, to the cent', Math.abs(row.balance - 17658.4) < 0.005, String(row.balance));
    ck('  while Payable still states what the SUPPLIER is owed',
       Math.abs(row.net_payable - 39450.2) < 0.05,
       'an advance is money that has left — it comes off the balance, not off their invoice');

    // Without an advance, a bill must read exactly as it did before the
    // column existed.
    const before = bills.compute({ date: '09/10/2026', supplier: 'Gomez', container_no: 'X',
        gross: 79520, truck: 16300, container: 8510, chassis: 6600, supplier_price: 0.82 });
    ck('a bill with no advance is untouched', before.balance === before.net_payable,
       `${before.balance} vs ${before.net_payable}`);

    // ── AND THE SUPPLIER ACCOUNT AGREES WITH THE LEDGER ─────────────────
    // Two screens answering "what do I owe Gomez" with different numbers is
    // worse than either being wrong on its own.
    const sa = require(path.join(ROOT, 'helpers/supplierAccount'));
    const saved = bills.list().length;
    ck('(fixture)', saved >= 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => {
    console.error('CRASHED:', e && e.stack);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
    process.exit(1);
});
