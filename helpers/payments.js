// ── helpers/payments.js — payments recorded against a load ─────────────────
//
// Per Apsara 2026-08-28: a Pay button beside Edit/Delete opening a form with
// payment mode (Zelle / Wire / Cash / Cheque) and an amount; anything short of
// the load total is a PARTIAL payment with a pending balance, and the result
// has to show up on the invoice.
//
// A LEDGER, not a flag. "Partial, with a pending amount" only means anything
// if a load can be settled across several payments — pay half on collection
// and the rest on Friday — so this stores each payment as its own row and
// derives paid/pending by summing them. A single paid_amount field on the load
// would lose the history the moment a second payment arrived, and the history
// is the part anyone actually argues about later.
//
// ITS OWN STORE, and here that is about money rather than tidiness. Loads are
// re-saved WHOLESALE on every edit — editLoad in helpers/loads.js rebuilds the
// record from the fields it knows about — so a payments array hanging off the
// load would be one dropped field away from erasing a receipt. That exact
// class of bug has already happened in this repo once (pdf_link was silently
// discarded by editOutboundLoad, which is why patchOutboundLoad exists).
// Keeping payments outside the load write path means correcting a weight
// cannot touch what was paid.
//
// Nothing here deletes or edits a payment's amount in place: a wrong payment
// is deleted whole and re-entered, so there is no half-edited row.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

// Fixed set, per Apsara. Kept as a constant and exported so the API, both
// clients and the PDF all read the same list rather than three drifting
// copies of a dropdown.
const PAYMENT_MODES = ['Zelle', 'Wire', 'Cash', 'Cheque'];

// Money is compared to the cent. Floating point makes 4010 * 2.2 come out as
// 8822.000000000001, so a load paid exactly to the penny would otherwise
// report a pending balance of -0.000000000001 and never read as settled.
const CENT = 0.005;

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const num0 = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const toNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
};

