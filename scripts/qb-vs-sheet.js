#!/usr/bin/env node
// ── scripts/qb-vs-sheet.js — her live sheet against her live books ─────────
// Apsara, 2026-09-24: "run qb against my live sheet. if anything is missing,
// put a entry".
//
//   node scripts/qb-vs-sheet.js [--since=2026-01-01] [--out=file.csv]
//
// The comparison itself lives in helpers/quickbooks/vsSheet.js (2026-09-26),
// because the QuickBooks page answers the same question now and two
// implementations that disagree would be worse than none. This is the CSV.
//
// READ-ONLY. Entering what is missing is a separate, deliberate step:
//   node scripts/qb-push-list.js --kind=bill|invoice ... --reason="..."
// because most of what is missing sits BEFORE the cutover, in the period her
// accountant owns, and $3M of entries is not a side effect of a report.
require('dotenv').config();
const fs = require('fs');
const vsSheet = require('../helpers/quickbooks/vsSheet');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };

(async () => {
    const since = arg('since') || '2026-01-01';
    const out = await vsSheet.compare({ since, env: 'production' });
    console.log(`live sheet since ${since}: ${out.sheet.purchases} purchases, ${out.sheet.sales} sales`);
    console.log(`QuickBooks since ${since}: ${out.quickbooks.bills} bills+expenses, ${out.quickbooks.invoices} invoices`);
    const rows = [['what', 'date', 'party', 'container', 'sheet no', 'sheet amount', 'side', 'status', 'QuickBooks']];
    for (const f of out.findings) {
        rows.push([f.status === 'missing' ? (f.kind === 'bill' ? 'PURCHASE not in QuickBooks' : 'SALE not in QuickBooks') : `${f.kind} ${f.status}`,
            f.date, f.party, f.container, f.no, f.amount,
            f.side === 'jarvis' ? 'after cutover (Jarvis)' : 'before cutover (accountant)', f.status, f.note]);
    }
    const file = arg('out') || 'Claude outputs/qb-vs-live-sheet.csv';
    try { fs.mkdirSync(require('path').dirname(file), { recursive: true }); } catch {}
    fs.writeFileSync(file, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
    console.log(out.tally);
    console.log(`missing before the cutover: $${out.totals.missingBefore} · after: $${out.totals.missingAfter}`);
    console.log('written:', file, `(${rows.length - 1} rows to look at)`);
    console.log('READ-ONLY — nothing was entered. Use qb-push-list.js for the ones you decide to enter.');
})().catch((e) => { console.error('qb-vs-sheet failed:', e.message); process.exit(1); });
