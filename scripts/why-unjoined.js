#!/usr/bin/env node
// ── scripts/why-unjoined.js — the two halves that never met ───────────────
//
// Apsara ran the integrity sweep against her live books on 2026-09-26 and it
// reported 23 containers with only one side of the trade. Two of the lines
// were the same container:
//
//   · CAIU9824029 — Calderon:     bought 277 days ago and not sold
//   · CAIU9824029 — SOLINE METAL: sold 277 days ago with no bill behind it
//
// A bill AND a sale, on the same container, on the same day, reported as two
// separate gaps. They are not two gaps. They are one container whose two
// halves failed to JOIN.
//
// ── WHY THEY FAIL TO JOIN ─────────────────────────────────────────────────
// helpers/margin.js:58 keys a row on BOOKING NUMBER AND CONTAINER:
//
//   keyOf(bookingNo, containerNo) => `${bookingNo}|${containerNo}`
//
// so a bill and a sale that agree on the container but disagree on the
// booking — or where one of them has no booking at all — never meet. The
// container then appears twice in the margin report, `bought` on one row and
// `sold` on the other, and its real margin appears on neither: the cost sits
// against one phantom and the revenue against the other.
//
// That is worth more than a tidy-up. Every report built on margin — profit by
// customer, by supplier, the spend report's other half — is missing those
// containers entirely.
//
// ── THIS TELLS YOU WHICH SIDE IS WRONG. IT CHANGES NOTHING ────────────────
// Read only. It prints the bill's booking and the sale's booking side by side
// so you can see which one is the typo, or whether the container was rebooked
// and both are correct in their own way. What to do about it is yours: a
// container rebooked mid-voyage is a real thing, and a script that silently
// "corrected" one of those would be inventing history.
//
//   node scripts/why-unjoined.js
//   node scripts/why-unjoined.js --all      every container, not only the pairs

const path = require('path');
const ROOT = path.join(__dirname, '..');
const ALL = process.argv.includes('--all');

const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));

const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Indexed by CONTAINER ALONE — which is the whole point. margin.js indexes by
// booking+container, and this shows what that costs.
const byContainer = new Map();
const put = (side, row) => {
    const c = norm(row.container_no);
    if (!c) return;
    if (!byContainer.has(c)) byContainer.set(c, { bills: [], sales: [] });
    byContainer.get(c)[side].push(row);
};

for (const b of bills.listWithTotals()) put('bills', b);
for (const s of sales.listWithTotals()) put('sales', s);

const pairs = [];
const onlyBill = [];
const onlySale = [];

for (const [container, sides] of byContainer) {
    if (sides.bills.length && sides.sales.length) {
        // Both halves exist. Do their booking numbers agree?
        const bBk = new Set(sides.bills.map((b) => norm(b.booking_no)));
        const sBk = new Set(sides.sales.map((s) => norm(s.booking_no)));
        const shared = [...bBk].some((x) => sBk.has(x));
        if (!shared) pairs.push({ container, sides, bBk: [...bBk], sBk: [...sBk] });
    } else if (sides.bills.length) onlyBill.push({ container, sides });
    else onlySale.push({ container, sides });
}

console.log(`\n  CONTAINERS WHOSE TWO HALVES DID NOT JOIN`);
console.log(`  ${'─'.repeat(70)}`);
console.log(`\n  margin.js joins on BOOKING + CONTAINER. These ${pairs.length} container${pairs.length === 1 ? ' has' : 's have'} both a bill`);
console.log(`  and a sale, but no booking number in common — so each one is counted`);
console.log(`  twice in the margin report and its real margin is computed nowhere.\n`);

if (!pairs.length) console.log('    (none — every container with both halves shares a booking)');

let lostCost = 0, lostRevenue = 0;
for (const p of pairs) {
    const b = p.sides.bills[0], s = p.sides.sales[0];
    lostCost += Number(b.amount) || 0;
    lostRevenue += Number(s.amount) || 0;
    console.log(`    ${p.container}`);
    console.log(`      bill   ${String(b.date || '—').padEnd(12)} ${String(b.supplier || '—').slice(0, 26).padEnd(27)} booking ${p.bBk.join(',') || '(blank)'}   ${money(b.amount)}`);
    console.log(`      sale   ${String(s.date || '—').padEnd(12)} ${String(s.customer || '—').slice(0, 26).padEnd(27)} booking ${p.sBk.join(',') || '(blank)'}   ${money(s.amount)}`);
    const blank = !p.bBk.filter(Boolean).length || !p.sBk.filter(Boolean).length;
    console.log(`      → ${blank ? 'one side has NO booking number' : 'the two booking numbers differ'}`);
    console.log('');
}

if (pairs.length) {
    console.log(`  ${money(lostCost)} of cost and ${money(lostRevenue)} of revenue are sitting on`);
    console.log(`  containers whose margin is never computed. That is not money missing`);
    console.log(`  from the ledgers — both halves are recorded — it is margin nobody sees.\n`);
}

if (ALL) {
    console.log(`  BOUGHT, GENUINELY NOT SOLD — ${onlyBill.length}`);
    for (const x of onlyBill.slice(0, 40)) {
        const b = x.sides.bills[0];
        console.log(`    ${x.container}  ${String(b.date || '—').padEnd(12)} ${b.supplier || '—'}  ${money(b.amount)}`);
    }
    console.log(`\n  SOLD, GENUINELY NO BILL — ${onlySale.length}`);
    for (const x of onlySale.slice(0, 40)) {
        const s = x.sides.sales[0];
        console.log(`    ${x.container}  ${String(s.date || '—').padEnd(12)} ${s.customer || '—'}  ${money(s.amount)}`);
    }
    console.log('');
} else {
    console.log(`  ${onlyBill.length} bought with no sale anywhere, ${onlySale.length} sold with no bill anywhere.`);
    console.log(`  Those are real gaps rather than join failures — --all lists them.\n`);
}
