// ── tests/ledger-export.js ──────────────────────────────────────────────────
// Apsara, 2026-09-19: "Add export option to bill and invoice-export as xls and
// pdf". Asked what the file should contain, she chose: exactly what is on
// screen — the current filters, the same columns in the same order, and the
// totals row.
//
// ── SO "EXACTLY" IS THE THING BEING TESTED ──────────────────────────────────
// Not "does a file come out". A file comes out either way. What matters is
// whether the file and the screen agree, and the ways they can stop agreeing
// are specific: a filter dropped on the way to the export, a column order
// re-derived instead of reused, a totals row computed over every row while the
// table shows twelve.
//
// ── AND THAT THE SPREADSHEET HOLDS NUMBERS ──────────────────────────────────
// "$12,345.67" in a cell is TEXT. It will not sum, sort or chart, and adding a
// column up is the first thing anyone does with an exported ledger. A test
// that only checked the cell "looks right" would pass on the useless version.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-export-'));
process.env.JARVIS_TEST = '1';
process.env.ADMIN_PASSWORD = 'admin-pw-eeeeeeeeeee';
process.env.STAFF_PASSWORD = 'staff-pw-fffffffffff';

const ROOT = path.join(__dirname, '..');
const le = require(path.join(ROOT, 'helpers/ledgerExport'));
const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));

