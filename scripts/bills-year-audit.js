#!/usr/bin/env node
// ── scripts/bills-year-audit.js ───────────────────────────────────────────
//
// Apsara, 2026-09-25: "remove 2025 rows in bill.only 2026 should be there."
//
// ── WHY THIS REPORTS BEFORE IT REMOVES ────────────────────────────────────
// Her bills live on the VM, not in this checkout, so there was no way to see
// what "the 2025 rows" actually are before writing the code. And a bill is
// not a display row: it is what a container cost and what is still owed for
// it. Deleting one changes
//
//   - what she owes that supplier (balance is summed across bills),
//   - the margin on that container (helpers/margin.js joins bill to sale),
//   - and orphans any PAYMENT recorded against it — the payment stays in
//     helpers/billPayments.js pointing at a bill that no longer exists, so
//     the money has left the account and belongs to nothing.
//
// So this runs in three gears and the first two touch nothing:
//
//   node scripts/bills-year-audit.js
//       Reports. What is there, by year, with the unpaid balance and the
//       payment count for each year. Writes nothing.
//
//   node scripts/bills-year-audit.js --keep 2026
//       Shows exactly which rows would go, listed, with totals. Writes
//       nothing.
//
//   node scripts/bills-year-audit.js --keep 2026 --write
//       Backs the file up first, to bills.json.before-<timestamp>, then
//       removes them. REFUSES if any row being removed has a payment against
//       it, unless --force-with-payments is also given — because that is the
//       one case where deleting loses money rather than clutter.
//
// Undated rows are NEVER removed. A bill with no date is one she has not
// finished, not a 2025 row; it has no year to judge and guessing at one is
// how a bill she is still working on disappears.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = require(path.join(ROOT, 'config'));

const argv = process.argv.slice(2);
const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] || '');
};
const has = (name) => argv.includes(name);

const KEEP = arg('--keep');
const WRITE = has('--write');
const FORCE = has('--force-with-payments');

const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const yearOf = (r) => {
    const d = String((r && r.date) || '').trim();
    const m = d.match(/^(\d{4})/);
    return m ? m[1] : null;          // null = undated, and undated is untouchable
};

const bills = require(path.join(ROOT, 'helpers/bills'));
const rows = bills.listWithTotals();

// Payments per bill, so "deleting this loses money" is a fact and not a fear.
let paidBy = {};
try { paidBy = require(path.join(ROOT, 'helpers/billPayments')).paidByBill() || {}; }
catch (e) { console.warn('[AUDIT] could not read bill payments:', e.message); }

// ── A PAYMENT POINTS AT A BILL THROUGH ITS ALLOCATIONS ────────────────────
// Not through a flat bill_id. The first version of this read `p.bill_id`,
// which exists on nothing in this codebase — helpers/billPayments.js's own
// paidByBill() walks `p.allocations[].bill_id`, because one wire can settle
// several containers at once.
//
// It passed against a hand-made fixture that had the field I imagined. On her
// real data it would have counted ZERO payments everywhere, and the refusal
// below — the one guard standing between "remove the 2025 clutter" and
// "orphan a $4,000 wire" — would never have fired. A safety check that cannot
// trigger is worse than no check, because it is believed.
let payCount = {};
try {
    const bp = require(path.join(ROOT, 'helpers/billPayments'));
    const all = typeof bp.list === 'function' ? bp.list() : [];
    for (const p of (all || [])) {
        for (const a of ((p && p.allocations) || [])) {
            const id = String((a && a.bill_id) || '');
            if (id) payCount[id] = (payCount[id] || 0) + 1;
        }
    }
} catch (e) {
    console.warn('[AUDIT] could not read payment allocations:', e.message);
    console.warn('[AUDIT] REFUSING to treat that as "no payments" — rerun once it reads.');
    process.exit(1);
}

// ── WHAT IS ACTUALLY THERE ────────────────────────────────────────────────
const byYear = new Map();
for (const r of rows) {
    const y = yearOf(r) || '(no date)';
    if (!byYear.has(y)) byYear.set(y, { n: 0, amount: 0, balance: 0, paid: 0, withPayments: 0, suppliers: new Set() });
    const g = byYear.get(y);
    g.n += 1;
    g.amount += Number(r.amount) || 0;
    g.balance += Number(r.balance) || 0;
    g.paid += Number(paidBy[r.id]) || 0;
    if ((Number(paidBy[r.id]) || 0) > 0 || payCount[r.id]) g.withPayments += 1;
    if (r.supplier) g.suppliers.add(String(r.supplier).trim());
}

