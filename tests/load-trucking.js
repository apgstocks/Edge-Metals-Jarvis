// ── tests/load-trucking.js ────────────────────────────────────────────────
// Apsara, 2026-09-20: "in yard app,what if my load includes trucking?" —
// answered "Both happen, depending on the seller", meaning she sometimes pays
// an outside hauler separately (which Trucker Bills already handled) and
// sometimes collects the metal herself and pays the SELLER less by the
// haulage (which had nowhere to live).
//
// Then: "trucking in loads should put a entry in trucker bills right?" —
// sometimes, and the whole of section E exists because the answer is not
// always. A deduction with no outside hauler behind it must NOT write a
// payable, or helpers/yardProfit.js subtracts money that never left.
//
// ── WHAT EACH SECTION IS GUARDING ─────────────────────────────────────────
//   A  the record: amount untouched, net_payable derived
//   B  an edit without the key PRESERVES — this is her installed APK
//   C  every "what is owed" reader agrees with the ledger
//   D  yard profit counts the haulage once, not twice
//   E  the trucker bill is offered, never silent, never duplicated
//   F  the documents she and the seller actually hold
//   G  END TO END through the real routes

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-loadtruck-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) { console.error('  ABORT  config not isolated'); process.exit(1); }

const loads = require(path.join(ROOT, 'helpers/loads'));
const truckerBills = require(path.join(ROOT, 'helpers/truckerBills'));
const loadTruckerBill = require(path.join(ROOT, 'helpers/loadTruckerBill'));

// One item, priced so the arithmetic is checkable by eye: 15,000 lb of net
// at $0.20 is $3,000 exactly, and a $200 haul leaves $2,800.
const ITEMS = [{ description: 'Sealed units', gross_weight: 16000, tare_weight: 1000, price: 0.2, unit: 'lb' }];

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — the record');

{
    const plain = await loads.addLoad({ date: '2026-09-20', seller: 'Ramesh', items: ITEMS });
    ck('a load with no trucking still totals the metal', plain.amount === 3000, `amount=${plain.amount}`);
    // The property, not the shape: whatever net_payable is called or stored
    // as, a load with no deduction must be payable in full. A mutation that
    // makes net_payable null here has to turn this red.
    ck('no deduction means payable equals amount', loads.payableOf(plain) === 3000, `payable=${loads.payableOf(plain)}`);
    ck('no deduction stores no trucking amount', plain.trucking_amount === null);

    const ded = await loads.addLoad({
        date: '2026-09-20', seller: 'Suresh', items: ITEMS,
        trucking_company: 'Bay Area Hauling', trucking_amount: 200, trucking_note: 'collected from his shop',
    });
    // THE RULE THIS FEATURE IS BUILT ON. `amount` is the figure on the ticket
    // the seller signs. Netting the haulage into it would mean her record and
    // his copy never agree again — the same rule helpers/bills.js states for
    // a supplier invoice.
    ck('a deduction does NOT reduce amount', ded.amount === 3000, `amount=${ded.amount}`);
    ck('the deduction lands in net_payable', ded.net_payable === 2800, `net_payable=${ded.net_payable}`);
    ck('payableOf reports the net', loads.payableOf(ded) === 2800);
    ck('the hauler is recorded', ded.trucking_company === 'Bay Area Hauling');
    ck('the note is recorded', ded.trucking_note === 'collected from his shop');

    // A load recorded before this feature existed has no net_payable key at
    // all. It must read as "no deduction", not as "owes nothing" — the
    // difference between the two is every load in her file.
    ck('a pre-existing load with no net_payable falls back to amount',
        loads.payableOf({ id: 'OLD', amount: 1234 }) === 1234);
    ck('a load with no price has no payable, not a zero one',
        loads.payableOf({ id: 'OLD2', amount: null }) === null);
    // 0 - trucking would invent a debt the SELLER owes HER.
    ck('payableFrom on a null amount stays null', loads.payableFrom(null, 500) === null);
    ck('payableFrom rounds to cents', loads.payableFrom(100.005, 0.001) === 100);
}

// ══════════════════════════════════════════════════════════════════════════
section('B — an edit without the key preserves the deduction');
// ══════════════════════════════════════════════════════════════════════════
// THE REASON THIS FEATURE HAS A CONDITIONAL AT ALL. The APK on her phone was
// built before trucking existed and will keep PUTting loads without these
// keys until a new build ships. If absence meant "no deduction", every edit
// made on the phone would silently wipe one entered at the desk — a money bug
// shipped by construction, found weeks later by paying a seller $200 too much.

