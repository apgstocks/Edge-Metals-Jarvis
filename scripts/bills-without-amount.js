#!/usr/bin/env node
// ── scripts/bills-without-amount.js ──────────────────────────────────────
// Apsara, 2026-10-08, from the books portal on her live VM:
//
//   "80 entries could not be posted. Every figure below is a floor, not a
//    total" — all of them `"metals-purchase" has no amount`.
//
// That is 80 supplier bills whose amount computes to nothing, and the
// consequence is not cosmetic: helpers/postings.js refuses to post an entry
// with no amount, so each one is on NO statement. Her cost of sales, her
// gross profit and what she owes each supplier are all understated by
// whatever those bills are worth — and a smaller profit looks exactly like
// a correct one.
//
//   node scripts/bills-without-amount.js
//   node scripts/bills-without-amount.js --rows      list every bill
//   node scripts/bills-without-amount.js --supplier Hugo
//
// READS ONLY. No writes, no network. Safe on the live VM.
//
// ── WHY A SCRIPT AND NOT A GUESS ─────────────────────────────────────────
// There are at least five different reasons a bill can come out with no
// amount, and they need different fixes — one is a typo, one is a missing
// weighbridge ticket, one is an import that never carried a price. Telling
// her "80 bills are broken" without saying WHICH KIND is handing her 80
// rows to open one at a time. This counts them by cause.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const ROWS = process.argv.includes('--rows');
const SUP = (() => { const i = process.argv.indexOf('--supplier'); return i > -1 ? process.argv[i + 1] : null; })();

const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const bills = require(path.join(ROOT, 'helpers/bills')).listWithTotals();

// The same test postings.js applies. CENT, not zero: an amount of 0.004
// is refused there too, so it must be counted here.
const CENT = 0.005;
const noAmount = bills.filter((b) => Math.abs(num(b.amount) || 0) < CENT)
    .filter((b) => !SUP || String(b.supplier || '').toLowerCase().includes(SUP.toLowerCase()));

console.log(`\n  ${bills.length} bills in total, ${noAmount.length} with no amount`
    + `${SUP ? ` (filtered to supplier ~"${SUP}")` : ''}\n`);
if (!noAmount.length) { console.log('  Nothing to report.\n'); process.exit(0); }

// ── WHY, BILL BY BILL ────────────────────────────────────────────────────
// helpers/bills.js computes amount one of two ways: the sum of the item
// lines when every line has one, else net weight x supplier_price. So the
// cause is whichever input is missing, and the ORDER below matters — a bill
// with neither a price nor a weight is reported once, under the first
// reason that applies, or the counts would exceed the bills.
function reasonFor(b) {
    const items = Array.isArray(b.items) ? b.items : [];
    const price = num(b.supplier_price);
    // net_lb, NOT net_weight. My first version read b.net_weight, which
    // listWithTotals does not produce — so every bill came back as "no net
    // weight" whatever was wrong with it, and the whole point of this
    // script is to tell the causes apart.
    const net = num(b.net_lb);
    const missingTares = Array.isArray(b.missing_tares) ? b.missing_tares : [];

    if (items.length && items.some((i) => num(i.amount) === null)) {
        const n = items.filter((i) => num(i.amount) === null).length;
        return { key: 'item-line-with-no-amount',
            what: `${n} of ${items.length} item line(s) have no amount, so the container has no total`,
            fix: 'open the bill and give every grade a price, or remove the blank lines' };
    }
    if (price === null && !items.length) {
        return { key: 'no-supplier-price',
            what: 'no supplier price and no item lines — nothing to multiply',
            fix: 'enter the supplier price, or the agreed invoice amount' };
    }
    // ── THE ONE THAT SURPRISED ME ────────────────────────────────────────
    // A bill can carry a gross, a tare AND a price and still produce no
    // amount, because a net is only computed once ALL FOUR tare components
    // are present — truck, container, chassis, boxes. listWithTotals says
    // which are missing in `missing_tares`, and that is almost certainly
    // what most of her 80 are: imported rows that never carried the
    // breakdown, so there is no net, so there is no amount.
    //
    // Reported before the generic "no net weight" because it is the same
    // symptom with a completely different fix: she is not missing a
    // weighbridge ticket, she is missing four numbers off one.
    if (missingTares.length && (net === null || Math.abs(net) < CENT)) {
        return { key: 'missing-tare-components',
            what: `no net because ${missingTares.length} tare component(s) are missing `
                + `(${missingTares.join(', ')})`,
            fix: 'fill the missing tare components on the bill — the net, and so the '
               + 'amount, is only computed once all four are there' };
    }
    if (net === null || Math.abs(net) < CENT) {
        return { key: 'no-net-weight',
            what: 'a price but no net weight — the weighbridge figures are missing',
            fix: 'enter gross and tare, or the weighbridge ticket' };
    }
    if (price !== null && Math.abs(price) < CENT) {
        return { key: 'price-is-zero',
            what: 'the supplier price is zero',
            fix: 'a genuine zero is rare — check it is not a typo or a free load' };
    }
    return { key: 'other',
        what: 'price and weight are both present but the amount still computes to nothing',
        fix: 'this one needs opening — the arithmetic in bills.js did not produce a figure' };
}

