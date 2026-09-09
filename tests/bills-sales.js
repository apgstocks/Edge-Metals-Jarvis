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
    // TWO containers, because that is her case: "There might be two
    // containers under a booking. Container number will be different for
    // every load." One bill is one container.
    'DALA23991600': {
        booking_number: 'DALA23991600', carrier: 'HMM',
        port_of_loading: 'LOS ANGELES', port_of_discharge: 'BUSAN',
        containers: [
            { seq: 1, size: '40HC', container_number: 'HMMU1111111', supplier: 'Eccomelt', trucker: 'Sher Trucking' },
            { seq: 2, size: '40HC', container_number: 'HMMU2222222', supplier: 'Oakland Metals', trucker: 'Sher Trucking' },
        ],
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
                              supplier_price: 0.32, trucking_amount: 1200 });
    ck('Total is the four tares added up', b.total === 29500, String(b.total));
    ck('  Net (lbs) is gross minus that', b.net_lb === 14500, String(b.net_lb));
    ck('  Net (MT) is lbs over 2204.62262', b.net_mt === 6.577, String(b.net_mt));
    ck('  a price under $10 is read as per POUND', b.price_unit === 'lb', String(b.price_unit));
    ck('  so the amount is net_lb x price', b.amount === 4640, String(b.amount));
    // Her formula was "Amount − Trucking − Advance"; she removed Advance on
    // 2026-09-10, so it is Amount − Trucking.
    ck('  Balance is amount minus trucking', b.balance === 3440, String(b.balance));
    ck('  and Advance is gone entirely, not just hidden',
       !bills.COLUMNS.some((c) => c.key === 'advance') && !bills.WRITABLE.includes('advance')
       && !('advance' in bills.summary([])),
       'a column dropped from a form is still a number sitting in a record affecting a balance');

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
    // Her original list, less the two she changed her mind about on
    // 2026-09-10 — "Remove advance on this" and "i dont want carrier to be
    // displayed" — plus the one she added: "i want photos field where url can
    // be pasted."
    // "Trucker needs to there next to Trucking Amount in bill" (2026-09-10) —
    // so the haulier moved down from beside Carrier to sit with what the haul
    // cost, and took her own word as its name.
    // Photos moved to the END on 2026-09-10: "in bills post saving,i want
    // photo column to be there at the last."
    const wanted = ['Source/Destination', 'Date', 'Supplier', 'Invoice no',
        'Booking no', 'Container no', 'Seal no', 'Item description', 'Gross', 'Truck',
        'Container', 'Chassis', 'Boxes', 'Total', 'Net weight (lbs)', 'Net weight (MT)',
        'Supplier price', 'Supplier invoice amount', 'Trucker', 'Trucking', 'Balance',
        'Photos'];
    ck('the bill has her columns, less Advance and Carrier, plus Photos',
       bills.tableColumns().length === 22, String(bills.tableColumns().length));
    ck('  Carrier is off the table but still on the form',
       !bills.tableColumns().some((c) => c.key === 'carrier')
       && bills.COLUMNS.some((c) => c.key === 'carrier')
       && bills.WRITABLE.includes('carrier'),
       '"on bill after saving,i dont want carrier to be displayed.on edit it can be there"');
    ck('  and all five weights sit on one line',
       (bills.GROUPS.find((g) => g.id === 'weights') || {}).cols === 5,
       '"weights should be in single line" — the auto-fit grid wrapped them 4 + 1');
    ck('  in her order', bills.tableColumns().map((c) => c.label).join('|') === wanted.join('|'),
       bills.tableColumns().map((c) => c.label).join('|'));
    ck('  with Photos last', bills.tableColumns().slice(-1)[0].key === 'photos',
       '"in bills post saving,i want photo column to be there at the last"');
    // The list she is building as she types — supplier and item description
    // offer what is already on her bills.
    ck('  supplier and item description suggest from her own data',
       bills.COLUMNS.filter((c) => c.suggest).map((c) => c.key).sort().join(',') === 'description,supplier',
       bills.COLUMNS.filter((c) => c.suggest).map((c) => c.key).join(','));
    ck('    fed by facets, so a new one joins the list when the bill saves',
       Object.keys(bills.facets([{ supplier: 'X', description: 'Y' }])).includes('description'),
       JSON.stringify(Object.keys(bills.facets([]))));
    ck('  with the six computed ones marked',
       bills.COLUMNS.filter((c) => c.derived).map((c) => c.key).join(',')
       === 'total,net_lb,net_mt,amount,balance', bills.COLUMNS.filter((c) => c.derived).map((c) => c.key).join(','));

    const sw = ['Customer name', 'Date', 'Invoice number', 'HBL number', 'Proforma date',
        'Reference', 'Weight', 'Invoice price', 'Invoice amount', 'Freight charges'];
    ck('the sale has all 10 she listed', sales.tableColumns().length === 10, String(sales.tableColumns().length));
    ck('  in her order', sales.tableColumns().map((c) => c.label).join('|') === sw.join('|'),
       sales.tableColumns().map((c) => c.label).join('|'));

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
       Array.isArray(r.json.columns) && r.json.columns.length === 22,
       'the table is built from the server list, so the two cannot drift');
    // The FORM walks groups, the TABLE walks her order. Both travel, so
    // neither client re-derives one from the other and gets it subtly wrong.
    ck('  plus the grouped fields the form needs',
       Array.isArray(r.json.fields) && Array.isArray(r.json.groups) && r.json.groups.length === 5,
       JSON.stringify((r.json.groups || []).map((g) => g.id)));
    // The original complaint was two columns both headed TRUCKING on two
    // identical empty boxes. Naming one of them "Trucker" fixes that at the
    // source, so no two columns share a heading at all any more.
    ck('  no two columns share a heading',
       new Set(r.json.columns.map((c) => c.label)).size === r.json.columns.length,
       r.json.columns.map((c) => c.label).join('|'));
    ck('    and the trucker sits next to what the trucking cost',
       (() => { const L = r.json.columns.map((c) => c.key);
                return L.indexOf('trucking_company') === L.indexOf('trucking_amount') - 1; })(),
       r.json.columns.map((c) => c.key).join(','));
    ck('    on the form too, in the money section',
       (r.json.fields.find((c) => c.key === 'trucking_company') || {}).group === 'money');
    ck('  and the typeable invoice amount carries the key to post it under',
       (r.json.fields.find((c) => c.key === 'amount') || {}).writeKey === 'supplier_invoice_amount',
       'without writeKey the derived column gets no input and her figure cannot be entered');

    r = await req('POST', '/api/bills', { sid: admin, body: {
        date: '2026-09-10', supplier: 'Eccomelt', booking_no: '272766480',
        gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
        supplier_price: 0.32, trucking_amount: 1200 } });
    ck('POST /api/bills saves it', r.status === 200 && !!r.json.bill, r.raw.slice(0, 120));
    const billId = r.json.bill && r.json.bill.id;
    ck('  and the response carries the arithmetic',
       r.json.bill.net_lb === 14500 && r.json.bill.balance === 3440 && r.json.bill.price_unit === 'lb',
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
       r.json.summary.count === 1 && r.json.summary.balance === 3440,
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

    // ── ONE BILL IS ONE CONTAINER ────────────────────────────────────────
    // Apsara, 2026-09-10: "There might be two containers under a booking.
    // Container number will be different for every load." The first version
    // filled container 1 and said nothing, so three bills off a 3-container
    // booking would have carried the same container number.
    const one = await req('GET', '/api/bills/from-booking/DALA23991600?container=1', { sid: admin });
    const two = await req('GET', '/api/bills/from-booking/DALA23991600?container=2', { sid: admin });
    ck('each container on a booking pre-fills its OWN number',
       one.json.prefill.container_no === 'HMMU1111111'
       && two.json.prefill.container_no === 'HMMU2222222',
       JSON.stringify([one.json.prefill.container_no, two.json.prefill.container_no]));
    ck('  and its own supplier, which also differs per container',
       one.json.prefill.supplier === 'Eccomelt' && two.json.prefill.supplier === 'Oakland Metals',
       JSON.stringify([one.json.prefill.supplier, two.json.prefill.supplier]));
    ck('  while the booking-level fields stay the same on both',
       one.json.prefill.carrier === two.json.prefill.carrier
       && one.json.prefill.route === two.json.prefill.route);
    ck('  and both containers are offered so she can pick',
       Array.isArray(two.json.containers) && two.json.containers.length === 2,
       'nothing is filled until she says which one this bill is for');

    // ── THE LIVE TOTALS COME FROM THE SERVER ─────────────────────────────
    // She fills five weights and four money fields to produce a Balance she
    // could not see until she saved. The preview shows it as she types — and
    // asks the server, rather than being a second implementation of her
    // formulas in the browser.
    r = await req('POST', '/api/bills/preview', { sid: admin, body: {
        gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
        supplier_price: 0.32, trucking_amount: 1200 } });
    ck('a preview computes without saving',
       r.status === 200 && r.json.net_lb === 14500 && r.json.balance === 3440,
       JSON.stringify({ n: r.json.net_lb, b: r.json.balance }));
    ck('  and really saves nothing',
       (await req('GET', '/api/bills', { sid: admin })).json.summary.count === 1,
       'a preview that writes a row is a row she did not ask for');
    ck('  a half-filled form previews what it can, without inventing zeros',
       (await req('POST', '/api/bills/preview', { sid: admin, body: { gross: 44000 } }))
         .json.missing_tares.length === 4,
       'the warning is what tells her the total is not finished');
    const sp = await req('POST', '/api/sales/preview', { sid: admin, body: { weight: 29000, invoice_price: 0.41, freight_charges: 1500 } });
    ck('  and sales previews too', sp.json.amount === 11890 && sp.json.net_of_freight === 10390,
       JSON.stringify(sp.json));

    r = await req('PUT', `/api/bills/${billId}`, { sid: admin, body: { seal_no: 'SEAL-1' } });
    ck('PUT patches one field', r.status === 200 && r.json.bill.seal_no === 'SEAL-1');
    ck('  without erasing the rest of the row',
       r.json.bill.supplier === 'Eccomelt' && r.json.bill.gross === 44000,
       'the editLoad lesson: rebuilding a record wholesale dropped pdf_link');

    // ── EDIT ─────────────────────────────────────────────────────────────
    // Apsara, 2026-09-10: "i want edit option in bill". Until now a typo in a
    // seal number meant deleting the row and retyping eighteen fields.
    r = await req('PUT', `/api/bills/${billId}`, { sid: admin, body: { seal_no: 'SEAL-2', gross: 46000 } });
    ck('an edit recomputes the derived columns',
       r.json.bill.net_lb === 16500 && r.json.bill.amount === 5280,
       JSON.stringify({ n: r.json.bill.net_lb, a: r.json.bill.amount }));

    // ── AND A CLEARED FIELD REALLY CLEARS ────────────────────────────────
    // The client sends every input on an edit, empty ones included, BECAUSE
    // the server PATCHes: dropping blanks would mean clearing a seal number
    // sends nothing for it and the old value survives. She would clear a
    // field, save, and watch it come back.
    r = await req('PUT', `/api/bills/${billId}`, { sid: admin, body: { seal_no: '' } });
    ck('  clearing a field actually clears it', r.json.bill.seal_no === '', JSON.stringify(r.json.bill.seal_no));
    ck('    without touching anything else',
       r.json.bill.supplier === 'Eccomelt' && r.json.bill.gross === 46000);

    // ── INCOMPLETE IS A STATE, NOT AN ERROR ──────────────────────────────
    // This section used to assert the OPPOSITE: that an edit could not blank
    // the date or supplier, because addBill refused a bill without them.
    // That was my rule, never hers, and on 2026-09-10 she asked for autosave
    // — "if i start adding atleast one value in bill,it should get
    // autosaved" — which makes a two-required-fields rule incompatible with
    // how she fills a bill in. So the store reports instead of refusing.
    const blanked = await req('PUT', `/api/bills/${billId}`, { sid: admin, body: { supplier: '' } });
    ck('an unfinished bill can be saved', blanked.status === 200, String(blanked.status));
    ck('  and says what it is still missing',
       (blanked.json.bill.incomplete || []).join(',') === 'supplier',
       JSON.stringify(blanked.json.bill.incomplete));
    await req('PUT', `/api/bills/${billId}`, { sid: admin, body: { supplier: 'Eccomelt' } });
    ck('  a finished one reports nothing missing',
       ((await req('GET', '/api/bills', { sid: admin })).json.bills
         .find((x) => x.id === billId).incomplete || []).length === 0);

    // What is still refused: a row with nothing in it at all. "At least one
    // value" is her own threshold, and a bill created by opening the form and
    // closing it again is litter in her table and in her sheet.
    const empty = await req('POST', '/api/bills', { sid: admin, body: {} });
    ck('  but an empty bill is still refused', empty.status >= 400, String(empty.status));
    const ws = await req('POST', '/api/bills', { sid: admin, body: { supplier: '   ' } });
    ck('    and so is one holding only whitespace', ws.status >= 400, String(ws.status));

    // Autosave creates from the FIRST value, so this has to work.
    const seed = await req('POST', '/api/bills', { sid: admin, body: { container_no: 'MSKU-AUTO' } });
    ck('  a single value is enough to create one', seed.status === 200 && !!seed.json.bill.id,
       'that is what autosave posts the moment she types');
    await req('DELETE', `/api/bills/${seed.json.bill.id}`, { sid: admin });

    r = await req('PUT', '/api/bills/NOPE', { sid: admin, body: { seal_no: 'x' } });
    ck('  editing a row that is not there is an error, not a silent no-op', r.status >= 400);

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

section('E2 — photos, filters, and the Shipment sheet row');
{
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;

    // ── PHOTOS ───────────────────────────────────────────────────────────
    // Apsara: "In bill,i want photos field where url can be pasted."
    let r = await req('POST', '/api/bills', { sid: admin, body: {
        date: '09/11/2026', supplier: 'PhotoCo',
        photos: 'https://drive.example.com/a.jpg\nhttps://drive.example.com/b.jpg' } });
    ck('pasted links are stored as a list', 
       Array.isArray(r.json.bill.photos) && r.json.bill.photos.length === 2,
       JSON.stringify(r.json.bill.photos));
    const photoId = r.json.bill.id;

    // These come back out as clickable links, so the scheme is checked at the
    // door rather than trusted at render time.
    r = await req('PUT', `/api/bills/${photoId}`, { sid: admin, body: {
        photos: 'javascript:alert(1) https://ok.example.com/c.jpg data:text/html,x file:///etc/passwd' } });
    ck('  a javascript: URL never reaches the record',
       r.json.bill.photos.join(',') === 'https://ok.example.com/c.jpg',
       JSON.stringify(r.json.bill.photos));
    ck('  and neither do data: or file:',
       !r.json.bill.photos.some((u) => /^(data|file):/i.test(u)));

    // ── FILTERS, SEVERAL AT ONCE ─────────────────────────────────────────
    // Apsara: "also i want filter.ultiple filters can also be applied."
    const all = (await req('GET', '/api/bills', { sid: admin })).json;
    ck('unfiltered returns everything', all.bills.length === all.total_unfiltered,
       `${all.bills.length} of ${all.total_unfiltered}`);
    ck('  and offers only values that exist',
       (all.facets.supplier || []).includes('PhotoCo') && (all.facets.supplier || []).includes('Eccomelt'),
       JSON.stringify(all.facets.supplier));

    const one = (await req('GET', '/api/bills?supplier=photoco', { sid: admin })).json;
    ck('one filter narrows, case-insensitively', one.bills.length === 1, String(one.bills.length));
    ck('  and the SUMMARY follows the filter, not the whole table',
       one.summary.count === 1 && one.summary.count !== all.summary.count,
       'totals describing rows that are not on screen is worse than no filter');
    ck('  while the facets still list every supplier',
       (one.facets.supplier || []).length === (all.facets.supplier || []).length,
       'narrowing by supplier must not empty the dropdown she just used');

    const both = (await req('GET', '/api/bills?supplier=photoco&from=09/01/2026&to=09/30/2026', { sid: admin })).json;
    ck('two filters AND together', both.bills.length === 1, String(both.bills.length));
    const none = (await req('GET', '/api/bills?supplier=photoco&from=01/01/2027', { sid: admin })).json;
    ck('  and a combination matching nothing returns nothing, not everything',
       none.bills.length === 0, String(none.bills.length));

    // ── THE SHIPMENT ROW ─────────────────────────────────────────────────
    // Apsara: "post save of a bill,i want Shipment tab to be created in edge
    // metals sheet.on every edit of the bill,i want that row to be modified."
    const ship = require(path.join(ROOT, 'helpers/shipmentSheetLog'));
    ck('the tab is called Shipment', ship.TAB_NAME === 'Shipment');
    const header = ship.headerRow();
    ck('  its header is built from the bill columns, not typed out again',
       bills.tableColumns().every((c) => header.includes(c.label)),
       'a column added to the store must not need a second edit here');
    ck('  carrier is in the SHEET even though it left the table',
       header.includes('Carrier'), header.join(' | '));

    // The key is what makes an edit modify the row instead of adding one.
    const row = ship.rowFor({ id: 'BILL_X', date: '09/10/2026', supplier: 'Eccomelt',
        gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500, supplier_price: 0.32 });
    ck('  every row is as wide as the header', row.length === header.length,
       `${row.length} vs ${header.length}`);
    ck('  and the LAST cell is the bill id the upsert matches on',
       row[row.length - 1] === 'BILL_X', JSON.stringify(row[row.length - 1]));
    // Counted, never hand-written: adding a bill column would otherwise point
    // the upsert at the wrong column and turn every edit into a new row.
    const letter = ship.keyColumnLetter();
    const idx = letter.split('').reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0);
    ck('  the key column letter tracks the header width', idx === header.length,
       `${letter} = ${idx}, header is ${header.length}`);
    ck('  the computed figures go to the sheet, not just the typed ones',
       row[header.indexOf('Net weight (lbs)')] === 14500 && row[header.indexOf('Balance')] === 4640,
       JSON.stringify([row[header.indexOf('Net weight (lbs)')], row[header.indexOf('Balance')]]));

    // ── AND IT MUST NOT BE ABLE TO COST HER A BILL ───────────────────────
    const src = fs.readFileSync(path.join(ROOT, 'helpers/shipmentSheetLog.js'), 'utf8');
    ck('a sheet failure is caught, not thrown at the Save',
       /\.catch\(\(e\) =>/.test(src) && /the bill IS saved/.test(src),
       'Drive being unreachable is not a reason to lose eighteen typed fields');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const postIdx = apiSrc.indexOf("app.post('/api/bills'");
    const seg = apiSrc.slice(postIdx, postIdx + 900);
    ck('  and it runs AFTER the bill is stored',
       seg.indexOf('addBill') < seg.indexOf('logBillSafely'),
       'writing the sheet first would risk a row for a bill that failed to save');
    ck('  an edit logs it too, so the row is modified',
       /logBillSafely\(bill, 'edited'\)/.test(apiSrc));
    ck('  and a test run can never touch her real spreadsheet',
       /JARVIS_TEST/.test(src), 'this file talks to the live Edge Metals sheet');

    await req('DELETE', `/api/bills/${photoId}`, { sid: admin });
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

    // ── "This is ugly and not user friendly" (2026-09-10) ────────────────
    // Checked on the CLASS, not on the exact markup around it. The first
    // version matched a literal `<div class="field">\n<label>${esc(...)` and
    // went red when the label gained a style attribute — a correct form
    // failing a test that was pinned to whitespace. tests/ledger-render.js
    // asserts the rendered result properly; this only needs to catch the
    // field class going missing entirely.
    ck('the form uses the app\'s own field styling, not browser default',
       /class="field"/.test(html) && /\.field input/.test(html),
       'bare inputs render white on a dark page — every other form here uses .field');
    ck('  and arrives in sections rather than one wall of boxes',
       /ledgerState\.groups/.test(html) && /c\.group === g\.id/.test(html),
       '23 identical boxes with no grouping is what she was looking at');
    ck('  with the running totals asked of the SERVER',
       /\$\{K\.path\}\/preview/.test(html),
       'computing her formulas in the browser would be a second implementation');
    ck('  every row offers an edit, not just a delete',
       /class="btn btn-secondary ledger-edit"/.test(html) && /openLedgerForm\(kind, row\)/.test(html),
       'a typo in a seal number should not mean retyping eighteen fields');
    ck('  and the SAME form does add and edit',
       /function openLedgerForm\(kind, existing\)/.test(html)
       && (html.match(/const sections = groups\.map/g) || []).length === 1,
       'two copies of an 18-field layout is two things to keep in step');
    ck('  an edit sends the emptied fields too',
       /if \(!\(k in body\)\) body\[k\] = ''/.test(html),
       'the server PATCHes, so a dropped blank means the old value survives');
    ck('  the running totals name the columns she asked for',
       /'Net weight \(lbs\)'/.test(html) && /'Net weight \(MT\)'/.test(html)
       && /'Supplier invoice amount'/.test(html),
       '"net lbs,net mt needs to be calculated and supplier invoice amount need to be displayed before save"');
    ck('  and a container picker when a booking has more than one',
       /boxes\.length > 1/.test(html) && /led-box/.test(html),
       '"There might be two containers under a booking"');
}

if (server) server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
