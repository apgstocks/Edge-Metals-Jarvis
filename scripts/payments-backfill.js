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
const BANK_ONLY = process.argv.includes('--bank-verified-only');   // with --write: only receipts a Plaid bank deposit confirms
const FIFO = process.argv.includes('--apply-unapplied');   // also apply cash QuickBooks holds unapplied, oldest invoice first
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
    const [payments, invoices] = await Promise.all([pull(client, 'Payment', `TxnDate >= '${since}'`), pull(client, 'Invoice', `TxnDate >= '${new Date(Date.parse(since) - 120 * 864e5).toISOString().slice(0, 10)}'`)])   // invoices can predate the Jarvis sale by weeks;
    console.log(`QuickBooks: ${payments.length} payments, ${invoices.length} invoices`);
    // With --customer, QuickBooks payments of OTHER customers are not "unplaced", they are simply not in scope.
    const inScope = (c) => !only || String((c && c.name) || '').toLowerCase().includes(only);
    const plan = pb.plan({ qb: { payments: payments.filter((p) => inScope(p.CustomerRef)), invoices: invoices.filter((i) => inScope(i.CustomerRef)) }, sales: rows, receipts: salesReceipts.list(), fifoUnapplied: FIFO });
    const t = plan.totals;
    console.log(`\nWould add ${t.receipts} receipts (${money(t.money)}) for ${t.customers} customers.  Already imported: ${t.alreadyImported}.`);
    if (t.modeGuessed) console.log(`  ${t.modeGuessed} receipts have a payment method QuickBooks did not name - set to Wire (check them).`);
    if (t.wireFeeCount) console.log(`  ${t.wireFeeCount} invoices closed with a small wire-fee shortfall (${money(t.wireFees)} in all, up to $${pb.FEE_TOLERANCE} each) - recorded as bank charges, said on each receipt.`);
    console.log(`Could NOT place: ${money(t.unmatched)} on QuickBooks invoices with no Jarvis sale (${plan.unmatched.length} lines); ${money(t.leftover)} more than the sale still showed outstanding.`);
    console.log(`Paid in QuickBooks but nothing explains it in Jarvis: ${plan.unexplained.length} sales, ${money(t.unexplained)}.`);
    if (t.unappliedCash) console.log(`QuickBooks holds ${money(t.unappliedCash)} of customer cash applied to NO invoice (lump payments). ${FIFO ? `Applying it to the oldest open invoices: ${money(t.unappliedPlaced)} placed.` : 'NOT applied here - add --apply-unapplied to apply it oldest invoice first.'}`);
    const rem = plan.remaining;
    console.log(`\nStill open in Jarvis AFTER this: ${rem.qbOpen.n + rem.qbPaidUnexplained.n + rem.notInQuickbooks.n} sales`);
    console.log(`  QuickBooks agrees they are unpaid:            ${String(rem.qbOpen.n).padStart(4)} sales  ${money(rem.qbOpen.amount)}`);
    console.log(`  QuickBooks says paid, nothing explains it:    ${String(rem.qbPaidUnexplained.n).padStart(4)} sales  ${money(rem.qbPaidUnexplained.amount)}`);
    console.log(`  No matching invoice found in QuickBooks:      ${String(rem.notInQuickbooks.n).padStart(4)} sales  ${money(rem.notInQuickbooks.amount)}`);
    const oo = plan.oldestOpen;
    if (oo.length) console.log(`  Oldest still open: ${oo.slice(0, 3).map((x) => `${x.invoice_no || x.container_no || '-'} (${x.date}) ${money(x.open)}`).join('; ')}   Newest: ${oo.slice(-1).map((x) => `${x.invoice_no || x.container_no || '-'} (${x.date})`)[0]}`);
    for (const x of rem.notInQuickbooksList.slice(0, 5)) console.log(`      e.g. ${x.invoice_no || '-'} / ${x.container_no || '-'} (${x.date || '-'}) ${money(x.open)}`);
    // CHECK AGAINST THE BANK (Plaid feed): is there a real deposit of that amount near each receipt's date?
    let bankRows = []; try { bankRows = require('../helpers/bankLedger').list(); } catch (e) { /* no bank feed here */ }
    const bv = pb.verifyWithBank(plan.proposed, bankRows);
    const bt = bv.totals;
    console.log(`\nBANK CHECK (Plaid feed ${bv.coverage.from || 'empty'} to ${bv.coverage.to || '-'}, ${bv.coverage.deposits} deposits):`);
    console.log(`  confirmed by a deposit of the same amount within ${pb.BANK_DAYS} days: ${String(bt.verified).padStart(4)} receipts  ${money(bt.verifiedMoney)}`);
    console.log(`  NOT found in the bank feed:                                ${String(bt.notFound).padStart(4)} receipts  ${money(bt.notFoundMoney)}`);
    console.log(`  older than the bank feed (cannot be checked):              ${String(bt.outsideFeed).padStart(4)} receipts  ${money(bt.outsideFeedMoney)}`);
    plan.proposed = bv.rows;
    const usedIds = new Set(bv.rows.filter((r) => r.bank_check.status === 'verified').map((r) => r.bank_check.deposit_id));
    const bh = pb.bankHints(plan.oldestOpen, bankRows, { usedDepositIds: usedIds });
    console.log(`\nOf the ${bh.of} sales still open, ${bh.hints.length} have an unused bank deposit of that amount (or up to $50 less, a wire fee) after the invoice date: ${money(bh.money)}`);
    for (const h of bh.hints.slice(0, 8)) console.log(`      ${String(h.invoice_no || h.container_no).padEnd(24)} ${money(h.open).padStart(14)}  deposit ${h.deposit_date} "${String(h.desc).slice(0, 36)}"`);
    if (plan.proposed.some((r) => r.matched_by_amount)) console.log(`  ${plan.proposed.filter((r) => r.matched_by_amount).length} receipts were matched to their invoice by exact amount only (noted on the receipt).`);
    if (only) {
        const cc = pb.crossCheck({ sales: rows, qbPayments: payments.filter((p) => inScope(p.CustomerRef)), bankRows, customer: only, since });
        console.log(`\nTHREE-WAY CHECK for "${only}" since ${since}:`);
        console.log(`  Jarvis invoiced:                          ${money(cc.invoiced)}   (Jarvis shows ${money(cc.jarvisReceived)} received)`);
        console.log(`  QuickBooks recorded as paid:              ${money(cc.qbPaid)}`);
        console.log(`  Bank deposits that look like theirs:      ${money(cc.bank)}   (${cc.bankDeposits} deposits${cc.nameSignal ? `, text contains "${cc.matchedBy}"` : ', name too generic to match - amount only'})`);
        console.log(`  If the bank figure is close to the invoiced figure, they HAVE paid and QuickBooks/Jarvis are the ones behind.`);
    }
    if (plan.unmatched.length) {
        console.log('\nQuickBooks payments I could not place on any Jarvis sale:');
        for (const u of plan.unmatched.slice(0, 10)) console.log(`  QB invoice ${String(u.doc).padEnd(26)} ${money(u.amount).padStart(14)}  (${u.why})`);
    }
    const per = {}; for (const r of plan.proposed) { (per[r.customer] = per[r.customer] || { n: 0, m: 0 }); per[r.customer].n++; per[r.customer].m += r.amount; }
    console.log('\nBy customer (largest first):');
    for (const [c, v] of Object.entries(per).sort((a, b) => b[1].m - a[1].m).slice(0, 15)) console.log(`  ${c.padEnd(34)} ${String(v.n).padStart(4)} receipts  ${money(v.m)}`);
    if (arg('csv')) {
        const esc = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
        const lines = ['ref,customer,date,amount,mode,mode_guessed,bank,sales_allocated,bank_check'];
        for (const r of plan.proposed) lines.push([r.ref, r.customer, r.date, r.amount, r.mode, r.mode_guessed, r.bank, r.allocations.length, r.bank_check && r.bank_check.status].map(esc).join(','));
        fs.writeFileSync(arg('csv'), lines.join('\n')); console.log(`\nProposed receipts written to ${arg('csv')}`);
    }
    if (!WRITE) { console.log('\nDRY RUN - nothing was written. Run again with --write to add these receipts.'); return; }
    const existing = new Set(salesReceipts.list().map((r) => String(r.ref || '')));
    const toWrite = BANK_ONLY ? plan.proposed.filter((r) => r.bank_check && r.bank_check.status === 'verified') : plan.proposed;
    if (BANK_ONLY) console.log(`\n--bank-verified-only: writing ${toWrite.length} of ${plan.proposed.length} receipts (the ones a bank deposit confirms).`);
    const out = await pb.apply(toWrite, { addReceipt: salesReceipts.addReceipt, existingRefs: existing });
    console.log(`\nWROTE ${out.written} receipts, skipped ${out.skipped}, failed ${out.failed.length}.`);
    for (const f of out.failed.slice(0, 20)) console.log(`  failed ${f.ref} ${f.customer}: ${f.why}`);
})().catch((e) => { console.error('payments-backfill failed:', e.message); process.exit(1); });
