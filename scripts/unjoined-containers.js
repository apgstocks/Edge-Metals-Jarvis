#!/usr/bin/env node
// ── scripts/unjoined-containers.js — both halves exist, neither meets ────
//
//     node scripts/unjoined-containers.js
//
// From her nightly sweep, 2026-10-06:
//   HMMU7199337 — Gomez to Rad Metal
//       bill DALA19473200, sale DALA44727400
//   CAIU9824029 — Calderon to SOLINE METAL
//       bill DALA33397100, sale DALA37197400
//
// The bill is there. The sale is there. The container number is the same on
// both. And the margin is computed NOWHERE, so those containers contribute
// nothing to profit in either direction — the cost is invisible and so is
// the revenue.
//
// ── WHY THEY DO NOT MEET, AND WHY THAT RULE IS RIGHT ─────────────────────
// margin.js keys on booking + container, and the comment above keyOf
// records why in her own words:
//
//   Apsara, 2026-09-19: "booking never makes it unique. sometimes diff
//   container under same booking. sometimes diff items in same container."
//
// A container number alone is NOT unique over time — MSKU1111111 sails
// again next year with different metal in it. So joining on the container
// alone would eventually marry this year's cost to next year's revenue, and
// that is a worse error than the one being fixed. The key stays.
//
// ── SO THIS DIAGNOSES, IT DOES NOT JOIN ──────────────────────────────────
// It finds every container whose bill and sale sit under DIFFERENT bookings,
// shows both halves, and says how many days apart they are — because that is
// the evidence that tells a mistyped booking from two genuine shipments that
// happen to reuse a container number. Weeks apart is one shipment with one
// booking wrong. A year apart is two shipments, correctly separate.
//
// It prints the margin that WOULD appear if they were one container, so the
// size of what is missing is visible. It changes nothing: correcting a
// booking number is hers, on the Bills or Invoice screen.
//
// helpers/margin.js's own unjoinable() covers a different case — rows with
// NO container number at all. This is the near miss it cannot see.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const money = (n) => (n === null || n === undefined)
    ? '—'
    : '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

function daysBetween(a, b) {
    const x = Date.parse(a), y = Date.parse(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return Math.round(Math.abs(x - y) / 86400000);
}

(function main() {
    const bills = require(path.join(ROOT, 'helpers/bills')).listWithTotals();
    const sales = require(path.join(ROOT, 'helpers/sales')).listWithTotals();

    const group = (rows, amountOf) => {
        const byContainer = new Map();
        for (const r of rows) {
            const c = up(r.container_no);
            if (!c) continue;                       // unjoinable() already covers these
            if (!byContainer.has(c)) byContainer.set(c, []);
            byContainer.get(c).push({ ...r, _amount: amountOf(r) });
        }
        return byContainer;
    };

    // Each store's OWN arithmetic, never the raw row — sales.json holds no
    // amount at all, and reading one printed $0.00 against seven real
    // invoices earlier this week.
    const billsBy = group(bills, (b) => (b.amount == null ? null : Number(b.amount)));
    const salesBy = group(sales, (s) => (s.receivable == null ? null : Number(s.receivable)));

    const found = [];
    for (const [container, bs] of billsBy) {
        const ss = salesBy.get(container);
        if (!ss || !ss.length) continue;            // sold-with-no-bill is a different finding

        const billBookings = new Set(bs.map((b) => up(b.booking_no)).filter(Boolean));
        const saleBookings = new Set(ss.map((s) => up(s.booking_no)).filter(Boolean));
        // Any booking in common means margin.js already joins them.
        const shared = [...billBookings].some((b) => saleBookings.has(b));
        if (shared) continue;
        // A missing booking on either side is a different problem — the row
        // is incomplete rather than mismatched — and the incomplete-rows
        // check already reports it.
        if (!billBookings.size || !saleBookings.size) continue;

        const cost = bs.reduce((t, b) => t + (b._amount || 0), 0);
        const revenue = ss.reduce((t, s) => t + (s._amount || 0), 0);
        const uncosted = bs.some((b) => b._amount === null) || ss.some((s) => s._amount === null);
        found.push({
            container,
            billBookings: [...billBookings], saleBookings: [...saleBookings],
            supplier: [...new Set(bs.map((b) => b.supplier).filter(Boolean))].join(', '),
            customer: [...new Set(ss.map((s) => s.customer).filter(Boolean))].join(', '),
            billDate: bs.map((b) => b.date).filter(Boolean).sort()[0] || null,
            saleDate: ss.map((s) => s.date).filter(Boolean).sort()[0] || null,
            cost, revenue, uncosted,
            bills: bs.length, sales: ss.length,
        });
    }

    console.log(`\nCONTAINERS WHOSE BILL AND SALE NEVER MEET — ${new Date().toISOString()}`);
    console.log('Both halves exist, the container number matches, the BOOKING does not.\n');

    if (!found.length) {
        console.log('None. Every container with both a bill and a sale shares a booking.\n');
        process.exit(0);
    }

    let missingMargin = 0;
    for (const f of found) {
        const gap = daysBetween(f.billDate, f.saleDate);
        console.log(`  ${f.container}  —  ${f.supplier || '(no supplier)'} to ${f.customer || '(no customer)'}`);
        console.log(`      bill  ${String(f.billDate || '(no date)').padEnd(12)} booking ${f.billBookings.join(', ')}`
            + `   ${f.bills} row(s)   cost ${money(f.uncosted ? null : f.cost)}`);
        console.log(`      sale  ${String(f.saleDate || '(no date)').padEnd(12)} booking ${f.saleBookings.join(', ')}`
            + `   ${f.sales} row(s)   revenue ${money(f.uncosted ? null : f.revenue)}`);

        // ── THE EVIDENCE ─────────────────────────────────────────────────
        // Days apart is what separates a mistyped booking from two genuine
        // shipments that reuse a container number.
        if (gap === null) {
            console.log('      dates missing, so whether this is one shipment cannot be told from here');
        } else if (gap <= 120) {
            console.log(`      ${gap} days apart — almost certainly ONE shipment with one booking mistyped`);
        } else {
            console.log(`      ${gap} days apart — likely TWO shipments reusing the container number, `
                + 'and correctly separate');
        }

        if (!f.uncosted) {
            const margin = Math.round((f.revenue - f.cost) * 100) / 100;
            console.log(`      margin currently computed NOWHERE; joined it would be ${money(margin)}`);
            if (gap !== null && gap <= 120) missingMargin += margin;
        } else {
            console.log('      one side has no amount yet, so the margin cannot be stated');
        }
        console.log('');
    }

    console.log(`${found.length} container(s). Margin missing from the likely-one-shipment ones: ${money(missingMargin)}\n`);
    console.log('NOTHING WAS CHANGED, and nothing here joins them automatically. margin.js keys on');
    console.log('booking + container because a container number repeats between years — joining on');
    console.log('the container alone would eventually marry one year\'s cost to another\'s revenue.');
    console.log('Correcting the wrong booking number is yours, on the Bills or Invoice screen.\n');
    process.exit(1);
})();
