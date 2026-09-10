// ── helpers/margin.js — what a container actually made ──────────────────
// The point of everything built on 2026-09-10. Bills became one row per
// container; Sales became one row per container keyed the same way, booking
// then container; and the two are now joinable. This file is the join.
//
// It is the number the business runs on and the app could not produce it
// before today: what a container COST and what it SOLD for are answered in
// two different tabs, and nobody was subtracting one from the other.
//
// ── WHAT COUNTS AS REVENUE, AND WHAT COUNTS AS COST ─────────────────────
// Every figure here already exists and is decided in exactly one place. This
// file adds no arithmetic of its own beyond the subtraction — if it did, it
// would be a second opinion about her formulas, free to drift from the first.
//
//   revenue   invoice amount            helpers/sales.compute
//           + charges billed to them    the 'in' charges on the sale row
//
//   cost      supplier invoice amount   helpers/bills.compute
//           + trucking                  the bill's split, or its typed total
//           + charges she pays          the 'out' charges on the sale row
//           + commission                invoiced weight in MT x the rate
//
// Trucking is taken from the BILL and not counted again from anywhere else.
// It is deducted from what the supplier is owed (bills.net_payable) AND it is
// a real cost of the container; those are two different questions and only
// one of them is this one. Counting it in both places here would be the
// classic double-subtraction, and it is the reason margin_gap below exists.
//
// ── A CONTAINER WITH ONLY ONE SIDE IS NOT A LOSS ────────────────────────
// A bill with no sale yet is not a container that lost its whole cost, and a
// sale with no bill is not pure profit. Those are reported as 'bought' and
// 'sold' with a null margin rather than a number that reads as a disaster or
// a windfall. Only 'closed' — both sides present — carries a figure.

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};

// The pair that identifies a physical container. A container number alone is
// not unique over time — MSKU1111111 sails again next year with different
// metal in it — so the booking is what makes it one, exactly as it is on
// both of the tables being joined.
const keyOf = (bookingNo, containerNo) =>
    `${String(bookingNo || '').trim().toUpperCase()}|${String(containerNo || '').trim().toUpperCase()}`;

const STATES = ['closed', 'bought', 'sold'];

