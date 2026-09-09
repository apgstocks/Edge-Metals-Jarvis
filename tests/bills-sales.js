// ── tests/bills-sales.js ──────────────────────────────────────────────────
// Apsara, 2026-09-09: "This is for edge metals not for edge yard. now i want
// to build a bill tab which contains Source/Destination,Carrier,TRUCKING,
// Date,SUPPLIER,Invoice no,Booking no,Container no,Seal no,item Description,
// GROSS,Truck,container,Chassis,Boxes,Total,Net weight(lbs),Net weight(MT),
// supplier price,Supplier invoice amount,Trucking,Advance,Balance in one tab..
// In sales tab-i want customer name,date,invoice number,HBL number,Proforma
// date,Reference,weight,invoice price,invoice amount,Freight charges"
//
// And her three answers when asked how the numbers should work:
//   "Net = Gross − (Truck+Container+Chassis+Boxes)"
//   "if price is in cents or less than 10 dollars,go with net lbs*price else
//    net mt*price"
//   "Amount − Trucking − Advance"
//
// WHY THIS FILE EXISTS AT ALL, stated plainly: helpers/bills.js sat on disk
// for a day with correct arithmetic and NOTHING IMPORTING IT. No routes, no
// tab, no tests. The arithmetic being right is not the same as the feature
// existing, and a test that only calls compute() would have been green
// throughout. So the routes are driven here, not just the helpers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bills-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';
process.env.APP_PASSWORD    = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD  = 'admin-pw-bbbbbbbbbbb';
process.env.STAFF_PASSWORD  = 'staff-pw-ccccccccccc';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.BILLS_FILE).startsWith(TMP) || !String(cfg.SALES_FILE).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated'); process.exit(1);
}

// A booking to pre-fill from. Seeded here rather than read from her live
// bookings.json — a test whose fixture is her real data passes or fails
// depending on what shipped that week.
fs.writeFileSync(cfg.BOOKINGS_FILE, JSON.stringify({
    '272766480': {
        booking_number: '272766480',
        carrier: 'MAERSK LINES, INC.',
        port_of_loading: 'HOUSTON', port_of_discharge: 'BUSAN',
        erd_date: '07/15/2026', cutoff_date: '07/20/2026',
        containers: [{ seq: 1, size: '40HC', container_number: 'MSKU1234567',
                       supplier: 'Eccomelt', trucker: 'Bayou Haulage' }],
    },
}, null, 2));

const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));
const { createApi } = require(path.join(ROOT, 'api'));

