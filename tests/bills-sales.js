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
    // Payable added 2026-09-10: "bill amount shoud be one thing after
    // deducting trucking,it should get auto adjusted na". It always did — this
    // is the middle link named, so the deduction is read rather than
    // reconstructed between two other columns.
        'Supplier price', 'Supplier invoice amount', 'Trucker', 'Trucking',
        'Payable', 'Balance', 'Photos'];
    ck('the bill has her columns, less Advance and Carrier, plus Photos',
       bills.tableColumns().length === wanted.length, String(bills.tableColumns().length));
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
    ck('  with every computed one marked',
       bills.COLUMNS.filter((c) => c.derived).map((c) => c.key).join(',')
       === 'total,net_lb,net_mt,amount,net_payable,balance',
       bills.COLUMNS.filter((c) => c.derived).map((c) => c.key).join(','));
    ck('    including Payable, so no client can post its own',
       !bills.WRITABLE.includes('net_payable'),
       'a client that can write the deduction can disagree with the server about it');

    // ── HER SECOND LIST, 2026-09-10 ──────────────────────────────────────
    // "Date,HBL No.(House BL),Invoice number,booking no,container no,Customer
    // name,Terms(LC/TT),Proforma Date,Reference,Item,Weight(in mt/lbs),invoice
    // price,Invoice amount", then: "bookng first then container no".
    //
    // Freight charges is off the table on purpose — it became a charge with a
    // note. compute() still folds the stored value in, so nothing entered
    // before today is lost; section N covers that.
    // Reordered 2026-09-10: "i wnt proforma date on right of item .next to it
    // should be reference .rename terms with payment terms and next to it
    // should be shipment terms."
    const sw = ['Booking no', 'Container no', 'Date', 'HBL number', 'Invoice number',
        'Customer name', 'Payment terms', 'Shipment terms', 'Item', 'Proforma date',
        'Reference', 'Weight', 'Invoice price', 'Invoice amount', 'Received', 'Balance'];
    ck('the sale has the columns she listed', sales.tableColumns().length === sw.length,
       String(sales.tableColumns().length));
    ck('  in her order, booking before container',
       sales.tableColumns().map((c) => c.label).join('|') === sw.join('|'),
       sales.tableColumns().map((c) => c.label).join('|'));
    const at = (l) => sw.indexOf(l);
    ck('  proforma date sits to the right of item, reference beside it',
       at('Proforma date') === at('Item') + 1 && at('Reference') === at('Proforma date') + 1);
    ck('  and shipment terms next to payment terms',
       at('Shipment terms') === at('Payment terms') + 1);
    ck('  two different questions, no longer one word',
       sales.COLUMNS.find((c) => c.key === 'terms').label === 'Payment terms'
       && !!sales.COLUMNS.find((c) => c.key === 'shipment_terms'),
       'LC/TT says when the money moves; FOB/CIF says where her risk ends');
    ck('  which is the same pair bills is keyed on, so the two can join',
       bills.COLUMNS.some((c) => c.key === 'booking_no') && bills.COLUMNS.some((c) => c.key === 'container_no'),
       'margin per container needs both sides keyed the same way');

    // A client that could post a balance not following from its own weights
    // is a client that can disagree with the server about money.
    // ── THE CHAIN, NAMED AT EVERY LINK ───────────────────────────────────
    const chain = bills.compute({ gross: 44000, truck: 15000, container: 8000,
        chassis: 6000, boxes: 500, supplier_price: 0.32,
        trucking_amount: 1200, paid: 500 });
    ck('trucking comes off the bill amount automatically',
       chain.net_payable === 3440, String(chain.net_payable));
    ck('  and the balance takes payments off THAT, not off the invoice again',
       chain.balance === 2940, String(chain.balance));
    ck('  while the bill amount stays the supplier\'s own figure',
       chain.amount === 4640,
       'netting trucking into it would mean her tab and their invoice never agree again');
    ck('  no trucking means payable equals the amount',
       bills.compute({ gross: 44000, truck: 15000, container: 8000, chassis: 6000,
                       boxes: 500, supplier_price: 0.32 }).net_payable === 4640);
    ck('  and nothing to price means nothing to pay, not zero',
       bills.compute({ trucking_amount: 1200 }).net_payable === null,
       'a payable of -1200 on an empty bill would be worse than a blank');

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
       Array.isArray(r.json.columns) && r.json.columns.length === bills.tableColumns().length,
       'the table is built from the server list, so the two cannot drift');
    // The FORM walks groups, the TABLE walks her order. Both travel, so
    // neither client re-derives one from the other and gets it subtly wrong.
    // Regrouped 2026-09-10 to her spec: "Date,Route,Carrier,Invoice no in one
    // group,next booking no,container no,seal no in another group,then
    // supplier,supplier price,bill amount in one group.Trucker related thing
    // as another,items and weights in another."
    ck('  plus the grouped fields the form needs',
       Array.isArray(r.json.fields) && Array.isArray(r.json.groups)
       && r.json.groups.map((g) => g.id).slice(0, 5).join(',')
          === 'shipment,container,purchase,trucking,items',
       JSON.stringify((r.json.groups || []).map((g) => g.id)));
    ck('    each stating its own order, not depending on array position',
       bills.groupColumns('shipment').map((c) => c.key).join(',')
         === 'date,route,carrier,invoice_no',
       bills.groupColumns('shipment').map((c) => c.key).join(','));
    ck('    the container group is the three numbers that identify the box',
       bills.groupColumns('container').map((c) => c.key).join(',')
         === 'booking_no,container_no,seal_no');
    ck('    and trucking is its own group rather than two boxes in Money',
       bills.groupColumns('trucking').map((c) => c.key).join(',')
         === 'trucking_company,trucking_amount');
    ck('    every column still belongs to a group that exists',
       bills.COLUMNS.every((c) => bills.GROUPS.some((g) => g.id === c.group)),
       bills.COLUMNS.filter((c) => !bills.GROUPS.some((g) => g.id === c.group)).map((c) => c.key).join(','));
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
    // Was 'money' until 2026-09-10: "Trucker related thing as another".
    // Its own group now, so the two boxes that once sat under two identical
    // TRUCKING headings are a named section instead.
    ck('    on the form too, in a Trucking section of its own',
       (r.json.fields.find((c) => c.key === 'trucking_company') || {}).group === 'trucking'
       && (r.json.fields.find((c) => c.key === 'trucking_amount') || {}).group === 'trucking',
       JSON.stringify([(r.json.fields.find((c) => c.key === 'trucking_company') || {}).group,
                       (r.json.fields.find((c) => c.key === 'trucking_amount') || {}).group]));
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
    ck('  and GET ships the same columns the helper defines',
       r.json.columns.length === sales.tableColumns().length,
       `${r.json.columns.length} over the wire, ${sales.tableColumns().length} in the helper`);
    ck('    booking first, container second, over the wire too',
       r.json.columns[0].key === 'booking_no' && r.json.columns[1].key === 'container_no',
       r.json.columns.slice(0, 2).map((c) => c.key).join(','));

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
    // Sales became FOUR entries on 2026-09-10 — "i told that i want sales to
    // be in different tabs na" — so this now checks that every one of them is
    // under Operations rather than that a single 'Sales' label exists.
    ck('every tab is registered under Operations',
       /\{ id: 'bills', label: 'Bills', group: 'Operations' \}/.test(html)
       && ['sales', 'sales-incoming', 'sales-freight', 'sales-commission']
            .every((id) => new RegExp(`id: '${id}',\\s+label: '[A-Za-z]+',\\s+group: 'Operations'`).test(html)),
       'her answer when asked: "Both as new tabs under Operations"');
    ck('  and the three derived views each have their own branch',
       /if \(tab === 'sales-incoming'\) return renderSalesSubTab\('incoming'\)/.test(html)
       && /if \(tab === 'sales-freight'\) return renderSalesSubTab\('freight'\)/.test(html)
       && /if \(tab === 'sales-commission'\) return renderSalesSubTab\('commission'\)/.test(html),
       'a nav entry with no branch is a tab that loads for ever');
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
    // The signature grew a third argument on 2026-09-10 (`seed`, a suggestion
    // for a NEW row, from the bill a container was bought on). Matched on the
    // first two so it pins the thing that matters — one form, not two.
    ck('  and the SAME form does add and edit',
       /function openLedgerForm\(kind, existing/.test(html)
       && (html.match(/const sections = groups\.map/g) || []).length === 1,
       'two copies of an 18-field layout is two things to keep in step');
    ck('    and a suggestion is NOT passed as an existing row',
       /function openLedgerForm\(kind, existing, seed\)/.test(html),
       'a seed in the existing slot would make autosave PUT against an id that is not there');
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

section('K — deleting a payment takes everything it touched with it');
{
    // Apsara, 2026-09-10: "Now i want to have delete option in payment."
    //
    // The button is the easy half. What is being tested here is what the
    // delete has to UNDO: the ledger row that feeds her spend report, the
    // paid figure on each container, and the audit entry that says who did
    // it. Money coming off the record is the most consequential thing this
    // file does, and the Yard has audited its equivalent since 2026-08-30.
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const bp = require(path.join(ROOT, 'helpers/billPayments'));
    const audit = require(path.join(ROOT, 'helpers/audit'));
    const { listPayments } = require(path.join(ROOT, 'helpers/payments'));

    const mk = async (container, amount) => (await req('POST', '/api/bills', { sid: admin, body: {
        date: '09/10/2026', supplier: 'Deleteme Metals', container_no: container,
        gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 0,
        supplier_price: amount / 12000,
    } })).json.bill;
    const b1 = await mk('DELU1', 3000);
    const b2 = await mk('DELU2', 3000);
    const owed = (id) => {
        const row = bp.paidByBill()[id] || 0;
        return row;
    };

    const made = await req('POST', '/api/bill-payments', { sid: admin, body: {
        date: '09/10/2026', amount: 2000, mode: 'Wire', bank: 'Chase', supplier: 'Deleteme Metals',
        allocations: [{ bill_id: b1.id, amount: 1200 }, { bill_id: b2.id, amount: 800 }],
    } });
    ck('a payment across two containers is recorded', made.status === 200, made.raw);
    const pid = made.json && made.json.payment && made.json.payment.id;
    ck('  both containers show it as paid', owed(b1.id) === 1200 && owed(b2.id) === 800,
       `${owed(b1.id)} / ${owed(b2.id)}`);
    const ledgerBefore = listPayments().filter((x) => x.load_id === pid).length;
    ck('  and there is one ledger row behind it', ledgerBefore === 1, String(ledgerBefore));

    const gone = await req('DELETE', `/api/bill-payments/${pid}`, { sid: admin });
    ck('the payment deletes', gone.status === 200, gone.raw);
    ck('  naming the containers it reopened',
       Array.isArray(gone.json.containers_reopened) && gone.json.containers_reopened.length === 2,
       JSON.stringify(gone.json));
    ck('  both containers owe again', owed(b1.id) === 0 && owed(b2.id) === 0,
       `${owed(b1.id)} / ${owed(b2.id)}`);

    // THIS is the one that matters. A receipt left in the ledger sums against
    // nothing and inflates her spend report for the month.
    ck('  the ledger row goes with it',
       listPayments().filter((x) => x.load_id === pid).length === 0,
       'a payment deleted from Bills and left in the spend report is money that never comes back');

    const entries = audit.listEntries().filter((e) => e.subject === pid);
    ck('  and the delete is audited', entries.length >= 1,
       'the Yard audits delete-payment; Edge Metals is a different company, not a lower standard');
    if (entries.length) {
        ck('    under its own action name, not the Yard\'s',
           entries[0].action === 'delete-bill-payment', entries[0].action);
        ck('    which the allowlist actually knows',
           entries[0].action !== 'unknown-action',
           'helpers/audit.js ACTIONS is an allowlist — an unregistered action logs as unknown');
        ck('    saying which company', entries[0].detail && entries[0].detail.company === 'edge-metals');
        ck('    what it was worth', entries[0].detail && entries[0].detail.amount === 2000);
        ck('    and what it had been covering',
           entries[0].detail && (entries[0].detail.allocations || []).length === 2);
    }

    // The sheet write is disabled under JARVIS_TEST (deliberately — a probe
    // without it put a junk row in her live Edge Metals spreadsheet on
    // 2026-09-10), so this is asserted against the source. Weak, and named as
    // weak: what it catches is the mirror being dropped from the delete path,
    // which is how the sheet ends up showing a payment that no longer exists.
    const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    const delRoute = apiSrc.slice(apiSrc.indexOf("app.delete('/api/bill-payments/:id'"),
                                  apiSrc.indexOf("app.get('/api/sales'"));
    ck('  and the Shipment tab is told the payment is gone',
       /logBillSafely/.test(delRoute) && /payment-removed/.test(delRoute),
       'POST re-mirrors every container it touches; DELETE moves the same numbers back');

    const twice = await req('DELETE', `/api/bill-payments/${pid}`, { sid: admin });
    ck('deleting it again is a clean 404, not a 500', twice.status === 404, twice.raw);

    // Staff must not reach this at all — '/api/bill-payments' is deliberately
    // absent from STAFF_ALLOWED_PATH_PREFIXES.
    const staff = (await login('staff-pw-ccccccccccc')).json.sid;
    const denied = await req('DELETE', '/api/bill-payments/anything', { sid: staff });
    ck('staff cannot delete a payment at all', denied.status === 403, String(denied.status));
}

section('L — cash, and the yard cash box it must not touch');
{
    // Apsara, 2026-09-10: "Always add cash as payment method."
    // Asked whether Edge Metals cash should draw down the yard's Petty cash
    // reserve: "No — Edge Metals cash is separate."
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const bp = require(path.join(ROOT, 'helpers/billPayments'));
    const petty = require(path.join(ROOT, 'helpers/pettyCash'));
    const { listPayments } = require(path.join(ROOT, 'helpers/payments'));

    ck('Cash is offered as a payment method', bp.BILL_PAYMENT_MODES.includes('Cash'),
       bp.BILL_PAYMENT_MODES.join(', '));

    const seen = await req('GET', '/api/bill-payments', { sid: admin });
    ck('  and the form is told about it',
       (seen.json.modes || []).includes('Cash'), JSON.stringify(seen.json.modes));

    const bill = (await req('POST', '/api/bills', { sid: admin, body: {
        date: '09/10/2026', supplier: 'Cashy Metals', container_no: 'CASH1',
        gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 0,
        supplier_price: 0.25,
    } })).json.bill;

    // Top the box up so a draw-down would be VISIBLE. Starting from zero
    // would let a wrong implementation pass by refusing rather than by
    // leaving the box alone.
    await petty.addTopUp({ date: '09/10/2026', amount: 4000, note: 'test float' });
    const before = petty.balance();
    ck('the yard cash box has money in it to take', before === 4000, String(before));

    const cash = await req('POST', '/api/bill-payments', { sid: admin, body: {
        date: '09/10/2026', amount: 500, mode: 'Cash',
        supplier: 'Cashy Metals', allocations: [{ bill_id: bill.id, amount: 500 }],
    } });
    ck('a cash payment records with no bank at all', cash.status === 200, cash.raw);
    ck('  and stores no bank, because there is not one',
       cash.json.payment && cash.json.payment.bank === null,
       JSON.stringify(cash.json.payment && cash.json.payment.bank));
    ck('  the container counts it as paid',
       (bp.paidByBill()[bill.id] || 0) === 500, String(bp.paidByBill()[bill.id]));

    // THE ONE THAT MATTERS.
    ck('  the EDGE YARD petty cash box does not move', petty.balance() === before,
       `${before} -> ${petty.balance()} — "Edge Metals cash is separate"`);

    const row = listPayments().find((x) => x.load_id === cash.json.payment.id);
    ck('  but it is still in the spend ledger', !!row && row.mode === 'Cash',
       'separate from petty cash is not the same as invisible');
    ck('    filed against Edge Metals, not a yard load',
       row && row.load_kind === 'bill', row && row.load_kind);
    ck('    and carrying no petty-cash withdrawal',
       row && !row.petty_cash_entry_id, JSON.stringify(row && row.petty_cash_entry_id));

    // Deleting must not PAY money INTO a box the cash never came out of.
    const gone = await req('DELETE', `/api/bill-payments/${cash.json.payment.id}`, { sid: admin });
    ck('deleting a cash payment succeeds', gone.status === 200, gone.raw);
    ck('  and still does not move the yard box', petty.balance() === before,
       `refunding it would credit the yard with cash it never spent: ${before} -> ${petty.balance()}`);
    ck('  while the container owes again', (bp.paidByBill()[bill.id] || 0) === 0);

    // ── THE OTHER DOOR INTO THE SAME ROOM ────────────────────────────────
    // deleteBillPayment goes through deletePaymentsForLoad. deletePayment(id)
    // is the single-row door, unreachable from the Bills tab today and wide
    // open to the yard assistant and DELETE /api/payments/:id. A mutation run
    // on 2026-09-10 showed its guard was pinned by nothing: removing it
    // survived every suite. Tested directly so the two doors cannot drift.
    const pay = require(path.join(ROOT, 'helpers/payments'));
    const lone = await pay.addPayment({ load_id: 'BP_LONE', load_kind: 'bill', amount: 250,
                                    mode: 'Cash', paid_on: '2026-09-10' });
    ck('a metals cash row can be deleted one at a time', await pay.deletePayment(lone.id) === true);
    ck('  and THAT door does not refund the yard box either', petty.balance() === before,
       `${before} -> ${petty.balance()}`);

    // A YARD cash payment must be unaffected by all of this.
    await pay.addPayment({ load_id: 'YARDLOAD1', load_kind: 'purchase', amount: 300,
                       mode: 'Cash', paid_on: '2026-09-10' });
    ck('a YARD cash payment still draws the box down', petty.balance() === before - 300,
       `${before} -> ${petty.balance()} — the yard rule must be untouched`);
}

section('M — one payment, one supplier, enforced where it is not displayed');
{
    // Apsara, 2026-09-10: "It must ask to select the supplier first... Then
    // show only related supplier container which are unpaid/part paid."
    //
    // The picker is the easy half and it is not enforcement. These drive the
    // ROUTE, which the yard assistant and anything else can reach without
    // going near the form.
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const bp = require(path.join(ROOT, 'helpers/billPayments'));

    const mk = async (supplier, container) => (await req('POST', '/api/bills', { sid: admin, body: {
        date: '09/10/2026', supplier, container_no: container,
        gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 0,
        supplier_price: 0.25,
    } })).json.bill;
    const eccoA = await mk('Sortby Eccomelt', 'SORT1');
    const eccoB = await mk('Sortby Eccomelt', 'SORT2');
    const oak   = await mk('Sortby Oakland', 'SORT3');

    const crossed = await req('POST', '/api/bill-payments', { sid: admin, body: {
        date: '09/10/2026', amount: 500, mode: 'Wire', bank: 'Chase',
        supplier: 'Sortby Eccomelt',
        allocations: [{ bill_id: oak.id, amount: 500 }],
    } });
    ck('a payment cannot settle another supplier\'s container', crossed.status === 400, crossed.raw);
    ck('  and the refusal names both sides',
       /Sortby Oakland/.test(crossed.json.error || '') && /SORT3/.test(crossed.json.error || ''),
       crossed.json.error);
    ck('  nothing was recorded', (bp.paidByBill()[oak.id] || 0) === 0);

    const half = await req('POST', '/api/bill-payments', { sid: admin, body: {
        date: '09/10/2026', amount: 1000, mode: 'Wire', bank: 'Chase',
        supplier: 'Sortby Eccomelt',
        allocations: [{ bill_id: eccoA.id, amount: 600 }, { bill_id: eccoB.id, amount: 400 }],
    } });
    ck('the same payment across that supplier\'s own containers is fine', half.status === 200, half.raw);

    // Case and stray spaces are typing, not a different company.
    const spaced = await req('POST', '/api/bill-payments', { sid: admin, body: {
        date: '09/10/2026', amount: 100, mode: 'Wire', bank: 'Chase',
        supplier: '  sortby eccomelt ',
        allocations: [{ bill_id: eccoA.id, amount: 100 }],
    } });
    ck('  and case or a stray space is not a different supplier', spaced.status === 200, spaced.raw);

    const nameless = await req('POST', '/api/bill-payments', { sid: admin, body: {
        date: '09/10/2026', amount: 100, mode: 'Wire', bank: 'Chase',
        allocations: [{ bill_id: eccoA.id, amount: 100 }],
    } });
    ck('a payment with no supplier at all is refused', nameless.status === 400, nameless.raw);
    ck('  saying to choose who is being paid', /needs a supplier/.test(nameless.json.error || ''),
       nameless.json.error);

    // Applying credit is bound by the ADVANCE's supplier, not by the caller's.
    const adv = await req('POST', '/api/bill-payments', { sid: admin, body: {
        kind: 'advance', date: '09/10/2026', amount: 900, mode: 'Wire', bank: 'Chase',
        supplier: 'Sortby Eccomelt', allocations: [],
    } });
    ck('an advance is held against the supplier', adv.status === 200, adv.raw);
    const misapplied = await req('POST', `/api/bill-payments/${adv.json.payment.id}/apply`,
        { sid: admin, body: { allocations: [{ bill_id: oak.id, amount: 300 }] } });
    ck('credit cannot be applied to another supplier\'s container',
       misapplied.status === 400, misapplied.raw);
    ck('  and the advance is untouched',
       (bp.list().find((x) => x.id === adv.json.payment.id).allocations || []).length === 0,
       'a refused apply that half-applied would be worse than one that failed loudly');
    const applied = await req('POST', `/api/bill-payments/${adv.json.payment.id}/apply`,
        { sid: admin, body: { allocations: [{ bill_id: eccoB.id, amount: 300 }] } });
    ck('  but to their own, it applies', applied.status === 200, applied.raw);

    // What the picker is built from.
    const open = (await req('GET', '/api/bill-payments', { sid: admin })).json.open_bills;
    const mine = open.filter((b) => String(b.supplier || '').startsWith('Sortby'));
    ck('the open list carries the supplier the picker groups by',
       mine.every((b) => !!b.supplier), JSON.stringify(mine.map((b) => b.supplier)));
    ck('  and what is paid so far, so a part-paid one can say so',
       mine.every((b) => typeof b.paid === 'number' && typeof b.amount === 'number'),
       JSON.stringify(mine[0]));
    ck('  listing only containers with something still owing',
       mine.every((b) => b.balance > 0), JSON.stringify(mine.map((b) => b.balance)));
}

section('N — sales at container grain: charges, commission, and the join');
{
    // Apsara, 2026-09-10, on rebuilding the sales tab: container as the grain,
    // "bookng first then container no", other charges each with a note, and
    // commission per MT off "The invoiced weight (sale)".
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const round2 = (n) => Math.round(n * 100) / 100;
    const round3 = (n) => Math.round(n * 1000) / 1000;

    // ── THE CHARGE LIST ──────────────────────────────────────────────────
    const good = sales.compute({ weight: 29000, invoice_price: 0.41, charges: [
        { what: 'Ocean freight', amount: 2850, direction: 'out', why: 'LAX to Busan on DALA2399' },
        { what: 'Detention', amount: 450, direction: 'in', why: '3 days at Busan, their clearance was late' },
    ] });
    ck('charges split by direction, not lumped into one number',
       good.charges_out_total === 2850 && good.charges_in_total === 450,
       JSON.stringify({ out: good.charges_out_total, in: good.charges_in_total }));
    ck('  what the customer owes includes what was rebilled to them',
       good.receivable === 12340, String(good.receivable));
    ck('  and what she pays does NOT inflate the receivable',
       good.receivable === round2(good.amount + good.charges_in_total),
       'adding an outgoing charge to the invoice would bill the customer for her own freight');

    const noNote = () => { try { sales.cleanCharges([{ what: 'Detention', amount: 450, direction: 'in' }]); return null; }
                           catch (e) { return e.message; } };
    ck('a charge with no note is refused', !!noNote(), 'the note is the whole reason this is a list');
    ck('  and says so in words she can act on', /why/i.test(noNote() || ''), noNote());
    const noDir = () => { try { sales.cleanCharges([{ what: 'X', amount: 1, why: 'y' }]); return null; }
                          catch (e) { return e.message; } };
    ck('a charge that does not say who pays is refused', !!noDir(), noDir());
    ck('  because the direction decides add or subtract',
       /you pay it or the customer/.test(noDir() || ''), noDir());
    ck('a blank row is not an error, it is a blank row',
       sales.cleanCharges([{ what: '', amount: null, why: '' }]).length === 0);

    // ── THE MONEY ALREADY ENTERED MUST NOT VANISH ────────────────────────
    // freight_charges predates the list. Rows carrying it are folded in.
    const legacy = sales.compute({ weight: 29000, invoice_price: 0.41, freight_charges: 1500 });
    ck('an old freight figure becomes a charge rather than disappearing',
       legacy.charges.length === 1 && legacy.charges[0].amount === 1500
       && legacy.charges[0].direction === 'out',
       JSON.stringify(legacy.charges));
    ck('  and net of freight still means what it always did',
       legacy.net_of_freight === 10390, String(legacy.net_of_freight));
    ck('  but a row with real charges ignores the legacy field, not doubling it',
       sales.compute({ weight: 29000, invoice_price: 0.41, freight_charges: 1500,
                       charges: [{ what: 'Ocean freight', amount: 2850, direction: 'out', why: 'x' }] })
            .charges_out_total === 2850,
       'counting both would overstate her cost by the old figure');

    // ── COMMISSION ───────────────────────────────────────────────────────
    const comm = sales.compute({ weight: 29000, invoice_price: 0.41, commission_per_mt: 6 });
    ck('commission runs off the INVOICED weight in MT',
       comm.commission_amount === round2(comm.weight_mt * 6), String(comm.commission_amount));
    ck('  which is her answer, not the purchased weight on the bill',
       comm.weight_mt === round3(29000 / bills.LB_PER_MT), String(comm.weight_mt));
    ck('  an agent\'s own figure wins over the arithmetic',
       sales.compute({ weight: 29000, invoice_price: 0.41, commission_per_mt: 6,
                       commission_amount: 80 }).commission_amount === 80);
    ck('    and says it was stated',
       sales.compute({ weight: 29000, commission_per_mt: 6, commission_amount: 80 }).commission_is_stated === true);
    ck('  no rate means no commission, not zero',
       sales.compute({ weight: 29000, invoice_price: 0.41 }).commission_amount === null,
       'zero is a decision; blank is a question');
    ck('what the sale costs Edge Metals is charges out plus commission',
       sales.compute({ weight: 29000, invoice_price: 0.41, commission_per_mt: 6, charges: [
           { what: 'Ocean freight', amount: 2850, direction: 'out', why: 'x' }] }).sale_side_cost
       === round2(2850 + comm.commission_amount));

    // ── BOOKING, THEN CONTAINER ──────────────────────────────────────────
    const order = sales.sortRows([
        { booking_no: 'DALA9', container_no: 'AAA1' },
        { container_no: 'ZZZ9' },
        { booking_no: 'DALA1', container_no: 'BBB2' },
        { booking_no: 'DALA1', container_no: 'AAA2' },
    ]).map((r) => `${r.booking_no || '-'}/${r.container_no}`);
    ck('rows come back booking first, container within it',
       order.join(' ') === 'DALA1/AAA2 DALA1/BBB2 DALA9/AAA1 -/ZZZ9', order.join(' '));
    ck('  and a row with no booking sorts last, not first',
       order[order.length - 1] === '-/ZZZ9',
       'an unfinished row at the top of the table is not a helpful default');

    // A container number is not unique over time; the pair is.
    ck('the same container under one booking is reported',
       sales.duplicates([{ id: 'a', booking_no: 'D1', container_no: 'C1' },
                         { id: 'b', booking_no: 'D1', container_no: ' c1 ' },
                         { id: 'c', booking_no: 'D2', container_no: 'C1' }]).length === 1,
       'a duplicate would double-count when bills and sales are joined');
    ck('  the SAME container under a DIFFERENT booking is not a duplicate',
       sales.duplicates([{ id: 'a', booking_no: 'D1', container_no: 'C1' },
                         { id: 'c', booking_no: 'D2', container_no: 'C1' }]).length === 0,
       'MSKU1111111 sails again next year with different metal in it');

    // ── TERMS ────────────────────────────────────────────────────────────
    const bad = await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Daekwang', terms: 'DP' } });
    ck('terms outside LC and TT are refused', bad.status === 400, bad.raw);
    const okTerms = await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Daekwang', terms: 'tt',
        booking_no: 'DALA2399', container_no: 'MSKU1111111', item: 'Auto cast',
        weight: 29000, invoice_price: 0.41, commission_per_mt: 6,
        charges: [{ what: 'Detention', amount: 450, direction: 'in', why: 'their delay at Busan' }] } });
    ck('  and lowercase is tidied rather than rejected',
       okTerms.status === 200 && okTerms.json.sale.terms === 'TT',
       okTerms.raw);
    ck('  the row comes back with its charges intact',
       (okTerms.json.sale.charges || []).length === 1
       && okTerms.json.sale.charges[0].why === 'their delay at Busan',
       JSON.stringify(okTerms.json.sale.charges));
    ck('  and its commission computed', okTerms.json.sale.commission_amount === 78.92,
       String(okTerms.json.sale.commission_amount));

    const viaRoute = await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Daekwang',
        charges: [{ what: 'Detention', amount: 450, direction: 'in' }] } });
    ck('the ROUTE refuses a charge with no note too', viaRoute.status === 400, viaRoute.raw);

    // Shipment terms are SUGGESTED, not policed — Incoterms have editions and
    // she trades on terms this file has no business refusing.
    const ship = await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Daekwang', terms: 'TT', shipment_terms: 'cfr' } });
    ck('a shipment term is tidied, not rejected',
       ship.status === 200 && ship.json.sale.shipment_terms === 'CFR', ship.raw);
    const odd = await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Daekwang', terms: 'TT', shipment_terms: 'DAT' } });
    ck('  and one not on the list is still accepted',
       odd.status === 200, 'unlike payment terms, this list only suggests');
    ck('  while payment terms stays closed',
       (await req('POST', '/api/sales', { sid: admin, body: {
           date: '09/10/2026', customer: 'Daekwang', terms: 'DP' } })).status === 400);

    const listed = await req('GET', '/api/sales', { sid: admin });
    ck('the sales list can be searched by container',
       (listed.json.filterable || []).includes('container_no'),
       JSON.stringify(listed.json.filterable));
    ck('  and by booking', (listed.json.filterable || []).includes('booking_no'));

    // The duplicate warning has to reach the client or it is a function
    // nobody calls — the exact failure this suite's header was written about.
    await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Daekwang', booking_no: 'DUPB', container_no: 'DUPC1' } });
    await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/11/2026', customer: 'Daekwang', booking_no: 'DUPB', container_no: 'dupc1' } });
    const withDupes = await req('GET', '/api/sales', { sid: admin });
    ck('a duplicated container is reported to the client',
       (withDupes.json.duplicates || []).some((d) => String(d.container_no).toUpperCase() === 'DUPC1'),
       JSON.stringify(withDupes.json.duplicates));
    ck('  but both rows are still returned, not silently dropped',
       withDupes.json.sales.filter((x) => String(x.container_no || '').toUpperCase() === 'DUPC1').length === 2,
       'refusing would be wrong: a container really can be split across two invoices');
    ck('  and the rows arrive in booking-then-container order',
       (() => { const b = withDupes.json.sales.map((x) => String(x.booking_no || '').toUpperCase())
                          .filter(Boolean);
                return b.every((v, i) => i === 0 || b[i - 1] <= v); })(),
       withDupes.json.sales.map((x) => x.booking_no || '-').join(','));
    ck('  the client is told which terms are allowed',
       JSON.stringify(withDupes.json.terms) === JSON.stringify(['LC', 'TT']),
       JSON.stringify(withDupes.json.terms));
}