function rows() {
    const bills = require('./bills');
    const sales = require('./sales');

    const byKey = new Map();
    const take = (k, seed) => {
        if (!byKey.has(k)) byKey.set(k, seed);
        return byKey.get(k);
    };

    for (const b of bills.listWithTotals()) {
        const container = String(b.container_no || '').trim();
        // Without a container there is nothing to join ON. Reported by the
        // caller as unjoinable rather than silently dropped — a bill nobody
        // can match is a bill whose margin will never appear, and that is
        // worth seeing.
        if (!container) continue;
        const k = keyOf(b.booking_no, container);
        const row = take(k, { key: k, booking_no: b.booking_no || null, container_no: container });
        row.bill_id = b.id;
        row.supplier = b.supplier || null;
        row.bill_date = b.date || null;
        row.bill_amount = num(b.amount);
        // The split's sum when there is one, her typed figure otherwise —
        // reading trucking_amount directly would take a stale number.
        row.trucking = num(b.trucking_amount_used !== undefined
            ? b.trucking_amount_used : b.trucking_amount);
        row.bought_weight_lb = num(b.net_lb);
    }

    for (const s of sales.listWithTotals()) {
        const container = String(s.container_no || '').trim();
        if (!container) continue;
        const k = keyOf(s.booking_no, container);
        const row = take(k, { key: k, booking_no: s.booking_no || null, container_no: container });
        row.sale_id = s.id;
        row.customer = s.customer || null;
        row.sale_date = s.date || null;
        row.invoice_amount = num(s.amount);
        row.charges_in = num(s.charges_in_total) || 0;
        row.charges_out = num(s.charges_out_total) || 0;
        row.commission = num(s.commission_amount) || 0;
        row.sold_weight_lb = num(s.weight_lb);
        row.received = num(s.received) || 0;
        row.receivable = num(s.receivable);
    }

    const out = [];
    for (const r of byKey.values()) {
        const bought = !!r.bill_id;
        const sold = !!r.sale_id;
        const state = bought && sold ? 'closed' : (bought ? 'bought' : 'sold');

        const revenue = sold ? round2((r.invoice_amount || 0) + (r.charges_in || 0)) : null;
        const cost = bought || sold
            ? round2((r.bill_amount || 0) + (r.trucking || 0)
                     + (r.charges_out || 0) + (r.commission || 0))
            : null;

        // Only a container with BOTH sides gets a figure. See the header.
        const margin = state === 'closed' && revenue !== null && cost !== null
            ? round2(revenue - cost) : null;
        const marginPct = (margin !== null && revenue) ? round2((margin / revenue) * 100) : null;

        // Bought and sold weights should agree. When they do not it is
        // reported, never corrected: moisture, reweighing at destination and
        // a genuine short-load all look identical from here, and only she
        // knows which it was.
        const weightGap = (r.bought_weight_lb !== null && r.bought_weight_lb !== undefined
            && r.sold_weight_lb !== null && r.sold_weight_lb !== undefined)
            ? Math.round((r.bought_weight_lb - r.sold_weight_lb) * 1000) / 1000 : null;

        out.push({
            ...r,
            bill_amount: r.bill_amount ?? null,
            trucking: r.trucking ?? null,
            invoice_amount: r.invoice_amount ?? null,
            charges_in: r.charges_in ?? null,
            charges_out: r.charges_out ?? null,
            commission: r.commission ?? null,
            state, revenue, cost, margin,
            margin_pct: marginPct,
            weight_gap: weightGap,
            // Per metric ton of what was SOLD, which is the figure a trader
            // compares between deals. Null rather than a division by zero.
            margin_per_mt: (margin !== null && r.sold_weight_lb)
                ? round2(margin / (r.sold_weight_lb / require('./bills').LB_PER_MT)) : null,
        });
    }

    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Bills and sales that carry no container number, and so can never appear
// above. Surfaced so an unjoinable row is something she can go and fix rather
// than a container that quietly has no margin for ever.
function unjoinable() {
    const bills = require('./bills');
    const sales = require('./sales');
    return {
        bills: bills.list().filter((b) => !String(b.container_no || '').trim())
            .map((b) => ({ id: b.id, date: b.date || null, supplier: b.supplier || null })),
        sales: sales.list().filter((s) => !String(s.container_no || '').trim())
            .map((s) => ({ id: s.id, date: s.date || null, customer: s.customer || null })),
    };
}

function filterRows(list, q = {}) {
    const bills = require('./bills');
    const state = String(q.state || '').trim().toLowerCase();
    const customer = String(q.customer || '').trim().toLowerCase();
    const supplier = String(q.supplier || '').trim().toLowerCase();
    const from = String(q.from || '').trim();
    const to = String(q.to || '').trim();
    const fromIso = from ? (bills.sortableDate(from) || from) : '';
    const toIso = to ? (bills.sortableDate(to) || to) : '';

    return (list || []).filter((r) => {
        if (state && r.state !== state) return false;
        if (customer && String(r.customer || '').toLowerCase() !== customer) return false;
        if (supplier && String(r.supplier || '').toLowerCase() !== supplier) return false;
        if (fromIso || toIso) {
            // Dated by the SALE where there is one — that is when the money
            // was made — and by the bill otherwise.
            const d = bills.sortableDate(r.sale_date || r.bill_date) || '';
            if (fromIso && (!d || d < fromIso)) return false;
            if (toIso && (!d || d > toIso)) return false;
        }
        return true;
    });
}

function summary(list) {
    const r = list || [];
    const closed = r.filter((x) => x.state === 'closed');
    const sum = (rows, f) => round2(rows.reduce((s, x) => s + (f(x) || 0), 0)) || 0;
    const revenue = sum(closed, (x) => x.revenue);
    const margin = sum(closed, (x) => x.margin);
    return {
        count: r.length,
        closed: closed.length,
        // Deliberately over CLOSED containers only. Averaging in a container
        // that has been bought and not yet sold would drag the figure toward
        // nothing for a reason that has nothing to do with how the deals went.
        revenue,
        cost: sum(closed, (x) => x.cost),
        margin,
        margin_pct: revenue ? round2((margin / revenue) * 100) : null,
        open_bought: r.filter((x) => x.state === 'bought').length,
        open_sold: r.filter((x) => x.state === 'sold').length,
    };
}

function facets(list) {
    const of = (f) => [...new Set((list || []).map((r) => String(r[f] || '').trim()).filter(Boolean))].sort();
    return { customer: of('customer'), supplier: of('supplier'), state: STATES };
}

module.exports = { rows, filterRows, summary, facets, unjoinable, keyOf, STATES };
