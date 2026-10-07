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
    charges: [{ id: 'C1', label: 'Ocean freight', amount: 500, payer: 'edge' }],
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

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