section('O — mark as paid, and the $25 the bank took on the way');
{
    // Apsara, 2026-09-10: "In outgoing-give the option as mark as paid..
    // sometimes there might be a deduction in received amount because of wire
    // deduction by bank".
    //
    // The whole point of these is that the shortfall CANNOT vanish. A boolean
    // `paid` column would say settled while the bank says $12,315 against a
    // $12,340 invoice, and nothing would say where the difference went.
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const receipts = require(path.join(ROOT, 'helpers/salesReceipts'));
    const { listPayments } = require(path.join(ROOT, 'helpers/payments'));

    const mk = async (customer, container, extra = {}) => (await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer, booking_no: 'RCPT1', container_no: container,
        weight: 29000, invoice_price: 0.41, ...extra,
    } })).json.sale;
    const inv = await mk('Wireco', 'WIRE1');
    ck('the invoice is what it always was', inv.amount === 11890, String(inv.amount));

    const owed = () => {
        const row = sales.listWithTotals().find((x) => x.id === inv.id);
        return { balance: row.balance, received: row.received, charge: row.bank_charge };
    };
    ck('  and it starts owing all of it', owed().balance === 11890, JSON.stringify(owed()));

    // ── THE CASE SHE DESCRIBED ───────────────────────────────────────────
    const paid = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 11865, mode: 'Wire', bank: 'Chase', customer: 'Wireco',
        allocations: [{ sale_id: inv.id, amount: 11865, deduction_amount: 25,
                        deduction_reason: 'bank_charge',
                        deduction_note: 'Intermediary bank fee on the TT' }],
    } });
    ck('a short wire can still settle the invoice', paid.status === 200, paid.raw);
    ck('  the container is square', owed().balance === 0, JSON.stringify(owed()));
    ck('  what actually arrived is what actually arrived',
       owed().received === 11865, String(owed().received));
    ck('  and the missing 25 is named, not absorbed',
       owed().charge === 25, JSON.stringify(owed()));
    ck('  the receipt total matches the bank, not the invoice',
       paid.json.receipt.amount === 11865,
       'typing 11890 here would make the receipt disagree with the statement');

    // ── AN UNCLASSIFIED SHORTFALL IS THE BUG THIS PREVENTS ───────────────
    const inv2 = await mk('Wireco', 'WIRE2');
    const vague = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 11865, mode: 'Wire', bank: 'Chase', customer: 'Wireco',
        allocations: [{ sale_id: inv2.id, amount: 11865, deduction_amount: 25 }],
    } });
    ck('a shortfall with no reason is refused', vague.status === 400, vague.raw);
    ck('  and the message offers the third option: leave it outstanding',
       /outstanding/.test(vague.json.error || ''), vague.json.error);

    // Underpaid with NO deduction is simply a balance, and must stay one.
    const partial = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 5000, mode: 'Wire', bank: 'Chase', customer: 'Wireco',
        allocations: [{ sale_id: inv2.id, amount: 5000 }],
    } });
    ck('part payment with no deduction is fine', partial.status === 200, partial.raw);
    const row2 = () => sales.listWithTotals().find((x) => x.id === inv2.id);
    ck('  and the rest stays owed', row2().balance === 6890, String(row2().balance));

    // ── A DISCOUNT IS NOT A BANK CHARGE ──────────────────────────────────
    const inv3 = await mk('Wireco', 'WIRE3');
    await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 11390, mode: 'Wire', bank: 'Chase', customer: 'Wireco',
        allocations: [{ sale_id: inv3.id, amount: 11390, deduction_amount: 500,
                        deduction_reason: 'discount', deduction_note: 'agreed on the moisture claim' }],
    } });
    const row3 = () => sales.listWithTotals().find((x) => x.id === inv3.id);
    ck('a discount closes the balance too', row3().balance === 0, String(row3().balance));
    ck('  but is counted as a discount, not a bank charge',
       row3().discount === 500 && row3().bank_charge === 0,
       JSON.stringify({ d: row3().discount, b: row3().bank_charge }));
    ck('  which the summary keeps apart',
       receipts.summary().bank_charges === 25 && receipts.summary().discounts === 500,
       JSON.stringify(receipts.summary()));

    // ── ONE RECEIPT, SEVERAL CONTAINERS ──────────────────────────────────
    const a = await mk('Multico', 'MULT1');
    const b = await mk('Multico', 'MULT2');
    const one = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 23780, mode: 'Wire', bank: 'Chase', customer: 'Multico',
        allocations: [{ sale_id: a.id, amount: 11890 }, { sale_id: b.id, amount: 11890 }],
    } });
    ck('one TT settles two containers', one.status === 200, one.raw);
    ck('  as ONE receipt, not two', receipts.list().filter((r) => r.customer === 'Multico').length === 1);

    const crossed = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 100, mode: 'Wire', bank: 'Chase', customer: 'Multico',
        allocations: [{ sale_id: inv.id, amount: 100 }],
    } });
    ck('a receipt cannot settle another customer\'s container', crossed.status === 400, crossed.raw);
    ck('  naming who it was actually invoiced to',
       /Wireco/.test(crossed.json.error || ''), crossed.json.error);

    const over = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 100, mode: 'Wire', bank: 'Chase', customer: 'Multico',
        allocations: [{ sale_id: a.id, amount: 500 }],
    } });
    ck('allocating more than arrived is refused', over.status === 400, over.raw);
    const under = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 500, mode: 'Wire', bank: 'Chase', customer: 'Multico',
        allocations: [{ sale_id: a.id, amount: 100 }],
    } });
    ck('  and so is money not put against anything', under.status === 400, under.raw);

    const noBank = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 100, mode: 'Wire', customer: 'Multico',
        allocations: [{ sale_id: a.id, amount: 100 }],
    } });
    ck('a wire has to say which account it landed in', noBank.status === 400, noBank.raw);
    const cash = await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 100, mode: 'Cash', customer: 'Multico',
        allocations: [{ sale_id: a.id, amount: 100 }],
    } });
    ck('  but cash does not, because it has not been banked yet', cash.status === 200, cash.raw);

    // ── AN INFLOW IS NOT A PAYMENT ───────────────────────────────────────
    ck('a receipt writes NO row to the spend ledger',
       listPayments().every((p) => !String(p.load_id || '').startsWith('RCPT_')),
       'a customer payment subtracted from her spend would be worse than not recording it');
    const petty = require(path.join(ROOT, 'helpers/pettyCash'));
    const before = petty.balance();
    await req('POST', '/api/sales-receipts', { sid: admin, body: {
        date: '09/12/2026', amount: 50, mode: 'Cash', customer: 'Multico',
        allocations: [{ sale_id: b.id, amount: 50 }],
    } });
    ck('  and cash in does not move the EDGE YARD cash box',
       petty.balance() === before, `${before} -> ${petty.balance()}`);

    // ── DELETING ONE REOPENS WHAT IT CLOSED ──────────────────────────────
    const audit = require(path.join(ROOT, 'helpers/audit'));
    const rid = paid.json.receipt.id;
    const gone = await req('DELETE', `/api/sales-receipts/${rid}`, { sid: admin });
    ck('deleting a receipt succeeds', gone.status === 200, gone.raw);
    ck('  the container owes again, bank charge and all',
       owed().balance === 11890 && owed().charge === 0, JSON.stringify(owed()));
    ck('  and it is audited under its own action',
       audit.listEntries().some((e) => e.subject === rid && e.action === 'delete-sales-receipt'),
       JSON.stringify(audit.listEntries().filter((e) => e.subject === rid).map((e) => e.action)));
    ck('  deleting it twice is a clean 404',
       (await req('DELETE', `/api/sales-receipts/${rid}`, { sid: admin })).status === 404);

    const staff = (await login('staff-pw-ccccccccccc')).json.sid;
    ck('staff cannot touch receipts at all',
       (await req('GET', '/api/sales-receipts', { sid: staff })).status === 403);
}

