// ── helpers/booksBuild.js — her real rows, fed to the posting layer ──────
//
// The keystone. helpers/postings.js turns transactions into debits and
// credits and helpers/statements.js turns those into the four statements,
// but neither reads a store — on purpose. This is the one file that does,
// and it is the only place that knows what lives where.
//
// ── EVERY AMOUNT COMES FROM THE STORE'S OWN ARITHMETIC ───────────────────
// Not from the raw row. sales.json has NO amount field: it stores weight
// and invoice_price and sales.js computes `receivable` with the lb/MT
// handling that makes it right. bills.js computes `net_payable` the same
// way. scripts/entity-audit.js read row.amount earlier today and printed
// $0.00 for seven real invoices, and CLAUDE.md records the identical
// mistake once before that.
//
// So: list through listWithTotals() where a store has one, and where a
// store genuinely does hold its amount, say so in a comment at the call.
// Anything whose figure cannot be obtained is REPORTED, never defaulted to
// zero — a quiet zero in a P&L is indistinguishable from a real one.
//
// ── IT WRITES NOTHING ────────────────────────────────────────────────────
// Read-only over every store it touches. The journal is derived and can be
// rebuilt at any time; see the header of helpers/postings.js for why that
// is the whole design rather than a detail.

const P = require('./postings');
const E = require('./entities');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// A store that is absent or unreadable must not take the books down — on
// a machine without her data most of them are. It becomes a note, and the
// caller can see which stores were actually read.
function safely(label, fn, notes) {
    try {
        const rows = fn();
        if (!Array.isArray(rows)) { notes.push(`${label}: not a list, skipped`); return []; }
        return rows;
    } catch (e) {
        notes.push(`${label}: could not be read — ${(e && e.message) || e}`);
        return [];
    }
}

// entities.js decides whose books a row belongs to. A row it cannot place
// is NOT posted: it would land on some company's return and we do not know
// which. Those are counted and returned so the caller can show her a list
// rather than a silently smaller profit.
function place(store, row, unplaced) {
    const r = E.of(store, row);
    if (!r.ledger) { unplaced.push({ store, row, why: r.basis }); return null; }
    return r;
}

