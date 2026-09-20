#!/usr/bin/env node
// ── scripts/margin-damage.js — what the container-key bug cost ──────────────
//
// Apsara, 2026-09-19: "booking never makes it unique.sometimes diff container
// under same booking.sometimes diff items in same container."
//
// helpers/margin.js kept ONE row per booking+container and discarded the
// rest, because the comment it was built on said that pair was unique. It is
// not. Her own container 266116225 / TEMU7944250 carries four grades:
//
//     the four lines total   $30,604.60
//     the report showed      $14,649.53
//
// That is fixed. This answers the question the fix does not: HOW MUCH, across
// the whole ledger, and for how long. She has been reading these margins all
// month and deciding on them.
//
//   node scripts/margin-damage.js              # the summary
//   node scripts/margin-damage.js --list       # every affected container
//   node scripts/margin-damage.js --list 40    # the worst 40
//
// ── READ-ONLY. It opens the stores, computes, and prints. It writes nothing,
// sends nothing and changes nothing, so it is safe to run on the live VM
// while she is working.
//
// ── WHY IT RE-IMPLEMENTS THE OLD BEHAVIOUR ──────────────────────────────────
// To say what the report USED to show, something has to reproduce it, and the
// code that did is gone. The old rule was one line — first row seen wins, and
// before today's sort change that was "whichever the sort put first" — so it
// is reproduced here, in eight lines, rather than kept alive in margin.js
// behind a flag nobody would ever set. A flag that must be set to get the
// WRONG answer is a flag that will one day be set by accident.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const wantList = argv.includes('--list');
const listN = (() => {
    const i = argv.indexOf('--list');
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

const bills = require(path.join(ROOT, 'helpers/bills'));
const sales = require(path.join(ROOT, 'helpers/sales'));
const { keyOf } = require(path.join(ROOT, 'helpers/margin'));

const money = (n) => (n === null || n === undefined || !isFinite(n))
    ? '—'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
};
const gradeOf = (r) => String((r && (r.item || r.description)) || '').trim().toUpperCase();

// ── GROUP BOTH LEDGERS BY CONTAINER ─────────────────────────────────────────
const byKey = new Map();
const put = (k, side, row) => {
    if (!byKey.has(k)) byKey.set(k, { key: k, bills: [], sales: [] });
    byKey.get(k)[side].push(row);
};

for (const b of bills.listWithTotals()) {
    const c = String(b.container_no || '').trim();
    if (!c) continue;
    put(keyOf(b.booking_no, c), 'bills', b);
}
for (const s of sales.listWithTotals()) {
    const c = String(s.container_no || '').trim();
    if (!c) continue;
    put(keyOf(s.booking_no, c), 'sales', s);
}

// ── WHAT EACH CONTAINER WAS WORTH, BOTH WAYS ────────────────────────────────
const rows = [];
let totalWas = 0, totalNow = 0, totalCostWas = 0, totalCostNow = 0;
const dupGrades = [];

for (const g of byKey.values()) {
    const [bk, cn] = g.key.split('|');

    // OLD: the first row of each side, everything else dropped.
    const revWas = g.sales.length ? num(g.sales[0].amount) + num(g.sales[0].charges_in_total) : 0;
    const costWas = g.bills.length
        ? num(g.bills[0].amount) + num(g.bills[0].trucking_amount_used !== undefined
            ? g.bills[0].trucking_amount_used : g.bills[0].trucking_amount)
          + (g.sales.length ? num(g.sales[0].charges_out_total) + num(g.sales[0].commission_amount) : 0)
        : 0;

    // NEW: every line of it.
    const revNow = g.sales.reduce((t, s) => t + num(s.amount) + num(s.charges_in_total), 0);
    const costNow = g.bills.reduce((t, b) => t + num(b.amount)
        + num(b.trucking_amount_used !== undefined ? b.trucking_amount_used : b.trucking_amount), 0)
        + g.sales.reduce((t, s) => t + num(s.charges_out_total) + num(s.commission_amount), 0);

    totalWas += revWas; totalNow += revNow;
    totalCostWas += costWas; totalCostNow += costNow;

    // ── A GENUINE DUPLICATE: THE SAME GRADE TWICE ───────────────────────
    // Separated out because it is the opposite problem. Summing lines is
    // right; summing the SAME line twice invents revenue, and now that the
    // lines are summed this is the one worth her attention.
    for (const [side, list] of [['sale', g.sales], ['bill', g.bills]]) {
        const seen = new Map();
        for (const r of list) {
            const key = gradeOf(r);
            if (!seen.has(key)) seen.set(key, []);
            seen.get(key).push(r);
        }
        for (const [grade, hits] of seen) {
            if (hits.length > 1) {
                dupGrades.push({ bk, cn, side, grade: grade || '(no grade named)', n: hits.length,
                                 amount: hits.reduce((t, r) => t + num(r.amount), 0) });
            }
        }
    }

    if (g.sales.length > 1 || g.bills.length > 1) {
        rows.push({
            bk, cn,
            // ── WHEN, added 2026-09-20 ───────────────────────────────────
            // This file's own header says it answers "HOW MUCH, across the
            // whole ledger, and FOR HOW LONG", and until now it answered only
            // the first. The second is the one that decides what she does
            // next: a figure spread evenly over six months is a reporting
            // correction, and the same figure concentrated in the month she
            // has been quoting from is a set of decisions to revisit.
            //
            // The SALE's date, because the missing money is revenue and the
            // month a sale lands in is the month its margin was read in.
            // Earliest line of the container, so a container whose grades
            // were invoiced across a month boundary counts once, in the month
            // it started — not twice, and not in whichever order the store
            // happened to return.
            //
            // THROUGH bills.sortableDate, not a regex of my own. Dates here
            // are stored EXACTLY AS TYPED: a row she entered on the form
            // holds "03/02/2026" and one that came off the sheet import holds
            // "2026-03-02", and her ledger is a mix of both. My first version
            // matched only the ISO shape, which would have filed every
            // hand-entered container under "no date" and reported the whole
            // loss as undatable. sortableDate is what the rest of this app
            // already uses to understand a date, and it returns null rather
            // than guessing at one it cannot read.
            month: (() => {
                const dates = g.sales.map((s) => bills.sortableDate(s && s.date))
                    .filter(Boolean).sort();
                return dates.length ? dates[0].slice(0, 7) : null;
            })(),
            // Marked so the list cannot be read as "revenue recovered" on a
            // container whose extra line is a double-count rather than a
            // second grade. Without this the two look identical, and the one
            // that needs deleting reads like the best news on the page.
            suspect: dupGrades.some((d) => d.bk === bk && d.cn === cn),
            saleLines: g.sales.length, billLines: g.bills.length,
            customer: (g.sales[0] || {}).customer || null,
            supplier: (g.bills[0] || {}).supplier || null,
            revWas, revNow, missed: revNow - revWas,
            marginWas: revWas - costWas, marginNow: revNow - costNow,
        });
    }
}

rows.sort((a, b) => b.missed - a.missed);

// ── THE ANSWER ──────────────────────────────────────────────────────────────
const containers = byKey.size;
const affected = rows.length;
const missedTotal = totalNow - totalWas;
const marginWas = totalWas - totalCostWas;
const marginNow = totalNow - totalCostNow;

console.log('');
console.log('  WHAT THE CONTAINER-KEY BUG WAS HIDING');
console.log('  ' + '─'.repeat(58));
console.log(`  containers in the ledger        ${containers}`);
console.log(`  carrying more than one line     ${affected}`
          + (containers ? `  (${Math.round((affected / containers) * 100)}%)` : ''));
console.log('');
console.log(`  revenue the report showed       ${money(totalWas)}`);
console.log(`  revenue it should have shown    ${money(totalNow)}`);
console.log(`  MISSING                         ${money(missedTotal)}`);
console.log('');
console.log(`  margin the report showed        ${money(marginWas)}`);
console.log(`  margin it should have shown     ${money(marginNow)}`);
console.log(`  understated by                  ${money(marginNow - marginWas)}`);

if (!affected) {
    console.log('');
    console.log('  Nothing to report — every container carries exactly one line.');
}

// ── AND FOR HOW LONG ────────────────────────────────────────────────────────
// Printed always, not behind --list: "which months did I read a wrong number
// in" is the question that decides whether anything needs revisiting, and
// putting it behind a flag means it is the part she does not see.
if (affected) {
    const byMonth = new Map();
    for (const r of rows) {
        const k = r.month || '(no date on the sale)';
        const m = byMonth.get(k) || { missed: 0, containers: 0 };
        m.missed += r.missed; m.containers += 1;
        byMonth.set(k, m);
    }
    const months = [...byMonth.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    console.log('');
    console.log('  AND WHICH MONTHS YOU READ IT IN');
    console.log('  ' + '─'.repeat(58));
    // Scaled against the WORST month, not against the total — a bar scaled to
    // the total is a row of stubs when one month dominates, which is exactly
    // when the shape matters most.
    const worst = months.reduce((t, [, m]) => Math.max(t, m.missed), 0);
    for (const [k, m] of months) {
        const bar = worst > 0 ? '█'.repeat(Math.max(1, Math.round((m.missed / worst) * 24))) : '';
        console.log(`  ${String(k).padEnd(22)}${money(m.missed).padStart(14)}   ${bar}`);
        console.log(`  ${''.padEnd(22)}${String(m.containers).padStart(3)} container(s)`);
    }
}

// ── AND THE OTHER KIND OF PROBLEM ───────────────────────────────────────────
if (dupGrades.length) {
    console.log('');
    console.log('  SAME GRADE CLAIMED TWICE — these are NOT multi-grade containers,');
    console.log('  and now that lines are summed each one ADDS money that was never');
    console.log('  invoiced. Worth looking at before trusting the figures above.');
    console.log('  ' + '─'.repeat(58));
    for (const d of dupGrades.slice(0, 30)) {
        console.log(`  ${d.bk} / ${d.cn}  ${d.side}  ${d.n}x "${d.grade}"  ${money(d.amount)}`);
    }
    if (dupGrades.length > 30) console.log(`  … and ${dupGrades.length - 30} more`);
} else if (affected) {
    console.log('');
    console.log('  No grade is claimed twice anywhere, so every multi-line container');
    console.log('  above is a real grade split and the summed figures are sound.');
}

if (wantList && affected) {
    console.log('');
    console.log('  WORST FIRST');
    console.log('  ' + '─'.repeat(58));
    for (const r of rows.slice(0, listN)) {
        console.log(`  ${r.bk} / ${r.cn}${r.suspect ? '   ⚠ has a repeated grade — check before trusting this line' : ''}`);
        console.log(`      ${r.saleLines} sale line(s), ${r.billLines} bill line(s)`
                  + `${r.customer ? '  · ' + r.customer : ''}`);
        console.log(`      showed ${money(r.revWas)}  ->  ${money(r.revNow)}`
                  + `   missing ${money(r.missed)}`);
    }
    if (rows.length > listN) console.log(`  … and ${rows.length - listN} more`);
}

console.log('');
console.log('  Read-only — nothing was changed. The fix is already in');
console.log('  helpers/margin.js; this only says what it was worth.');
console.log('');
