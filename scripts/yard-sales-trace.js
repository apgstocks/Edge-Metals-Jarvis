#!/usr/bin/env node
// ── scripts/yard-sales-trace.js — where did the yard's sales go? ───────────
//
// Apsara, 2026-10-26, on the Books page showing Edge Yard revenue of $50,160
// against $1.25m of purchases: "Yard sales+expenses tab need to be shown here
// na", then "still yard sales is not proper".
//
// She is right, and the right test is hers: BOOKS MUST AGREE WITH THE TAB.
// helpers/metalsReports.js already states that doctrine — read through the
// same helper the screen's own route calls, so what Jarvis says and what the
// screen shows cannot disagree. helpers/booksBuild.js does not follow it for
// this store, and this script measures the gap rather than arguing about it.
//
//   node scripts/yard-sales-trace.js
//   node scripts/yard-sales-trace.js --from 2026-01-01 --to 2026-12-31
//   node scripts/yard-sales-trace.js --show 20     # list the rows that fell out
//
// READ ONLY. Run it where data/ is (the VM).
//
// ── WHAT IT IS LOOKING FOR, AND WHY GUESSING FAILED ──────────────────────
// booksBuild reads every other money store through its helper — `sales` via
// listWithTotals(), `bills` via listWithTotals() — with a comment on the bills
// line spelling out why: "the raw row is not the source of truth for money".
// outbound_loads is the exception; it is read raw:
//
//     amount: num(l.amount)        // outbound_loads — RAW
//     amount: num(s.receivable...) // sales — via listWithTotals()
//
// outboundLoads.sumItems() returns null for `amount` when no item on the row
// carries one, and that null is what gets stored. postings.post() then refuses
// anything under a cent with "has no amount", so the sale leaves the books
// altogether. Separately, entities.place() drops any row it cannot put on a
// company. Both are silent in the total; only this script says which.
const path = require('path');
const ROOT = path.join(__dirname, '..');

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FROM = arg('from');
const TO = arg('to');
const SHOW = Number(arg('show', '0')) || 0;

const money = (v) => (v === null || v === undefined ? '—'
    : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const inRange = (d) => {
    const s = String(d || '');
    if (FROM && s < FROM) return false;
    if (TO && s > TO) return false;
    return true;
};

const OL = require(path.join(ROOT, 'helpers/outboundLoads'));
const E = require(path.join(ROOT, 'helpers/entities'));

const rows = (OL.loadOutboundLoads() || []).filter((l) => l && inRange(l.date));

// Every way a row can fail to become revenue, counted separately. The point
// is that these are DIFFERENT jobs: an unpriced row needs a price, an
// unplaced row needs a company, and they are fixed by different people.
const buckets = {
    counted: [], noAmount: [], unplaced: [], noDate: [],
};
let countedTotal = 0, lostTotal = 0;

for (const l of rows) {
    if (!l.date) { buckets.noDate.push(l); continue; }
    const placed = E.of('outbound_loads', l);
    if (!placed.ledger) { buckets.unplaced.push({ l, why: placed.basis }); continue; }

    const amt = l.amount;
    if (amt === null || amt === undefined || Math.abs(Number(amt) || 0) < 0.005) {
        // What it WOULD have been worth if its items were priced — read off
        // the row's own items, so the figure is hers and not invented.
        const items = Array.isArray(l.items) ? l.items : [];
        const net = items.reduce((s, it) => s + (Number(it && it.net_weight) || 0), 0);
        buckets.noAmount.push({ l, items: items.length, net });
        continue;
    }
    buckets.counted.push(l);
    countedTotal += Number(amt) || 0;
}

console.log('\n── Edge Yard sales: what reaches the books ─────────────────────');
console.log(`   ${FROM || 'the beginning'} to ${TO || 'today'}\n`);
console.log(`   outbound loads in range      ${String(rows.length).padStart(6)}`);
console.log(`   ─ reach the P&L              ${String(buckets.counted.length).padStart(6)}   ${money(countedTotal)}`);
console.log(`   ─ dropped: no amount on them ${String(buckets.noAmount.length).padStart(6)}   <- items carry no price`);
console.log(`   ─ dropped: no company        ${String(buckets.unplaced.length).padStart(6)}   <- entities.js could not place`);
console.log(`   ─ dropped: no date           ${String(buckets.noDate.length).padStart(6)}`);

const lost = buckets.noAmount.length + buckets.unplaced.length + buckets.noDate.length;
if (rows.length) {
    const pct = (100 * lost / rows.length).toFixed(1);
    console.log(`\n   ${lost} of ${rows.length} rows (${pct}%) are not in Yard sales on the Books page.`);
}

if (buckets.noAmount.length) {
    const withWeight = buckets.noAmount.filter((x) => x.net > 0);
    console.log(`\n   OF THE UNPRICED: ${withWeight.length} have a NET WEIGHT but no price.`);
    console.log('   Those are real sales missing only a figure — price them and they');
    console.log('   appear. The rest have neither, and may be drafts.');
}

if (buckets.unplaced.length) {
    const why = new Map();
    for (const u of buckets.unplaced) why.set(u.why, (why.get(u.why) || 0) + 1);
    console.log('\n   WHY ROWS COULD NOT BE PLACED:');
    for (const [w, n] of [...why].sort((a, b) => b[1] - a[1])) {
        console.log(`     ${String(n).padStart(5)}  ${w}`);
    }
}

if (SHOW) {
    const show = (label, list, fmt) => {
        if (!list.length) return;
        console.log(`\n   ${label} (first ${Math.min(SHOW, list.length)}):`);
        for (const x of list.slice(0, SHOW)) console.log('     ' + fmt(x));
    };
    show('UNPRICED', buckets.noAmount,
        (x) => `${x.l.id || '(no id)'}  ${x.l.date}  ${x.l.buyer || '(no buyer)'}  `
            + `${x.items} item(s), net ${x.net || 0}`);
    show('UNPLACED', buckets.unplaced,
        (x) => `${x.l.id || '(no id)'}  ${x.l.date}  ${x.l.buyer || '(no buyer)'}  — ${x.why}`);
    show('NO DATE', buckets.noDate, (l) => `${l.id || '(no id)'}  ${l.buyer || '(no buyer)'}`);
}

console.log('\n   Compare the first figure with the Sales tab for the same period.');
console.log('   If they differ, the difference is in the rows above and nowhere else.\n');

process.exitCode = lost ? 1 : 0;
