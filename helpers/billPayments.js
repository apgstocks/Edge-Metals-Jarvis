// ── helpers/billPayments.js — paying for containers ──────────────────────
// Apsara, 2026-09-10: "We need pay option.in payment,there is a possible of
// giving advance deduction and multiple container paynebt at once.how should
// we handle this?"
//
// Two things the existing ledger cannot say, and one it must keep saying.
//
// ── WHAT helpers/payments.js CANNOT EXPRESS ──────────────────────────────
// It ties ONE payment to ONE thing (`load_id`, required). That is right for a
// yard load, where a payment is for that load. It cannot express either of
// the two shapes she described:
//
//   1. ONE WIRE, THREE CONTAINERS. A single transfer paying three bills.
//      Splitting it into three payment rows loses the fact that one payment
//      happened, and a supplier chasing "did you send the 20th's wire" is
//      then answered from three half-answers.
//
//   2. AN ADVANCE. Money sent to a supplier BEFORE any container is billed.
//      There is no bill to attach it to at the moment it is sent, which is
//      exactly what addPayment refuses.
//
// So a payment here is a HEADER plus ALLOCATIONS: one record for the transfer
// that really happened, and a list of how much of it went to which container.
// An advance is simply a payment whose allocations do not yet add up to its
// amount — the remainder is credit sitting against that supplier.
//
// ── AND WHAT MUST KEEP WORKING ───────────────────────────────────────────
// The spend report, petty cash and the audit log all read helpers/payments.js.
// A second money store invisible to them would mean her report quietly stops
// matching her bank. So every payment here ALSO writes one row to that ledger
// — one row per TRANSFER, not per allocation, carrying load_kind:'bill'.
// helpers/spendReport.js already branches on load_kind for 'sale' and
// 'trucker'; 'bill' is the third.
//
// ── WHEN IT COUNTS AS SPENT ──────────────────────────────────────────────
// On the day the money leaves the bank, not the day it is allocated. Her
// choice, asked directly, and it is the opposite of what the advance feature
// removed on 2026-08-29 used to do: that one recognised spend at APPLICATION
// time, so a $10,000 wire showed as $0 spent until it was attached to
// something. Defensible for cost attribution and wrong for cash flow, and the
// failure is silent — a month with a big unapplied advance simply looks
// cheaper than it was.
//
// Because the ledger row is written once, at transfer time, applying an
// advance later adds an ALLOCATION and no money. That is what stops the same
// dollar being counted twice.
//
// ── EDGE METALS ONLY ─────────────────────────────────────────────────────
// She removed supplier advances from the yard on 2026-08-29 ("remove that
// advance concept") and that removal stands: nothing here touches loads,
// sellers or the yard's payment forms. Freight is a different business, which
// is the same reason bills and sales are not yard loads. Raised with her
// before building, because rebuilding something someone deleted is worth
// asking about rather than assuming.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const CENT = 0.005;

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
}

// Zelle and Wire only, matching helpers/truckerBills.js. Deliberately NOT
// Cash: a cash payment draws down petty cash, and entangling a supplier's
// container invoice with the yard's cash box is a knot nobody wants to untie
// later. If she pays a supplier in cash it can be added — as one entry, on
// purpose, not by accident.
const BILL_PAYMENT_MODES = ['Zelle', 'Wire', 'Cash'];

