#!/usr/bin/env node
// ── scripts/import-fmc-eccomelt.js ──────────────────────────────────────────
// Apsara, 2026-09-23: "upload all fmc,eccomelt invoice".
//
// The FMC and ECCOMELT tabs of her Shipments workbook are local deliveries
// that never went through Jarvis: 127 FMC tickets and 27 eccomelt loads in
// 2026, of which 99 ($1,679,108.55) are in no ledger and not in QuickBooks
// either. This brings them into Jarvis's Sales ledger first, so they are
// visible, correctable and covered by the journal — QuickBooks comes after,
// through the normal push.
//
//   node scripts/import-fmc-eccomelt.js <tabs.json> [--since=2026-01-01]
//                                       [--only=fmc|eccomelt] [--really]
//
// Dry run unless --really. Never touches a sale that is already there: a row
// counts as present when the same customer has a sale on that date for that
// amount, or an invoice number that matches the ticket.
require('dotenv').config();
const fs = require('fs');
const sales = require('../helpers/sales');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const REALLY = process.argv.includes('--really');
const SINCE = arg('since') || '2026-01-01';
const ONLY = (arg('only') || '').toLowerCase();
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const CUSTOMER = { fmc: 'FMC METALS', eccomelt: 'eccomelt' };

function planned(tabs) {
    const out = [];
    if (ONLY !== 'eccomelt') for (const r of tabs.fmc || []) {
        const ticket = String(r.ticket || '').replace(/\.0$/, '').trim();
        if (!r.date || r.date < SINCE || !(r2(r.amount) > 0)) continue;
        // Rows with no ticket number are item lines under a ticket, not
        // invoices of their own — left out until Apsara says what they are.
        if (!/^\d+$/.test(ticket)) { out.push({ skip: 'no ticket number — item line?', date: r.date, customer: CUSTOMER.fmc, amount: r2(r.amount) }); continue; }
        out.push({ date: r.date, customer: CUSTOMER.fmc, invoice_no: ticket, item: r.item || 'Scrap', weight: Number(r.net) || null,
            price_unit: 'lb', weight_unit: 'lb', invoice_price: r.net ? r2(r.amount / Number(r.net)) : null, amount: r2(r.amount),
            note: `FMC tab ticket ${ticket}` });
    }
    if (ONLY !== 'fmc') for (const r of tabs.eccomelt || []) {
        if (!r.date || r.date < SINCE || !(r2(r.amount) > 0)) continue;
        out.push({ date: r.date, customer: CUSTOMER.eccomelt, invoice_no: '', item: r.item || 'Al Wheels Dirty', weight: Number(r.net) || null,
            price_unit: 'lb', weight_unit: 'lb', invoice_price: Number(r.price) || null, amount: r2(r.amount),
            note: 'ECCOMELT tab delivery' });
    }
    return out;
}

function alreadyThere(row, existing) {
    const same = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
    return existing.find((s) => {
        if (!same(s.customer, row.customer)) return false;
        if (row.invoice_no && same(s.invoice_no, row.invoice_no)) return true;
        return String(s.date || '').slice(0, 10) === row.date && Math.abs(r2(sales.withTotals(s).amount) - row.amount) < 0.02;
    });
}

(async () => {
    const file = process.argv.slice(2).find((x) => !x.startsWith('--'));
    if (!file) { console.log('usage: node scripts/import-fmc-eccomelt.js <tabs.json> [--since=] [--only=] [--really]'); process.exit(1); }
    const tabs = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = planned(tabs);
    const existing = sales.list();
    const tally = { 'would-add': 0, 'already in Jarvis': 0, skipped: 0 }; let money = 0;
    for (const row of rows) {
        if (row.skip) { tally.skipped++; continue; }
        const have = alreadyThere(row, existing);
        if (have) { tally['already in Jarvis']++; continue; }
        tally['would-add']++; money = r2(money + row.amount);
        console.log(`${REALLY ? 'add  ' : 'would add'} ${row.date} ${row.customer.padEnd(11)} ${(row.invoice_no || '(local)').padEnd(8)} $${String(row.amount).padStart(11)} ${row.item}`);
        if (REALLY) { const saved = await sales.addSale({ ...row, created_by: 'fmc/eccomelt tab import' }); existing.push(saved); }
    }
    console.log(tally, `$${money}`);
    console.log(REALLY ? 'Added to Jarvis. They reach QuickBooks only through a push you run next.'
        : 'DRY RUN — nothing written. Add --really to write them into Jarvis.');
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