{
    const l = await loads.addLoad({
        date: '2026-09-20', seller: 'Old APK Test', items: ITEMS,
        trucking_company: 'Bay Area Hauling', trucking_amount: 200,
    });

    // Exactly what the old client sends: every field it knows about, and not
    // one word about trucking.
    const afterOldClient = await loads.editLoad(l.id, {
        date: '2026-09-21', seller: 'Old APK Test', seller_address: null, seller_phone: null,
        buyer: null, buyer_address: null, description: '', items: ITEMS, weight_unit: 'lb',
    });
    ck('an edit that never mentions trucking keeps the amount', afterOldClient.trucking_amount === 200,
        `trucking_amount=${afterOldClient.trucking_amount}`);
    ck('an edit that never mentions trucking keeps the hauler', afterOldClient.trucking_company === 'Bay Area Hauling');
    ck('and the date it DID send still changed', afterOldClient.date === '2026-09-21');
    ck('net_payable survives that edit', afterOldClient.net_payable === 2800);

    // ── AND IT IS RECOMPUTED, NOT CARRIED ─────────────────────────────────
    // An edit can change the items without mentioning trucking. A net_payable
    // left over from the old amount is a wrong number that looks right.
    const cheaper = [{ ...ITEMS[0], price: 0.1 }];   // 15,000 lb @ $0.10 = $1,500
    const afterItems = await loads.editLoad(l.id, {
        date: '2026-09-21', seller: 'Old APK Test', items: cheaper, weight_unit: 'lb',
    });
    ck('changing items recomputes the amount', afterItems.amount === 1500, `amount=${afterItems.amount}`);
    ck('changing items recomputes the payable from the SURVIVING trucking',
        afterItems.net_payable === 1300, `net_payable=${afterItems.net_payable}`);

    // A client that knows about the field clears it by sending it empty.
    const cleared = await loads.editLoad(l.id, {
        date: '2026-09-21', seller: 'Old APK Test', items: cheaper, weight_unit: 'lb',
        trucking_company: '', trucking_amount: '', trucking_note: '',
    });
    ck('sending the key empty clears the deduction', cleared.trucking_amount === null);
    ck('and the payable goes back to the full amount', cleared.net_payable === 1500);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — every reader of "what is owed" agrees');
// ══════════════════════════════════════════════════════════════════════════
// There are twenty call sites that ask paymentSummary what a load is worth.
// A figure that disagrees between the card, the ticket, the pay sheet and
// what Jarvis says out loud is worse than no figure at all.

{
    const l = await loads.addLoad({
        date: '2026-09-20', seller: 'Owed Test', items: ITEMS,
        trucking_company: 'Bay Area Hauling', trucking_amount: 200,
    });
    const { paymentSummary } = require(path.join(ROOT, 'helpers/payments'));

    const asPayable = paymentSummary(l.id, loads.payableOf(l));
    ck('nothing paid yet leaves the NET outstanding, not the gross',
        asPayable.pending === 2800, `pending=${asPayable.pending}`);

    // The voice tools are the callers CLAUDE.md warns about twice over.
    const tools = require(path.join(ROOT, 'helpers/tools'));
    const detail = await tools.TOOLS.load_detail.run({ load_id: l.id });
    ck('load_detail found it', detail.found === true);
    ck('load_detail reports the metal figure', detail.load.amount === 3000);
    ck('load_detail reports the payable SEPARATELY', detail.load.net_payable === 2800,
        `net_payable=${detail.load && detail.load.net_payable}`);
    ck('load_detail measures the balance against the payable', detail.summary.pending === 2800,
        `pending=${detail.summary && detail.summary.pending}`);

    const found = await tools.TOOLS.find_loads.run({ seller: 'Owed Test' });
    const row = (found.loads || found.rows || []).find((r) => r.id === l.id);
    ck('find_loads returns the row', !!row);
    if (row) {
        ck('find_loads carries the payable', row.net_payable === 2800, `net_payable=${row.net_payable}`);
        ck('find_loads measures pending against it', row.payment.pending === 2800, `pending=${row.payment.pending}`);
    }

    // The brief the assistant reads aloud.
    const brief = require(path.join(ROOT, 'helpers/yardBrief'));
    const b = await brief.buildYardBrief ? await brief.buildYardBrief() : null;
    if (b && Array.isArray(b.outstanding)) {
        const o = b.outstanding.find((x) => x.load_id === l.id);
        ck('the brief lists it as outstanding', !!o);
        // `total` on this list means WHAT IS OWED. The metal's figure rides
        // along beside it so the model can explain the gap, rather than
        // replacing it and leaving two numbers that do not subtract.
        if (o) ck('the brief owes the net, not the gross',
            String(o.total).replace(/[^0-9.]/g, '') === '2800.00', `total=${o.total}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the haulage is counted once');
// ══════════════════════════════════════════════════════════════════════════
// helpers/yardProfit.js ALREADY subtracts every trucker bill. If the same
// haulage also sat inside a load's `amount`, the report would claim she spent
// the deduction on top of paying it.

{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-profit-'));
    // A clean store, so the figure below is not a hostage to earlier sections.
    const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
    await mutateJson(cfg.LOADS_FILE, [], () => ([
        { id: 'P_PLAIN', date: '2026-09-20', seller: 'A', amount: 1000, net_payable: 1000, items: [] },
        { id: 'P_DED',   date: '2026-09-20', seller: 'B', amount: 2000, net_payable: 1800,
          trucking_company: 'Bay Area Hauling', trucking_amount: 200, items: [] },
    ]));
    await mutateJson(cfg.TRUCKER_BILLS_FILE, [], () => ([
        { id: 'TRK_1', date: '2026-09-20', company: 'Bay Area Hauling', amount: 200, load_ticket: 'P_DED' },
    ]));

    const { yardProfit } = require(path.join(ROOT, 'helpers/yardProfit'));
    const r = yardProfit({ from: '2026-09-20', to: '2026-09-20' });

    // $1,000 to A in full + $1,800 to B after the deduction = $2,800 for metal,
    // and the $200 haul shows once, on its own line.
    ck('bought is what actually left her hand for metal', r.cash.bought === 2800, `bought=${r.cash.bought}`);
    ck('trucking is the trucker bill', r.cash.trucking === 200, `trucking=${r.cash.trucking}`);
    // THE PROPERTY, stated as arithmetic rather than as a constant: the two
    // lines must add back up to the loads' gross figures. A mutation that
    // leaves `bought` on l.amount makes this 3200 and turns this red.
    ck('bought + trucking equals what the loads are worth gross',
        r.cash.bought + r.cash.trucking === 3000, `${r.cash.bought} + ${r.cash.trucking}`);

    fs.rmSync(dir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the trucker bill is offered, never silent');
// ══════════════════════════════════════════════════════════════════════════

{
    const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
    await mutateJson(cfg.TRUCKER_BILLS_FILE, [], () => ([]));

    // 1. HER OWN TRUCK. A deduction with no hauler named must write nothing —
    //    a bill here is a payable to nobody, and yardProfit would subtract
    //    money that never moved.
    const own = { id: 'OWN_1', date: '2026-09-20', seller: 'Ramesh', amount: 3000, trucking_amount: 200, trucking_company: null };
    // Caught, not awaited bare. The helper's contract is that it never throws
    // for a BUSINESS reason — a load must still save when the bill cannot be
    // made. Without this the no-hauler mutation killed the suite with a stack
    // trace instead of a named failure, which reads as "something is broken"
    // rather than "this rule is gone".
    let r1, r1Threw = null;
    try { r1 = await loadTruckerBill.maybeCreateTruckerBill(own, { wanted: true }); }
    catch (e) { r1Threw = e; r1 = {}; }
    ck('it refuses without throwing — a load must still save', r1Threw === null,
        r1Threw && r1Threw.message);
    ck('no hauler named writes no bill', !r1.created && r1.reason === 'no_trucking_company', JSON.stringify(r1));
    ck('and it says WHY, rather than doing nothing quietly', !!r1.reason);
    ck('the store is still empty', truckerBills.listBills().length === 0);

    // 2. NOT ASKED. Trucking on a load is not by itself a request for a bill.
    // ── DATED IN THE PAST ON PURPOSE ──────────────────────────────────
    // This fixture used today's date, and the "the bill takes the LOAD date"
    // check below passed while a mutation replacing it with todayLocal()
    // survived — the two strings were identical, so the check could not tell
    // them apart. A haul recorded a few days late is the case that matters:
    // a bill dated today moves her trucking spend into the wrong month.
    const HAUL_DAY = '2026-08-11';
    const outside = { id: 'OUT_1', date: HAUL_DAY, seller: 'Suresh', amount: 3000,
                      trucking_amount: 200, trucking_company: 'Bay Area Hauling' };
    const r2 = await loadTruckerBill.maybeCreateTruckerBill(outside, { wanted: false });
    ck('an unticked box writes no bill', !r2.created && r2.reason === 'not_requested');
    ck('still empty', truckerBills.listBills().length === 0);

    // 3. ASKED, WITH A HAULER. The real case.
    const r3 = await loadTruckerBill.maybeCreateTruckerBill(outside, { wanted: true, createdBy: 'tester' });
    ck('a ticked box with a hauler writes the bill', r3.created === true, JSON.stringify(r3));
    ck('the bill carries the amount', r3.bill && r3.bill.amount === 200);
    ck('the bill carries the hauler', r3.bill && r3.bill.company === 'Bay Area Hauling');
    // The free-text cross-reference the store already had. NOT a foreign key —
    // helpers/truckerBills.js's header says why that must stay true.
    ck('the bill points back at the load ticket', r3.bill && r3.bill.load_ticket === 'OUT_1');
    const today = require(path.join(ROOT, 'helpers/time')).todayLocal();
    ck('the fixture is not dated today, or the next check proves nothing', HAUL_DAY !== today);
    ck('the bill takes the LOAD date, not today', r3.bill && r3.bill.date === HAUL_DAY,
        `date=${r3.bill && r3.bill.date}, today=${today}`);

    // 4. ASKED TWICE. Ticking the box again on an edit must not double the debt.
    const r4 = await loadTruckerBill.maybeCreateTruckerBill(outside, { wanted: true });
    ck('a second ask writes nothing', !r4.created && r4.reason === 'already_exists', JSON.stringify(r4));
    ck('and names the bill that already exists', r4.bill_id === r3.bill.id);
    ck('exactly one bill exists for this load', truckerBills.billsForLoadTicket('OUT_1').length === 1);
    ck('the store holds one bill in total', truckerBills.listBills().length === 1);

    // The lookup must not be defeated by how the ticket was typed — but it
    // must also not match everything.
    ck('the ticket lookup is case-insensitive', truckerBills.billsForLoadTicket('out_1').length === 1);
    ck('a blank ticket matches nothing', truckerBills.billsForLoadTicket('').length === 0);
    ck('an unrelated ticket matches nothing', truckerBills.billsForLoadTicket('OUT_2').length === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('F — the documents she and the seller hold');

{
    const { generateLoadPdf, generateLoadReceiptPdf } = require(path.join(ROOT, 'helpers/pdf'));
    const base = {
        id: 'DOC_1', date: '2026-09-20', seller: 'Ramesh', buyer: 'Edge Trading',
        gross_weight: 16000, tare_weight: 1000, net_weight: 15000, amount: 3000, weight_unit: 'lb',
        items: [{ description: 'Sealed units', gross_weight: 16000, tare_weight: 1000, net_weight: 15000, price: 0.2, unit: 'lb', amount: 3000 }],
    };
    // ── REAL TEXT, NOT THE RAW BYTES ─────────────────────────────────────
    // buf.toString() was the first attempt and it was worthless: PDFKit
    // Flate-compresses its content streams, so every string in the document
    // is invisible to a substring search. The "no deduction shows nothing"
    // checks below PASSED against it — vacuously, because nothing is findable
    // either way — which is precisely the check-shaped-like-the-code trap.
    //
    // pdf-parse was the second attempt. It reads correctly, then throws from
    // inside its own bundled pdf.js on a later call in the same process — so
    // the section went red with a stack trace instead of a named failure, in a
    // suite of 149 files where that reads as "something is broken" and not as
    // "this extractor is fragile".
    //
    // So: inflate the content streams here. Twelve lines, no dependency, no
    // global state, and it either finds the string or it does not.
    const zlib = require('zlib');
    const text = async (buf) => {
        let raw = '';
        let i = 0;
        while ((i = buf.indexOf('stream', i)) !== -1) {
            let s = i + 6;
            if (buf[s] === 0x0d) s++;
            if (buf[s] === 0x0a) s++;
            const end = buf.indexOf('endstream', s);
            if (end === -1) break;
            // Uncompressed streams (fonts, images) simply fail to inflate and
            // are skipped — a font's bytes are not text this test cares about.
            try { raw += zlib.inflateSync(buf.slice(s, end)).toString('latin1'); } catch (e) { /* not flate */ }
            i = end + 9;
        }
        // PDFKit writes each run as a hex glyph string inside a TJ array with
        // KERNING NUMBERS between the runs: [<4c657373> 20 <20747275636b696e67>].
        // Decoding in place and leaving the numbers where they were produced
        // "Less 20  trucking", which no substring search will ever match — the
        // checks below all went red against correct output until this took the
        // hex runs ALONE and joined them.
        return (raw.match(/<[0-9A-Fa-f]+>/g) || [])
            .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
            .join('');
    };

    const plain = await text(await generateLoadPdf({ ...base }));
    // EVERY OTHER TICKET IN THE BOOK IS UNCHANGED. A "Trucking $0.00" line on
    // a document nobody asked to change is the over-reach CLAUDE.md is about.
    ck('a ticket with no deduction says nothing about trucking', !/Less trucking/.test(plain));
    ck('a ticket with no deduction says nothing about a net payable', !/Net payable/.test(plain));

    const ded = await text(await generateLoadPdf({ ...base, trucking_company: 'Bay Area Hauling', trucking_amount: 200 }));
    ck('a ticket WITH a deduction shows it', /Less trucking/.test(ded));
    ck('and shows what the seller is actually handed', /Net payable/.test(ded));
    ck('the ticket still carries the metal figure too', /Amount total/.test(ded));

    // A buyer's copy has no business carrying what she paid a hauler on the
    // way in.
    const sale = await text(await generateLoadPdf({ ...base, trucking_company: 'Bay Area Hauling', trucking_amount: 200 }, { kind: 'sale' }));
    ck('a SALE ticket never shows a trucking deduction', !/Less trucking/.test(sale));

    // The slip that physically leaves with the seller — the one he holds up
    // when the cash does not match.
    const rcptPlain = await text(await generateLoadReceiptPdf({ ...base }));
    ck('a receipt with no deduction is unchanged', !/Less trucking/.test(rcptPlain));
    const rcptDed = await text(await generateLoadReceiptPdf({ ...base, trucking_company: 'Bay Area Hauling', trucking_amount: 200 }));
    ck('a receipt WITH a deduction shows it', /Less trucking/.test(rcptDed));
    ck('and shows the net payable', /Net payable/.test(rcptDed));
}

// ══════════════════════════════════════════════════════════════════════════
section('G — END TO END, through the real routes');
// ══════════════════════════════════════════════════════════════════════════
// Apsara, 2026-09-17: "ALwyas test end to end when you add a new feature."
// Every section above can pass while the feature does not work: the route may
// not forward the field, the client may send a key the server never reads.
// So: a real server, a real login, a load posted the way the form posts it,
// and the payable read back out of the route the card reads.

{
    const http = require('http');
    process.env.APP_PASSWORD   = process.env.APP_PASSWORD   || 'user-pw-aaaaaaaaaaaa';
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pw-bbbbbbbbbbb';
    process.env.STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'staff-pw-ccccccccccc';

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r2 = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r2.on('error', reject); if (data) r2.write(data); r2.end();
    });

    const sid = ((await req('POST', '/login', { body: { password: process.env.ADMIN_PASSWORD } })).json || {}).sid;
    ck('signed in', !!sid);

    const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
    await mutateJson(cfg.TRUCKER_BILLS_FILE, [], () => ([]));
    const billsBefore = truckerBills.listBills().length;

    // Posted the way the Loads form posts it, trucking and checkbox included.
    const created = await req('POST', '/api/loads', { sid, body: {
        date: '2026-09-20', seller: 'E2E Seller', buyer: 'Edge Trading',
        items: ITEMS, weight_unit: 'lb',
        trucking_company: 'Bay Area Hauling', trucking_amount: 200, trucking_note: 'picked up',
        create_trucker_bill: true,
        client_request_id: 'e2e-trucking-1',
    } });
    ck('the route accepted the load', created.status === 200, `status=${created.status}`);
    const id = created.json && created.json.load && created.json.load.id;
    ck('it has an id', !!id);
    ck('the route stored the deduction', created.json.load.trucking_amount === 200,
        `trucking_amount=${created.json.load && created.json.load.trucking_amount}`);
    ck('the route derived the payable', created.json.load.net_payable === 2800,
        `net_payable=${created.json.load && created.json.load.net_payable}`);
    ck('the route reports what happened to the ticked box', !!created.json.trucker_bill);
    ck('and it created the bill', created.json.trucker_bill && created.json.trucker_bill.created === true,
        JSON.stringify(created.json.trucker_bill));
    // A DELTA, not an absolute — earlier sections write to this store, and a
    // test that breaks when an unrelated fixture moves is a test that gets
    // deleted.
    ck('exactly one bill was added', truckerBills.listBills().length - billsBefore === 1);

    // Read back out of the route the CARD reads.
    const list = await req('GET', '/api/loads', { sid });
    const row = (list.json || []).find((l) => l.id === id);
    ck('the card route returns it', !!row);
    if (row) {
        ck('the card gets the metal figure', row.amount === 3000);
        ck('the card gets the payable', row.net_payable === 2800, `net_payable=${row.net_payable}`);
        // THE GAP THIS SECTION EXISTS TO CATCH. The helper can be right and
        // the route can still hand the card a balance measured against the
        // wrong total.
        ck('the card balance is measured against the payable',
            row.payment && row.payment.pending === 2800, `pending=${row.payment && row.payment.pending}`);
    }

    // Ticking the box again on an edit must not double her debt.
    const edited = await req('PUT', `/api/loads/${encodeURIComponent(id)}`, { sid, body: {
        date: '2026-09-20', seller: 'E2E Seller', buyer: 'Edge Trading', items: ITEMS, weight_unit: 'lb',
        trucking_company: 'Bay Area Hauling', trucking_amount: 200, create_trucker_bill: true,
    } });
    ck('the edit succeeded', edited.status === 200, `status=${edited.status}`);
    ck('the edit refused to write a second bill',
        edited.json.trucker_bill && edited.json.trucker_bill.reason === 'already_exists',
        JSON.stringify(edited.json.trucker_bill));
    ck('still exactly one bill', truckerBills.listBills().length - billsBefore === 1);

    // ── THE OLD APK, THROUGH THE REAL ROUTE ───────────────────────────────
    // The single most valuable check in this file. A PUT with no trucking key
    // at all is what her phone sends, and it must leave the deduction alone.
    const fromOldApk = await req('PUT', `/api/loads/${encodeURIComponent(id)}`, { sid, body: {
        date: '2026-09-21', seller: 'E2E Seller', buyer: 'Edge Trading', items: ITEMS, weight_unit: 'lb',
    } });
    ck('the old-client edit succeeded', fromOldApk.status === 200);
    ck('a PUT with no trucking key did NOT wipe the deduction',
        fromOldApk.json.load && fromOldApk.json.load.trucking_amount === 200,
        `trucking_amount=${fromOldApk.json.load && fromOldApk.json.load.trucking_amount}`);
    ck('and the payable is intact', fromOldApk.json.load && fromOldApk.json.load.net_payable === 2800);
    ck('while the field it DID send changed', fromOldApk.json.load && fromOldApk.json.load.date === '2026-09-21');

    // Cash comes out of petty cash, which starts empty in a fresh store —
    // the payment route refuses with PETTY_CASH_EMPTY otherwise, which is
    // correct behaviour and not what this section is testing.
    await require(path.join(ROOT, 'helpers/pettyCash')).addTopUp({ amount: 50000, date: '2026-09-20', note: 'float' });

    // A payment of the NET settles the load. Under the old arithmetic this
    // would read as $200 still outstanding.
    const paid = await req('POST', '/api/payments', { sid, body: {
        load_id: id, load_kind: 'purchase', amount: 2800, mode: 'Cash', paid_on: '2026-09-21',
    } });
    ck('the payment posted', paid.status === 200, `status=${paid.status} ${JSON.stringify(paid.json)}`);
    const after = await req('GET', '/api/loads', { sid });
    const row2 = (after.json || []).find((l) => l.id === id);
    ck('paying the NET settles the load',
        row2 && row2.payment && row2.payment.pending === 0, `pending=${row2 && row2.payment && row2.payment.pending}`);

    await new Promise((r) => server.close(r));
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\n  CRASH  ', e && e.stack || e); process.exit(1); });
