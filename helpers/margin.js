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

// ── THE PAIR THAT IDENTIFIES A PHYSICAL CONTAINER ───────────────────────
// A container number alone is not unique over time — MSKU1111111 sails again
// next year with different metal in it — so the booking has to be part of the
// key, exactly as it is on both of the tables being joined.
//
// WHAT THIS COMMENT USED TO SAY, AND WHY IT IS CORRECTED
// It said "the booking is what makes it one", i.e. that booking+container was
// UNIQUE. Apsara, 2026-09-19: "booking never makes it unique.sometimes diff
// container under same booking.sometimes diff items in same container."
//
// She is right and the old wording was load-bearing: several files were built
// on the belief that one key means one row, and this one silently dropped
// $15,955 of revenue from a single container because of it. booking+container
// identifies a CONTAINER. It does not identify a ROW — a container carries as
// many rows as it carries grades.
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

    // ── SEVERAL LINES ON ONE CONTAINER ARE ONE CONTAINER'S MONEY ─────────
    //
    // Apsara, 2026-09-19, correcting the comment this file was built on:
    //
    //     "booking never makes it unique.sometimes diff container under same
    //      booking.sometimes diff items in same container."
    //
    // She is right, and it was costing her real money in this report. Every
    // row here used to be ASSIGNED, so a container carrying four grades kept
    // the first line and threw the other three away. Her own figures, booking
    // 266116225 / TEMU7944250:
    //
    //     the four invoice lines total   $30,604.60
    //     this report showed revenue of  $14,649.53
    //     money missing                  $15,955.07
    //
    // So the lines are SUMMED. It was never a decision to drop them; it was a
    // consequence of a sentence about uniqueness that was not true.
    //
    // ── BOTH SIDES, OR THE NUMBER GETS WORSE RATHER THAN BETTER ──────────
    // She answered about the SALES side, which is what she was looking at.
    // Summing only that side would divide a container's whole revenue by one
    // line of its cost — a margin that reads far better than the deal, which
    // is the direction nobody questions and this file already warns about.
    // There is no version of "fix half of it" that is safer than fixing both,
    // so both are summed and this paragraph is here to say that the purchase
    // half was my call and not hers.
    //
    // ── WHAT A DUPLICATE MEANS NOW ───────────────────────────────────────
    // It used to mean "more than one row on this container", which on her
    // data is most containers and therefore meant nothing. A real duplicate
    // is the SAME GRADE claimed twice — that is the one that double-counts.
    // See sales.duplicates()/bills.duplicates(), where the same change is
    // made, so the ledger screen and this report agree about what is wrong.
    // ── WHAT COUNTS AS THE SAME LINE TWICE ───────────────────────────────
    // The grade, normalised. Two rows on one container naming different
    // grades are that container's two grades; two rows naming the SAME grade
    // are a double-count, and now that the lines are summed a double-count
    // adds real money to the report rather than merely confusing it.
    //
    // A blank grade counts as a grade: two rows on one container with nothing
    // named is the classic duplicated row, and it is the shape her earliest
    // duplicate test uses.
    const gradeOf = (r) => String(r.item || r.description || '').trim().toUpperCase();
    const noteGrade = (row, side, r) => {
        const seen = row[side] || (row[side] = new Map());
        const g = gradeOf(r);
        if (!seen.has(g)) { seen.set(g, [r.id]); return; }
        seen.get(g).push(r.id);
    };
    const repeatedIds = (seen) => {
        const out2 = [];
        for (const ids of (seen || new Map()).values()) if (ids.length > 1) out2.push(...ids);
        return out2;
    };

    const addNum = (a, b2) => (a === null || a === undefined)
        ? (b2 === null || b2 === undefined ? null : b2)
        : round2(a + (num(b2) || 0));
    // Newest of two dates, by the same normaliser the ledgers sort on, so a
    // container's date does not depend on which row was read first.
    const laterDate = (a, b2) => {
        const sd = require('./bills').sortableDate;
        const [x, y] = [sd(a), sd(b2)];
        if (!x) return b2 || a || null;
        if (!y) return a;
        return x >= y ? a : b2;
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
        noteGrade(row, '_billGrades', b);
        if (row.bill_id) {
            // Every line's id is kept — the caller lists them, and a real
            // duplicate has to be findable from here.
            row.bill_ids = (row.bill_ids || [row.bill_id]).concat(b.id);
            row.bill_amount = addNum(row.bill_amount, b.amount);
            row.trucking = addNum(row.trucking, b.trucking_amount_used !== undefined
                ? b.trucking_amount_used : b.trucking_amount);
            row.bought_weight_lb = addNum(row.bought_weight_lb, b.net_lb);
            row.bill_date = laterDate(row.bill_date, b.date);
            // Two different suppliers on one container is not a multi-grade
            // line, it is a mistake. Named rather than silently merged.
            if (b.supplier && row.supplier && b.supplier !== row.supplier) {
                row.supplier_conflict = [...new Set([...(row.supplier_conflict || [row.supplier]), b.supplier])];
            }
            continue;
        }
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
        // The sell side of the same change. Four grades invoiced off one
        // container are four lines of ONE container's revenue, not four
        // candidates for the honour of being its revenue.
        //
        // Worth recording what was nearly done instead: reordering the sales
        // table newest-first earlier today would have changed WHICH single
        // line this report kept, silently, for every multi-grade container.
        // That would have been a second wrong answer sitting on top of the
        // first, and harder to see because the number would have moved.
        noteGrade(row, '_saleGrades', s);
        if (row.sale_id) {
            row.sale_ids = (row.sale_ids || [row.sale_id]).concat(s.id);
            row.invoice_amount = addNum(row.invoice_amount, s.amount);
            row.charges_in = round2((row.charges_in || 0) + (num(s.charges_in_total) || 0));
            row.charges_out = round2((row.charges_out || 0) + (num(s.charges_out_total) || 0));
            row.commission = round2((row.commission || 0) + (num(s.commission_amount) || 0));
            row.sold_weight_lb = addNum(row.sold_weight_lb, s.weight_lb);
            row.received = round2((row.received || 0) + (num(s.received) || 0));
            row.receivable = addNum(row.receivable, s.receivable);
            row.sale_date = laterDate(row.sale_date, s.date);
            // Same reasoning as the supplier above: one container invoiced to
            // two different customers is a mistake, not a grade split.
            if (s.customer && row.customer && s.customer !== row.customer) {
                row.customer_conflict = [...new Set([...(row.customer_conflict || [row.customer]), s.customer])];
            }
            continue;
        }
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

        const { _billGrades, _saleGrades, ...rest } = r;
        out.push({
            ...rest,
            bill_amount: r.bill_amount ?? null,
            trucking: r.trucking ?? null,
            invoice_amount: r.invoice_amount ?? null,
            charges_in: r.charges_in ?? null,
            charges_out: r.charges_out ?? null,
            commission: r.commission ?? null,
            state, revenue, cost, margin,
            // ── NON-EMPTY MEANS THE SAME GRADE TWICE ─────────────────
            // It used to mean "more than one row on this container", which
            // on her data is most containers — so the warning fired
            // everywhere and therefore nowhere. Apsara, 2026-09-19:
            // "sometimes diff items in same container".
            //
            // Now that the lines are SUMMED, a repeated grade is not merely
            // confusing: it adds money that was never invoiced. That is the
            // one worth a flag.
            duplicate_bill_ids: repeatedIds(_billGrades),
            duplicate_sale_ids: repeatedIds(_saleGrades),
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
        // Surfaced beside the money, because a duplicate makes the margin
        // beside it wrong and there is no way to tell by looking at it.
        conflicted: r.filter((x) => (x.duplicate_bill_ids || []).length
                                 || (x.duplicate_sale_ids || []).length).length,
    };
}

function facets(list) {
    const of = (f) => [...new Set((list || []).map((r) => String(r[f] || '').trim()).filter(Boolean))].sort();
    return { customer: of('customer'), supplier: of('supplier'), state: STATES };
}

module.exports = { rows, filterRows, summary, facets, unjoinable, keyOf, STATES };