function build({ from, to } = {}) {
    const notes = [];
    const unplaced = [];
    const txs = [];

    const inRange = (d) => {
        const s = String(d || '');
        if (from && s < String(from)) return false;
        if (to && s > String(to)) return false;
        return true;
    };

    // ── EDGE METALS: BILLS ───────────────────────────────────────────────
    // listWithTotals computes net_payable; the raw row does not carry it.
    for (const b of safely('bills', () => require('./bills').listWithTotals(), notes)) {
        if (!inRange(b.date)) continue;
        const p = place('bills', b, unplaced); if (!p) continue;
        // GROSS, not net_payable. bills.js:402-408: amount is what the metal
        // came to, net_payable is what the SUPPLIER is owed after the haulage
        // she covers for them. Passing net_payable here and letting the rule
        // subtract trucking again booked material at 37,000 on a 40,000 bill
        // — and balanced perfectly while doing it.
        txs.push({
            kind: 'metals-purchase', entity: p.ledger, date: b.date,
            amount: num(b.amount),
            trucking: num(b.trucking_amount_used != null ? b.trucking_amount_used : b.trucking_amount),
            party: b.supplier, memo: b.container_no || b.invoice_no || null,
            source: { store: 'bills', id: b.id },
        });
    }

    // ── EDGE METALS: INVOICES ────────────────────────────────────────────
    // `receivable` is computed. Reading b.amount here is the exact bug that
    // printed $0.00 for seven invoices.
    for (const s of safely('sales', () => require('./sales').listWithTotals(), notes)) {
        if (!inRange(s.date)) continue;
        const p = place('sales', s, unplaced); if (!p) continue;
        txs.push({
            kind: 'metals-sale', entity: p.ledger, date: s.date,
            amount: num(s.receivable != null ? s.receivable : s.amount),
            commission: num(s.commission_amount),
            party: s.customer, memo: s.container_no || s.invoice_no || null,
            source: { store: 'sales', id: s.id },
        });
    }

    // ── PAYING SUPPLIERS ─────────────────────────────────────────────────
    // The applied figure decides how much settles a payable and how much is
    // still an advance — the distinction that keeps $1.18M off the P&L.
    for (const bp of safely('bill_payments', () => require('./billPayments').list(), notes)) {
        if (!inRange(bp.date)) continue;
        const p = place('bill_payments', bp, unplaced); if (!p) continue;
        const applied = (bp.allocations || []).reduce((t, a) => t + num(a.amount), 0);
        txs.push({
            kind: 'supplier-payment', entity: p.ledger, paidBy: p.paidBy, date: bp.date,
            amount: num(bp.amount), applied,
            mode: bp.mode, bank: bp.bank,
            party: bp.supplier, source: { store: 'bill_payments', id: bp.id },
        });
    }

    // ── CUSTOMERS PAYING ─────────────────────────────────────────────────
    for (const r of safely('sales_receipts', () => require('./salesReceipts').list(), notes)) {
        if (!inRange(r.date)) continue;
        const p = place('sales_receipts', r, unplaced); if (!p) continue;
        txs.push({
            kind: 'customer-receipt', entity: p.ledger, paidBy: p.paidBy, date: r.date,
            amount: num(r.amount), shortfall: num(r.shortfall || r.deduction),
            mode: r.mode, bank: r.bank,
            party: r.customer, source: { store: 'sales_receipts', id: r.id },
        });
    }

    // ── THE YARD ─────────────────────────────────────────────────────────
    // loads.json holds its own amount — it is typed on the load form, not
    // derived from a price per unit the way an invoice is.
    for (const l of safely('loads', () => require('./loads').loadLoads(), notes)) {
        if (!inRange(l.date)) continue;
        const p = place('loads', l, unplaced); if (!p) continue;
        txs.push({
            kind: 'yard-purchase', entity: p.ledger, date: l.date,
            amount: num(l.amount), party: l.seller,
            source: { store: 'loads', id: l.id },
        });
    }
    for (const l of safely('outbound_loads', () => require('./outboundLoads').loadOutboundLoads(), notes)) {
        if (!inRange(l.date)) continue;
        const p = place('outbound_loads', l, unplaced); if (!p) continue;
        txs.push({
            kind: 'yard-sale', entity: p.ledger, date: l.date,
            amount: num(l.amount), party: l.buyer,
            source: { store: 'outbound_loads', id: l.id },
        });
    }
    for (const t of safely('trucker_bills', () => require('./truckerBills').listBills(), notes)) {
        if (!inRange(t.date)) continue;
        const p = place('trucker_bills', t, unplaced); if (!p) continue;
        txs.push({
            kind: 'trucker-bill', entity: p.ledger, date: t.date,
            amount: num(t.amount), party: t.trucker || t.carrier,
            source: { store: 'trucker_bills', id: t.id },
        });
    }

    // ── LOCAL-DELIVERY CARRIERS: NTG, TQL, SCHNEIDER ─────────────────────
    // Apsara, 2026-10-08: "5100 for them". Until today this store reached no
    // statement at all — scripts/trucking-double-count.js found it sitting
    // outside the books entirely, so freight was understated by whatever was
    // in it and the CPA pack was missing it.
    //
    // TWO transactions per invoice, not one. The invoice is the cost and the
    // liability; the payment is separate so an unpaid invoice still shows as
    // owed, and so a payment with no identifiable bank becomes a PROBLEM
    // rather than a guessed credit (see postings.js).
    for (const ci of safely('carrier_invoices', () => require('./carrierInvoices').list(), notes)) {
        if (!inRange(ci.invoice_date)) continue;
        const p = place('carrier_invoices', ci, unplaced); if (!p) continue;
        txs.push({
            kind: 'carrier-invoice', entity: p.ledger, date: ci.invoice_date,
            amount: num(ci.amount), party: ci.carrier, ref: ci.ref,
            memo: ci.lane || null,
            source: { store: 'carrier_invoices', id: ci.id },
        });
        // Each recorded payment on its own, so two part payments are two
        // credits on the dates they happened rather than one lump.
        for (const pay of (Array.isArray(ci.payments) ? ci.payments : [])) {
            if (!inRange(pay.date)) continue;
            txs.push({
                kind: 'carrier-invoice-payment', entity: p.ledger, date: pay.date,
                amount: num(pay.amount), party: ci.carrier, ref: ci.ref,
                mode: pay.mode || null, bank: pay.bank || null,
                source: { store: 'carrier_invoices', id: ci.id },
            });
        }
        // An IMPORTED row carries `paid` with no payments[] behind it — the
        // carrier's remittance mail said so and never said from which account.
        //
        // ── APSARA, 2026-10-08: "it is from BofA only" ───────────────────
        // Asked about exactly these rows — the ones imported from a carrier's
        // remittance mail — and that is the only place the answer is applied.
        // Her local carriers are paid out of Bank of America, so the credit
        // goes to 1010 instead of being left as a could-not-post problem.
        //
        // ── WHY THE ANSWER IS NOT IN bankAccount() ───────────────────────
        // bankAccount() in helpers/postings.js is shared by every rule that
        // touches money — supplier payments, customer receipts, expenses. A
        // default of BofA there would mean a payment where the bank was left
        // BLANK quietly credits BofA, and `payManual` writes
        // `bank: input.bank || null`, so a payment SHE typed with the bank
        // field empty would post against an account she never chose. That is
        // the shape CLAUDE.md §1 is about: a rule that is right on one screen
        // landing in code other callers reach.
        //
        // So the answer is stamped here, on the one tx this build emits for
        // an imported row, and `source !== 'manual'` is the gate. The gate
        // marks the NEW shape, not the old one: a row she typed by hand is
        // NOT covered by her rule. (addManual sets `paid: 0` and payManual
        // appends to payments[] for every increment, so a manual row has no
        // unexplained remainder to begin with — the gate is belt and braces,
        // and it is what stops her sentence spreading if that ever changes.)
        const recorded = (Array.isArray(ci.payments) ? ci.payments : [])
            .reduce((t, x) => t + num(x.amount), 0);
        const unexplained = Math.round((num(ci.paid) - recorded) * 100) / 100;
        if (unexplained > 0.005) {
            const imported = ci.source !== 'manual';
            txs.push({
                kind: 'carrier-invoice-payment', entity: p.ledger,
                date: (ci.paid_dates || []).slice(-1)[0] || ci.invoice_date,
                amount: unexplained, party: ci.carrier, ref: ci.ref,
                mode: imported ? 'bank transfer' : null,
                bank: imported ? 'BofA' : null,
                // Kept on the tx so the general ledger can say WHY it says
                // BofA. Nothing read it off the remittance mail; it is her
                // standing answer, and a reader of the GL deserves to know
                // the difference between a recorded fact and a known default.
                bank_assumed: imported || undefined,
                source: { store: 'carrier_invoices', id: ci.id },
            });
        }
    }

    // ── EXPENSES ─────────────────────────────────────────────────────────
    // The category chooses the account and postings.js refuses an unknown
    // one. That refusal is the point: it surfaces an account the chart is
    // missing instead of burying the row in "Other".
    for (const x of safely('expenses', () => require('./expenses').loadExpenses(), notes)) {
        if (!inRange(x.date)) continue;
        const p = place('expenses', x, unplaced); if (!p) continue;
        txs.push({
            kind: 'expense', entity: p.ledger, date: x.date,
            amount: num(x.amount), category: x.category,
            mode: x.method, bank: x.bank,
            party: x.payee || null, memo: x.description || null,
            source: { store: 'expenses', id: x.id },
        });
    }

    const j = P.journal(txs);
    return {
        from: from || null, to: to || null,
        transactions: txs.length,
        journal: j,
        lines: j.lines,
        unplaced,
        notes,
        // ── WHAT THE CALLER MUST NOT IGNORE ──────────────────────────────
        // `complete` is false if ANY row could not be placed on a company or
        // could not be posted. A statement built from an incomplete journal
        // is a smaller profit than the truth, and looks exactly like a
        // correct one.
        complete: unplaced.length === 0 && j.problems.length === 0,
        problems: j.problems,
    };
}

module.exports = { build };
