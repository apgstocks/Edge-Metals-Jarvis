// ── helpers/yardProfit.js — what the yard bought, sold, and kept ────────────
//
// Apsara, 2026-09-16, asked which reports she actually opens on the phone and
// picking one that did not exist anywhere: "Profit — bought vs sold".
//
// EDGE YARD ONLY. Edge Metals has its own margin (helpers/margin.js, bills
// against sales) and the two must never be added together — that is the rule
// this whole app is arranged around.
//
// ── THE DANGEROUS VERSION OF THIS REPORT ────────────────────────────────────
// The obvious one is: everything sold this month minus everything bought this
// month. It is easy, it looks like profit, and it is wrong — badly enough to
// make someone stop buying in a good month. Metal bought in September is sold
// in October. A month with a big purchase and a slow sales week shows a loss
// that never happened, and the month after shows a profit that was really
// earned by the first one.
//
// So this reports TWO different things and refuses to blur them:
//
//   MARGIN ON WHAT WAS SOLD — revenue minus the cost of THAT SPECIFIC METAL,
//   from the inbound loads it was drawn from (helpers/outboundLoads.js's
//   linked_inbound_load_ids and per-item draws). This is real profit, and it
//   is the number worth looking at.
//
//   CASH IN AND OUT OVER THE PERIOD — bought, sold, expenses, trucker bills.
//   This is a cash-flow picture, not profit, and is labelled as such.
//
// ── AND IT SAYS HOW MUCH OF THE MARGIN IS ACTUALLY KNOWN ────────────────────
// Cost is only known for sales whose material was linked back to the loads it
// came from. If half the sales are unlinked, the margin covers half the
// business — and a margin quietly computed on half the sales, presented as
// the whole picture, is the most misleading number this app could produce.
//
// coverage tells the truth about that, and the clients are expected to show
// it. A figure whose reliability is invisible gets trusted completely.

const { round2 } = require('./money');

const inRange = (date, from, to) => !!date && (!from || date >= from) && (!to || date <= to);

function yardProfit({ from = null, to = null } = {}) {
    const { loadLoads } = require('./loads');
    const { loadOutboundLoads, getOutboundReport } = require('./outboundLoads');

    const purchases = loadLoads().filter((l) => inRange(l && l.date, from, to));
    const sales = loadOutboundLoads().filter((l) => inRange(l && l.date, from, to));

    // ── THE REAL ONE ─────────────────────────────────────────────────────
    // getOutboundReport already derives cost from the linked inbound loads
    // and returns null rather than a guess when it cannot. Reused rather than
    // recomputed: two pieces of code that both work out margin will disagree
    // eventually, and on money that is not a bug anyone catches quickly.
    const outbound = getOutboundReport(loadOutboundLoads(), { from, to });

    // How much of the revenue has a cost behind it. Without this the margin
    // is a number with no stated scope.
    let linkedRevenue = 0;
    for (const b of (outbound.byBuyer || [])) {
        if (b && b.cost != null) linkedRevenue += (b.amount || 0);
    }
    const revenue = outbound.totalAmount || 0;
    const coverage = revenue > 0 ? Math.round((linkedRevenue / revenue) * 1000) / 10 : null;

    // ── THE CASH PICTURE, LABELLED AS SUCH ───────────────────────────────
    const bought = round2(purchases.reduce((s, l) => s + (l.amount || 0), 0)) || 0;
    const sold = round2(sales.reduce((s, l) => s + (l.amount || 0), 0)) || 0;

    let expenses = 0;
    try {
        const { loadExpenses } = require('./expenses');
        expenses = round2((loadExpenses() || [])
            .filter((e) => inRange(e && e.date, from, to))
            .reduce((s, e) => s + (Number(e.amount) || 0), 0)) || 0;
    } catch (e) {
        // A report that fails entirely because one store is unreadable is
        // worse than one that reports what it can and says which part is
        // missing — see `partial` below.
        //
        // LOGGED, not swallowed. The first version of this file called a
        // function that does not exist (loadBills, where the module exports
        // listBills) and the silent catch turned my typo into a permanent
        // "trucker bills unreadable" that looked like a data problem. A
        // fail-soft branch that hides a coding error is worse than the crash
        // it replaced.
        console.error('[yardProfit] expenses unreadable:', e.message);
        expenses = null;
    }

    let trucking = 0;
    try {
        const { listBills } = require('./truckerBills');
        trucking = round2((listBills() || [])
            .filter((b) => inRange(b && b.date, from, to))
            .reduce((s, b) => s + (Number(b.amount) || 0), 0)) || 0;
    } catch (e) {
        console.error('[yardProfit] trucker bills unreadable:', e.message);
        trucking = null;
    }

    return {
        from, to,
        unit: outbound.unit || 'lb',

        // The number that means profit.
        margin: {
            revenue: round2(revenue),
            cost_of_material_sold: outbound.totalCost,
            margin: outbound.totalMargin,
            // Percent of revenue whose cost is actually known. null when
            // nothing was sold in the range.
            coverage_pct: coverage,
            // Said in words so a client cannot render the figure without the
            // caveat by simply forgetting to.
            caveat: outbound.totalMargin === null
                ? 'No sale in this range is linked to the loads it came from, so there is no cost to measure against.'
                : (coverage !== null && coverage < 99
                    ? `Covers ${coverage}% of sales — the rest are not linked to the loads they came from.`
                    : null),
            byBuyer: (outbound.byBuyer || []).map((b) => ({
                buyer: b.buyer, net: b.net, amount: b.amount, cost: b.cost, margin: b.margin,
            })),
        },

        // NOT profit. Named so it cannot be mistaken for it.
        cash: {
            bought, sold, expenses, trucking,
            net: (expenses === null || trucking === null) ? null
                : round2(sold - bought - expenses - trucking),
            note: 'Money in and out over this period only. NOT profit — metal bought this month is usually sold in another, so a big purchase shows as a loss it never was.',
        },

        counts: { purchases: purchases.length, sales: sales.length },
        // Which parts could not be read, so the screen can say so rather than
        // printing a confident total that quietly excludes something.
        partial: [expenses === null ? 'expenses' : null, trucking === null ? 'trucker bills' : null].filter(Boolean),
    };
}

module.exports = { yardProfit };