section('P — settling what a sale costs: freight out, and the agent');
{
    // Apsara, 2026-09-10, asked whether freight and commission need paid or
    // unpaid tracking: "Yes — both get settled separately."
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const st = require(path.join(ROOT, 'helpers/salesSettlements'));
    const { listPayments } = require(path.join(ROOT, 'helpers/payments'));
    const spend = require(path.join(ROOT, 'helpers/spendReport'));

    const row = (await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Costco Metals', booking_no: 'COST1',
        container_no: 'COSTU1', weight: 29000, invoice_price: 0.41, commission_per_mt: 6,
        charges: [
            { what: 'Ocean freight', amount: 2850, direction: 'out', why: 'LAX to Busan' },
            { what: 'Detention', amount: 450, direction: 'in', why: 'their delay, rebilled' },
        ],
    } })).json.sale;

    const open = () => st.payables().filter((p) => p.sale_id === row.id);
    ck('an outgoing charge becomes a payable', open().some((p) => p.what === 'Ocean freight'),
       JSON.stringify(open().map((p) => p.what)));
    ck('  and so does the commission', open().some((p) => p.kind === 'commission'));
    ck('  a charge the CUSTOMER pays is not one of them',
       !open().some((p) => p.what === 'Detention'),
       'that is a receivable — putting it here has Edge Metals paying itself');
    ck('  the commission payable is the computed figure',
       open().find((p) => p.kind === 'commission').amount === 78.92,
       String(open().find((p) => p.kind === 'commission').amount));
    ck('  and says how it was worked out',
       /per MT on/.test(open().find((p) => p.kind === 'commission').why),
       open().find((p) => p.kind === 'commission').why);

    const freight = open().find((p) => p.what === 'Ocean freight');
    const part = await req('POST', '/api/sales-settlements', { sid: admin, body: {
        date: '09/12/2026', amount: 1000, mode: 'Wire', bank: 'Chase', payee: 'HMM',
        allocations: [{ sale_id: row.id, kind: 'charge', charge_id: freight.charge_id, amount: 1000 }],
    } });
    ck('a part payment against a charge is fine', part.status === 200, part.raw);
    ck('  and the rest stays outstanding',
       st.payables().find((p) => p.key === freight.key).balance === 1850,
       String(st.payables().find((p) => p.key === freight.key).balance));

    // One transfer covering the freight balance AND the commission.
    const rest = await req('POST', '/api/sales-settlements', { sid: admin, body: {
        date: '09/13/2026', amount: 1928.92, mode: 'Wire', bank: 'Chase', payee: 'HMM',
        allocations: [
            { sale_id: row.id, kind: 'charge', charge_id: freight.charge_id, amount: 1850 },
            { sale_id: row.id, kind: 'commission', amount: 78.92 },
        ],
    } });
    ck('one transfer settles a charge and the commission together', rest.status === 200, rest.raw);
    ck('  both are square', st.payables().filter((p) => p.sale_id === row.id)
       .every((p) => Math.abs(p.balance) < 0.005),
       JSON.stringify(st.payables().filter((p) => p.sale_id === row.id).map((p) => p.balance)));
    ck('  and this container has nothing left outstanding',
       st.payables().filter((p) => p.sale_id === row.id)
         .every((p) => Math.abs(p.balance) < 0.005),
       JSON.stringify(st.payables().filter((p) => p.sale_id === row.id)));

    const over = await req('POST', '/api/sales-settlements', { sid: admin, body: {
        date: '09/13/2026', amount: 10, mode: 'Wire', bank: 'Chase', payee: 'HMM',
        allocations: [{ sale_id: row.id, kind: 'charge', charge_id: freight.charge_id, amount: 10 }],
    } });
    ck('paying something already settled is refused', over.status === 400, over.raw);
    ck('  saying what is actually left on it',
       /nothing outstanding/.test(over.json.error || ''), over.json.error);

    const noPayee = await req('POST', '/api/sales-settlements', { sid: admin, body: {
        date: '09/13/2026', amount: 10, mode: 'Wire', bank: 'Chase',
        allocations: [{ sale_id: row.id, kind: 'commission', amount: 10 }],
    } });
    ck('a settlement has to say who was paid', noPayee.status === 400, noPayee.raw);

    // ── IT IS MONEY OUT, SO IT IS IN THE SPEND REPORT ────────────────────
    const ledger = listPayments().filter((p) => p.load_kind === 'sale_cost');
    ck('each transfer writes ONE ledger row, and a refused one writes none',
       ledger.length === 2, String(ledger.length));
    ck('  under its own kind, not folded into supplier payments',
       ledger.every((p) => p.load_kind === 'sale_cost'),
       'freight is what it costs to SELL, not what was paid for metal');
    const rep = spend.buildSpendReport({ payments: listPayments() });
    ck('  and the report gives it its own total',
       rep.saleCostTotal === 2928.92, String(rep.saleCostTotal));
    ck('    kept out of the supplier total',
       !rep.rows.some((x) => x.kind === 'supplier' && x.amount === 1928.92),
       'a margin worked out from a supplier line containing freight is wrong the flattering way');
    ck('    and out of expenses, which is where an unnamed kind would land',
       rep.rows.filter((x) => x.kind === 'sale_cost').length === 2,
       JSON.stringify(rep.rows.map((x) => x.kind)));

    // Cash out on an Edge Metals cost must not touch the yard box.
    const petty = require(path.join(ROOT, 'helpers/pettyCash'));
    await petty.addTopUp({ date: '09/13/2026', amount: 500, note: 'float for the sale-cost test' });
    const before = petty.balance();
    const row2 = (await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Costco Metals', booking_no: 'COST2', container_no: 'COSTU2',
        weight: 29000, invoice_price: 0.41,
        charges: [{ what: 'Fumigation', amount: 120, direction: 'out', why: 'wooden dunnage' }] } })).json.sale;
    const fum = st.payables().find((p) => p.sale_id === row2.id);
    const cash = await req('POST', '/api/sales-settlements', { sid: admin, body: {
        date: '09/13/2026', amount: 120, mode: 'Cash', payee: 'Fumigation co',
        allocations: [{ sale_id: row2.id, kind: 'charge', charge_id: fum.charge_id, amount: 120 }],
    } });
    ck('a cash settlement records with no bank', cash.status === 200, cash.raw);
    ck('  and does NOT move the Edge Yard petty cash box',
       petty.balance() === before, `${before} -> ${petty.balance()}`);

    // ── DELETING TAKES THE LEDGER ROW WITH IT ────────────────────────────
    const audit = require(path.join(ROOT, 'helpers/audit'));
    const sid2 = rest.json.settlement.id;
    const gone = await req('DELETE', `/api/sales-settlements/${sid2}`, { sid: admin });
    ck('deleting a settlement succeeds', gone.status === 200, gone.raw);
    ck('  the charge and commission owe again',
       st.payables().find((p) => p.key === freight.key).balance === 1850,
       String(st.payables().find((p) => p.key === freight.key).balance));
    ck('  its ledger row goes too',
       listPayments().filter((p) => p.load_id === sid2).length === 0,
       'a settlement deleted here and left in the spend report is money that never comes back');
    ck('  and it is audited', audit.listEntries().some((e) => e.subject === sid2 && e.action === 'delete-sale-cost'));

    const staff = (await login('staff-pw-ccccccccccc')).json.sid;
    ck('staff cannot reach settlements',
       (await req('GET', '/api/sales-settlements', { sid: staff })).status === 403);
}

