// ── helpers/salesSettlements.js — what a sale COSTS, and paying it ───────
// Apsara, 2026-09-10, asked whether freight and commission need to be tracked
// as paid or unpaid: "Yes — both get settled separately."
//
// ── WHAT IS BEING SETTLED ────────────────────────────────────────────────
// Two kinds of payable hang off a sold container, and both live on the
// container row rather than in a table of their own (see the header of
// helpers/sales.js for why a second table would have meant four copies of the
// container number):
//
//   · a CHARGE with direction 'out' — ocean freight, THC, fumigation. What
//     Edge Metals pays a carrier or a vendor to get the container there.
//   · COMMISSION — invoiced weight in MT x the rate, paid to an agent.
//
// A charge with direction 'in' is NOT here. That is money the customer owes
// on top of the invoice, and it is collected through helpers/salesReceipts.js.
// Putting it here would have Edge Metals paying itself.
//
// ── THE SHAPE, AGAIN ─────────────────────────────────────────────────────
// Header plus allocations, for the third time in this codebase, because it is
// the same fact each time: one transfer settles several things, and one thing
// is settled over several transfers. An allocation names the container AND
// what on it — a charge by its id, or the commission.
//
// Charge ids are minted in helpers/sales.cleanCharges and preserved on every
// save. By array index this file would follow the wrong charge the first time
// one was deleted from the middle of the list, and it would do it silently.
//
// ── AND IT IS MONEY OUT, SO IT IS IN THE SPEND REPORT ────────────────────
// Unlike a receipt, this really is an outflow, so it writes one row per
// transfer to helpers/payments.js with load_kind 'sale_cost' — its own kind,
// not folded into 'bill'. A supplier payment buys metal; freight and
// commission are what it costs to SELL it, and a margin worked out from a
// Supplier line quietly containing both is wrong in the direction that looks
// fine. helpers/spendReport.js has the matching branch and its own total.
//
// Cash settlements do NOT draw down the yard's petty cash box — 'sale_cost'
// is in payments.js's EDGE_METALS_KINDS for the same reason 'bill' is.

const cfg = require('../config');
const { loadJson, mutateJson } = require('./json');

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};
const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const CENT = 0.005;

const SETTLEMENT_MODES = ['Wire', 'Zelle', 'Cash', 'Cheque'];
const TARGET_KINDS = ['charge', 'commission'];