const by = new Map();
for (const b of noAmount) {
    const r = reasonFor(b);
    const cur = by.get(r.key) || { ...r, bills: [] };
    cur.bills.push(b);
    by.set(r.key, cur);
}

console.log('── WHY, BY CAUSE ─────────────────────────────────────────────────\n');
for (const g of [...by.values()].sort((a, b2) => b2.bills.length - a.bills.length)) {
    console.log(`  ${String(g.bills.length).padStart(4)}  ${g.what}`);
    console.log(`        → ${g.fix}\n`);
}

// ── AND WHETHER THEY ARE REAL ────────────────────────────────────────────
// A bill with no amount AND no supplier AND no container is probably a
// blank row somebody started and left. One with a supplier and a container
// is a real purchase that is missing from her books, and those are the ones
// that cost her money. Separating them is the difference between "80
// problems" and "nine problems and 71 empties".
const real = noAmount.filter((b) => String(b.supplier || '').trim()
    && (String(b.container_no || '').trim() || String(b.invoice_no || '').trim()));
const blank = noAmount.filter((b) => !String(b.supplier || '').trim()
    && !String(b.container_no || '').trim() && !String(b.invoice_no || '').trim());

console.log('── HOW MANY ACTUALLY MATTER ──────────────────────────────────────\n');
console.log(`  ${real.length} have a supplier AND a container or invoice number`);
console.log('        a real purchase that is on no statement — these are the ones that cost money\n');
console.log(`  ${blank.length} have no supplier and no container or invoice number`);
console.log('        almost certainly blank rows; worth deleting so they stop being counted\n');
console.log(`  ${noAmount.length - real.length - blank.length} are somewhere in between\n`);

// ── WHEN DID THEY ARRIVE ─────────────────────────────────────────────────
// Clustered in one month says an import went wrong. Spread evenly says the
// form lets a bill be saved without an amount, which is a different fix.
const byMonth = new Map();
for (const b of noAmount) {
    const m = String(b.date || '').slice(0, 7) || '(no date)';
    byMonth.set(m, (byMonth.get(m) || 0) + 1);
}
console.log('── WHEN THEY ARRIVED ─────────────────────────────────────────────\n');
for (const [m, n] of [...byMonth.entries()].sort()) {
    console.log(`  ${m.padEnd(10)} ${String(n).padStart(4)}  ${'#'.repeat(Math.min(n, 50))}`);
}
console.log('\n  Clustered in one month means an import went wrong and the fix is there.');
console.log('  Spread evenly means the form accepts a bill with no amount, which is a');
console.log('  different fix and a more important one.\n');

const bySupplier = new Map();
for (const b of real) {
    const s = String(b.supplier || '').trim() || '(none)';
    bySupplier.set(s, (bySupplier.get(s) || 0) + 1);
}
if (bySupplier.size) {
    console.log('── WHOSE BILLS, AMONG THE REAL ONES ──────────────────────────────\n');
    for (const [s, n] of [...bySupplier.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 15)) {
        console.log(`  ${String(n).padStart(4)}  ${s}`);
    }
    console.log();
}

if (ROWS) {
    console.log('── EVERY ONE ─────────────────────────────────────────────────────\n');
    for (const b of noAmount) {
        const r = reasonFor(b);
        console.log(`  ${String(b.id).padEnd(22)} ${String(b.date || '').slice(0, 10).padEnd(12)}`
            + `${String(b.supplier || '(no supplier)').padEnd(24)}`
            + `${String(b.container_no || b.invoice_no || '').padEnd(16)} ${r.key}`);
    }
    console.log();
}

// ── WHAT IT IS COSTING, WHERE THAT CAN BE SAID AT ALL ────────────────────
// Deliberately NOT a total of the missing amounts — there are none, that is
// the whole problem, and inventing one from a price she has not given would
// be the $0.00-on-seven-invoices mistake again. What CAN be counted is how
// much weight is sitting in bills that have no money against them.
const lbs = noAmount.reduce((t, b) => t + (num(b.net_lb) || 0), 0);
console.log('── WHAT CANNOT BE SAID, AND WHY ──────────────────────────────────\n');
console.log('  There is no "total missing" figure here on purpose: these bills have no');
console.log('  amount, so any total would be one this script invented.');
if (lbs > 0) {
    console.log(`\n  What IS countable: ${lbs.toLocaleString('en-US')} lb of material sits in these`);
    console.log('  bills with no money against it. At a rough 0.30/lb that is of the order of');
    console.log(`  ${money(lbs * 0.3)} missing from cost of sales — an ORDER OF MAGNITUDE, not a figure,`);
    console.log('  and not to be used for anything but deciding whether this is urgent.\n');
} else {
    console.log('\n  These bills carry no net weight either, so there is nothing to size it by.\n');
}