section('Q — the customer box, and the figures that move as she types');
{
    // Apsara, 2026-09-10: "also i want customer to be populated with address
    // book data as i type match" and "also i want invoice amount and
    // commission amount to be computed dynamically".
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const ab = require(path.join(ROOT, 'helpers/addressBook'));

    // Two aliases for one company — she calls it both, and offering only the
    // first is how the second gets typed by hand and stops matching.
    await ab.addManualEntry(['Daekwang Steel', 'DK Metals'], 'Busan, Korea');
    await ab.addManualEntry(['Hanwha'], 'Seoul, Korea');
    await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Typed By Hand Co', booking_no: 'FAC1', container_no: 'FACU1' } });

    const listed = await req('GET', '/api/sales', { sid: admin });
    const offered = listed.json.facets.customer || [];
    ck('the address book feeds the customer type-ahead',
       offered.includes('Daekwang Steel') && offered.includes('Hanwha'),
       JSON.stringify(offered));
    ck('  every alias, not just the first',
       offered.includes('DK Metals'),
       'one company she calls two things is still one company');
    ck('  and what she has already invoiced is still there',
       offered.includes('Typed By Hand Co'), JSON.stringify(offered));
    ck('  her own customers first, spelled the way the invoices say',
       offered.indexOf('Typed By Hand Co') < offered.indexOf('Daekwang Steel'),
       JSON.stringify(offered));
    ck('  with no duplicates', new Set(offered).size === offered.length, JSON.stringify(offered));
    ck('  and the column is marked as a suggesting one',
       (sales.COLUMNS.find((c) => c.key === 'customer') || {}).suggest === true,
       'the facet list is worth nothing if the field does not read it');

    // ── COMPUTED WHILE SHE TYPES ─────────────────────────────────────────
    // The strip in the form and the cards on the tab are the same list, and
    // both are fed by this route. Every figure it names must come back.
    const pv = await req('POST', '/api/sales/preview', { sid: admin, body: {
        weight: 29000, invoice_price: 0.41, commission_per_mt: 6,
        charges: [{ what: 'Detention', amount: 450, direction: 'in', why: 'their delay' }],
    } });
    ck('a preview computes the invoice amount before anything is saved',
       pv.json.amount === 11890, String(pv.json.amount));
    ck('  and the commission with it', pv.json.commission_amount === 78.92,
       String(pv.json.commission_amount));
    ck('  and what the customer will owe', pv.json.receivable === 12340, String(pv.json.receivable));
    ck('  without saving a row', (await req('GET', '/api/sales', { sid: admin }))
       .json.sales.every((x) => x.container_no !== 'FACU9'));

    const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    const cards = /sales: \{[\s\S]*?cards: \[([\s\S]*?)\],\n  \},/.exec(html);
    ck('the live strip names the invoice amount and the commission',
       !!cards && /'amount'/.test(cards[1]) && /'commission_amount'/.test(cards[1]),
       cards ? cards[1].replace(/\s+/g, ' ').trim() : 'card list not found');
    ck('  and no longer names a column that became a charge',
       !!cards && !/freight_charges/.test(cards[1]),
       'freight_charges is folded into the charge list — a dead card is a dash for ever');
    ck('  every figure it names really comes back from preview',
       !!cards && [...cards[1].matchAll(/'([a-z_]+)',\s*'(money|num)'/g)]
         .every((m) => Object.prototype.hasOwnProperty.call(pv.json, m[1])),
       cards ? [...cards[1].matchAll(/'([a-z_]+)',\s*'(money|num)'/g)].map((m) => m[1]).join(',') : '');
    ck('  and the strip is fed by the SERVER, not a second copy of her formulas',
       /\$\{K\.path\}\/preview/.test(html),
       'computing this in the browser is free to disagree with the file that decides it');
}

