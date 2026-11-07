#!/usr/bin/env node
// scripts/payments-backfill.js - QuickBooks payments -> Jarvis receipts (ownership plan, slice 1).
//   node scripts/payments-backfill.js                 DRY RUN: prints what it would add, writes nothing
//   node scripts/payments-backfill.js --csv=plan.csv  also writes the proposed receipts to a CSV for her to review
//   node scripts/payments-backfill.js --customer="rad metal"   only that customer
//   node scripts/payments-backfill.js --write         adds the receipts (after she has read the dry run)
// Reads QuickBooks only (never writes to it). Run on the VM, where QuickBooks is connected.
require('dotenv').config();
const fs = require('fs');
const sales = require('../helpers/sales');
const salesReceipts = require('../helpers/salesReceipts');
const pb = require('../helpers/paymentBackfill');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const WRITE = process.argv.includes('--write');
const only = (arg('customer') || '').toLowerCase();
const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

async function pull(client, table, where, cap = 20000) {
    let all = [], start = 1;
    for (;;) {
        const r = await client.query(`select * from ${table}${where ? ' where ' + where : ''} startposition ${start} maxresults 1000`, { env: require('../helpers/quickbooks/auth').qbEnv() });
        const rows = r[table] || []; all = all.concat(rows);
        if (rows.length < 1000 || all.length >= cap) break; start += 1000;
    }
    return all;
}

(async () => {
    const client = require('../helpers/quickbooks/client');
    let rows = sales.listWithTotals();
    if (only) rows = rows.filter((s) => String(s.customer || '').toLowerCase().includes(only));
    const since = rows.map((s) => s.date).filter(Boolean).sort()[0] || '2026-01-01';
    console.log(`Jarvis sales: ${rows.length}${only ? ` (matching "${only}")` : ''}; reading QuickBooks payments and invoices since ${since} ...`);
    const [payments, invoices] = await Promise.all([pull(client, 'Payment', `TxnDate >= '${since}'`), pull(client, 'Invoice', `TxnDate >= '${since}'`)]);
    console.log(`QuickBooks: ${payments.length} payments, ${invoices.length} invoices`);
    const plan = pb.plan({ qb: { payments, invoices }, sales: rows, receipts: salesReceipts.list() });
    const t = plan.totals;
    console.log(`\nWould add ${t.receipts} receipts (${money(t.money)}) for ${t.customers} customers.  Already imported: ${t.alreadyImported}.`);
    if (t.modeGuessed) console.log(`  ${t.modeGuessed} receipts have a payment method QuickBooks did not name - set to Wire (check them).`);
    console.log(`Could NOT place: ${money(t.unmatched)} on QuickBooks invoices with no Jarvis sale (${plan.unmatched.length} lines); ${money(t.leftover)} more than the sale still showed outstanding.`);
    console.log(`Paid in QuickBooks but nothing explains it in Jarvis: ${plan.unexplained.length} sales, ${money(t.unexplained)}.`);
    const per = {}; for (const r of plan.proposed) { (per[r.customer] = per[r.customer] || { n: 0, m: 0 }); per[r.customer].n++; per[r.customer].m += r.amount; }
    console.log('\nBy customer (largest first):');
    for (const [c, v] of Object.entries(per).sort((a, b) => b[1].m - a[1].m).slice(0, 15)) console.log(`  ${c.padEnd(34)} ${String(v.n).padStart(4)} receipts  ${money(v.m)}`);
    if (arg('csv')) {
        const esc = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
        const lines = ['ref,customer,date,amount,mode,mode_guessed,bank,sales_allocated'];
        for (const r of plan.proposed) lines.push([r.ref, r.customer, r.date, r.amount, r.mode, r.mode_guessed, r.bank, r.allocations.length].map(esc).join(','));
        fs.writeFileSync(arg('csv'), lines.join('\n')); console.log(`\nProposed receipts written to ${arg('csv')}`);
    }
    if (!WRITE) { console.log('\nDRY RUN - nothing was written. Run again with --write to add these receipts.'); return; }
    const existing = new Set(salesReceipts.list().map((r) => String(r.ref || '')));
    const out = await pb.apply(plan.proposed, { addReceipt: salesReceipts.addReceipt, existingRefs: existing });
    console.log(`\nWROTE ${out.written} receipts, skipped ${out.skipped}, failed ${out.failed.length}.`);
    for (const f of out.failed.slice(0, 20)) console.log(`  failed ${f.ref} ${f.customer}: ${f.why}`);
})().catch((e) => { console.error('payments-backfill failed:', e.message); process.exit(1); });
