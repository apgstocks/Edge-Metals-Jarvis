#!/usr/bin/env node
// ── scripts/margin-unjoined-audit.js ──────────────────────────────────────
// Task #141: "containers whose bill and sale never joined — margin computed
// nowhere."
//
// ── WHY IT HAPPENS ────────────────────────────────────────────────────────
// helpers/margin.js joins the two ledgers on
//
//     keyOf(booking_no, container_no)  ->  "BOOKING|CONTAINER"
//
// so a container whose BILL and SALE disagree about the booking — or where
// one side has it blank, or the box was re-booked after purchase — splits
// into a 'bought' row and a 'sold' row. Both are correct on their own. The
// margin between them is never computed, and nothing says so.
//
// Apsara, 2026-09-19, quoted in margin.js itself:
//
//     "booking never makes it unique. sometimes diff container under same
//      booking"
//
// She said the booking is not the identity. It is still half the key.
//
// ── THIS MEASURES. IT CHANGES NOTHING ─────────────────────────────────────
// Read-only, by construction: it loads the two ledgers and counts. There is
// no write path in this file.
//
// Deliberately an audit rather than a fix, because changing that key touches
// helpers/saleInvoice.js and helpers/saleInvoiceFlow.js, which both import
// keyOf — and the right move is to know the size of the problem before
// anyone edits a key that three files agree on. If the answer is "two
// containers from 2025", that is a data correction. If it is "sixty
// containers and most of this year's margin", that is a different decision.
//
// Run ON THE VM, where the real ledgers are:
//   node scripts/margin-unjoined-audit.js
//   node scripts/margin-unjoined-audit.js --csv > unjoined.csv

const path = require('path');
const ROOT = path.join(__dirname, '..');
const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));
const margin = require(path.join(ROOT, 'helpers/margin'));

const CSV = process.argv.includes('--csv');
const money = (n) => (n === null || n === undefined) ? '—'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

// What margin.js already decided, so this audit and the screen can never
// disagree about which containers are closed.
const rows = margin.rows();
const bought = rows.filter((r) => r.state === 'bought');
const sold = rows.filter((r) => r.state === 'sold');

// ── THE CONTAINER IS THE IDENTITY ─────────────────────────────────────────
// Re-join the two open sides on the container ALONE. Anything that pairs up
// here is a container that has both a cost and a revenue in the system and is
// nevertheless reported as half-finished.
const soldByContainer = new Map();
for (const s of sold) {
    const c = up(s.container_no);
    if (!c) continue;
    (soldByContainer.get(c) || soldByContainer.set(c, []).get(c)).push(s);
}

const pairs = [];
for (const b of bought) {
    const c = up(b.container_no);
    if (!c) continue;
    for (const s of (soldByContainer.get(c) || [])) {
        pairs.push({
            container: c,
            billBooking: up(b.booking_no) || '(blank)',
            saleBooking: up(s.booking_no) || '(blank)',
            supplier: b.supplier || null,
            customer: s.customer || null,
            cost: b.cost,
            revenue: s.revenue,
            // ── A ZERO IS NOT A PRICE ────────────────────────────────
            // A sale with no amount entered yet comes through as 0, not
            // null, and "margin -$30,000" on an unpriced container is a
            // number that would start a phone call about a loss that has not
            // happened. Treated as unpriced, and said so.
            margin: (b.cost && s.revenue) ? Math.round((s.revenue - b.cost) * 100) / 100 : null,
            unpriced: !b.cost ? 'no cost on the bill yet'
                : !s.revenue ? 'no amount on the sale yet' : null,
        });
    }
}

if (CSV) {
    console.log('container,bill_booking,sale_booking,supplier,customer,cost,revenue,margin');
    for (const p of pairs) {
        console.log([p.container, p.billBooking, p.saleBooking,
            `"${String(p.supplier || '').replace(/"/g, '""')}"`,
            `"${String(p.customer || '').replace(/"/g, '""')}"`,
            p.cost ?? '', p.revenue ?? '', p.margin ?? ''].join(','));
    }
    return;
}

const closed = rows.filter((r) => r.state === 'closed');
console.log(`\nMARGIN JOIN AUDIT — ${rows.length} container rows\n`);
console.log(`  closed (margin computed)   ${String(closed.length).padStart(4)}`);
console.log(`  bought, no sale            ${String(bought.length).padStart(4)}`);
console.log(`  sold, no bill              ${String(sold.length).padStart(4)}`);

if (!pairs.length) {
    console.log('\n  No container appears on BOTH open sides.');
    console.log('  So the open rows are genuinely half-finished — a bill waiting for its');
    console.log('  sale, or a sale whose bill has not been entered. The booking in the');
    console.log('  join key is not costing anything today.\n');
} else {
    const withMargin = pairs.filter((p) => p.margin !== null);
    const total = withMargin.reduce((s, p) => s + p.margin, 0);
    console.log(`\n── ${pairs.length} CONTAINER(S) HAVE BOTH A COST AND A REVENUE, AND NO MARGIN ──\n`);
    console.log('   Each of these is bought AND sold. They did not join because the two');
    console.log('   sides disagree about the booking, which is half the join key.\n');
    for (const p of pairs.sort((a, b) => (b.margin || 0) - (a.margin || 0))) {
        console.log(`   ${p.container}`);
        console.log(`     bill booking ${p.billBooking}   sale booking ${p.saleBooking}`);
        console.log(`     ${String(p.supplier || '?').padEnd(24)} -> ${p.customer || '?'}`);
        console.log(`     cost ${money(p.cost)}   revenue ${money(p.revenue)}   margin `
            + (p.unpriced ? `— (${p.unpriced})` : money(p.margin)));
        console.log('');
    }
    console.log(`   ${withMargin.length} of them can be priced: ${money(total)} of margin is`);
    console.log('   computed nowhere today.');
    if (withMargin.length < pairs.length) {
        console.log(`   The other ${pairs.length - withMargin.length} are missing a cost or a price, so`);
        console.log('   they would still not produce a figure even once joined.');
    }
}

// ── AND THE ONES THAT CAN NEVER JOIN ──────────────────────────────────────
const u = margin.unjoinable();
if (u.bills.length || u.sales.length) {
    console.log(`\n── NO CONTAINER NUMBER AT ALL (${u.bills.length + u.sales.length}) ─────────────────────`);
    console.log('   These cannot be joined by anything. A different problem: the row needs');
    console.log('   a container number typed on it.\n');
    for (const b of u.bills.slice(0, 10)) console.log(`   bill  ${b.date || '—'}  ${b.supplier || '—'}`);
    for (const s of u.sales.slice(0, 10)) console.log(`   sale  ${s.date || '—'}  ${s.customer || '—'}`);
    if (u.bills.length + u.sales.length > 20) console.log(`   …and ${u.bills.length + u.sales.length - 20} more`);
}

console.log('\n   Read-only. Nothing was changed.\n');