const listPayments = () => {
    const raw = loadJson(cfg.PAYMENTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

// Advances are excluded by the load_id test itself — they carry none until
// they are applied, at which point the application is its own row with a real
// load_id. So an unapplied advance can never make a load look part-paid.
const paymentsForLoad = (loadId) => listPayments()
    .filter((p) => p.load_id === loadId)
    .sort((a, b) => String(a.paid_on || a.created_at || '').localeCompare(String(b.paid_on || b.created_at || '')));

function newPaymentId() {
    return `PAY_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Advances were REMOVED 2026-08-29, per Apsara: "remove that advance
// concept." ────────────────────────────────────────────────────────────────
//
// What used to be here: a payment scoped to a seller instead of a load, held
// as credit and applied to loads later. Gone — no addAdvance, no applyAdvance,
// no /api/advances, no UI.
//
// LEGACY ROWS ARE STILL SAFE. Any is_advance record already written to
// payments.json carries load_id: null, so paymentsForLoad's load_id filter
// simply never matches it. It cannot corrupt a balance and cannot make a load
// look part-paid — it just sits in the file, inert and invisible. Rows created
// by APPLYING an advance are ordinary payment rows with a real load_id and
// keep working exactly as before; they are indistinguishable from any other
// payment apart from an applied_from field nothing reads any more.
//
// If an unapplied advance ever needs to be recovered, it is in payments.json
// with is_advance: true — the money was never lost, only the feature.

async function addPayment(input = {}) {
    const loadId = String(input.load_id || '').trim();
    if (!loadId) throw new Error('load_id is required');
    const amount = round2(toNum(input.amount));
    // Rejected rather than stored as null: a payment with no amount cannot be
    // summed, so it would sit on the ledger looking like a receipt while
    // contributing nothing to the balance — worse than not being there.
    if (amount == null) throw new Error('a payment amount is required');
    if (amount <= 0) throw new Error('a payment amount must be greater than zero');
    const mode = PAYMENT_MODES.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    if (!mode) throw new Error(`payment mode must be one of: ${PAYMENT_MODES.join(', ')}`);

    // ── CASH COMES OUT OF THE PETTY CASH BOX ──────────────────────────────
    // Per Apsara 2026-09-02: "If i click pay in load and select cash, the
    // invoice amount should be adjusted against this."
    //
    // THE CASH IS RESERVED BEFORE THE PAYMENT IS WRITTEN, and the reservation
    // is reversed if that write fails. Two files cannot be updated atomically
    // here, so the question is which way round to fail, and the two are not
    // equally bad:
    //
    //   cash out, payment missing  -> the box shows less than it holds. Visible
    //                                 on the tab as a withdrawal with no
    //                                 payment beside it, and reversible.
    //   payment in, cash not taken -> the balance is overstated, so the NEXT
    //                                 payment is allowed to overdraw a box that
    //                                 is already empty. Nothing on screen says
    //                                 so, and the error compounds.
    //
    // So: reserve first. The reversal below closes the window in the ordinary
    // case; the ordering is what protects the case where the process dies
    // between the two writes.
    //
    // The cap is NOT applied silently. withdrawForPayment refuses when there is
    // not enough and returns `available`; the client shows that and asks; only
    // then does it come back with allow_partial. Her words: "make it as partial
    // payment and notify user" — the notification is the point, so it is a
    // precondition rather than an afterthought.
    let cashEntry = null;
    let cashTaken = null;
    if (mode === 'Cash') {
        const petty = require('./pettyCash');
        const res = await petty.withdrawForPayment({
            amount,
            loadId,
            paymentId: null,                 // stamped after the payment id exists
            date: input.paid_on,
            createdBy: input.created_by || null,
            allowPartial: input.allow_partial === true,
        });
        cashEntry = res.entry;
        cashTaken = res.taken;
    }

    const record = {
        id: newPaymentId(),
        load_id: loadId,
        // Which store the payable lives in. Ids are unique per store but not
        // across them, so without this a purchase and a sale could collide.
        //
        // 'trucker' added 2026-09-03 for the haulage bills. It has to be an
        // ALLOWLIST rather than the old `=== 'sale' ? 'sale' : 'purchase'`,
        // which silently coerced everything else to 'purchase': a trucker
        // payment would have been stored as a purchase, and then the spend
        // report — which splits on this field — would have labelled it
        // "Load TRK_001" and added it to what the yard paid for metal. The
        // grand total would still have been right, which is what makes that
        // class of bug last: nothing looks wrong until someone asks what a
        // month's haulage cost.
        //
        // Anything unrecognised still falls back to 'purchase', so records
        // written before this field existed keep their meaning.
        load_kind: ['sale', 'trucker'].includes(input.load_kind) ? input.load_kind : 'purchase',
        mode,
        // What was ACTUALLY paid. On a capped cash payment this is less than
        // was asked for, and the rest stays outstanding — which is exactly
        // what "make it a partial payment" means. Stored as the real figure so
        // paymentSummary, the card, the ticket and the invoice all agree
        // without any of them knowing about petty cash.
        amount: cashTaken != null ? cashTaken : amount,
        // Set only on a cash payment: the ledger row this drew on. Lets the
        // Petty cash tab link a withdrawal back to the load it paid, and lets
        // deletePayment find what to refund without scanning.
        petty_cash_entry_id: cashEntry ? cashEntry.id : null,
        // Local day, not UTC. toISOString() rolls over at UTC midnight, which is
        // early evening at the yard — an evening payment was being stamped with
        // tomorrow's date. See todayLocal() in helpers/time.js.
        paid_on: input.paid_on || require('./time').todayLocal(),
        reference: String(input.reference || '').trim() || null,
        note: String(input.note || '').trim() || null,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };
    try {
        await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
            const list = Array.isArray(all) ? all : [];
            list.push(record);
            return list;
        }, { strict: true });
    } catch (err) {
        // The payment did not land. Put the cash back, or the box would show
        // money gone for a payment that does not exist — see the ordering note
        // above. The reversal is stamped against the withdrawal's own id.
        if (cashEntry) {
            try {
                await require('./pettyCash').reverseForPayment(cashEntry.id, { createdBy: input.created_by || null });
            } catch (e) {
                // Both writes failed. Say so loudly and in full: this is the
                // one state a person has to reconcile by hand, and a silent
                // catch here is how it would be discovered weeks later.
                console.error(`[PAYMENTS] CASH RESERVED BUT NOT REFUNDED — petty cash entry ${cashEntry.id} took ${cashTaken} for load ${loadId} and the payment write failed. Refund also failed:`, e.message);
            }
        }
        throw err;
    }

    // Stamp the withdrawal with the payment it belongs to, now that the id
    // exists. Best-effort and deliberately not fatal: the money has already
    // moved correctly and the entry still carries load_id, so a failure here
    // costs a cross-reference, not a cent. Refunds fall back to the entry id.
    if (cashEntry) {
        try {
            await require('./pettyCash').stampPaymentId(cashEntry.id, record.id);
        } catch (e) {
            console.warn(`[PAYMENTS] could not link petty cash entry ${cashEntry.id} to payment ${record.id}:`, e.message);
        }
    }
    return record;
}

// Deleting a CASH payment puts the money back in the box. Per Apsara's model
// the two are the same event seen from two sides, so undoing one has to undo
// the other — otherwise deleting a mistaken $400 cash payment would leave the
// box $400 short forever, with nothing on screen explaining why.
//
// Refunded as a REVERSAL row rather than by deleting the withdrawal: a ledger
// you can remove rows from is one nobody can reconcile. The pair stays
// visible — money out on the 2nd, money back on the 3rd.
//
// Order is deliberate and the mirror of addPayment. There the cash moved
// first, because an overstated balance is the dangerous direction. Here the
// payment is removed first for the same reason: if the refund then fails, the
// box reads LOW, which is safe and visible, rather than high.
//
// The refund is idempotent by design (see reverseForPayment), so a retry after
// a partial failure cannot pay the money back twice.
async function deletePayment(id) {
    let removed = false;
    const doomed = listPayments().find((p) => p && p.id === id) || null;
    await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const next = list.filter((p) => p.id !== id);
        removed = next.length !== list.length;
        return next;
    });
    if (removed && doomed && doomed.mode === 'Cash') {
        // By the withdrawal's own id when we have it, else by payment id —
        // reverseForPayment accepts either, and the entry id is the one that
        // survives a payment written before the link was stamped.
        const key = doomed.petty_cash_entry_id || doomed.id;
        try {
            await require('./pettyCash').reverseForPayment(key, { createdBy: null });
        } catch (e) {
            console.error(`[PAYMENTS] deleted cash payment ${id} but could NOT return ${doomed.amount} to petty cash (${key}):`, e.message);
        }
    }
    return removed;
}

// Removes every payment for a load. Called when a load is deleted, so a
// deleted load cannot leave orphan receipts summing against nothing.
// Cascade from deleting a LOAD. Same refund rule — a load being deleted does
// not mean the cash was really spent, and the box has to come back to what it
// was. Note this is reachable today only for a load with no payments (the Pay
// and Delete buttons are mutually exclusive on the card since 2026-09-01), but
// the route still exists and the yard assistant can reach it, so the refund
// belongs here rather than in the button.
async function deletePaymentsForLoad(loadId) {
    let removed = 0;
    const doomed = listPayments().filter((p) => p && p.load_id === loadId);
    await mutateJson(cfg.PAYMENTS_FILE, [], (all) => {
        const list = Array.isArray(all) ? all : [];
        const next = list.filter((p) => p.load_id !== loadId);
        removed = list.length - next.length;
        return next;
    });
    for (const p of doomed) {
        if (p.mode !== 'Cash') continue;
        const key = p.petty_cash_entry_id || p.id;
        try {
            await require('./pettyCash').reverseForPayment(key, { createdBy: null });
        } catch (e) {
            console.error(`[PAYMENTS] load ${loadId} deleted but could NOT return ${p.amount} cash to petty cash (${key}):`, e.message);
        }
    }
    return removed;
}

// The figure every screen and the invoice quote. Derived, never stored, so it
// cannot drift from the payments it is supposed to summarise — and so that
// editing a load's price recalculates the balance instead of leaving a stale
// "paid in full" behind.
function paymentSummary(loadId, loadAmount) {
    const rows = paymentsForLoad(loadId);
    const paid = round2(rows.reduce((a, p) => a + (toNum(p.amount) || 0), 0)) || 0;
    const total = round2(toNum(loadAmount));

    // A load with no priced items has no total to settle against. Report what
    // was paid and say the balance is unknown rather than inventing one —
    // claiming "fully paid" because the total happens to be null would be a
    // lie with money attached.
    if (total == null) {
        return { paid, total: null, pending: null, status: paid > 0 ? 'paid_amount_unknown' : 'unpaid', payments: rows };
    }

    const pending = round2(total - paid);
    let status;
    if (paid <= CENT) status = 'unpaid';
    else if (pending > CENT) status = 'partial';
    else if (pending < -CENT) status = 'overpaid';
    else status = 'paid';
    return {
        paid,
        total,
        // Never negative on an overpayment — the overage is reported through
        // `status` and `over`, so a UI showing "pending" cannot show a
        // negative balance as though something were still owed.
        pending: pending > CENT ? pending : 0,
        over: pending < -CENT ? round2(-pending) : 0,
        status,
        payments: rows,
    };
}

module.exports = {
    PAYMENT_MODES, listPayments, paymentsForLoad, addPayment,
    deletePayment, deletePaymentsForLoad, paymentSummary,
};
