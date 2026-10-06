// ── tests/payment-edit.js ─────────────────────────────────────────────────
// Apsara, 2026-10-07: "give option to pay multiple invoices together and
// option to edit".
//
// Paying several at once already worked — allocations have always been a
// list. EDITING did not exist anywhere: every payment path in this system
// is record-and-delete only, so fixing a typo meant deleting the payment and
// entering it again, which reopens containers in between and loses what the
// original said.
//
// Her two rules, asked directly:
//   · containers      "Recompute everything, show me before saving."
//   · QuickBooks      "Refuse, and tell me to change both."
//
// Section A is the one that protects everything else: the validation an edit
// faces must be the SAME validation a create faces. A second, laxer way in
// is how a payment with no supplier or a bank on a cash row gets stored.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-payedit-'));
process.env.DATA_DIR = TMP;
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));
if (!String(cfg.DATA_DIR).startsWith(TMP)) {
    console.error('  ABORT  config is not isolated — refusing to run against real data');
    process.exit(1);
}

const BP = require(path.join(ROOT, 'helpers/billPayments'));

// Two bills from one supplier, so one payment can cover both.
fs.writeFileSync(cfg.BILLS_FILE, JSON.stringify([
    { id: 'B1', container_no: 'CONT1', booking_no: 'BK1', date: '2026-03-01',
      supplier: 'DRM', supplier_invoice_amount: 10000 },
    { id: 'B2', container_no: 'CONT2', booking_no: 'BK2', date: '2026-03-02',
      supplier: 'DRM', supplier_invoice_amount: 6000 },
], null, 2));

