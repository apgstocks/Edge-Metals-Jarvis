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