const list = () => {
    const raw = loadJson(cfg.BILL_PAYMENTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const newId = () => `BPAY_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// Every allocation across every payment, flattened. The one place that knows
// how much a given container has been paid.
function allocationsFor(billId) {
    const id = String(billId || '');
    const out = [];
    for (const p of list()) {
        for (const a of (p.allocations || [])) {
            if (String(a.bill_id) === id) {
                out.push({ payment_id: p.id, date: p.date, mode: p.mode, bank: p.bank,
                           ref: p.ref, kind: p.kind, amount: num(a.amount) || 0 });
            }
        }
    }
    return out.sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
}

const paidFor = (billId) => round2(allocationsFor(billId).reduce((s, a) => s + a.amount, 0)) || 0;

// paid-per-bill for EVERY bill in one pass. listWithTotals calls this once
// rather than calling paidFor per row — with a few hundred bills and a few
// hundred payments the per-row version is quadratic, and it is the kind of
// slow that only shows up months in.
function paidByBill() {
    const out = {};
    for (const p of list()) {
        for (const a of (p.allocations || [])) {
            const k = String(a.bill_id);
            out[k] = round2((out[k] || 0) + (num(a.amount) || 0));
        }
    }
    return out;
}

// ── WHAT IS LEFT OF AN ADVANCE ───────────────────────────────────────────
// An advance's unallocated remainder is credit against that supplier. Summed
// per supplier so the Bills tab can say "Eccomelt has $4,200 sitting" without
// her going to look for it.
function advancesFor(supplier) {
    const want = String(supplier || '').trim().toLowerCase();
    return list()
        .filter((p) => p.kind === 'advance')
        .filter((p) => !want || String(p.supplier || '').trim().toLowerCase() === want)
        .map((p) => {
            const used = round2((p.allocations || []).reduce((s, a) => s + (num(a.amount) || 0), 0)) || 0;
            return { ...p, used, available: round2((num(p.amount) || 0) - used) };
        });
}

function advanceCredit(supplier) {
    return round2(advancesFor(supplier).reduce((s, a) => s + Math.max(0, a.available || 0), 0)) || 0;
}

// Every supplier holding credit, for the panel.
function creditBySupplier() {
    const out = {};
    for (const a of advancesFor(null)) {
        const s = String(a.supplier || '').trim();
        if (!s || !(a.available > CENT)) continue;
        out[s] = round2((out[s] || 0) + a.available);
    }
    return out;
}

// Allocations are checked BEFORE anything is written: an allocation naming a
// bill that does not exist, or adding up to more than the payment, is a
// mistake worth refusing rather than storing and reporting oddly forever.
// Two names for the same supplier is a data-entry question, not a matching
// question — the Bills form type-aheads off the values already stored, so the
// string she picks IS the string on the bill. Compared case- and
// whitespace-insensitively only, deliberately: anything fuzzier would start
// deciding that "Eccomelt" and "Eccomelt LLC" are one company, which is a
// judgement no payment route should be making on its own.
const sameSupplier = (a, b) =>
    String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function cleanAllocations(input, amount, { allowUnallocated = false, supplier = null } = {}) {
    const bills = require('./bills');
    const all = bills.list();
    const known = new Set(all.map((b) => b.id));
    const byId = new Map(all.map((b) => [b.id, b]));
    const out = [];
    for (const a of (input || [])) {
        const billId = String((a && a.bill_id) || '').trim();
        const amt = num(a && a.amount);
        if (!billId) continue;
        if (amt === null || amt <= 0) continue;
        if (!known.has(billId)) throw new Error(`no bill ${billId}`);
        // ── ONE PAYMENT, ONE SUPPLIER ────────────────────────────────────
        // Apsara, 2026-09-10: "It must ask to select the supplier first...
        // Then show only related supplier container".
        //
        // The picker in dashboard/index.html only offers containers belonging
        // to the supplier she chose. This is the same rule stated where it is
        // enforced rather than where it is displayed — the trucker-bill route
        // learned that the hard way ("Written at the same time as the button
        // this time"). A wire marked Eccomelt sitting against an Oakland
        // Metals container is not a UI slip; it is a supplier statement that
        // is false, and it would silently settle the wrong company's invoice.
        if (supplier) {
            const b = byId.get(billId);
            if (b && !sameSupplier(b.supplier, supplier)) {
                throw new Error(`container ${b.container_no || billId} belongs to ${b.supplier || 'no supplier'}, not ${supplier}`);
            }
        }
        const already = out.find((x) => x.bill_id === billId);
        if (already) already.amount = round2(already.amount + amt);
        else out.push({ bill_id: billId, amount: round2(amt) });
    }
    const total = round2(out.reduce((s, a) => s + a.amount, 0)) || 0;
    if (total - amount > CENT) {
        throw new Error(`allocations come to $${total.toFixed(2)} but the payment is $${amount.toFixed(2)}`);
    }
    // A plain payment must be fully allocated — otherwise it is an advance,
    // and calling it a payment hides credit she would never find again.
    if (!allowUnallocated && amount - total > CENT) {
        throw new Error(`$${round2(amount - total).toFixed(2)} of this payment is not allocated to any container — record it as an advance instead`);
    }
    return out;
}

// Writes the money-out row that helpers/spendReport.js reads. ONE per
// transfer, so a wire covering three containers is one line in her report and
// one line on her bank statement.
async function mirrorToLedger(rec) {
    const { addPayment } = require('./payments');
    return addPayment({
        // The payment's own id, NOT a bill id. paymentsForLoad(billId) must
        // never match it — a bill's paid figure comes from allocations, and a
        // yard load must never see this row at all.
        load_id: rec.id,
        load_kind: 'bill',
        amount: rec.amount,
        mode: rec.mode,
        bank: rec.bank || null,
        // ── THE LEDGER'S DATE FORMAT, NOT HERS ───────────────────────────
        // She types MM/DD/YYYY; helpers/payments.js stores YYYY-MM-DD (its
        // default is time.todayLocal()). Passing hers straight through put a
        // date the spend report's range filter could not read, so the payment
        // existed and appeared in no report at all — money spent and
        // invisible, which is the worst of the three ways this could fail.
        paid_on: require('./bills').sortableDate(rec.date) || rec.date,
        note: rec.kind === 'advance'
            ? `Advance to ${rec.supplier || 'supplier'}${rec.ref ? ` (${rec.ref})` : ''}`
            : `Bill payment${rec.supplier ? ` to ${rec.supplier}` : ''}${rec.ref ? ` (${rec.ref})` : ''}`,
        require_bank: rec.mode !== 'Cash',
        recorded_by: rec.created_by || null,
    });
}

// ── THE RULES, LIFTED OUT SO EDIT CANNOT GROW A SECOND COPY ──────────────
// Extracted 2026-10-07, unchanged, when editBillPayment was added. Every
// rule below was already here and still runs in the same order for every
// existing caller — addPaymentRecord simply calls this first now.
//
// It exists because an edit has to enforce exactly what a create enforces.
// A second copy of "a bank is required for Zelle and Wire" would be correct
// on the day it was written and wrong the day one of them changed, and the
// two would disagree about money with nothing saying which was right.
//
// PURE: validates and returns the clean fields. It writes nothing and
// touches no store, so it can also back a preview that changes nothing.
function validatePaymentInput(input = {}, { advance = false } = {}) {
    const amount = round2(num(input.amount));
    if (amount === null || amount <= 0) throw new Error('a payment amount is required');
    const mode = BILL_PAYMENT_MODES.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    if (!mode) throw new Error(`payment mode must be one of: ${BILL_PAYMENT_MODES.join(', ')}`);
    if (mode !== 'Cash' && !String(input.bank || '').trim()) {
        throw new Error('a bank is required for Zelle and Wire');
    }
    if (!String(input.date || '').trim()) throw new Error('a payment needs a date');
    if (advance && !String(input.supplier || '').trim()) {
        throw new Error('an advance needs a supplier — it is credit against them until you apply it');
    }
    if (!advance && !String(input.supplier || '').trim()) {
        throw new Error('a payment needs a supplier — choose who is being paid');
    }
    const allocations = cleanAllocations(input.allocations, amount, {
        allowUnallocated: advance,
        supplier: String(input.supplier || '').trim() || null,
    });
    return {
        amount, mode,
        bank: mode === 'Cash' ? null : String(input.bank).trim(),
        date: String(input.date).trim(),
        ref: String(input.ref || '').trim() || null,
        supplier: String(input.supplier || '').trim() || null,
        note: String(input.note || '').trim() || null,
        allocations,
    };
}

async function addPaymentRecord(input = {}, { advance = false } = {}) {
    // Every rule now lives in validatePaymentInput above, unchanged and in
    // the same order. The comments that explained each one stayed with the
    // rules; what follows is the record and the two writes.
    const v = validatePaymentInput(input, { advance });
    const { amount, mode, allocations } = v;

    // Built from the VALIDATED fields, not from `input` again. Re-deriving
    // `bank: mode === 'Cash' ? null : input.bank.trim()` here would be a
    // second copy of a rule that already ran, and the day one of them
    // changes they disagree about money with nothing saying which is right.
    const rec = {
        id: newId(),
        kind: advance ? 'advance' : 'payment',
        date: v.date,
        amount,
        mode,
        bank: v.bank,
        ref: v.ref,
        supplier: v.supplier,
        note: v.note,
        allocations,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };

    // ── THE LEDGER ROW FIRST ─────────────────────────────────────────────
    // If the ledger write fails, nothing is stored here either — better a
    // payment she has to enter again than one that exists in the Bills tab
    // and is missing from her spend report, which is the shape of error
    // nobody finds until the month is closed.
    const mirrored = await mirrorToLedger(rec);
    rec.ledger_payment_id = mirrored && mirrored.id ? mirrored.id : null;

    // ── STRICT: THIS WRITE EITHER HAPPENS OR SAYS SO ─────────────────────
    // mutateJson is forgiving by default — on failure it logs, returns
    // loadJson() and NEVER RUNS THE MUTATOR, handing back plausible-looking
    // data with no way to tell the write never landed. Its own note says the
    // paths where a lost write means lost DATA should opt in; this is one of
    // them, and 131 of 146 writes in this codebase had not.
    //
    // The catch covers mutator errors too, not just lock contention, so the
    // forgiving path also swallows bugs in the function above.
    //
    // No retry loop on top: LOCK_OPTS already backs off eight times (40ms to
    // 400ms), so a failure here is genuinely exceptional and a second layer
    // would be defensive code with nothing to defend against.
    await mutateJson(cfg.BILL_PAYMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(rec);
        return rows;
    }, { strict: true });
    return rec;
}

const addBillPayment = (input) => addPaymentRecord(input, { advance: false });
// ── "ADVANCE" HERE, "PREPAYMENT" IN EDGE YARD — DELIBERATELY ─────────────
// Apsara, 2026-10-02, asked whether to unify the two words: "Prepayment
// option should be separte for edge ayrd. it is not restricted just for edge
// metals." They are different companies with different stores, and the names
// stay different. See the long note above addPrepayment in helpers/payments.js.
const addAdvance = (input) => addPaymentRecord(input, { advance: true });

// ── APPLYING AN ADVANCE MOVES NO MONEY ───────────────────────────────────
// It adds an allocation to a payment that already happened. No second ledger
// row, because the money already left the bank and was already counted on the
// day it did. This is the join that stops a dollar being spent twice.
async function applyAdvance(paymentId, allocations = []) {
    let out = null, problem = null;
    await mutateJson(cfg.BILL_PAYMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === paymentId);
        if (i === -1) { problem = `no payment ${paymentId}`; return rows; }
        if (rows[i].kind !== 'advance') { problem = 'only an advance can be applied'; return rows; }
        const amount = num(rows[i].amount) || 0;
        let merged;
        try {
            // Bound to the advance's OWN supplier, not to whatever the
            // caller sent: credit paid to one supplier cannot settle
            // another's container, and this is the route that would let it.
            merged = cleanAllocations([...(rows[i].allocations || []), ...allocations], amount,
                                      { allowUnallocated: true, supplier: rows[i].supplier || null });
        } catch (e) { problem = e.message; return rows; }
        rows[i] = { ...rows[i], allocations: merged, updated_at: new Date().toISOString() };
        out = rows[i];
        return rows;
    }, { strict: true });
    if (problem) throw new Error(problem);
    return out;
}

// Deleting a payment removes its ledger row too, or her report keeps counting
// money that is no longer recorded as paid. Same rule loads already follow.
// ── EDITING A RECORDED PAYMENT ───────────────────────────────────────────
// Apsara, 2026-10-07: "give option to pay multiple invoices together and
// option to edit". Paying several at once already worked — allocations have
// always been a list. Editing did not exist anywhere: every payment path in
// this system is record-and-delete only, so fixing a typo meant deleting the
// payment and entering it again, which reopens containers in between and
// loses what the original said.
//
// Asked what an edit should do about the containers it had already settled,
// she chose: "Recompute everything, show me before saving." So previewEdit
// below computes the consequences and writes NOTHING; editBillPayment is the
// second step, and the screen is expected to show the first.
//
// Asked what should happen to a payment already pushed to QuickBooks:
// "Refuse, and tell me to change both." That is the same rule the 07:30
// ledger agent already follows, and it fails CLOSED — if QuickBooks cannot
// be reached, the edit is refused rather than risked.

// What this edit would do, computed against the current ledger. Pure: no
// writes, so a screen can show it before she commits.
function previewEdit(id, patch = {}) {
    const before = list().find((p) => p.id === id);
    if (!before) throw new Error(`no payment ${id}`);

    const merged = {
        amount: patch.amount !== undefined ? patch.amount : before.amount,
        mode: patch.mode !== undefined ? patch.mode : before.mode,
        bank: patch.bank !== undefined ? patch.bank : before.bank,
        date: patch.date !== undefined ? patch.date : before.date,
        ref: patch.ref !== undefined ? patch.ref : before.ref,
        supplier: patch.supplier !== undefined ? patch.supplier : before.supplier,
        note: patch.note !== undefined ? patch.note : before.note,
        allocations: patch.allocations !== undefined ? patch.allocations : before.allocations,
    };
    // Validated by the SAME rules a new payment faces. An edit that could
    // store something a create would refuse is a second, laxer way in.
    const after = validatePaymentInput(merged, { advance: before.kind === 'advance' });

    // ── WHAT MOVES, PER BILL ─────────────────────────────────────────────
    // The figure she actually cares about: which containers stop being
    // settled and which become settled. Computed as a DELTA against this
    // payment's own allocations, so other payments against the same bill are
    // untouched by the arithmetic.
    const was = new Map();
    for (const a of (before.allocations || [])) was.set(String(a.bill_id), round2((was.get(String(a.bill_id)) || 0) + (num(a.amount) || 0)));
    const will = new Map();
    for (const a of (after.allocations || [])) will.set(String(a.bill_id), round2((will.get(String(a.bill_id)) || 0) + (num(a.amount) || 0)));

    const bills = require('./bills').listWithTotals();
    const byId = new Map(bills.map((b) => [String(b.id), b]));
    const touched = [...new Set([...was.keys(), ...will.keys()])];

    const changes = touched.map((billId) => {
        const b = byId.get(billId) || null;
        const owed = b && b.net_payable != null ? round2(num(b.net_payable)) : null;
        // What every OTHER payment has put against this bill.
        const otherPaid = round2(allocationsFor(billId)
            .filter((a) => String(a.payment_id || a.paymentId || '') !== String(id))
            .reduce((s, a) => s + (num(a.amount) || 0), 0)) || 0;
        const paidBefore = round2(otherPaid + (was.get(billId) || 0));
        const paidAfter = round2(otherPaid + (will.get(billId) || 0));
        const settledBefore = owed !== null && paidBefore + 0.005 >= owed;
        const settledAfter = owed !== null && paidAfter + 0.005 >= owed;
        return {
            bill_id: billId,
            container_no: b ? (b.container_no || null) : null,
            supplier: b ? (b.supplier || null) : null,
            owed,
            paid_before: paidBefore, paid_after: paidAfter,
            settled_before: settledBefore, settled_after: settledAfter,
            // The sentence a screen can show without doing arithmetic itself.
            effect: settledBefore && !settledAfter ? 'reopens'
                : !settledBefore && settledAfter ? 'becomes settled'
                : paidBefore === paidAfter ? 'unchanged' : 'amount changes',
        };
    }).sort((a, b) => String(a.container_no || '').localeCompare(String(b.container_no || '')));

    return {
        id,
        before: { amount: before.amount, mode: before.mode, bank: before.bank, date: before.date,
            ref: before.ref, supplier: before.supplier, allocations: before.allocations || [] },
        after: { amount: after.amount, mode: after.mode, bank: after.bank, date: after.date,
            ref: after.ref, supplier: after.supplier, allocations: after.allocations },
        changes,
        reopens: changes.filter((c) => c.effect === 'reopens').length,
        settles: changes.filter((c) => c.effect === 'becomes settled').length,
        // A money change needs the ledger row rewritten too; a reference typo
        // does not. Said out loud so the caller knows what it is asking for.
        touchesLedger: round2(num(before.amount)) !== after.amount
            || String(before.mode) !== after.mode
            || String(before.bank || '') !== String(after.bank || '')
            || String(before.date) !== after.date
            || String(before.supplier || '') !== String(after.supplier || '')
            || String(before.ref || '') !== String(after.ref || ''),
    };
}

async function editBillPayment(id, patch = {}, { actor = null } = {}) {
    const before = list().find((p) => p.id === id);
    if (!before) throw new Error(`no payment ${id}`);

    // ── THE QUICKBOOKS GATE, FAILING CLOSED ──────────────────────────────
    // Her answer, 2026-10-07: "Refuse, and tell me to change both."
    // QuickBooks is not re-pushed on an edit, so a silent change here leaves
    // her books and Jarvis disagreeing with nothing recording who moved what.
    try {
        const qb = require('./qbLinked');
        const link = qb.linkedRow(before, { kind: 'bill_payments', keys: qb.liveKeys() });
        if (link && link.linked) {
            throw new Error(`this payment is already in QuickBooks (${link.why}). `
                + 'Change it in both, or delete it there first — an edit here alone would '
                + 'leave your books and Jarvis disagreeing.');
        }
    } catch (e) {
        if (/already in QuickBooks/.test(String(e && e.message))) throw e;
        // Could not ASK QuickBooks. Refuse rather than risk it — the same
        // direction ledgerAgent fails in, and for the same reason.
        throw new Error(`could not check QuickBooks (${(e && e.message) || e}), so this edit is `
            + 'refused rather than risked. Nothing was changed.');
    }

    const plan = previewEdit(id, patch);
    const after = plan.after;

    // The ledger mirror is rebuilt only when something it carries changed.
    // Done BEFORE the store write, the same order addPaymentRecord uses and
    // for the same reason: better a payment she re-enters than one that is
    // in the Bills tab and missing from her spend report.
    // ── OLD OUT, NEW IN, AND PUT IT BACK IF THE NEW ONE FAILS ────────────
    // deletePaymentsForLoad keys on the PAYMENT id, and the rebuilt mirror
    // carries the same id — so mirroring first and deleting second would
    // remove both rows and leave the spend report blind to this payment
    // entirely. The order has to be delete, then mirror.
    //
    // Which means a failure between the two would lose the ledger row for a
    // payment that still exists. So a failed re-mirror restores the ORIGINAL
    // before rethrowing, and the store write below never runs — she is left
    // exactly where she started rather than half-edited.
    let ledgerId = before.ledger_payment_id || null;
    if (plan.touchesLedger) {
        const { deletePaymentsForLoad } = require('./payments');
        await deletePaymentsForLoad(before.id);
        try {
            const mirrored = await mirrorToLedger({ ...before, ...after, id: before.id });
            ledgerId = mirrored && mirrored.id ? mirrored.id : null;
        } catch (e) {
            try { await mirrorToLedger(before); } catch (e2) {
                console.error('[BILL-PAY] the edit failed AND the original ledger row could not be '
                    + 'restored. The payment is unchanged in the Bills tab but missing from the '
                    + 'spend report:', e2.message);
            }
            throw new Error(`could not rewrite the ledger row (${(e && e.message) || e}) — `
                + 'nothing was changed');
        }
    }

    await mutateJson(cfg.BILL_PAYMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r && r.id === id);
        if (i === -1) throw new Error(`payment ${id} disappeared while being edited`);
        rows[i] = {
            ...rows[i],
            date: after.date, amount: after.amount, mode: after.mode, bank: after.bank,
            ref: after.ref, supplier: after.supplier, note: after.note,
            allocations: after.allocations,
            ledger_payment_id: ledgerId,
            // The original is kept. An edit that erases what the row used to
            // say is a deletion wearing a friendlier word.
            edited_at: new Date().toISOString(),
            edited_by: actor || null,
            edit_history: [...(rows[i].edit_history || []), {
                at: new Date().toISOString(), by: actor || null,
                was: { date: before.date, amount: before.amount, mode: before.mode,
                    bank: before.bank, ref: before.ref, supplier: before.supplier,
                    allocations: before.allocations || [] },
            }],
        };
        return rows;
    }, { strict: true });

    return { ...plan, applied: true };
}

async function deleteBillPayment(id) {
    const doomed = list().find((p) => p.id === id);
    if (!doomed) throw new Error(`no payment ${id}`);
    await mutateJson(cfg.BILL_PAYMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i !== -1) rows.splice(i, 1);
        return rows;
    }, { strict: true });
    try {
        const { deletePaymentsForLoad } = require('./payments');
        await deletePaymentsForLoad(doomed.id);
    } catch (e) {
        console.error('[BILL-PAY] removed the payment but could not remove its ledger row:', e.message);
    }
    return true;
}

// What the tab shows at the top.
function summary() {
    const rows = list();
    const sum = (f) => round2(rows.filter(f).reduce((s, p) => s + (num(p.amount) || 0), 0)) || 0;
    return {
        count: rows.length,
        paid: sum((p) => p.kind === 'payment'),
        advanced: sum((p) => p.kind === 'advance'),
        credit_available: round2(Object.values(creditBySupplier()).reduce((s, v) => s + v, 0)) || 0,
    };
}

module.exports = {
    BILL_PAYMENT_MODES,
    list, allocationsFor, paidFor, paidByBill,
    advancesFor, advanceCredit, creditBySupplier,
    addBillPayment, addAdvance, applyAdvance, deleteBillPayment, summary,
    // Added 2026-10-07. previewEdit writes nothing and is what the screen
    // shows her BEFORE editBillPayment is called — her own choice:
    // "Recompute everything, show me before saving."
    validatePaymentInput, previewEdit, editBillPayment,
    cleanAllocations, sameSupplier,
};