(async () => {

// ── A — AN EDIT FACES THE SAME RULES AS A CREATE ──────────────────────────
{
    section('A — one set of rules, not two');

    ck('the validator is exported and shared',
       typeof BP.validatePaymentInput === 'function');

    // The rules a create enforces, each one proven to still bite on an edit.
    const good = { amount: 100, mode: 'Wire', bank: 'BofA', date: '2026-03-10',
        supplier: 'DRM', allocations: [{ bill_id: 'B1', amount: 100 }] };
    ck('a sound payment validates', !!BP.validatePaymentInput(good), 'the control');

    const cases = [
        ['no amount', { ...good, amount: 0 }, /amount is required/],
        ['an unknown mode', { ...good, mode: 'Bitcoin' }, /payment mode must be one of/],
        ['a wire with no bank', { ...good, bank: '' }, /bank is required/],
        ['no date', { ...good, date: '' }, /needs a date/],
        ['no supplier', { ...good, supplier: '' }, /needs a supplier/],
    ];
    for (const [label, input, re] of cases) {
        let msg = null;
        try { BP.validatePaymentInput(input); } catch (e) { msg = e.message; }
        ck(`  ${label} is refused`, re.test(String(msg)), String(msg));
    }

    // Cash carries no bank — a bank on a cash row is a false statement.
    const cash = BP.validatePaymentInput({ ...good, mode: 'Cash', bank: 'BofA' });
    ck('  and cash keeps no bank', cash.bank === null, JSON.stringify(cash.bank));

    // And the validator writes nothing.
    const src = fs.readFileSync(path.join(ROOT, 'helpers/billPayments.js'), 'utf8');
    const fn = src.slice(src.indexOf('function validatePaymentInput'), src.indexOf('async function addPaymentRecord'));
    ck('  the validator touches no store', !/mutateJson|loadJson/.test(fn),
       'it also backs the preview, which must change nothing');
}

// ── B — PAYING SEVERAL BILLS AT ONCE ALREADY WORKED ───────────────────────
{
    section('B — one payment, several containers');

    const p = await BP.addBillPayment({
        amount: 16000, mode: 'Wire', bank: 'BofA', date: '2026-03-10', supplier: 'DRM',
        allocations: [{ bill_id: 'B1', amount: 10000 }, { bill_id: 'B2', amount: 6000 }],
    });
    ck('one payment covers two bills', (p.allocations || []).length === 2, JSON.stringify(p.allocations));
    ck('  and both are fully paid',
       BP.paidFor('B1') === 10000 && BP.paidFor('B2') === 6000,
       `${BP.paidFor('B1')} / ${BP.paidFor('B2')}`);
    global.__PAY_ID = p.id;
}

// ── C — THE PREVIEW CHANGES NOTHING ───────────────────────────────────────
// "Recompute everything, show me before saving."
{
    section('C — show her first');

    const id = global.__PAY_ID;
    const beforeFile = fs.readFileSync(cfg.BILL_PAYMENTS_FILE, 'utf8');

    // Move the whole payment onto one bill: CONT2 should reopen.
    const plan = BP.previewEdit(id, { allocations: [{ bill_id: 'B1', amount: 16000 }], amount: 16000 });
    ck('the preview names what reopens', plan.reopens === 1, JSON.stringify(plan.changes));
    const c2 = plan.changes.find((c) => c.container_no === 'CONT2');
    ck('  and says which container', c2 && c2.effect === 'reopens', JSON.stringify(c2));
    ck('  with what was paid and what will be',
       c2 && c2.paid_before === 6000 && c2.paid_after === 0, JSON.stringify(c2));
    ck('  and what that container owes', c2 && c2.owed === 6000, JSON.stringify(c2 && c2.owed));

    ck('NOTHING was written', fs.readFileSync(cfg.BILL_PAYMENTS_FILE, 'utf8') === beforeFile,
       'a preview that writes is not a preview');
    ck('  and the bill is still settled until she says go',
       BP.paidFor('B2') === 6000, String(BP.paidFor('B2')));

    // An edit that would not validate must fail at PREVIEW, not at save.
    let msg = null;
    try { BP.previewEdit(id, { mode: 'Bitcoin' }); } catch (e) { msg = e.message; }
    ck('  an invalid edit is refused before it is shown',
       /payment mode must be one of/.test(String(msg)), String(msg));

    // A reference typo must not claim it touches the ledger.
    const refOnly = BP.previewEdit(id, { ref: 'WIRE-99' });
    ck('  changing a reference IS a ledger change (the note carries it)',
       refOnly.touchesLedger === true, 'the mirrored row quotes the reference in its note');
    const noteOnly = BP.previewEdit(id, { note: 'internal remark' });
    ck('  while an internal note is not', noteOnly.touchesLedger === false,
       'the ledger row does not carry it, so there is nothing to rewrite');
}

// ── D — THE EDIT ITSELF ───────────────────────────────────────────────────
{
    section('D — and then it really moves');

    const id = global.__PAY_ID;
    const res = await BP.editBillPayment(id, {
        amount: 16000, allocations: [{ bill_id: 'B1', amount: 16000 }],
    }, { actor: 'test' });

    ck('the edit reports it applied', res.applied === true, JSON.stringify(res.applied));
    ck('  CONT2 really reopened', BP.paidFor('B2') === 0, String(BP.paidFor('B2')));
    ck('  and CONT1 now carries the whole payment', BP.paidFor('B1') === 16000, String(BP.paidFor('B1')));

    const row = BP.list().find((p) => p.id === id);
    ck('  the payment keeps its id', !!row, 'an edit that changes the id is a delete and a create');
    ck('  and its original creation time', !!row.created_at);
    ck('  it records when it was edited and by whom',
       !!row.edited_at && row.edited_by === 'test', JSON.stringify([row.edited_at, row.edited_by]));

    // ── THE ORIGINAL IS KEPT ─────────────────────────────────────────────
    // An edit that erases what the row used to say is a deletion wearing a
    // friendlier word.
    ck('  and what it USED to say is kept',
       Array.isArray(row.edit_history) && row.edit_history.length === 1, JSON.stringify(row.edit_history));
    const was = row.edit_history[0].was;
    ck('    with the old allocations',
       was.allocations.length === 2, JSON.stringify(was.allocations));
    ck('    and the old amount', was.amount === 16000, String(was.amount));

    // The ledger mirror must follow a money change, not be left behind.
    const ledger = require(path.join(ROOT, 'helpers/payments')).listPayments()
        .filter((r) => String(r.load_id) === String(id));
    ck('  the spend-report row still exists, exactly once',
       ledger.length === 1, `${ledger.length} ledger rows — two would double-count the payment`);

    // ── HISTORY ACCUMULATES, AND ONE EDIT CANNOT PROVE IT ────────────────
    // Replacing the array instead of appending passed this file until a
    // SECOND edit was made: a list of one and a list that was overwritten
    // look identical. The property is that the first version survives the
    // second edit — otherwise "what it used to say is kept" is true only
    // until the next time she touches it.
    await BP.editBillPayment(id, { ref: 'SECOND-EDIT' }, { actor: 'test2' });
    const twice = BP.list().find((p) => p.id === id);
    ck('  a second edit APPENDS rather than replacing',
       (twice.edit_history || []).length === 2, JSON.stringify((twice.edit_history || []).length));
    ck('    and the FIRST version is still there',
       (twice.edit_history[0].was.allocations || []).length === 2,
       JSON.stringify(twice.edit_history[0].was.allocations));
    ck('    with the second recording who made it',
       twice.edit_history[1].by === 'test2', JSON.stringify(twice.edit_history[1].by));
    ck('    and still exactly one ledger row after two edits',
       require(path.join(ROOT, 'helpers/payments')).listPayments()
           .filter((r) => String(r.load_id) === String(id)).length === 1,
       'each edit deletes the old mirror before writing the new one');
}

// ── E — QUICKBOOKS: REFUSE, AND FAIL CLOSED ───────────────────────────────
// Her rule: "Refuse, and tell me to change both."
{
    section('E — a payment already in her books');

    const qbPath = require.resolve(path.join(ROOT, 'helpers/qbLinked'));
    const real = require.cache[qbPath];

    // Linked: refuse, and say to change both.
    require.cache[qbPath] = { id: qbPath, filename: qbPath, loaded: true, exports: {
        liveKeys: () => ({}), linkedRow: () => ({ linked: true, why: 'pushed as Bill #412' }) } };
    let msg = null;
    try { await BP.editBillPayment(global.__PAY_ID, { ref: 'X' }); } catch (e) { msg = e.message; }
    ck('an edit to a QuickBooks-linked payment is REFUSED',
       /already in QuickBooks/.test(String(msg)), String(msg));
    ck('  and it tells her to change both', /Change it in both/.test(String(msg)), String(msg));

    // Cannot ask QuickBooks at all: refuse rather than risk it.
    require.cache[qbPath] = { id: qbPath, filename: qbPath, loaded: true, exports: {
        liveKeys: () => { throw new Error('token expired'); }, linkedRow: () => ({ linked: false }) } };
    msg = null;
    try { await BP.editBillPayment(global.__PAY_ID, { ref: 'Y' }); } catch (e) { msg = e.message; }
    ck('  and it FAILS CLOSED when QuickBooks cannot be reached',
       /could not check QuickBooks/.test(String(msg)), String(msg));
    ck('    saying nothing was changed', /Nothing was changed/.test(String(msg)), String(msg));

    // And it really did not write.
    const row = BP.list().find((p) => p.id === global.__PAY_ID);
    ck('    the payment is untouched', row.ref !== 'X' && row.ref !== 'Y', JSON.stringify(row.ref));

    if (real) require.cache[qbPath] = real; else delete require.cache[qbPath];
}

// ── F — IT CANNOT EDIT WHAT IS NOT THERE ──────────────────────────────────
{
    section('F — the edges');

    let msg = null;
    try { BP.previewEdit('NOPE', {}); } catch (e) { msg = e.message; }
    ck('previewing a payment that does not exist is refused', /no payment NOPE/.test(String(msg)), String(msg));
    msg = null;
    try { await BP.editBillPayment('NOPE', {}); } catch (e) { msg = e.message; }
    ck('  and so is editing one', /no payment NOPE/.test(String(msg)), String(msg));

    // An empty patch is a no-op, not an error — the screen may send the
    // whole row back unchanged.
    const same = BP.previewEdit(global.__PAY_ID, {});
    ck('an empty patch changes nothing',
       same.reopens === 0 && same.settles === 0 && same.touchesLedger === false,
       JSON.stringify({ r: same.reopens, s: same.settles, l: same.touchesLedger }));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failed:'); failures.forEach((f) => console.log('    · ' + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
