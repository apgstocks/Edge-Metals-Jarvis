// ── helpers/loadTruckerBill.js — the load's deduction, as a debt to a hauler ──
//
// Apsara, 2026-09-20: "trucking in loads should put a entry in trucker bills
// right?"
//
// Sometimes. Not always, and the difference is money.
//
// THREE SITUATIONS, NOT TWO
// -------------------------
//   1. She hauls it herself and pays the seller less by the haulage.
//      There is no third party. A trucker bill here is a payable to nobody —
//      and helpers/yardProfit.js SUBTRACTS trucker bills, so it would report
//      $2,459 leaving the yard when $2,259 left her hand. Wrong by exactly
//      the deduction, every time.
//   2. An outside hauler collects it, she pays him, and deducts it from the
//      seller. Here the bill is right, and it is a SECOND fact rather than a
//      restatement of the first: the deduction reduces what the seller gets,
//      the bill records what the hauler is owed. $2,259 + $200 = the load's
//      full amount, and nothing is counted twice or lost.
//   3. An outside hauler, seller paid in full. Trucker bill only, no
//      deduction — which is what the yard already did before today.
//
// So this is OFFERED, never automatic. The caller passes `wanted` straight
// from a checkbox she has seen. A payable that appears in her Trucker Bills
// from nowhere is worse than one she forgot to enter, because she will find
// the one she forgot when the hauler calls.
//
// WHY EVERY REFUSAL HAS A REASON
// ------------------------------
// This returns `{ created }` or `{ skipped, reason }` and never throws for a
// business reason. A load must still save when the bill cannot be made — the
// metal is in the yard either way — but "nothing happened" with no explanation
// is how a checkbox silently stops working. The reason travels back to the
// client so the screen can say which of these it was.
//
// IT WILL NOT WRITE A SECOND BILL, and it will not EDIT an existing one.
// Editing looked tempting: she corrects the trucking on a load, the bill
// follows. But that bill may already be paid, and a ledger of money owed that
// rewrites itself because a different screen changed is the kind of thing
// nobody can reconstruct afterwards. So a load whose ticket already appears on
// a trucker bill is reported back, with the bill's id, and she decides.

const truckerBills = require('./truckerBills');

async function maybeCreateTruckerBill(load, { wanted, createdBy } = {}) {
    if (!wanted) return { skipped: true, reason: 'not_requested' };
    if (!load || !load.id) return { skipped: true, reason: 'no_load' };

    const amount = Number(load.trucking_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return { skipped: true, reason: 'no_trucking_amount' };
    }

    // truckerBills.validateBill hard-requires a company, so this would throw
    // rather than skip. Caught here instead, because "you did not say who
    // hauled it" is a sentence she can act on and a 500 is not — and because
    // a blank company is exactly the shape of situation 1 above, where no bill
    // should be written at all.
    const company = String(load.trucking_company || '').trim();
    if (!company) return { skipped: true, reason: 'no_trucking_company' };

    const existing = truckerBills.billsForLoadTicket(load.id);
    if (existing.length) {
        return { skipped: true, reason: 'already_exists', bill_id: existing[0].id, existing_amount: existing[0].amount };
    }

    // The load's own date, so the bill lands in the same period as the haul it
    // paid for. A bill dated today against a load from last month would move
    // her spend report's trucking total into the wrong month.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(load.date || ''))
        ? load.date : require('./time').todayLocal();

    const bill = await truckerBills.addBill({
        date, company, amount,
        // The free-text cross-reference the store already has. Still not a
        // foreign key — see helpers/truckerBills.js's header for why that is
        // deliberate and must stay that way.
        load_ticket: load.id,
        notes: load.trucking_note || `Deducted from ${load.seller || 'the seller'} on load ${load.id}.`,
        created_by: createdBy || 'unknown',
    });
    return { created: true, bill };
}

module.exports = { maybeCreateTruckerBill };