console.log(`\nBILLS BY YEAR — ${rows.length} rows in ${cfg.BILLS_FILE}\n`);
console.log('  year        rows   invoiced        still owed      paid   rows w/ payments  suppliers');
console.log('  ' + '-'.repeat(92));
for (const y of [...byYear.keys()].sort()) {
    const g = byYear.get(y);
    console.log(`  ${y.padEnd(10)} ${String(g.n).padStart(4)}   ${money(g.amount).padStart(14)}  ${money(g.balance).padStart(14)}  ${money(g.paid).padStart(12)}   ${String(g.withPayments).padStart(6)}            ${g.suppliers.size}`);
}

if (!KEEP) {
    console.log('\nNothing was changed. To see what removing a year would do:');
    console.log('    node scripts/bills-year-audit.js --keep 2026\n');
    process.exit(0);
}

// ── WHAT WOULD GO ─────────────────────────────────────────────────────────
const keepYears = KEEP.split(',').map((s) => s.trim()).filter(Boolean);
const doomed = rows.filter((r) => {
    const y = yearOf(r);
    return y !== null && !keepYears.includes(y);     // undated is never doomed
});
const undated = rows.filter((r) => yearOf(r) === null);

console.log(`\nKEEPING ${keepYears.join(', ')} — ${doomed.length} row(s) would be REMOVED, ${undated.length} undated row(s) left alone.\n`);

if (!doomed.length) {
    console.log('  Nothing matches. No change needed.\n');
    process.exit(0);
}

const owed = doomed.reduce((a, r) => a + (Number(r.balance) || 0), 0);
const paidOnDoomed = doomed.reduce((a, r) => a + (Number(paidBy[r.id]) || 0), 0);
const withPayments = doomed.filter((r) => (Number(paidBy[r.id]) || 0) > 0 || payCount[r.id]);

console.log('  date         supplier                    container        invoiced        balance   payments');
console.log('  ' + '-'.repeat(100));
for (const r of doomed.slice(0, 200)) {
    console.log(`  ${String(r.date || '').padEnd(12)} ${String(r.supplier || '—').slice(0, 26).padEnd(27)} ${String(r.container_no || '—').padEnd(16)} ${money(r.amount).padStart(13)}  ${money(r.balance).padStart(13)}   ${(Number(paidBy[r.id]) || 0) > 0 ? money(paidBy[r.id]) : '—'}`);
}
if (doomed.length > 200) console.log(`  … and ${doomed.length - 200} more`);

console.log('\n  ── WHAT THIS COSTS ────────────────────────────────────────────────');
console.log(`  Rows removed ................ ${doomed.length}`);
console.log(`  Suppliers affected .......... ${new Set(doomed.map((r) => String(r.supplier || '').trim()).filter(Boolean)).size}`);
console.log(`  Balance that disappears ..... ${money(owed)}   <- what she stops owing on paper`);
console.log(`  Payments already made ....... ${money(paidOnDoomed)} across ${withPayments.length} row(s)`);
if (withPayments.length) {
    console.log('\n  !! ' + withPayments.length + ' of these rows HAVE PAYMENTS AGAINST THEM.');
    console.log('     Removing the bill leaves the payment pointing at nothing: the money');
    console.log('     left the account and now belongs to no container. Those payments are');
    console.log('     not deleted by this script and would have to be dealt with separately.');
}

if (!WRITE) {
    console.log('\nNothing was changed. To actually remove them:');
    console.log(`    node scripts/bills-year-audit.js --keep ${KEEP} --write\n`);
    process.exit(0);
}

if (withPayments.length && !FORCE) {
    console.log('\nREFUSED. Rows with payments against them are in this set.');
    console.log('If that is genuinely what you want, add --force-with-payments.\n');
    process.exit(1);
}

// ── BACKUP FIRST, ALWAYS ──────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${cfg.BILLS_FILE}.before-${stamp}`;
fs.copyFileSync(cfg.BILLS_FILE, backup);
console.log(`\nBacked up to ${backup}`);

// Written through the same strict mutateJson the rest of the money stores
// use, so a failed write is loud rather than silently returning the old file.
const { mutateJson } = require(path.join(ROOT, 'helpers/json'));
const doomedIds = new Set(doomed.map((r) => r.id));

(async () => {
    const after = await mutateJson(cfg.BILLS_FILE, [], (listRaw) => {
        const l = Array.isArray(listRaw) ? listRaw : [];
        return l.filter((r) => !doomedIds.has(r && r.id));
    }, { strict: true });

    const left = Array.isArray(after) ? after.length : 0;
    console.log(`Removed ${rows.length - left} row(s). ${left} remain.`);
    if (left !== rows.length - doomed.length) {
        console.log(`!! Expected ${rows.length - doomed.length}. Restore with:  cp "${backup}" "${cfg.BILLS_FILE}"`);
        process.exit(1);
    }
    console.log(`\nIf this was wrong:  cp "${backup}" "${cfg.BILLS_FILE}"  then restart jarvis.\n`);
})().catch((e) => { console.error(e); console.log(`\nRestore with:  cp "${backup}" "${cfg.BILLS_FILE}"\n`); process.exit(1); });
