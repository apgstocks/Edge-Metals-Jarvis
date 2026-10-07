// ── tests/payment-edit-all.js ─────────────────────────────────────────────
// Apsara, 2026-10-07: "there should be an option to record the payment of
// trucker/commission/freight ... and option to edit".
//
// Paying them already existed, and so did paying several at once. Editing
// did not exist on ANY payment path. tests/payment-edit.js covers supplier
// bill payments; this covers the other two helpers, which between them
// carry all three cost types she named:
//
//   helpers/salesSettlements.js   freight (kind 'charge') AND commission
//   helpers/metalsTrucking.js     trucking
//
// Her two rules, identical on every path:
//   containers  "Recompute everything, show me before saving."
//   QuickBooks  "Refuse, and tell me to change both."
//
// Section A is the one that protects the rest: each edit must face the SAME
// validation its create faces. Three helpers with three slightly different
// rule sets is exactly where a second, laxer way in gets built.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const ck = (label, ok, detail) => {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; failures.push(label); console.log('  FAIL  ' + label); if (detail) console.log('        ' + detail); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-payedit-all-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

// ── SET BEFORE config IS REQUIRED, AND THAT IS NOT A STYLE CHOICE ────────
// config.js reads these ONCE at load. Section F's first draft set them inside
// the section, after the require below, and every signed-in request came back
// 401 — which reads exactly like a broken permission guard rather than a test
// that configured itself too late. tests/payment-edit.js lost the same hour.
process.env.APP_PASSWORD = 'user-pw-aaaaaaaaaaaa';
process.env.ADMIN_PASSWORD = 'admin-pw-bbbbbbbbbbb';
process.env.JARVIS_PASSWORD = 'jarvis-pw-ddddddddddd';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const ST = require(path.join(ROOT, 'helpers/salesSettlements'));
const TR = require(path.join(ROOT, 'helpers/metalsTrucking'));

// ── A REAL LEDGER, BECAUSE THE VALIDATORS READ ONE ───────────────────────
// cleanAllocations on both paths checks an allocation against what is
// actually OUTSTANDING — settlements via payables() over sales.json,
// trucking via payables() over bills.json. A fixture with no sales made the
// first version of this file throw on its very first assertion, which is the
// validator doing its job: you cannot pay a commission that does not exist.
//
// So: a sale carrying a commission and a freight charge, and a bill carrying
// trucking. The payable KEYS are then read back from payables() rather than
// guessed — the identity of a charge is this file's business, not the test's.
fs.writeFileSync(cfg.SALES_FILE, JSON.stringify([{
    id: 'S1', customer: 'ACME', date: '2026-03-01',
    container_no: 'CONT1', booking_no: 'BK1',
    item: 'Cu', weight: 20000, weight_unit: 'lb',
    invoice_price: 1.5, price_unit: 'lb',
    commission_per_mt: 30,
    // ── direction: 'out', AND THAT WAS A BUG IN THIS FIXTURE ─────────────
    // This charge was seeded as { label, amount, payer } with no direction.
    // payables() skips any charge whose direction is not 'out' ("'in' is a
    // receivable"), so it produced NO freight payable at all — and sections
    // B–E, which say they cover freight AND commission, were only ever
    // exercising commission. The file's own header claimed both. Found by
    // section F asking for an outstanding freight charge and being told
    // there wasn't one.
    charges: [{ id: 'C1', direction: 'out', what: 'Ocean freight',
                why: 'Zimex, CONT1', amount: 500 }],
}], null, 2));
fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify([
    { id: 'B1', container_no: 'CONT1', booking_no: 'BK1', date: '2026-03-01',
      supplier: 'DRM', supplier_invoice_amount: 20000, trucking_amount: 400,
      trucking_company: 'AJ Transport' },
    { id: 'B2', container_no: 'CONT2', booking_no: 'BK2', date: '2026-03-02',
      supplier: 'DRM', supplier_invoice_amount: 15000, trucking_amount: 300,
      trucking_company: 'AJ Transport' },
], null, 2));

