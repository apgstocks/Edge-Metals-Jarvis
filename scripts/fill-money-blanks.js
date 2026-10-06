#!/usr/bin/env node
// ── scripts/fill-money-blanks.js — the cost her books do not have ────────
//
//     node scripts/fill-money-blanks.js            # show, write nothing
//     node scripts/fill-money-blanks.js --apply    # write them
//
// Apsara, 2026-10-06, from her nightly sweep: nine containers whose
// supplier_price and supplier_invoice_amount are BLANK in Jarvis while her
// Google Sheet holds a real figure. About $367,000 of supplier cost.
//
// Cost missing means profit OVERSTATED by the same amount, which on a
// return means tax overstated. It is the largest single thing wrong with
// her books and the cheapest to fix, because the numbers already exist.
//
// ── WHY THIS HAS NEVER HAPPENED BY ITSELF ────────────────────────────────
// helpers/metalsSheetSync.js already finds them — `fillableBills`. The
// 07:30 ledger agent already knows how to write a fill. But
// ledgerAgent.classify() refuses anything that touches money, by design:
// a sheet must not silently rewrite her cost figures. So these have sat in
// the proposed pile every night, correctly, with no way to say yes in bulk.
//
// This is that yes. It is a separate, deliberate, typed command rather than
// a relaxation of the nightly rule — the 07:30 agent still cannot write a
// money field and that has not changed.
//
// ── AUDIT FIRST, ALWAYS ──────────────────────────────────────────────────
// Writes NOTHING without --apply. The default run prints every container,
// both figures and the total, because she asked to see what a change does
// before it does it, and because a sheet is not automatically right.
//
// Each write still goes through ledgerAgent.apply, which:
//   · refuses any row already pushed to QuickBooks, and FAILS CLOSED if
//     QuickBooks cannot be reached — a fill behind her books is worse than
//     no fill;
//   · refuses a field that is no longer blank, so a second run cannot
//     overwrite something she typed in between;
//   · writes through bills.editBill rather than touching JSON.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const sync = require(path.join(ROOT, 'helpers/metalsSheetSync'));
    const agent = require(path.join(ROOT, 'helpers/ledgerAgent'));
    const cfg = require(path.join(ROOT, 'config'));

    console.log(`\nMONEY BLANKS THE SHEET CAN FILL — ${new Date().toISOString()}`);
    console.log(APPLY ? 'MODE: APPLY — rows will be written\n' : 'MODE: show only — nothing will be written\n');

    // ── READ THE SHEET ───────────────────────────────────────────────────
    let book;
    try {
        book = await sync.fetchWorkbook(cfg.METALS_SHEET_ID || cfg.SHEET_ID);
    } catch (e) {
        console.log(`Could not read the sheet: ${(e && e.message) || e}`);
        console.log('This script only works on the VM, where the sheet credentials live.\n');
        process.exit(2);
    }

    const bills = require(path.join(ROOT, 'helpers/bills')).listWithTotals();
    const sales = require(path.join(ROOT, 'helpers/sales')).listWithTotals();
    const report = sync.diff({
        sheetBills: book.bills || [], sheetSales: book.sales || [],
        bills, sales,
    });

    // ── ONLY THE MONEY ONES ──────────────────────────────────────────────
    // A blank seal_no is not what this command is for. MONEY_FIELDS is the
    // agent's own list, required rather than restated so the two cannot
    // disagree about what counts as money.
    const isMoney = (field) => agent.MONEY_FIELDS.includes(field);

    const findings = [];
    for (const [ledger, rows] of [['bills', report.fillableBills], ['sales', report.fillableSales]]) {
        for (const r of (rows || [])) {
            for (const b of (r.blanks || [])) {
                if (!isMoney(b.field)) continue;
                findings.push({
                    ledger, row_id: r.row_id,
                    container_no: r.container_no, party: r.supplier,
                    fix: {
                        field: b.field, to: b.sheet,
                        // Provenance. classify() refuses a fix that cannot say
                        // where its value came from, and that rule still
                        // applies here — allowMoney relaxes the money test,
                        // nothing else.
                        from_source: 'the Edge Metals sheet',
                    },
                });
            }
        }
    }

    if (!findings.length) {
        console.log('No money fields are blank in Jarvis where the sheet has a figure.\n');
        process.exit(0);
    }

    // ── SHOW HER EVERY ONE ───────────────────────────────────────────────
    const byContainer = new Map();
    for (const f of findings) {
        const k = f.container_no || f.row_id;
        if (!byContainer.has(k)) byContainer.set(k, { party: f.party, fixes: [] });
        byContainer.get(k).fixes.push(f);
    }

    let amountTotal = 0;
    console.log(`${findings.length} blank money field(s) across ${byContainer.size} container(s)\n`);
    for (const [container, v] of byContainer) {
        console.log(`  ${container}  —  ${v.party || '(no supplier)'}`);
        for (const f of v.fixes) {
            console.log(`      ${f.fix.field.padEnd(24)} (blank)  →  ${f.fix.to}`);
            if (/amount/.test(f.fix.field)) amountTotal += Number(f.fix.to) || 0;
        }
    }
    console.log(`\n  TOTAL supplier cost currently missing: ${money(amountTotal)}`);
    console.log('  Cost missing means profit overstated by the same amount.\n');

    if (!APPLY) {
        console.log('Nothing was written. Re-run with --apply to write these.\n');
        process.exit(0);
    }

    // ── APPLY, THROUGH THE EXISTING GATES ────────────────────────────────
    const res = await agent.apply(findings, { allowMoney: true });

    let applied = 0;
    console.log(`APPLIED — ${res.applied.length}`);
    for (const a of res.applied) {
        console.log(`  ${a.container_no || a.row_id}  ${a.fix.field} = ${a.fix.to}`);
        if (/amount/.test(a.fix.field)) applied += Number(a.fix.to) || 0;
    }
    if (res.skipped.length) {
        console.log(`\nSKIPPED — ${res.skipped.length}. Nothing is wrong with these; they need you.`);
        for (const s of res.skipped) console.log(`  ${s.container_no || s.row_id}  ${s.fix && s.fix.field}: ${s.why}`);
    }
    if (res.failed.length) {
        console.log(`\nFAILED — ${res.failed.length}`);
        for (const f of res.failed) console.log(`  ${f.container_no || f.row_id}  ${f.error}`);
    }

    console.log(`\n${money(applied)} of supplier cost written into the books.`);
    console.log('Re-run the integrity sweep to confirm these have gone from its list.\n');
    process.exit(res.failed.length ? 1 : 0);
})().catch((e) => { console.error('threw:', e && e.stack); process.exit(1); });