(async () => {

// Three bills, two suppliers — so a filter has something to remove.
await bills.addBill({ date: '09/10/2026', supplier: 'Eccomelt', carrier: 'MSC',
    booking_no: 'B1', container_no: 'AAAU1111111', route: 'HOUSTON / BUSAN',
    gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
    supplier_price: 0.32, price_unit: 'lb' });
await bills.addBill({ date: '09/11/2026', supplier: 'Eccomelt', carrier: 'MSC',
    booking_no: 'B2', container_no: 'BBBU2222222', route: 'HOUSTON / BUSAN',
    gross: 46000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
    supplier_price: 0.31, price_unit: 'lb' });
await bills.addBill({ date: '09/12/2026', supplier: 'Oakland Metals', carrier: 'HMM',
    booking_no: 'B3', container_no: 'CCCU3333333', route: 'OAKLAND / BUSAN',
    gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 400,
    supplier_price: 700, price_unit: 'mt' });
await sales.addSale({ date: '09/12/2026', customer: 'Aris Enterprises USA LLC',
    invoice_no: '260918_AP_26Aris02', container_no: 'MSDU2726332',
    weight: 23.693, invoice_price: 1208 });

// ── A. WHAT IS ON SCREEN IS WHAT IS IN THE FILE ─────────────────────────────
section('A. the export is the view');
{
    const all = le.build('bills', {});
    ck('with no filters it is every row', all.rows.length === 3, String(all.rows.length));

    const one = le.build('bills', { supplier: 'Oakland Metals' });
    ck('a filter narrows it', one.rows.length === 1, String(one.rows.length));
    ck('  and it says what it narrowed BY, on the file itself',
       one.filters.join(';') === 'supplier: Oakland Metals', one.filters.join(';'));
    ck('  while still saying how many there were in total',
       one.total_unfiltered === 3, String(one.total_unfiltered));

    // ── THE TOTALS DESCRIBE THE FILTERED ROWS ───────────────────────────
    // The /api/bills route says why: a summary adding up rows that are not on
    // the page is a balance belonging to a different set of bills, which is
    // worse than no totals row at all. That property has to survive the trip
    // into a file, where nobody can see the table it disagrees with.
    ck('the totals are of the FILTERED rows, not all of them',
       one.summary.net_lb === all.rows.find((r) => r.supplier === 'Oakland Metals').net_lb,
       `${one.summary.net_lb} vs ${all.summary.net_lb} for all three`);

    // ── COLUMNS COME FROM THE STORE, NOT A SECOND LIST ──────────────────
    // A column added to bills.js must appear in the export without anyone
    // remembering to add it here. Compared against tableColumns() itself,
    // which is what the table is drawn from.
    ck('the columns are the table\'s columns, in the table\'s order',
       all.columns.map((c) => c.key).join(',') === bills.tableColumns().filter(Boolean).map((c) => c.key).join(','));

    const inv = le.build('sales', {});
    ck('the Invoice register exports too', inv.rows.length === 1 && inv.title === 'Invoice register',
       `${inv.rows.length} / ${inv.title}`);
    ck('  with the sales columns, not the bills ones',
       inv.columns.map((c) => c.key).join(',') === sales.tableColumns().filter(Boolean).map((c) => c.key).join(','));
}

// ── B. THE SPREADSHEET HOLDS NUMBERS ────────────────────────────────────────
section('B. the workbook is usable, not a picture');
{
    const ExcelJS = require('exceljs');
    const built = le.build('bills', {});
    const buf = await le.toWorkbook(built, { when: 'TEST-TIME' });
    ck('a workbook comes out', Buffer.isBuffer(buf) && buf.length > 4000, String(buf && buf.length));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    ck('  with one sheet, named for the ledger', wb.worksheets.length === 1 && /Purchase bills/.test(ws.name), ws.name);

    // Find the header row rather than assuming row 5 — a title block that
    // grows by a line should not silently shift every later assertion onto
    // the wrong row, which is how a test starts passing against nothing.
    //
    // Found by matching the FIRST COLUMN'S OWN LABEL, whatever it is. The
    // first version looked for "Date" and the first column is
    // "Source/Destination", so it found nothing and three checks failed
    // before the suite crashed on a column index of 0. Hard-coding a label
    // here would be a second copy of the column order, which is the exact
    // thing this file exists to prevent.
    const firstLabel = built.columns[0].label;
    let headRow = 0;
    ws.eachRow((r, n) => { if (!headRow && String(r.getCell(1).value || '') === firstLabel) headRow = n; });
    ck('  the header row is found', headRow > 0, `no row starts with "${firstLabel}"`);

    const heads = [];
    ws.getRow(headRow).eachCell((c) => heads.push(String(c.value || '')));
    ck('  headers match the table exactly',
       heads.join(',') === built.columns.map((c) => c.label).join(','), heads.join(','));
    ck('  and they are frozen, or they scroll away on a 492-row sheet',
       (ws.views[0] || {}).state === 'frozen' && ws.views[0].ySplit === headRow,
       JSON.stringify(ws.views[0]));

    const col = (name) => heads.indexOf(name) + 1;
    const body = ws.getRow(headRow + 1);
    const amountCell = body.getCell(col(built.columns.find((c) => c.key === 'amount').label));
    ck('MONEY IS A NUMBER, not "$12,345.67"', typeof amountCell.value === 'number',
       `${typeof amountCell.value} — a text cell will not sum, and summing is the first thing anyone does`);
    ck('  shown as money by its format', /\$#,##0\.00/.test(amountCell.numFmt || ''), amountCell.numFmt);

    const grossCell = body.getCell(col(built.columns.find((c) => c.key === 'gross').label));
    ck('weights are numbers too', typeof grossCell.value === 'number', typeof grossCell.value);

    // ── THE UNIT TRAVELS WITH THE PRICE ─────────────────────────────────
    // She prices some suppliers by the pound and some by the tonne, so the
    // unit is per ROW and a column header cannot carry it. A bare 0.32 is a
    // figure someone multiplies by 2204 in good faith.
    const priceLabel = built.columns.find((c) => c.key === 'supplier_price').label;
    const rowsBySupplier = {};
    ws.eachRow((r, n) => {
        if (n <= headRow) return;
        const sup = String(r.getCell(col(built.columns.find((c) => c.key === 'supplier').label)).value || '');
        if (sup) rowsBySupplier[sup] = r;
    });
    const perLb = rowsBySupplier['Eccomelt'] && rowsBySupplier['Eccomelt'].getCell(col(priceLabel));
    const perMt = rowsBySupplier['Oakland Metals'] && rowsBySupplier['Oakland Metals'].getCell(col(priceLabel));
    ck('a per-pound price says /lb', perLb && /\/lb/.test(perLb.numFmt || ''), perLb && perLb.numFmt);
    ck('  and a per-tonne one says /MT', perMt && /\/MT/.test(perMt.numFmt || ''), perMt && perMt.numFmt);
    ck('  both still being numbers', typeof (perLb || {}).value === 'number' && typeof (perMt || {}).value === 'number');

    // ── THE TOTALS ROW ──────────────────────────────────────────────────
    let totalRow = null;
    ws.eachRow((r) => { r.eachCell((c) => { if (String(c.value || '') === 'TOTAL') totalRow = r; }); });
    ck('there is a TOTAL row', !!totalRow);
    ck('  and it agrees with the summary the screen shows',
       totalRow && totalRow.getCell(col(built.columns.find((c) => c.key === 'net_lb').label)).value === built.summary.net_lb,
       totalRow && String(totalRow.getCell(col(built.columns.find((c) => c.key === 'net_lb').label)).value));
    ck('  and the word TOTAL did not land on top of a figure',
       totalRow && !built.columns.some((c, i) =>
           String(totalRow.getCell(i + 1).value || '') === 'TOTAL'
           && Object.prototype.hasOwnProperty.call(built.summary, c.key)),
       'a label written over a total is a total silently deleted');

    // Filters are stated IN the file. A filtered export found in six months
    // with no note of what it excluded is a misleading document.
    const filtered = await le.toWorkbook(le.build('bills', { supplier: 'Oakland Metals' }), { when: 'T' });
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(filtered);
    let saidSo = false;
    wb2.worksheets[0].eachRow((r) => { if (/filtered by supplier: Oakland Metals/.test(String(r.getCell(1).value || ''))) saidSo = true; });
    ck('a filtered file says so on its face', saidSo);
}

// ── C. THE PDF ──────────────────────────────────────────────────────────────
section('C. the printed ledger');
{
    const built = le.build('bills', {});
    const html = le.toHtml(built, { when: 'TEST-TIME' });
    const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const text = strip(html);

    ck('every row is on it', built.rows.every((r) => text.includes(r.container_no)),
       'a printed ledger missing rows is worse than no printed ledger');
    ck('  with the totals', /TOTAL/.test(text));
    ck('  and the money formatted, not raw', /\$[\d,]+\.\d\d/.test(text), text.slice(0, 200));
    ck('  the price carrying its unit', /\/lb/.test(text) && /\/MT/.test(text));

    // ── thead REPEATS ───────────────────────────────────────────────────
    // 492 bills is many pages. Columns named only on page one is a table
    // nobody can read past page one.
    ck('the header repeats on every page', /thead\s*\{\s*display:\s*table-header-group/.test(html),
       'the columns would be named on page 1 only');
    ck('  and rows are not split across a page break', /page-break-inside:\s*avoid/.test(html));
    ck('  landscape, because a bills row has eighteen columns', /size:\s*A4 landscape/.test(html));

    // ── IT DOES NOT GO THROUGH THE ONE-PAGE FITTER ──────────────────────
    // That fitter exists so an INVOICE does not spill a near-empty second
    // page. A 492-row ledger squeezed onto one sheet is unreadable.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/ledgerExport.js'), 'utf8');
    ck('the ledger PDF does NOT use the one-page fitter', !/pdfFittedToOnePage\s*\(/.test(src),
       'the whole ledger would be scaled down to fit one sheet');
    // ── BUT IT DOES GO THROUGH THE QUEUE ────────────────────────────────
    // This is the largest render in the app, so the reason pdfQueue exists —
    // two people generating at once — applies here more than anywhere.
    ck('  but it DOES take a slot in the PDF queue', /require\('\.\/pdfQueue'\)\.run\(/.test(src),
       'the biggest render in the app would launch a Chromium beside every other one');

    let handed = null;
    // The same `when` as the html above, or the two differ by a timestamp and
    // the comparison fails for a reason that has nothing to do with the
    // renderer — which is exactly what it did the first time.
    const out = await le.toPdf(built, { when: 'TEST-TIME',
        renderer: async (h) => { handed = h; return Buffer.from('%PDF stub'); } });
    ck('an injected renderer is used, so this is testable without Chromium',
       Buffer.isBuffer(out) && handed === html,
       handed === null ? 'the renderer was never called' : 'it rendered something else');

    // An empty view still produces a document that says it is empty, rather
    // than a blank page that looks like a failed export.
    const none = le.toHtml(le.build('bills', { supplier: 'Nobody At All' }), { when: 'T' });
    ck('an empty view prints "nothing matches", not a blank page',
       /Nothing matches these filters/.test(none));
}

// ── D. THROUGH THE REAL ROUTE ───────────────────────────────────────────────
// Apsara's rule: "ALwyas test end to end when you add a new feature." The
// helper being right proves nothing about whether the route reaches it, passes
// the filters through, or names the file something openable.
section('D. the export routes');
{
    const http = require('http');
    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${listener.address().port}`;

    const get = (p2, sid) => new Promise((resolve, reject) => {
        const r2 = http.request(base + p2, { method: 'GET',
            headers: sid ? { Authorization: `Bearer ${sid}` } : {} }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                                          body: Buffer.concat(chunks) }));
        });
        r2.on('error', reject); r2.end();
    });
    const post = (p2, body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const r2 = http.request(base + p2, { method: 'POST', headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve(j); });
        });
        r2.on('error', reject); r2.write(data); r2.end();
    });

    const admin = ((await post('/login', { password: 'admin-pw-eeeeeeeeeee' })) || {}).sid;
    const staff = ((await post('/login', { password: 'staff-pw-fffffffffff' })) || {}).sid;
    ck('logged in', !!admin);

    const xl = await get('/api/bills/export?format=xlsx', admin);
    ck('the xlsx route answers', xl.status === 200, String(xl.status));
    ck('  with a real workbook, not JSON',
       xl.body.slice(0, 2).toString('binary') === 'PK', xl.body.slice(0, 40).toString('binary'));
    ck('  offered as a download, not rendered in the tab',
       /attachment/.test(xl.headers['content-disposition'] || ''), xl.headers['content-disposition']);
    // .xlsx even when she says "xls": the file IS a modern workbook, and
    // naming it .xls makes Excel warn about the contents on every open.
    ck('  named .xlsx', /filename="Bills_\d{4}-\d{2}-\d{2}\.xlsx"/.test(xl.headers['content-disposition'] || ''),
       xl.headers['content-disposition']);
    ck('  and the spreadsheet content-type, so Excel opens it',
       /spreadsheetml/.test(xl.headers['content-type'] || ''), xl.headers['content-type']);

    const asXls = await get('/api/bills/export?format=xls', admin);
    ck('asking for "xls" still gets a working workbook', asXls.status === 200
       && asXls.body.slice(0, 2).toString('binary') === 'PK');

    // ── THE FILTERS REACH THE FILE ──────────────────────────────────────
    // The single most likely way this feature is wrong: the button builds a
    // URL the route ignores, and she sends someone the whole ledger believing
    // it is one supplier's.
    const ExcelJS = require('exceljs');
    const narrowed = await get('/api/bills/export?format=xlsx&supplier=' + encodeURIComponent('Oakland Metals'), admin);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(narrowed.body);
    let dataRows = 0, sawEccomelt = false;
    wb.worksheets[0].eachRow((r) => {
        // A data row is one whose Date cell holds a date — located by label,
        // not by position, for the same reason as above.
        const heads2 = [];
        wb.worksheets[0].getRow(1).eachCell(() => {});
        const dateAt = (() => {
            let at = 0;
            wb.worksheets[0].eachRow((rr) => {
                if (at) return;
                rr.eachCell((c, i) => { if (String(c.value || '') === 'Date') at = i; });
            });
            return at;
        })();
        const first = dateAt ? String(r.getCell(dateAt).value || '') : '';
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(first)) dataRows += 1;
        r.eachCell((c) => { if (String(c.value || '') === 'Eccomelt') sawEccomelt = true; });
    });
    ck('a filtered export really is filtered', dataRows === 1 && !sawEccomelt,
       `${dataRows} data row(s), Eccomelt present: ${sawEccomelt}`);
    ck('  and its filename says it was', /_filtered\.xlsx/.test(narrowed.headers['content-disposition'] || ''),
       narrowed.headers['content-disposition']);

    const inv = await get('/api/sales/export?format=xlsx', admin);
    ck('the Invoice register exports through its own route', inv.status === 200
       && /filename="Invoices_/.test(inv.headers['content-disposition'] || ''),
       inv.headers['content-disposition']);

    const bad = await get('/api/bills/export?format=csv', admin);
    ck('an unknown format is refused clearly, not silently', bad.status === 400
       && /xlsx or pdf/.test((JSON.parse(bad.body.toString() || '{}') || {}).error || ''),
       bad.body.toString().slice(0, 120));

    // The ledger in one file cannot be looser than reading the table, and
    // staff are deliberately kept off the money screens.
    const denied = await get('/api/bills/export?format=xlsx', staff);
    ck('staff cannot export the ledger', [401, 403].includes(denied.status), String(denied.status));

    listener.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