let server, base;
function req(method, urlPath, { sid, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + urlPath, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null; try { json = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, json, raw });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const login = (password) => req('POST', '/login', { body: { password } });

(async () => {

section('A — her formulas, exactly as she gave them');
{
    // 44,000 gross with 29,500 of tares. Her formula: Net = Gross − (Truck +
    // Container + Chassis + Boxes).
    const b = bills.compute({ gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
                              supplier_price: 0.32, trucking_amount: 1200, advance: 2000 });
    ck('Total is the four tares added up', b.total === 29500, String(b.total));
    ck('  Net (lbs) is gross minus that', b.net_lb === 14500, String(b.net_lb));
    ck('  Net (MT) is lbs over 2204.62262', b.net_mt === 6.577, String(b.net_mt));
    ck('  a price under $10 is read as per POUND', b.price_unit === 'lb', String(b.price_unit));
    ck('  so the amount is net_lb x price', b.amount === 4640, String(b.amount));
    // Her words: "Amount − Trucking − Advance".
    ck('  Balance is amount minus trucking minus advance', b.balance === 1440, String(b.balance));

    // ── THE $10 BOUNDARY, BOTH SIDES ─────────────────────────────────────
    // This is the assertion that matters most in the file. lbs and MT differ
    // by a factor of 2204, so reading the unit wrong does not shade a total
    // by a few percent — it produces a figure wrong by three orders of
    // magnitude, in a column she pays from.
    const at = (p) => bills.compute({ gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500, supplier_price: p });
    ck('$9.99 is still per pound', at(9.99).price_unit === 'lb', String(at(9.99).price_unit));
    ck('  $10.00 crosses to per MT', at(10).price_unit === 'mt', String(at(10).price_unit));
    ck('  $0.32 is per pound', at(0.32).price_unit === 'lb');
    ck('  $700 is per MT', at(700).price_unit === 'mt');
    ck('  and per-MT does the other multiplication',
       at(700).amount === 4603.9, String(at(700).amount));
    // The override, for the day she really does buy at $8/MT.
    ck('  an explicit price_unit beats the guess',
       bills.compute({ gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
                       supplier_price: 8, price_unit: 'mt' }).price_unit === 'mt',
       'the magnitude rule is a good heuristic and still a guess about money');
}

section('B — what it refuses to do');
{
    // A missing tare is NOT a zero tare. Treating the gap as 0 silently
    // inflates the net weight and therefore the amount.
    const b = bills.compute({ gross: 44000, truck: 15000, supplier_price: 0.32 });
    ck('a missing tare is reported, not treated as zero',
       b.missing_tares.join(',') === 'container,chassis,boxes', JSON.stringify(b.missing_tares));
    ck('  the row is still totalled on what IS there', b.total === 15000 && b.net_lb === 29000);

    const empty = bills.compute({});
    ck('nothing typed gives nulls, never zeros',
       empty.net_lb === null && empty.amount === null && empty.balance === null,
       JSON.stringify(empty));
    ck('  and no price means no unit is claimed', empty.price_unit === null);

    // The supplier's invoice is the document of record.
    const stated = bills.compute({ gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
                                   supplier_price: 0.32, supplier_invoice_amount: 4700 });
    ck('an amount she typed WINS over the computed one', stated.amount === 4700);
    ck('  but the disagreement is reported, not hidden',
       stated.amount_differs === 60 && stated.computed_amount === 4640,
       JSON.stringify({ d: stated.amount_differs, c: stated.computed_amount }));
}

section('C — sales, and the one place the $10 rule lives');
{
    const s = sales.compute({ weight: 29000, invoice_price: 0.41, freight_charges: 1500 });
    ck('a five-figure weight is read as pounds', s.weight_unit === 'lb', String(s.weight_unit));
    ck('  and converted for the MT column', s.weight_mt === 13.154, String(s.weight_mt));
    ck('  amount is weight x price', s.amount === 11890, String(s.amount));
    ck('  net of freight comes off the top', s.net_of_freight === 10390, String(s.net_of_freight));
    ck('  a weight she gives in MT is taken as MT',
       sales.compute({ weight: 19.96, weight_unit: 'mt' }).weight_mt === 19.96);

    // ── ONE THRESHOLD, NOT TWO ───────────────────────────────────────────
    // Scrap is quoted the same way whichever direction it moves. Two copies
    // of the $10 rule is two chances to drift, and the drift is a factor of
    // 2204 on an invoice.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/sales.js'), 'utf8');
    ck('sales imports the ceiling rather than restating it',
       /bills\.PER_LB_CEILING/.test(src) && !/=\s*10\b/.test(src.replace(/\/\/.*$/gm, '')),
       'a second copy of the threshold would drift, and the drift is x2204');
    ck('  and the two agree on the same weight and price',
       sales.compute({ weight: 14500, invoice_price: 0.32 }).amount
       === bills.compute({ gross: 14500, truck: 0, container: 0, chassis: 0, boxes: 0, supplier_price: 0.32 }).amount,
       'purchase and sale must not disagree about what a pound is');
}

section('D — her columns, in her order');
{
    // Checked against her message verbatim. A table built from a list that
    // has drifted from what she asked for is a table with a heading over the
    // wrong number.
    const wanted = ['Source/Destination', 'Carrier', 'Trucking', 'Date', 'Supplier', 'Invoice no',
        'Booking no', 'Container no', 'Seal no', 'Item description', 'Gross', 'Truck', 'Container',
        'Chassis', 'Boxes', 'Total', 'Net weight (lbs)', 'Net weight (MT)', 'Supplier price',
        'Supplier invoice amount', 'Trucking', 'Advance', 'Balance'];
    ck('the bill has all 23 columns she listed', bills.COLUMNS.length === 23, String(bills.COLUMNS.length));
    ck('  in her order', bills.COLUMNS.map((c) => c.label).join('|') === wanted.join('|'),
       bills.COLUMNS.map((c) => c.label).join('|'));
    ck('  with the six computed ones marked',
       bills.COLUMNS.filter((c) => c.derived).map((c) => c.key).join(',')
       === 'total,net_lb,net_mt,amount,balance', bills.COLUMNS.filter((c) => c.derived).map((c) => c.key).join(','));

    const sw = ['Customer name', 'Date', 'Invoice number', 'HBL number', 'Proforma date',
        'Reference', 'Weight', 'Invoice price', 'Invoice amount', 'Freight charges'];
    ck('the sale has all 10 she listed', sales.COLUMNS.length === 10, String(sales.COLUMNS.length));
    ck('  in her order', sales.COLUMNS.map((c) => c.label).join('|') === sw.join('|'),
       sales.COLUMNS.map((c) => c.label).join('|'));

    // A client that could post a balance not following from its own weights
    // is a client that can disagree with the server about money.
    ck('a client may not write the derived columns',
       !bills.WRITABLE.includes('balance') && !bills.WRITABLE.includes('net_lb')
       && !bills.WRITABLE.includes('total'), bills.WRITABLE.join(','));
    ck('  but CAN write the invoice amount, which is a document not a sum',
       bills.WRITABLE.includes('supplier_invoice_amount') && sales.WRITABLE.includes('invoice_amount'));
}

section('E — the routes, because a helper nothing calls is not a feature');
{
    const app = createApi();
    await new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;

    let r = await req('GET', '/api/bills', { sid: admin });
    ck('GET /api/bills answers', r.status === 200, String(r.status));
    ck('  and ships the columns with the data',
       Array.isArray(r.json.columns) && r.json.columns.length === 23,
       'the table is built from the server list, so the two cannot drift');

    r = await req('POST', '/api/bills', { sid: admin, body: {
        date: '2026-09-10', supplier: 'Eccomelt', booking_no: '272766480',
        gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
        supplier_price: 0.32, trucking_amount: 1200, advance: 2000 } });
    ck('POST /api/bills saves it', r.status === 200 && !!r.json.bill, r.raw.slice(0, 120));
    const billId = r.json.bill && r.json.bill.id;
    ck('  and the response carries the arithmetic',
       r.json.bill.net_lb === 14500 && r.json.bill.balance === 1440 && r.json.bill.price_unit === 'lb',
       JSON.stringify({ n: r.json.bill.net_lb, b: r.json.bill.balance }));

    // The derived columns are computed server-side even when a client tries
    // to send its own.
    r = await req('POST', '/api/bills', { sid: admin, body: {
        date: '2026-09-10', supplier: 'Liar Ltd', gross: 1000, truck: 100,
        container: 0, chassis: 0, boxes: 0, supplier_price: 1, balance: 999999, net_lb: 888888 } });
    ck('a client cannot post its own balance',
       r.json.bill.balance === 900 && r.json.bill.net_lb === 900,
       JSON.stringify({ b: r.json.bill.balance, n: r.json.bill.net_lb }));
    await req('DELETE', `/api/bills/${r.json.bill.id}`, { sid: admin });

    r = await req('GET', '/api/bills', { sid: admin });
    ck('  the list totals reconcile with the row',
       r.json.summary.count === 1 && r.json.summary.balance === 1440,
       JSON.stringify(r.json.summary));

    // ── PRE-FILL FROM THE BOOKING SHE PICKS ──────────────────────────────
    // Her answer: "Pick a booking, the rest fills in."
    r = await req('GET', '/api/bills/from-booking/272766480', { sid: admin });
    ck('a booking pre-fills the bill', r.status === 200 && !!r.json.prefill, r.raw.slice(0, 120));
    if (r.json.prefill) {
        ck('  carrier and route come off the booking',
           /MAERSK/i.test(r.json.prefill.carrier || '') && /HOUSTON/i.test(r.json.prefill.route || ''),
           JSON.stringify(r.json.prefill));
        // ── THE BUG THIS CAUGHT ──────────────────────────────────────────
        // helpers/booking.js:getBooking returns { booking, status }, not the
        // booking. Reading fields off the wrapper gives undefined for every
        // one of them — and the same mistake was sitting live in TWO places
        // in workflow/actions.js, where "Booking undefined: carrier —, ERD —,
        // cutoff —" was being handed to the email drafter. Asserted on real
        // values, not on the field merely existing.
        ck('  and the container and supplier too, from the container row',
           r.json.prefill.container_no === 'MSKU1234567'
           && r.json.prefill.supplier === 'Eccomelt'
           && r.json.prefill.trucking_company === 'Bayou Haulage',
           JSON.stringify(r.json.prefill));
        ck('  with the other containers offered rather than a second lookup',
           Array.isArray(r.json.containers) && r.json.containers.length === 1,
           JSON.stringify(r.json.containers));
        ck('  and it is a SUGGESTION — nothing was saved',
           (await req('GET', '/api/bills', { sid: admin })).json.summary.count === 1,
           'a pre-fill that writes a row is a row she did not ask for');
    }
    r = await req('GET', '/api/bills/from-booking/NOPE999', { sid: admin });
    ck('  an unknown booking says so rather than filling nothing silently', r.status === 404);

    r = await req('PUT', `/api/bills/${billId}`, { sid: admin, body: { seal_no: 'SEAL-1' } });
    ck('PUT patches one field', r.status === 200 && r.json.bill.seal_no === 'SEAL-1');
    ck('  without erasing the rest of the row',
       r.json.bill.supplier === 'Eccomelt' && r.json.bill.gross === 44000,
       'the editLoad lesson: rebuilding a record wholesale dropped pdf_link');

    // Sales, same shape.
    r = await req('POST', '/api/sales', { sid: admin, body: {
        date: '2026-09-10', customer: 'Daekwang', invoice_no: 'INV-1', hbl_no: 'HBL-9',
        proforma_date: '2026-09-01', reference: 'REF-7', weight: 29000,
        invoice_price: 0.41, freight_charges: 1500 } });
    ck('POST /api/sales saves it', r.status === 200 && !!r.json.sale, r.raw.slice(0, 120));
    ck('  with its arithmetic', r.json.sale.amount === 11890 && r.json.sale.net_of_freight === 10390,
       JSON.stringify({ a: r.json.sale.amount, n: r.json.sale.net_of_freight }));
    const saleId = r.json.sale.id;

    r = await req('GET', '/api/sales', { sid: admin });
    ck('  and GET ships its 10 columns', r.json.columns.length === 10, String(r.json.columns.length));

    // ── AND THEY ARE SEPARATE STORES ─────────────────────────────────────
    // "This is for edge metals not for edge yard." A sale here must not turn
    // up in the yard's loads, and vice versa.
    const yard = await req('GET', '/api/loads', { sid: admin });
    const yardRows = Array.isArray(yard.json) ? yard.json : (yard.json.loads || []);
    ck('an Edge Metals sale does not appear in the yard loads',
       !yardRows.some((l) => l.id === saleId),
       'ocean paperwork on a weighbridge ticket is what this separation prevents');

    r = await req('DELETE', `/api/sales/${saleId}`, { sid: admin });
    ck('DELETE removes it', r.status === 200
       && (await req('GET', '/api/sales', { sid: admin })).json.sales.length === 0);
    r = await req('DELETE', '/api/sales/NOPE', { sid: admin });
    ck('  and deleting nothing is an error, not a silent success', r.status >= 400);
}

section('F — who may see her supplier prices');
{
    const staff = (await login('staff-pw-ccccccccccc')).json.sid;
    // /api/bills and /api/sales are deliberately absent from
    // STAFF_ALLOWED_PATH_PREFIXES. These are supplier prices, customer
    // invoices and margins on the freight side — a different thing from the
    // yard paperwork staff own. Same reasoning that keeps /api/payments off.
    for (const p of ['/api/bills', '/api/sales']) {
        const r = await req('GET', p, { sid: staff });
        ck(`staff cannot read ${p}`, r.status === 403, String(r.status));
    }
    const w = await req('POST', '/api/bills', { sid: staff, body: { date: '2026-09-10', supplier: 'X' } });
    ck('  nor write one', w.status === 403, String(w.status));

    // The nav hides them too — UX only, the server above is the boundary.
    const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    ck('both tabs are registered under Operations',
       /\{ id: 'bills', label: 'Bills', group: 'Operations' \}/.test(html)
       && /\{ id: 'sales', label: 'Sales', group: 'Operations' \}/.test(html),
       'her answer when asked: "Both as new tabs under Operations"');
    ck('  and each one actually renders something',
       /if \(tab === 'bills'\) return renderLedgerTab\('bills'\)/.test(html)
       && /if \(tab === 'sales'\) return renderLedgerTab\('sales'\)/.test(html),
       'a nav entry with no branch is a tab that loads for ever');
    ck('  the table is built from the SERVER columns, not a second list here',
       /ledgerState\.columns|Array\.isArray\(data\.columns\)/.test(html)
       && !/Source\/Destination/.test(html),
       '23 hand-typed headings is 23 chances to put Chassis where Boxes goes');
    ck('  and the price cell shows its unit',
       /'\/lb'/.test(html) && /'\/MT'/.test(html),
       'her answer: "Yes — show \'/lb\' or \'/MT\' on the row"');
}

if (server) server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
