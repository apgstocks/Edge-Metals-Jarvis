#!/usr/bin/env node
// ── scripts/books-readiness.js — can a return be filed from this yet? ────
//
//     node scripts/books-readiness.js
//     node scripts/books-readiness.js --from 2026-01-01 --to 2026-12-31
//
// Apsara's goal, 2026-10-06: "it should be in a way that we wont ever need
// quickbook at all", and the year-end pack for her CPA.
//
// Everything else in the books stack answers a narrow question. This one
// answers hers: is the P&L complete enough to file, and if not, what is
// missing and what is it worth?
//
// ── THE THREE WAYS A P&L CAN BE WRONG WHILE LOOKING RIGHT ────────────────
//   1. a row posts nowhere          — the figure is simply absent
//   2. revenue with no cost behind it — profit, and tax, overstated
//   3. cost with no revenue yet       — profit understated, or stock
//                                       sitting that nobody has counted
//
// A trial balance balances in all three cases. That is the whole reason
// this report exists rather than a green tick on the statements screen.
//
// READ-ONLY. It builds the journal, which is derived, and writes nothing.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
};
const FROM = arg('--from');
const TO = arg('--to');

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

(function main() {
    const B = require(path.join(ROOT, 'helpers/booksBuild'));
    const S = require(path.join(ROOT, 'helpers/statements'));
    const E = require(path.join(ROOT, 'helpers/entities'));

    console.log(`\nBOOKS READINESS — ${new Date().toISOString()}`);
    if (FROM || TO) console.log(`period: ${FROM || 'the beginning'} to ${TO || 'today'}`);
    console.log('');

    const built = B.build({ from: FROM, to: TO });

    // ── WHAT POSTED, AND WHAT DID NOT ────────────────────────────────────
    console.log(`TRANSACTIONS READ: ${built.transactions}`);
    console.log(`JOURNAL LINES:     ${built.lines.length}`);
    if (built.notes.length) {
        console.log('\nSTORES NOT READ');
        built.notes.forEach((n) => console.log('  · ' + n));
    }

    if (built.unplaced.length) {
        console.log(`\nROWS BELONGING TO NO COMPANY — ${built.unplaced.length}`);
        console.log('  These are in no statement at all. entities.js could not decide whose');
        console.log('  books they are, and guessing would put money on the wrong return.');
        const byStore = new Map();
        for (const u of built.unplaced) byStore.set(u.store, (byStore.get(u.store) || 0) + 1);
        for (const [store, n] of byStore) console.log(`    ${String(n).padStart(5)}  ${store}`);
    }

    if (built.problems.length) {
        // Grouped: 25 rows saying "needs weights, price" is one problem, not 25.
        console.log(`\nROWS THAT COULD NOT BE POSTED — ${built.problems.length}`);
        const kinds = new Map();
        for (const p of built.problems) {
            const key = /no account for the category/.test(p) ? 'an expense category the chart does not have'
                : /has no amount/.test(p) ? 'no amount — needs weights or a price'
                : /cannot tell which bank/.test(p) ? 'a bank Jarvis does not recognise'
                : /no company against it/.test(p) ? 'no company'
                : /does not balance/.test(p) ? 'a posting rule that does not balance'
                : p.slice(0, 60);
            kinds.set(key, (kinds.get(key) || 0) + 1);
        }
        for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(n).padStart(5)}  ${k}`);
        }
        // The specific ones are worth seeing — a category she can add in a
        // minute is a different job from 25 containers needing weighing.
        const cats = [...new Set(built.problems
            .filter((p) => /no account for the category/.test(p))
            .map((p) => (/"([^"]*)"/.exec(p) || [])[1]))].filter(Boolean);
        if (cats.length) console.log(`           categories to add: ${cats.join(', ')}`);
    }

    // ── REVENUE WITH NO COST, AND COST WITH NO REVENUE ───────────────────
    // Read straight off her own stores rather than off the journal, because
    // a container whose sale posted and whose bill did not would otherwise
    // look complete.
    const bills = require(path.join(ROOT, 'helpers/bills')).listWithTotals();
    const sales = require(path.join(ROOT, 'helpers/sales')).listWithTotals();
    const inRange = (d) => {
        const s = String(d || '');
        if (FROM && s < FROM) return false;
        if (TO && s > TO) return false;
        return true;
    };
    const billContainers = new Set(bills.filter((b) => inRange(b.date)).map((b) => up(b.container_no)).filter(Boolean));
    const saleContainers = new Set(sales.filter((s) => inRange(s.date)).map((s) => up(s.container_no)).filter(Boolean));

    let revenueNoCost = 0; const soldNoBill = new Set();
    for (const s of sales) {
        if (!inRange(s.date)) continue;
        const c = up(s.container_no);
        if (!c || billContainers.has(c)) continue;
        revenueNoCost += Number(s.receivable) || 0;
        soldNoBill.add(c);
    }
    let costNoRevenue = 0; const boughtNotSold = new Set();
    for (const b of bills) {
        if (!inRange(b.date)) continue;
        const c = up(b.container_no);
        if (!c || saleContainers.has(c)) continue;
        costNoRevenue += Number(b.amount) || 0;
        boughtNotSold.add(c);
    }

    console.log('\nHALF-FINISHED CONTAINERS');
    console.log(`  sold with no bill behind them : ${String(soldNoBill.size).padStart(4)} containers, `
        + `${money(revenueNoCost)} of revenue`);
    console.log('      profit — and therefore tax — is OVERSTATED by whatever those cost');
    console.log(`  bought and not yet sold       : ${String(boughtNotSold.size).padStart(4)} containers, `
        + `${money(costNoRevenue)} of cost`);
    console.log('      either stock still on hand, or a sale that was never recorded');

    // ── PER COMPANY ──────────────────────────────────────────────────────
    console.log('\nPER COMPANY');
    for (const ent of E.ENTITIES) {
        const pk = S.pack(built.lines, { entity: ent.id, from: FROM, to: TO });
        const lines = built.lines.filter((l) => l.entity === ent.id).length;
        console.log(`\n  ${ent.uiName}  (${ent.legalName})`);
        if (!lines) { console.log('      nothing posted to this company in the period'); continue; }
        console.log(`      income      ${money(pk.profitAndLoss.incomeTotal).padStart(16)}`);
        console.log(`      cost of sales ${money(pk.profitAndLoss.cogsTotal).padStart(14)}`);
        console.log(`      overheads     ${money(pk.profitAndLoss.expenseTotal).padStart(14)}`);
        console.log(`      NET           ${money(pk.profitAndLoss.netIncome).padStart(14)}`);
        console.log(`      trial balance ${pk.trialBalance.balanced ? 'balances' : 'DOES NOT BALANCE'}`
            + `, balance sheet ${pk.balanceSheet.balances ? 'balances' : 'DOES NOT BALANCE'}`);
        if (!pk.filable) {
            console.log(`      NOT FILABLE — missing ${pk.filingBlockers.join(', ')}`);
        }
        for (const p of pk.problems) console.log(`      ! ${p}`);
    }

    // ── THE VERDICT ──────────────────────────────────────────────────────
    const posted = built.transactions - built.problems.length - built.unplaced.length;
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`${pct(posted, built.transactions)} of rows posted `
        + `(${posted} of ${built.transactions})`);

    const blockers = [];
    if (built.unplaced.length) blockers.push(`${built.unplaced.length} rows belong to no company`);
    if (built.problems.length) blockers.push(`${built.problems.length} rows cannot be posted`);
    if (soldNoBill.size) blockers.push(`${soldNoBill.size} containers sold with no cost behind them`);
    const notFilable = E.ENTITIES.filter((e) => !E.filable(e.id).ok);
    if (notFilable.length) {
        blockers.push(`${notFilable.length} compan${notFilable.length === 1 ? 'y has' : 'ies have'} `
            + 'no tax ID or address on file');
    }

    if (!blockers.length) {
        console.log('\nNothing is missing. A return could be prepared from these books.\n');
        process.exit(0);
    }
    console.log('\nNOT READY TO FILE:');
    blockers.forEach((b) => console.log('  · ' + b));
    console.log('\nThe statements still BALANCE — they balance whether or not rows are missing,');
    console.log('which is exactly why this report exists rather than a tick on the P&L screen.\n');
    process.exit(1);
})();