section('R — several grades in one container');
{
    // Apsara, 2026-09-10: "Also in bill what if i have multiple items in same
    // container." Asked how the weights work: "Each item has its own weight
    // and price."
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const round2 = (n) => Math.round(n * 100) / 100;
    const round3 = (n) => Math.round(n * 1000) / 1000;

    const mixed = bills.compute({
        gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
        items: [
            { description: 'Al combo', weight: 8000, price: 0.32 },
            { description: 'Auto cast', weight: 6500, price: 0.28 },
        ],
    });
    ck('each grade is priced on its own weight',
       mixed.items.map((i) => i.amount).join(',') === '2560,1820',
       JSON.stringify(mixed.items.map((i) => i.amount)));
    ck('  and the bill is their sum, not a blended price',
       mixed.amount === 4380, String(mixed.amount));
    ck('    which is NOT what one price over the net would give',
       mixed.amount !== bills.compute({ gross: 44000, truck: 15000, container: 8000,
                                        chassis: 6000, boxes: 500, supplier_price: 0.32 }).amount,
       'a blended price makes a container look fine while one grade inside it loses money');
    ck('  the item weights are totalled', mixed.items_weight === 14500, String(mixed.items_weight));
    ck('  and reconcile to the container net', mixed.weight_gap === 0, String(mixed.weight_gap));

    // The $10 rule applies per line, so a per-MT grade can sit beside a
    // per-lb one on the same container.
    const perMt = bills.compute({ gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
        items: [{ description: 'Zorba', weight: 14500, price: 700 }] });
    ck('a price of 700 on a line is read as per MT',
       perMt.items[0].price_unit === 'mt', perMt.items[0].price_unit);
    ck('  so the line is weight in MT times the rate',
       perMt.items[0].amount === round2(round3(14500 / bills.LB_PER_MT) * 700),
       String(perMt.items[0].amount));

    // ── A GAP IS REPORTED, NEVER REFUSED ─────────────────────────────────
    const short = await req('POST', '/api/bills', { sid: admin, body: {
        date: '09/10/2026', supplier: 'Mixed Metals', container_no: 'MIXU1',
        gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
        items: [{ description: 'Al combo', weight: 8000, price: 0.32 },
                { description: 'Auto cast', weight: 6000, price: 0.28 }],
    } });
    ck('a bill whose grades do not add up still saves', short.status === 200, short.raw);
    ck('  and says by how much', short.json.bill.weight_gap === 500,
       String(short.json.bill.weight_gap));
    ck('  because the packing list and the weighbridge disagree as a matter of course',
       short.json.bill.amount === round2(8000 * 0.32 + round3(6000) * 0.28),
       String(short.json.bill.amount));

    const noDesc = await req('POST', '/api/bills', { sid: admin, body: {
        date: '09/10/2026', supplier: 'Mixed Metals',
        items: [{ weight: 100, price: 0.3 }],
    } });
    ck('an item with no description is refused', noDesc.status === 400, noDesc.raw);
    ck('  asking what grade it is', /grade/.test(noDesc.json.error || ''), noDesc.json.error);
    ck('a blank line is not an error',
       bills.cleanItems([{ description: '', weight: null, price: null }]).length === 0);

    // ── ONE ITEM IS STILL ONE ITEM ───────────────────────────────────────
    const single = bills.compute({ gross: 44000, truck: 15000, container: 8000,
                                   chassis: 6000, boxes: 500, supplier_price: 0.32 });
    ck('a bill with no items works exactly as before',
       single.amount === 4640 && single.items.length === 0, String(single.amount));
    ck('  and has no weight gap to report', single.weight_gap === null,
       'a gap on a bill with no grades would be a warning about nothing');
    ck('  her stated invoice amount still wins over the lines',
       bills.compute({ gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
                       supplier_invoice_amount: 5000,
                       items: [{ description: 'Al combo', weight: 8000, price: 0.32 }] }).amount === 5000,
       'the supplier invoice is the document of record');

    // Ids survive an edit, so anything referencing a line keeps referencing it.
    const withIds = bills.cleanItems([{ description: 'Al combo', weight: 8000, price: 0.32 }]);
    ck('every item gets an id', !!withIds[0].id);
    ck('  kept when the bill is saved again',
       bills.cleanItems(withIds)[0].id === withIds[0].id,
       'by array index, deleting a middle line would move everything below it');

    const saved = await req('GET', `/api/bills`, { sid: admin });
    const row = saved.json.bills.find((x) => x.container_no === 'MIXU1');
    ck('the route returns the items with the row', (row.items || []).length === 2,
       JSON.stringify((row.items || []).map((i) => i.description)));

    // ── A TICKET PER GRADE ───────────────────────────────────────────────
    // Apsara, 2026-09-10: "What if i have different weights like gross ,tare
    // etc.. for diff item in same container", answered "Each grade is its own
    // weighbridge ticket."
    const tickets = bills.compute({ items: [
        { description: 'Al combo',  gross: 30000, truck: 14000, boxes: 200, price: 0.32 },
        { description: 'Auto cast', gross: 26000, truck: 14000, boxes: 100, price: 0.28 },
    ] });
    ck('each grade nets out its own ticket',
       tickets.items.map((i) => i.weight).join(',') === '15800,11900',
       JSON.stringify(tickets.items.map((i) => i.weight)));
    ck('  and is priced on that net', tickets.items[0].amount === 5056, String(tickets.items[0].amount));
    ck('the container gross becomes the sum of the tickets',
       tickets.gross_used === 56000, String(tickets.gross_used));
    ck('  the tares too', tickets.total === 28300, String(tickets.total));
    ck('  and the net is the sum of the lines, not a second subtraction',
       tickets.net_lb === 27700, String(tickets.net_lb));
    ck('  the row says the weights came from the lines',
       tickets.weights_from_items === true);
    ck('  so there is no weight gap to warn about',
       tickets.weight_gap === null,
       'a permanent zero in that field would train her to stop reading it');

    // THE TRAP. One chassis under two grades, counted twice, is what keying
    // the tares to the TICKET prevents. Asserted as arithmetic so a later
    // refactor that folds container tares back up gets caught.
    const twoTickets = bills.compute({ items: [
        { description: 'A', gross: 30000, truck: 14000, chassis: 6000 },
        { description: 'B', gross: 26000, truck: 14000, chassis: 6000 },
    ] });
    ck('two tickets subtract their OWN chassis, not one shared one',
       twoTickets.net_lb === 10000 + 6000, String(twoTickets.net_lb));

    const conflict = bills.compute({
        gross: 44000, truck: 15000, container: 8000, chassis: 6000, boxes: 500,
        items: [{ description: 'Al combo', gross: 30000, truck: 14000, boxes: 200, price: 0.32 }],
    });
    ck('a container weight she typed is not overwritten in silence',
       conflict.weight_conflict === -1300, String(conflict.weight_conflict));
    ck('  the tickets still decide the net',
       conflict.net_lb === 15800, String(conflict.net_lb));
    ck('  and no conflict is reported when there is none',
       tickets.weight_conflict === null);

    // Blank tares on a ticket are reported, never treated as zero — the same
    // rule the container has had since the file was written.
    ck('a ticket says which of its own tares are missing',
       tickets.items[0].missing_tares.join(',') === 'container,chassis',
       JSON.stringify(tickets.items[0].missing_tares));
    ck('  and a line with no ticket claims none',
       bills.cleanItems([{ description: 'X', weight: 100, price: 0.3 }])[0].weighed === false);

    const perTicket = await req('POST', '/api/bills', { sid: admin, body: {
        date: '09/10/2026', supplier: 'Ticket Metals', container_no: 'TIKU1',
        items: [{ description: 'Al combo', gross: 30000, truck: 14000, boxes: 200, price: 0.32 }],
    } });
    ck('a per-ticket bill saves through the route', perTicket.status === 200, perTicket.raw);
    ck('  with the container net derived from it',
       perTicket.json.bill.net_lb === 15800, String(perTicket.json.bill.net_lb));
}