const list = () => {
    const raw = loadJson(cfg.SALES_SETTLEMENTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
};

const newId = () => `STL_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// One target is one payable: a named charge on a container, or that
// container's commission. The key is what allocations are indexed by, and it
// is deliberately built from BOTH parts — a charge id alone would collide
// with nothing today and with everything the day charges are copied between
// containers.
const keyOf = (saleId, kind, chargeId) =>
    kind === 'commission' ? `${saleId}|commission` : `${saleId}|charge|${chargeId}`;

// ── WHAT IS OWED ON EVERY PAYABLE ────────────────────────────────────────
// One pass over the sales rows and one over the settlements. Built here
// rather than on the sales row because a payable is not a column: a container
// can carry four charges, and four columns is where this design started.
function payables({ excluding = null } = {}) {
    const sales = require('./sales');
    const paid = paidByTarget({ excluding });
    const out = [];

    for (const row of sales.listWithTotals()) {
        for (const c of (row.charges || [])) {
            if (c.direction !== 'out') continue;         // 'in' is a receivable
            const key = keyOf(row.id, 'charge', c.id);
            const already = paid[key] || 0;
            out.push({
                key, sale_id: row.id, kind: 'charge', charge_id: c.id,
                booking_no: row.booking_no || null,
                container_no: row.container_no || null,
                hbl_no: row.hbl_no || null,
                customer: row.customer || null,
                what: c.what, why: c.why,
                amount: c.amount,
                paid: already,
                balance: round2(c.amount - already),
            });
        }

        const comm = row.commission_amount;
        if (comm !== null && comm !== undefined && comm > 0) {
            const key = keyOf(row.id, 'commission', null);
            const already = paid[key] || 0;
            out.push({
                key, sale_id: row.id, kind: 'commission', charge_id: null,
                booking_no: row.booking_no || null,
                container_no: row.container_no || null,
                hbl_no: row.hbl_no || null,
                customer: row.customer || null,
                what: 'Commission',
                why: row.commission_per_mt
                    ? `${row.commission_per_mt} per MT on ${row.weight_mt || 0} MT invoiced`
                    : 'Stated amount',
                amount: comm,
                paid: already,
                balance: round2(comm - already),
            });
        }
    }
    return out;
}

// ── `excluding` — DEFAULT NOTHING, SO EVERY EXISTING CALLER IS UNCHANGED ─
// Added 2026-10-07 for editSettlement. A settlement's OWN allocations are
// part of what made its target look settled, so validating an edit against
// "what is outstanding" would refuse to let her touch any settlement that
// actually paid something off — which is most of them. Passing the
// settlement's id here takes its own contribution back out first.
//
// The flag marks the NEW shape rather than the old one: no caller has to set
// it to keep today's behaviour.
function paidByTarget({ excluding = null } = {}) {
    const out = {};
    for (const st of list()) {
        if (excluding && String(st.id) === String(excluding)) continue;
        for (const a of (st.allocations || [])) {
            const k = keyOf(a.sale_id, a.kind, a.charge_id);
            out[k] = round2((out[k] || 0) + (num(a.amount) || 0));
        }
    }
    return out;
}

// What each container has had paid out on it, for the sales table.
function settledBySale() {
    const out = {};
    for (const st of list()) {
        for (const a of (st.allocations || [])) {
            out[a.sale_id] = round2((out[a.sale_id] || 0) + (num(a.amount) || 0));
        }
    }
    return out;
}

function cleanAllocations(input, amount, { excluding = null } = {}) {
    const open = new Map(payables({ excluding }).map((p) => [p.key, p]));
    const out = [];

    for (const a of (input || [])) {
        const saleId = String((a && a.sale_id) || '').trim();
        const kind = TARGET_KINDS.includes(String((a && a.kind) || '').trim())
            ? String(a.kind).trim() : null;
        const amt = round2(num(a && a.amount));
        if (!saleId || !kind) continue;
        if (amt === null || amt <= 0) continue;

        const chargeId = kind === 'charge' ? String((a && a.charge_id) || '').trim() : null;
        if (kind === 'charge' && !chargeId) throw new Error('which charge is being paid?');

        const key = keyOf(saleId, kind, chargeId);
        const target = open.get(key);
        // Not "no such sale" — the payable may be gone because the charge was
        // deleted or the commission rate cleared, and saying so is the
        // difference between a fixable message and a puzzling one.
        if (!target) {
            throw new Error(`nothing outstanding to pay on that ${kind} — it may have been changed or already settled`);
        }

        const existing = out.find((x) => keyOf(x.sale_id, x.kind, x.charge_id) === key);
        if (existing) existing.amount = round2(existing.amount + amt);
        else out.push({ sale_id: saleId, kind, charge_id: chargeId, amount: amt });
    }

    // ── NOT MORE THAN IS OWED ON EACH ONE ────────────────────────────────
    // Found by its own test, 2026-09-10: the map above is built from EVERY
    // payable, settled ones included, so a second payment against a charge
    // already square went through and wrote a second ledger row. The total
    // spend was then overstated by it, with every individual figure looking
    // ordinary — the shape of error that survives until a month is closed.
    for (const a of out) {
        const target = open.get(keyOf(a.sale_id, a.kind, a.charge_id));
        if (!target) continue;                          // handled above
        if (a.amount - target.balance > CENT) {
            const left = target.balance <= CENT
                ? 'nothing outstanding on it'
                : `only $${target.balance.toFixed(2)} outstanding`;
            throw new Error(`$${a.amount.toFixed(2)} against ${target.what} on ${target.container_no || target.sale_id}, but there is ${left} — it may have been changed or already settled`);
        }
    }

    const total = round2(out.reduce((s, a) => s + a.amount, 0)) || 0;
    if (total - amount > CENT) {
        throw new Error(`allocations come to $${total.toFixed(2)} but the payment is $${amount.toFixed(2)}`);
    }
    // Same rule as the purchase side: an unallocated remainder here would be
    // money out with nothing to say what it bought.
    if (amount - total > CENT) {
        throw new Error(`$${round2(amount - total).toFixed(2)} of this payment is not against any charge`);
    }
    return out;
}

async function mirrorToLedger(rec) {
    const { addPayment } = require('./payments');
    return addPayment({
        load_id: rec.id,                 // the SETTLEMENT's id, not a sale id
        load_kind: 'sale_cost',
        amount: rec.amount,
        mode: rec.mode,
        bank: rec.bank || null,
        // The ledger stores YYYY-MM-DD; she types MM/DD/YYYY. Passing hers
        // straight through once put a payment in no report at all.
        paid_on: require('./bills').sortableDate(rec.date) || rec.date,
        require_bank: rec.mode === 'Wire' || rec.mode === 'Zelle',
        created_by: rec.created_by || null,
    });
}

// ── THE RULES, LIFTED OUT SO EDIT CANNOT GROW A SECOND COPY ──────────────
// Extracted 2026-10-07, unchanged and in the same order, when editSettlement
// was added — the same move helpers/billPayments.js made the same day and
// for the same reason: an edit must enforce exactly what a create enforces,
// or it is a second and laxer way in.
//
// WRITES NOTHING — but it is NOT pure. cleanAllocations calls payables(),
// which reads sales.json, because an allocation is only valid against a
// charge or commission that is actually outstanding. A first version of this
// comment claimed "no store", and the test caught it immediately by failing
// on a fixture with no sales. Worth stating plainly: a preview built on this
// needs her real ledger to be readable, and refuses rather than guessing
// when a target has since been settled or deleted.
function validateSettlementInput(input = {}, { excluding = null } = {}) {
    const amount = round2(num(input.amount));
    if (amount === null || amount <= 0) throw new Error('a settlement amount is required');
    const mode = SETTLEMENT_MODES.find((m) => m.toLowerCase() === String(input.mode || '').trim().toLowerCase());
    if (!mode) throw new Error(`payment mode must be one of: ${SETTLEMENT_MODES.join(', ')}`);
    if (!String(input.date || '').trim()) throw new Error('a settlement needs a date');
    if (!String(input.payee || '').trim()) throw new Error('who is being paid?');
    if ((mode === 'Wire' || mode === 'Zelle') && !String(input.bank || '').trim()) {
        throw new Error('a bank is required for Zelle and Wire');
    }
    const allocations = cleanAllocations(input.allocations, amount, { excluding });
    if (!allocations.length) throw new Error('nothing was allocated — which charge is this paying?');
    return {
        amount, mode,
        bank: (mode === 'Wire' || mode === 'Zelle') ? String(input.bank).trim() : null,
        date: String(input.date).trim(),
        ref: String(input.ref || '').trim() || null,
        payee: String(input.payee).trim(),
        note: String(input.note || '').trim() || null,
        allocations,
    };
}

async function addSettlement(input = {}) {
    // Every rule now lives in validateSettlementInput above. The comment
    // below about payee being deliberately unchecked stayed with the field.
    const v = validateSettlementInput(input);
    const { amount, mode, allocations } = v;

    const rec = {
        id: newId(),
        date: v.date,
        amount,
        mode,
        bank: v.bank,
        ref: v.ref,
        // Free text and deliberately not checked against the allocations: a
        // charge records what it was for, not who to pay, so there is nothing
        // here to check against. Recording an unverifiable claim is honest;
        // pretending to verify it would not be.
        payee: v.payee,
        note: v.note,
        allocations,
        created_at: new Date().toISOString(),
        created_by: input.created_by || null,
    };

    // Ledger first: better a settlement she has to enter again than one that
    // exists here and is missing from her spend report.
    const mirrored = await mirrorToLedger(rec);
    rec.ledger_payment_id = mirrored && mirrored.id ? mirrored.id : null;

    await mutateJson(cfg.SALES_SETTLEMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        rows.push(rec);
        return rows;
    });
    return rec;
}

// ── EDITING A FREIGHT OR COMMISSION SETTLEMENT ───────────────────────────
// Apsara, 2026-10-07: "give option to pay multiple invoices together and
// option to edit". Several at once already worked — allocations are a list.
// Editing did not exist on any payment path in this system.
//
// Her two rules, the same ones helpers/billPayments.js now follows:
//   containers  "Recompute everything, show me before saving."
//   QuickBooks  "Refuse, and tell me to change both."
//
// This covers TWO of the three cost types she named — a settlement carries
// kind 'charge' (freight and other sale charges) or 'commission'.

// What this edit would do. Writes nothing, so a screen can show it first.
function previewSettlementEdit(id, patch = {}) {
    const before = list().find((s) => s.id === id);
    if (!before) throw new Error(`no settlement ${id}`);

    const merged = {
        amount: patch.amount !== undefined ? patch.amount : before.amount,
        mode: patch.mode !== undefined ? patch.mode : before.mode,
        bank: patch.bank !== undefined ? patch.bank : before.bank,
        date: patch.date !== undefined ? patch.date : before.date,
        ref: patch.ref !== undefined ? patch.ref : before.ref,
        payee: patch.payee !== undefined ? patch.payee : before.payee,
        note: patch.note !== undefined ? patch.note : before.note,
        allocations: patch.allocations !== undefined ? patch.allocations : before.allocations,
    };
    // Its own allocations taken out first — see paidByTarget.
    const after = validateSettlementInput(merged, { excluding: id });

    // What each target was paid before and after. keyOf is this file's own
    // identity for a charge or a commission, so the delta is computed on the
    // same key the payables list uses — not a second idea of what a target is.
    const sum = (allocs) => {
        const m = new Map();
        for (const a of (allocs || [])) {
            const k = keyOf(a.sale_id, a.kind, a.charge_id);
            m.set(k, round2((m.get(k) || 0) + (num(a.amount) || 0)));
        }
        return m;
    };
    const was = sum(before.allocations);
    const will = sum(after.allocations);

    const outstanding = new Map();
    try {
        for (const p of payables()) outstanding.set(keyOf(p.sale_id, p.kind, p.charge_id), p);
    } catch (e) { /* payables needs sales; a preview must still work without */ }

    const changes = [...new Set([...was.keys(), ...will.keys()])].map((key) => {
        const p = outstanding.get(key) || null;
        const paidBefore = was.get(key) || 0;
        const paidAfter = will.get(key) || 0;
        return {
            key,
            kind: p ? p.kind : (String(key).includes('|commission') ? 'commission' : 'charge'),
            sale_id: p ? p.sale_id : null,
            container_no: p ? (p.container_no || null) : null,
            label: p ? (p.label || p.what || null) : null,
            owed: p && p.amount != null ? round2(num(p.amount)) : null,
            paid_before: paidBefore, paid_after: paidAfter,
            effect: paidBefore === paidAfter ? 'unchanged'
                : paidAfter === 0 ? 'no longer paid by this settlement'
                : paidBefore === 0 ? 'now paid by this settlement' : 'amount changes',
        };
    }).sort((a, b) => String(a.container_no || '').localeCompare(String(b.container_no || '')));

    return {
        id,
        before: { amount: before.amount, mode: before.mode, bank: before.bank, date: before.date,
            ref: before.ref, payee: before.payee, allocations: before.allocations || [] },
        after: { amount: after.amount, mode: after.mode, bank: after.bank, date: after.date,
            ref: after.ref, payee: after.payee, allocations: after.allocations },
        changes,
        dropped: changes.filter((c) => c.effect === 'no longer paid by this settlement').length,
        added: changes.filter((c) => c.effect === 'now paid by this settlement').length,
        touchesLedger: round2(num(before.amount)) !== after.amount
            || String(before.mode) !== after.mode
            || String(before.bank || '') !== String(after.bank || '')
            || String(before.date) !== after.date
            || String(before.payee || '') !== String(after.payee || '')
            || String(before.ref || '') !== String(after.ref || ''),
    };
}

async function editSettlement(id, patch = {}, { actor = null } = {}) {
    const before = list().find((s) => s.id === id);
    if (!before) throw new Error(`no settlement ${id}`);

    // Her rule: refuse, and FAIL CLOSED if QuickBooks cannot be asked.
    try {
        const qb = require('./qbLinked');
        const link = qb.linkedRow(before, { kind: 'sales_settlements', keys: qb.liveKeys() });
        if (link && link.linked) {
            throw new Error(`this settlement is already in QuickBooks (${link.why}). `
                + 'Change it in both, or delete it there first — an edit here alone would '
                + 'leave your books and Jarvis disagreeing.');
        }
    } catch (e) {
        if (/already in QuickBooks/.test(String(e && e.message))) throw e;
        throw new Error(`could not check QuickBooks (${(e && e.message) || e}), so this edit is `
            + 'refused rather than risked. Nothing was changed.');
    }

    const plan = previewSettlementEdit(id, patch);
    const after = plan.after;

    // Delete then mirror, never the other way round: deletePaymentsForLoad
    // keys on the settlement id, which a rebuilt mirror also carries, so
    // mirroring first would remove both and leave the spend report blind.
    // A failed re-mirror restores the original and nothing else is written.
    let ledgerId = before.ledger_payment_id || null;
    if (plan.touchesLedger) {
        const { deletePaymentsForLoad } = require('./payments');
        await deletePaymentsForLoad(before.id);
        try {
            const mirrored = await mirrorToLedger({ ...before, ...after, id: before.id });
            ledgerId = mirrored && mirrored.id ? mirrored.id : null;
        } catch (e) {
            try { await mirrorToLedger(before); } catch (e2) {
                console.error('[SETTLE] the edit failed AND the original ledger row could not be '
                    + 'restored:', e2.message);
            }
            throw new Error(`could not rewrite the ledger row (${(e && e.message) || e}) — `
                + 'nothing was changed');
        }
    }

    await mutateJson(cfg.SALES_SETTLEMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r && r.id === id);
        if (i === -1) throw new Error(`settlement ${id} disappeared while being edited`);
        rows[i] = {
            ...rows[i],
            date: after.date, amount: after.amount, mode: after.mode, bank: after.bank,
            ref: after.ref, payee: after.payee, note: after.note,
            allocations: after.allocations,
            ledger_payment_id: ledgerId,
            edited_at: new Date().toISOString(),
            edited_by: actor || null,
            // Appended, never replaced — an edit that erases what the row
            // used to say is a deletion wearing a friendlier word.
            edit_history: [...(rows[i].edit_history || []), {
                at: new Date().toISOString(), by: actor || null,
                was: { date: before.date, amount: before.amount, mode: before.mode,
                    bank: before.bank, ref: before.ref, payee: before.payee,
                    allocations: before.allocations || [] },
            }],
        };
        return rows;
    }, { strict: true });

    return { ...plan, applied: true };
}

async function deleteSettlement(id) {
    const doomed = list().find((r) => r.id === id);
    if (!doomed) throw new Error(`no settlement ${id}`);
    await mutateJson(cfg.SALES_SETTLEMENTS_FILE, [], (all) => {
        const rows = Array.isArray(all) ? all : [];
        const i = rows.findIndex((r) => r.id === id);
        if (i !== -1) rows.splice(i, 1);
        return rows;
    });
    try {
        await require('./payments').deletePaymentsForLoad(doomed.id);
    } catch (e) {
        console.error('[SALE-COST] removed the settlement but not its ledger row:', e.message);
    }
    return doomed;
}

function summary() {
    const p = payables();
    const owed = round2(p.reduce((s, x) => s + Math.max(0, x.balance || 0), 0)) || 0;
    return {
        count: list().length,
        paid: round2(list().reduce((s, x) => s + (num(x.amount) || 0), 0)) || 0,
        outstanding: owed,
        charges_outstanding: round2(p.filter((x) => x.kind === 'charge')
            .reduce((s, x) => s + Math.max(0, x.balance || 0), 0)) || 0,
        commission_outstanding: round2(p.filter((x) => x.kind === 'commission')
            .reduce((s, x) => s + Math.max(0, x.balance || 0), 0)) || 0,
    };
}

module.exports = {
    SETTLEMENT_MODES, TARGET_KINDS,
    list, addSettlement, deleteSettlement, summary,
    payables, paidByTarget, settledBySale, cleanAllocations, keyOf,
    // Added 2026-10-07. previewSettlementEdit writes nothing and is what the
    // screen shows BEFORE editSettlement — "Recompute everything, show me
    // before saving." Covers freight and commission, two of the three cost
    // types she named.
    validateSettlementInput, previewSettlementEdit, editSettlement,
};