(async () => {

// ── A — EACH EDIT FACES ITS OWN CREATE'S RULES ────────────────────────────
{
    section('A — one set of rules per helper, not two');

    ck('settlements export their validator', typeof ST.validateSettlementInput === 'function');
    ck('trucking exports its validator', typeof TR.validateTruckingInput === 'function');

    // The commission actually outstanding on the seeded sale. Read from
    // payables() rather than written here, because what a commission comes
    // to is sales.js's arithmetic, not the test's.
    const COMM = ST.payables().find((p) => p.kind === 'commission');
    ck('the seeded sale really has a commission outstanding',
       !!COMM && COMM.amount > 0, JSON.stringify(COMM));

    const goodSettle = { amount: COMM.amount, mode: 'Wire', bank: 'BofA', date: '2026-03-10',
        payee: 'Zimex', allocations: [{ sale_id: 'S1', kind: 'commission', amount: COMM.amount }] };
    global.__COMM = COMM;
    ck('a sound settlement validates', !!ST.validateSettlementInput(goodSettle));
    for (const [label, over, re] of [
        ['no amount', { amount: 0 }, /amount is required/],
        ['an unknown mode', { mode: 'Bitcoin' }, /payment mode must be one of/],
        ['no date', { date: '' }, /needs a date/],
        ['nobody being paid', { payee: '' }, /who is being paid/],
        ['a wire with no bank', { bank: '' }, /bank is required/],
        // The real message is better than the one I first expected: the
        // unallocated-remainder rule fires first and names the amount, so an
        // empty allocation list reads as "$272.16 of this payment is not
        // against any charge" rather than a bare "nothing was allocated".
        ['nothing allocated', { allocations: [] }, /not against any charge|nothing was allocated/],
    ]) {
        let msg = null;
        try { ST.validateSettlementInput({ ...goodSettle, ...over }); } catch (e) { msg = e.message; }
        ck(`  settlement: ${label} is refused`, re.test(String(msg)), String(msg));
    }

    const goodTruck = { amount: 300, mode: 'Wire', bank: 'BofA', date: '2026-03-10',
        trucking_company: 'AJ Transport', allocations: [{ bill_id: 'B1', amount: 300 }] };
    ck('a sound trucking payment validates', !!TR.validateTruckingInput(goodTruck));
    for (const [label, over, re] of [
        ['no amount', { amount: 0 }, /amount is required/],
        ['no company', { trucking_company: '' }, /who is being paid/],
        ['a wire with no bank', { bank: '' }, /bank is required/],
        ["nothing allocated", { allocations: [] }, /not against any container|nothing was allocated/],
    ]) {
        let msg = null;
        try { TR.validateTruckingInput({ ...goodTruck, ...over }); } catch (e) { msg = e.message; }
        ck(`  trucking: ${label} is refused`, re.test(String(msg)), String(msg));
    }

    // Cash carries no bank on either path.
    ck('  settlement cash keeps no bank',
       ST.validateSettlementInput({ ...goodSettle, mode: 'Cash', bank: 'BofA' }).bank === null);
    ck('  trucking cash keeps no bank',
       TR.validateTruckingInput({ ...goodTruck, mode: 'Cash', bank: 'BofA' }).bank === null);

    // Neither validator writes.
    for (const [name, file, fn] of [
        ['salesSettlements', 'helpers/salesSettlements.js', 'validateSettlementInput'],
        ['metalsTrucking', 'helpers/metalsTrucking.js', 'validateTruckingInput'],
    ]) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const body = src.slice(src.indexOf(`function ${fn}`), src.indexOf('async function add'));
        ck(`  ${name}'s validator touches no store`, !/mutateJson/.test(body));
    }
}

// ── B — SETTLEMENTS: FREIGHT AND COMMISSION ───────────────────────────────
{
    section('B — a freight and commission settlement, edited');

    const COMM = global.__COMM;
    const FULL = COMM.amount;
    const PART = Math.round((FULL / 2) * 100) / 100;

    const made = await ST.addSettlement({
        amount: FULL, mode: 'Wire', bank: 'BofA', date: '2026-03-10', payee: 'Zimex',
        allocations: [{ sale_id: 'S1', kind: 'commission', amount: FULL }],
    });
    ck('a commission settlement is recorded', made.amount === FULL, JSON.stringify(made.amount));

    const beforeFile = fs.readFileSync(cfg.SALES_SETTLEMENTS_FILE, 'utf8');
    const plan = ST.previewSettlementEdit(made.id, {
        amount: PART, allocations: [{ sale_id: 'S1', kind: 'commission', amount: PART }],
    });
    ck('  the preview shows the amount changing',
       plan.changes.some((c) => c.effect === 'amount changes'),
       JSON.stringify(plan.changes.map((c) => [c.kind, c.effect, c.paid_before, c.paid_after])));
    ck('  from the old figure to the new one',
       plan.changes.some((c) => c.paid_before === FULL && c.paid_after === PART),
       JSON.stringify(plan.changes));
    ck('  and it writes nothing',
       fs.readFileSync(cfg.SALES_SETTLEMENTS_FILE, 'utf8') === beforeFile,
       'a preview that writes is not a preview');
    ck('  the settlement is still the old amount until she says go',
       ST.list().find((s) => s.id === made.id).amount === FULL);

    // An edit that would not validate must fail at PREVIEW, not at save.
    let bad = null;
    try { ST.previewSettlementEdit(made.id, { mode: 'Bitcoin' }); } catch (e) { bad = e.message; }
    ck('  an invalid edit is refused before it is shown',
       /payment mode must be one of/.test(String(bad)), String(bad));

    const res = await ST.editSettlement(made.id, {
        amount: PART, allocations: [{ sale_id: 'S1', kind: 'commission', amount: PART }],
    }, { actor: 'test' });
    ck('  the edit applies', res.applied === true);
    const row = ST.list().find((s) => s.id === made.id);
    ck('  the amount really moved', row.amount === PART, JSON.stringify(row.amount));
    ck('  the id survives', row.id === made.id, 'an edit that changes the id is a delete and a create');
    ck('  and the original is kept',
       (row.edit_history || []).length === 1 && row.edit_history[0].was.amount === FULL,
       JSON.stringify(row.edit_history));

    // Appends, not replaces — one edit cannot prove this.
    await ST.editSettlement(made.id, { ref: 'SECOND' }, { actor: 'test2' });
    const twice = ST.list().find((s) => s.id === made.id);
    ck('  a second edit APPENDS to the history',
       (twice.edit_history || []).length === 2, String((twice.edit_history || []).length));
    ck('    and the FIRST version survives it',
       twice.edit_history[0].was.amount === FULL,
       'replacing instead of appending looks identical after one edit — this is what catches it');
    ck('  with exactly one ledger row after two edits',
       require(path.join(ROOT, 'helpers/payments')).listPayments()
           .filter((r) => String(r.load_id) === String(made.id)).length === 1,
       'mirroring before deleting would have removed both');
    global.__ST_ID = made.id;
}

// ── C — TRUCKING ──────────────────────────────────────────────────────────
{
    section('C — a trucking payment, edited');

    const made = await TR.addTruckingPayment({
        amount: 700, mode: 'Wire', bank: 'BofA', date: '2026-03-12',
        trucking_company: 'AJ Transport',
        allocations: [{ bill_id: 'B1', amount: 400 }, { bill_id: 'B2', amount: 300 }],
    });
    ck('one payment covers two containers',
       (made.allocations || []).length === 2, JSON.stringify(made.allocations));

    const plan = TR.previewTruckingEdit(made.id, {
        amount: 400, allocations: [{ bill_id: 'B1', amount: 400 }],
    });
    ck('  the preview says one is dropped', plan.dropped === 1, JSON.stringify(plan.changes));
    ck('  and names what it used to be paid',
       plan.changes.some((c) => c.paid_before === 300 && c.paid_after === 0),
       JSON.stringify(plan.changes));

    const res = await TR.editTruckingPayment(made.id, {
        amount: 400, allocations: [{ bill_id: 'B1', amount: 400 }],
    }, { actor: 'test' });
    ck('  the edit applies', res.applied === true);
    const row = TR.list().find((p) => p.id === made.id);
    ck('  only one allocation remains', (row.allocations || []).length === 1, JSON.stringify(row.allocations));
    ck('  and the original is kept',
       row.edit_history[0].was.allocations.length === 2, JSON.stringify(row.edit_history[0].was));
    global.__TR_ID = made.id;
}

// ── D — QUICKBOOKS REFUSES, AND FAILS CLOSED, ON BOTH ─────────────────────
{
    section('D — her rule, on both paths');

    const qbPath = require.resolve(path.join(ROOT, 'helpers/qbLinked'));
    const real = require.cache[qbPath];

    for (const [name, mod, id, fn] of [
        ['settlement', ST, global.__ST_ID, 'editSettlement'],
        ['trucking', TR, global.__TR_ID, 'editTruckingPayment'],
    ]) {
        require.cache[qbPath] = { id: qbPath, filename: qbPath, loaded: true, exports: {
            liveKeys: () => ({}), linkedRow: () => ({ linked: true, why: 'pushed as #99' }) } };
        let msg = null;
        try { await mod[fn](id, { ref: 'X' }); } catch (e) { msg = e.message; }
        ck(`a linked ${name} is REFUSED`, /already in QuickBooks/.test(String(msg)), String(msg));
        ck(`  and it tells her to change both`, /Change it in both/.test(String(msg)), String(msg));

        require.cache[qbPath] = { id: qbPath, filename: qbPath, loaded: true, exports: {
            liveKeys: () => { throw new Error('token expired'); }, linkedRow: () => ({ linked: false }) } };
        msg = null;
        try { await mod[fn](id, { ref: 'Y' }); } catch (e) { msg = e.message; }
        ck(`  ${name} FAILS CLOSED when QuickBooks cannot be reached`,
           /could not check QuickBooks/.test(String(msg)), String(msg));
        ck(`    saying nothing was changed`, /Nothing was changed/.test(String(msg)), String(msg));
    }

    if (real) require.cache[qbPath] = real; else delete require.cache[qbPath];

    // And neither actually wrote.
    ck('neither payment was touched',
       ST.list().find((s) => s.id === global.__ST_ID).ref !== 'X'
       && TR.list().find((p) => p.id === global.__TR_ID).ref !== 'X');
}

// ── E — THE EDGES ─────────────────────────────────────────────────────────
{
    section('E — the edges, on both');

    for (const [name, mod, preview, edit] of [
        ['settlement', ST, 'previewSettlementEdit', 'editSettlement'],
        ['trucking', TR, 'previewTruckingEdit', 'editTruckingPayment'],
    ]) {
        let msg = null;
        try { mod[preview]('NOPE', {}); } catch (e) { msg = e.message; }
        ck(`previewing a ${name} that does not exist is refused`, /NOPE/.test(String(msg)), String(msg));
        msg = null;
        try { await mod[edit]('NOPE', {}); } catch (e) { msg = e.message; }
        ck(`  and editing one`, /NOPE/.test(String(msg)), String(msg));
    }

    const same = ST.previewSettlementEdit(global.__ST_ID, {});
    ck('an empty patch changes nothing',
       same.dropped === 0 && same.added === 0 && same.touchesLedger === false, JSON.stringify(same.dropped));
}

// ── F — END TO END, THROUGH THE ROUTES THE SCREENS REALLY CALL ────────────
// "ALwyas test end to end when you add a new feature." Sections B–E prove the
// two helpers are right; they were right for a day while NOTHING could reach
// them, because the routes did not exist. This section is the part that would
// have noticed.
//
// It also checks the screens, for the specific reason that the supplier-
// payment Edit button shipped sending `{ amount }` alone and the server
// correctly refused every fully-allocated payment. A button wired to a route
// is not a working feature until the thing it sends is accepted.
{
    section('F — both edits, over HTTP, and the buttons that call them');

    const http = require('http');

    const { createApi } = require(path.join(ROOT, 'api'));
    const app = createApi();
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const req = (method, p, { body, sid } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (sid) headers.Authorization = `Bearer ${sid}`;
        const r = http.request(base + p, { method, headers }, (res) => {
            let raw = ''; res.on('data', (c) => { raw += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
        });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
    const login = async (pw) => {
        const r = await req('POST', '/login', { body: { password: pw } });
        return (r.json && (r.json.sid || r.json.session_id)) || null;
    };
    const jarvis = await login(process.env.JARVIS_PASSWORD);
    const admin = await login(process.env.ADMIN_PASSWORD);
    ck('the Jarvis profile can sign in', !!jarvis, String(jarvis));

    // ── TRUCKING, THE THIRD COST TYPE ────────────────────────────────────
    // A FRESH payment on B2 only. Earlier sections already moved B1 around,
    // and a test that depends on where they left it breaks the day one of
    // them changes — so this makes its own and measures its own delta.
    const mk = await req('POST', '/api/metals-trucking', { sid: jarvis, body: {
        amount: 150, mode: 'Wire', bank: 'BofA', date: '2026-03-20',
        trucking_company: 'AJ Transport', allocations: [{ bill_id: 'B2', amount: 150 }],
    } });
    ck('a trucking payment is recorded over HTTP',
       mk.status === 200 || mk.status === 201, `${mk.status} ${JSON.stringify(mk.json)}`);
    const tid = (mk.json && (mk.json.id || (mk.json.payment && mk.json.payment.id)))
        || (TR.list().slice(-1)[0] || {}).id;
    ck('  and it has an id', !!tid, String(tid));

    const tPatch = { amount: 90, allocations: [{ bill_id: 'B2', amount: 90 }] };
    const tBefore = JSON.stringify(TR.list().find((p) => p.id === tid));
    const tPrev = await req('POST', `/api/metals-trucking/${tid}/preview-edit`, { sid: jarvis, body: tPatch });
    ck('the trucking preview route answers', tPrev.status === 200,
       `${tPrev.status} ${JSON.stringify(tPrev.json)}`);
    ck('  with a plan naming the new amount',
       !!(tPrev.json && tPrev.json.plan && tPrev.json.plan.after && tPrev.json.plan.after.amount === 90),
       JSON.stringify(tPrev.json && tPrev.json.plan && tPrev.json.plan.after));
    ck('  and it wrote NOTHING',
       JSON.stringify(TR.list().find((p) => p.id === tid)) === tBefore,
       'a preview route that writes is the worst kind of surprise');

    const tPut = await req('PUT', `/api/metals-trucking/${tid}`, { sid: jarvis, body: tPatch });
    ck('the trucking edit route applies it', tPut.status === 200,
       `${tPut.status} ${JSON.stringify(tPut.json)}`);
    ck('  and the amount really changed in the store',
       (TR.list().find((p) => p.id === tid) || {}).amount === 90,
       'the route forwarded the patch, which is the thing that breaks');
    const tAdmin = await req('PUT', `/api/metals-trucking/${tid}`, { sid: admin, body: {
        amount: 80, allocations: [{ bill_id: 'B2', amount: 80 }],
    } });
    ck('  admin is refused by the trucking route',
       tAdmin.status === 401 || tAdmin.status === 403, String(tAdmin.status));
    ck('    and the payment survived the refusal',
       (TR.list().find((p) => p.id === tid) || {}).amount === 90);
    const tGone = await req('PUT', '/api/metals-trucking/NOPE', { sid: jarvis, body: { amount: 1 } });
    ck('  a missing trucking payment is a 404, not a 500', tGone.status === 404, String(tGone.status));

    // ── COMMISSION AND FREIGHT ───────────────────────────────────────────
    // Freight this time, not commission: section B already edited the
    // commission, and the FREIGHT branch of the same store deserves its own
    // trip through the route.
    const CHG = ST.payables().find((p) => p.kind === 'charge' && p.balance > 0.005);
    ck('the seeded sale still has freight outstanding', !!CHG, JSON.stringify(CHG));
    if (CHG) {
        const half = Math.round((CHG.balance / 2) * 100) / 100;
        const alloc = { sale_id: CHG.sale_id, kind: 'charge', charge_id: CHG.charge_id, amount: CHG.balance };
        const sMk = await req('POST', '/api/sales-settlements', { sid: jarvis, body: {
            amount: CHG.balance, mode: 'Wire', bank: 'BofA', date: '2026-03-20',
            payee: 'Zimex', allocations: [alloc],
        } });
        ck('a freight settlement is recorded over HTTP',
           sMk.status === 200 || sMk.status === 201, `${sMk.status} ${JSON.stringify(sMk.json)}`);
        const sid2 = (sMk.json && (sMk.json.id || (sMk.json.settlement && sMk.json.settlement.id)))
            || (ST.list().slice(-1)[0] || {}).id;

        const sPatch = { amount: half, allocations: [{ ...alloc, amount: half }] };
        const sBefore = JSON.stringify(ST.list().find((s) => s.id === sid2));
        const sPrev = await req('POST', `/api/sales-settlements/${sid2}/preview-edit`,
                                { sid: jarvis, body: sPatch });
        ck('the settlement preview route answers', sPrev.status === 200,
           `${sPrev.status} ${JSON.stringify(sPrev.json)}`);
        ck('  with a plan naming the new amount',
           !!(sPrev.json && sPrev.json.plan && sPrev.json.plan.after && sPrev.json.plan.after.amount === half),
           JSON.stringify(sPrev.json && sPrev.json.plan && sPrev.json.plan.after));
        ck('  and it wrote NOTHING',
           JSON.stringify(ST.list().find((s) => s.id === sid2)) === sBefore,
           'a preview route that writes is the worst kind of surprise');

        const sPut = await req('PUT', `/api/sales-settlements/${sid2}`, { sid: jarvis, body: sPatch });
        ck('the settlement edit route applies it', sPut.status === 200,
           `${sPut.status} ${JSON.stringify(sPut.json)}`);
        ck('  and the amount really changed in the store',
           (ST.list().find((s) => s.id === sid2) || {}).amount === half,
           'the route forwarded the patch');
        const sAdmin = await req('PUT', `/api/sales-settlements/${sid2}`, { sid: admin, body: sPatch });
        ck('  admin is refused by the settlement route',
           sAdmin.status === 401 || sAdmin.status === 403, String(sAdmin.status));
        const sGone = await req('PUT', '/api/sales-settlements/NOPE', { sid: jarvis, body: { amount: 1 } });
        ck('  a missing settlement is a 404, not a 500', sGone.status === 404, String(sGone.status));
    }

    // ── THE BUTTONS, AND THE PATCH THEY REALLY SEND ──────────────────────
    const web = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
    for (const [what, cls, route] of [
        ['trucking', 'trkPayEdit', '/api/metals-trucking/'],
        ['sale costs', 'stlEdit', '/api/sales-settlements/'],
    ]) {
        ck(`the ${what} tab has an Edit button`, web.includes(`class="${cls}"`), cls);
        void route;
        ck(`  and it is gated on metalsCanDelete, like Delete beside it`,
           new RegExp(`metalsCanDelete\\(\\)[\\s\\S]{0,200}?class="${cls}"`).test(web),
           'the routes are requireSuper');
    }

    // ONE flow, not three copies — #182 is open because two Delete buttons
    // were written twice and drifted. If this count ever rises, the next edit
    // screen was copy-pasted instead of calling the flow.
    // Counted at the CALL, not by name: `editPaymentFlow({` matches the
    // definition too, so the first draft read 4 and reported a copy-paste
    // that was not there.
    // ── ASK THE DEAD-ROUTE GUARD ITSELF ──────────────────────────────────
    // editPaymentFlow's first draft took a base path and assembled the URL
    // inside the shared function. check-route-reach.js reads string literals
    // out of each api() call, so all three PUTs instantly became "a permission
    // that exists and cannot be used" — the same class of mistake as
    // registering routes in a loop, one file over.
    //
    // A regex here looked right and was NOT: with the path hidden behind
    // a join(), `api\('/api/metals-trucking/'[^;]*?method: 'PUT'` still
    // matched, because it ran from the PREVIEW call's literal to the SAVE
    // call's method — the two are separated by a comma, not a semicolon. It
    // survived its own mutation. So this runs the real tool and reads its
    // verdict, which is the only thing that was ever being claimed.
    const reach = require('child_process').spawnSync(
        process.execPath, [path.join(ROOT, 'scripts/check-route-reach.js')],
        { encoding: 'utf8' });
    const reachOut = String(reach.stdout || '') + String(reach.stderr || '');
    for (const put of ['PUT    /api/metals-trucking/:id',
                       'PUT    /api/sales-settlements/:id',
                       'PUT    /api/bill-payments/:id']) {
        ck(`check-route-reach can see ${put.replace(/\s+/g, ' ')}`,
           !reachOut.includes(put),
           'the screen builds this path from a variable, so the guard cannot see it');
    }

    const callers = (web.match(/=>\s*editPaymentFlow\(\{/g) || []).length;
    ck('all three Edit buttons share ONE flow',
       callers === 3 && /async function editPaymentFlow/.test(web),
       `${callers} call sites found`);

    server.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