section('S — Edge Metals haulage, which is not the yard\'s');
{
    // Apsara, 2026-09-10: "Similar to sales,crate a tab called Trucking,and
    // put all the relevant details from bill to this..give an option to pay.
    // Also give an option to filter by date,month,trucking company,status".
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const mt = require(path.join(ROOT, 'helpers/metalsTrucking'));
    const { listPayments } = require(path.join(ROOT, 'helpers/payments'));
    const spend = require(path.join(ROOT, 'helpers/spendReport'));

    const mk = async (container, company, amount, date) => (await req('POST', '/api/bills', { sid: admin, body: {
        date, supplier: 'Haul Metals', container_no: container, booking_no: 'HAULBK',
        gross: 40000, truck: 14000, container: 8000, chassis: 6000, boxes: 0,
        supplier_price: 0.25, trucking_company: company, trucking_amount: amount,
    } })).json.bill;
    const h1 = await mk('HAULU1', 'Sher Trucking', 1200, '09/10/2026');
    const h2 = await mk('HAULU2', 'Sher Trucking', 1200, '08/08/2026');
    const h3 = await mk('HAULU3', 'Bayou Haulage', 900, '09/02/2026');
    await mk('HAULU4', 'Sher Trucking', 0, '09/03/2026');

    const mine = () => mt.payables().filter((r) => String(r.supplier) === 'Haul Metals');
    ck('every bill with a trucking amount becomes a haulage line',
       mine().length === 3, String(mine().length));
    ck('  one with a company but no amount does not',
       !mine().some((r) => r.container_no === 'HAULU4'),
       'a $0 payable is a row she skips past every time');
    ck('  and each carries what it came from',
       mine().every((r) => r.container_no && r.booking_no && r.supplier),
       'all the relevant details from bill');
    ck('  starting unpaid', mine().every((r) => r.status === 'unpaid'));

    // ── HER FOUR FILTERS ─────────────────────────────────────────────────
    const f = (q) => mt.filterPayables(mine(), q);
    ck('filter by trucking company',
       f({ trucking_company: 'Sher Trucking' }).length === 2,
       String(f({ trucking_company: 'Sher Trucking' }).length));
    ck('  case is typing, not a different company',
       f({ trucking_company: 'sher trucking' }).length === 2);
    // Month was removed on 2026-09-10 — "Remove month in trucking,we have
    // date filter na". A whole month is a from/to like any other range, and
    // two controls answering one question can contradict each other.
    ck('there is no month filter to contradict the date range',
       !Object.prototype.hasOwnProperty.call(mt.facets(mine()), 'month'),
       JSON.stringify(Object.keys(mt.facets(mine()))));
    ck('  and a whole month is just a range',
       f({ from: '09/01/2026', to: '09/30/2026' }).length === 2,
       JSON.stringify(f({ from: '09/01/2026', to: '09/30/2026' }).map((r) => r.date)));
    ck('filter by a date range', f({ from: '09/01/2026', to: '09/05/2026' }).length === 1,
       JSON.stringify(f({ from: '09/01/2026', to: '09/05/2026' }).map((r) => r.date)));
    ck('  and her MM/DD/YYYY is understood, not compared as text',
       f({ from: '09/01/2026' }).length === 2,
       '"09/01/2026" sorts before "08/08/2026" as a string — that is the trap');

    const pay = await req('POST', '/api/metals-trucking', { sid: admin, body: {
        date: '09/12/2026', amount: 1600, mode: 'Wire', bank: 'Chase',
        trucking_company: 'Sher Trucking',
        allocations: [{ bill_id: h1.id, amount: 1200 }, { bill_id: h2.id, amount: 400 }],
    } });
    ck('one transfer pays two hauls', pay.status === 200, pay.raw);
    const after = () => mt.payables().filter((r) => String(r.supplier) === 'Haul Metals');
    ck('  the settled one reads paid',
       after().find((r) => r.bill_id === h1.id).status === 'paid');
    ck('  the part-paid one reads part',
       after().find((r) => r.bill_id === h2.id).status === 'part',
       after().find((r) => r.bill_id === h2.id).status);
    ck('filter by status unpaid keeps the part-paid one',
       mt.filterPayables(after(), { status: 'unpaid' }).length === 2,
       'a haul she still owes money on belongs in the list she works from');
    ck('  and paid shows only the settled', 
       mt.filterPayables(after(), { status: 'paid' }).length === 1);
    ck('  the summary describes the rows it was given, not everything',
       mt.summary(mt.filterPayables(after(), { status: 'paid' })).amount === 1200,
       'a summary over everything while the table shows a subset is what breaks trust in a filter');

    // ── AND THE ROUTE MUST FILTER TOO, NOT JUST THE HELPER ───────────────
    // A mutation survived here on 2026-09-10: the route could total EVERY
    // haul while returning a filtered table and nothing noticed, because the
    // only assertion was against the helper. The cards would then describe
    // rows that are not on screen, which is the exact failure that makes a
    // filter something she stops believing.
    const filtered = await req('GET', '/api/metals-trucking?trucking_company=Bayou%20Haulage', { sid: admin });
    ck('the route applies her filter', filtered.status === 200
       && filtered.json.payables.every((r) => r.trucking_company === 'Bayou Haulage'),
       JSON.stringify(filtered.json.payables.map((r) => r.trucking_company)));
    ck('  and totals the rows it returned, not every row',
       filtered.json.summary.amount
         === Math.round(filtered.json.payables.reduce((t, r) => t + r.amount, 0) * 100) / 100,
       JSON.stringify({ card: filtered.json.summary.amount,
                        rows: filtered.json.payables.reduce((t, r) => t + r.amount, 0) }));
    ck('    while still saying how many there are in total',
       filtered.json.total_unfiltered > filtered.json.payables.length,
       JSON.stringify({ shown: filtered.json.payables.length, all: filtered.json.total_unfiltered }));
    ck('  the facets come from EVERY row, not the filtered ones',
       (filtered.json.facets.trucking_company || []).includes('Sher Trucking'),
       'narrowing by trucker would otherwise empty the trucker list she just used');

    const crossed = await req('POST', '/api/metals-trucking', { sid: admin, body: {
        date: '09/12/2026', amount: 100, mode: 'Wire', bank: 'Chase',
        trucking_company: 'Sher Trucking', allocations: [{ bill_id: h3.id, amount: 100 }],
    } });
    ck('a payment cannot settle another haulier\'s container', crossed.status === 400, crossed.raw);
    ck('  naming who actually hauled it', /Bayou Haulage/.test(crossed.json.error || ''), crossed.json.error);

    const over = await req('POST', '/api/metals-trucking', { sid: admin, body: {
        date: '09/12/2026', amount: 500, mode: 'Wire', bank: 'Chase',
        trucking_company: 'Sher Trucking', allocations: [{ bill_id: h1.id, amount: 500 }],
    } });
    ck('paying a settled haul again is refused', over.status === 400, over.raw);

    // ── ITS OWN LINE IN THE SPEND REPORT ─────────────────────────────────
    const rows = listPayments().filter((p) => p.load_kind === 'metals_trucking');
    ck('the transfer reaches the spend ledger', rows.length === 1, String(rows.length));
    ck('  under its own kind, not the yard\'s trucker line',
       rows[0].load_kind === 'metals_trucking',
       'one figure covering both companies could never be split again');
    const rep = spend.buildSpendReport({ payments: listPayments() });
    ck('  with its own total', rep.metalsTruckingTotal === 1600, String(rep.metalsTruckingTotal));
    ck('    kept out of the yard trucker total',
       rep.truckerTotal === 0 || !rep.rows.some((x) => x.kind === 'trucker' && x.amount === 1600),
       JSON.stringify({ trucker: rep.truckerTotal, metals: rep.metalsTruckingTotal }));

    // Cash out on Metals haulage must not touch the yard box.
    const petty = require(path.join(ROOT, 'helpers/pettyCash'));
    await petty.addTopUp({ date: '09/13/2026', amount: 2000, note: 'haulage test float' });
    const before = petty.balance();
    const cash = await req('POST', '/api/metals-trucking', { sid: admin, body: {
        date: '09/13/2026', amount: 900, mode: 'Cash', trucking_company: 'Bayou Haulage',
        allocations: [{ bill_id: h3.id, amount: 900 }],
    } });
    ck('a cash haulage payment records with no bank', cash.status === 200, cash.raw);
    ck('  and does NOT move the Edge Yard petty cash box',
       petty.balance() === before, `${before} -> ${petty.balance()}`);

    // ── THE ROWS ARE DERIVED, SO THEY FOLLOW THE BILL ────────────────────
    await req('PUT', `/api/bills/${h1.id}`, { sid: admin, body: { trucking_amount: 1500 } });
    ck('changing the bill changes the haulage line',
       mt.payables().find((r) => r.bill_id === h1.id).amount === 1500,
       'nothing is copied, so nothing can go stale');
    ck('  and what was paid against it still counts',
       mt.payables().find((r) => r.bill_id === h1.id).balance === 300,
       String(mt.payables().find((r) => r.bill_id === h1.id).balance));

    const audit = require(path.join(ROOT, 'helpers/audit'));
    const pid = pay.json.payment.id;
    const gone = await req('DELETE', `/api/metals-trucking/${pid}`, { sid: admin });
    ck('deleting a haulage payment succeeds', gone.status === 200, gone.raw);
    ck('  the hauls owe again',
       mt.payables().find((r) => r.bill_id === h2.id).status === 'unpaid');
    ck('  its ledger row goes too',
       listPayments().filter((p) => p.load_id === pid).length === 0);
    ck('  and it is audited',
       audit.listEntries().some((e) => e.subject === pid && e.action === 'delete-metals-trucking'));

    const staff = (await login('staff-pw-ccccccccccc')).json.sid;
    ck('staff cannot reach Metals haulage',
       (await req('GET', '/api/metals-trucking', { sid: staff })).status === 403,
       'the YARD trucker tab is theirs; this one is not');
}

section('T — several grades on one invoice');
{
    // Apsara, 2026-09-10: "Once bill thing are fixed,i want outgoing sales to
    // be fixed to support multi item in a container."
    const admin = (await login('admin-pw-bbbbbbbbbbb')).json.sid;
    const round2 = (n) => Math.round(n * 100) / 100;
    const round3 = (n) => Math.round(n * 1000) / 1000;

    const multi = sales.compute({ commission_per_mt: 6, items: [
        { description: 'Al combo',  weight: 15800, price: 0.41 },
        { description: 'Auto cast', weight: 11900, price: 0.38 },
    ] });
    ck('each grade is invoiced on its own weight and price',
       multi.items.map((i) => i.amount).join(',') === '6478,4522',
       JSON.stringify(multi.items.map((i) => i.amount)));
    ck('  and the invoice is their sum', multi.amount === 11000, String(multi.amount));
    ck('  the weight is the lines\' total, not something typed beside them',
       multi.weight_lb === 27700, String(multi.weight_lb));
    ck('  and the row says the weight came from the lines',
       multi.weights_from_items === true);

    // THE ONE THAT MATTERS. Commission is weight x rate, and the weight it
    // uses has to be the one on the invoice — the lines' total once there are
    // lines, or an agent is paid on a figure the document does not show.
    ck('commission runs off the LINES\' weight',
       multi.commission_amount === round2(round3(27700 / bills.LB_PER_MT) * 6),
       String(multi.commission_amount));

    // The purchase side's own function, imported rather than written twice —
    // the two are joined on booking + container for margin, and two
    // implementations of "a grade line" would eventually disagree about how
    // one is priced.
    ck('a sale line takes a weighbridge ticket, exactly as a bill line does',
       sales.compute({ items: [{ description: 'A', gross: 30000, truck: 14000,
                                 boxes: 200, price: 0.41 }] }).weight_lb === 15800,
       'one cleanItems, not two');
    ck('  and the $10 rule applies per line here too',
       sales.compute({ items: [{ description: 'Z', weight: 27700, price: 700 }] })
            .items[0].price_unit === 'mt');

    const conflict = sales.compute({ weight: 29000, items: [
        { description: 'Al combo', weight: 15800, price: 0.41 } ] });
    ck('a weight she typed is reported, not overwritten in silence',
       conflict.weight_conflict === round3(29000 - 15800), String(conflict.weight_conflict));
    ck('  while the lines still decide', conflict.weight_lb === 15800);

    const single = sales.compute({ weight: 29000, invoice_price: 0.41, commission_per_mt: 6 });
    ck('a sale with no lines works exactly as before',
       single.amount === 11890 && single.items.length === 0, String(single.amount));
    ck('  and reports no conflict about lines it does not have',
       single.weight_conflict === null);
    ck('  her stated invoice amount still wins',
       sales.compute({ invoice_amount: 12000, items: [
           { description: 'A', weight: 15800, price: 0.41 } ] }).amount === 12000,
       'the invoice is the document of record');

    const saved = await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Multi Co', booking_no: 'MULTIBK', container_no: 'MULTU1',
        terms: 'TT', commission_per_mt: 6,
        items: [{ description: 'Al combo', weight: 15800, price: 0.41 },
                { description: 'Auto cast', weight: 11900, price: 0.38 }],
    } });
    ck('a multi-grade sale saves through the route', saved.status === 200, saved.raw);
    ck('  with both lines', (saved.json.sale.items || []).length === 2);
    ck('  the invoice summed from them', saved.json.sale.amount === 11000,
       String(saved.json.sale.amount));
    ck('  and its commission off their weight',
       saved.json.sale.commission_amount === round2(round3(27700 / bills.LB_PER_MT) * 6),
       String(saved.json.sale.commission_amount));

    const noDesc = await req('POST', '/api/sales', { sid: admin, body: {
        date: '09/10/2026', customer: 'Multi Co', items: [{ weight: 100, price: 0.4 }] } });
    ck('a line with no description is refused here too', noDesc.status === 400, noDesc.raw);

    // Every line keeps its id across saves, so anything pointing at one keeps
    // pointing at the same one.
    const ids = (saved.json.sale.items || []).map((i) => i.id);
    const edited = await req('PUT', `/api/sales/${saved.json.sale.id}`, { sid: admin, body: {
        items: saved.json.sale.items } });
    ck('line ids survive an edit',
       (edited.json.sale.items || []).map((i) => i.id).join(',') === ids.join(','),
       'by array index, deleting a middle line moves everything below it');
}

if (server) server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
