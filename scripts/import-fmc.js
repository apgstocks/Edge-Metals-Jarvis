#!/usr/bin/env node
// ── scripts/import-fmc.js — the FMC tab, as invoices ───────────────────────
// Apsara, 2026-09-25: "Upload the fmc invoices".
//
// Built to match what her accountant already does, read out of QuickBooks
// rather than guessed (invoices #38980, #38987, #38965…):
//
//   one invoice per TICKET · invoice number = the ticket number ·
//   one line · item "Copper" · qty = net lbs · price = amount / net ·
//   customer FMC METALS · "Due on receipt" (set by pushInvoice, not here —
//   Jarvis's own `terms` field means LC or TT and refuses anything else)
//
// She books even the $1.38/lb tickets as Copper, so this does too. Reading
// the LIVE tab, not a download, because the workbook changes hourly.
//
//   node scripts/import-fmc.js [--since=2026-01-01] [--really]
//
// Dry run unless --really. Writes to JARVIS only; QuickBooks is the separate
// push (scripts/qb-push-list.js --kind=invoice --customer="FMC METALS").
//
// ── WHAT IT DELIBERATELY LEAVES OUT ────────────────────────────────────────
// The 57 rows with no ticket number (~$310k): they carry a material, a weight
// and a price, they sit under a ticket whose total does not include them, and
// nobody has yet said whether they are separate sales or detail lines. And
// eccomelt, which is invoiced in BUNDLES — 26ECCO01 is every load to 14 May
// to the cent — so one invoice per load there would double-bill $360,518.90.
require('dotenv').config();
const cfg = require('../config');
const sales = require('../helpers/sales');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const REALLY = process.argv.includes('--really');
const SINCE = arg('since') || '2026-01-01';
const CUSTOMER = 'FMC METALS';
const ITEM = 'Copper';
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) && String(v).trim() !== '' ? n : null; };

async function liveTab() {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: cfg.GDRIVE_KEYFILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const api = google.sheets({ version: 'v4', auth });
    const rows = (await api.spreadsheets.values.get({ spreadsheetId: cfg.INVOICE_SHEET_ID, range: 'FMC!A1:K600' })).data.values || [];
    // Purchase Ticket · Date · Item · Gross · Tare · Net · Price · Amount · …
    const out = [];
    for (const row of rows.slice(2)) {
        const ticket = String(row[0] || '').trim().replace(/\.0$/, '');
        const d = String(row[1] || '').trim();
        let date = null;
        let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(d); if (m) date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        if (!date) { m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(d); if (m) date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; }
        const amount = num(row[7]);
        if (!date || date < SINCE || !(amount > 0)) continue;
        out.push({ ticket, date, item: String(row[2] || '').trim(), net: num(row[5]), amount: r2(amount) });
    }
    return out;
}

(async () => {
    const rows = await liveTab();
    const tickets = rows.filter((r) => /^\d+$/.test(r.ticket));
    const loose = rows.filter((r) => !/^\d+$/.test(r.ticket));
    console.log(`FMC tab since ${SINCE}: ${tickets.length} tickets ($${r2(tickets.reduce((s, r) => s + r.amount, 0))})`);
    console.log(`left out: ${loose.length} rows with no ticket number ($${r2(loose.reduce((s, r) => s + r.amount, 0))}) — still unclassified\n`);

    const have = sales.list();
    const already = (t) => have.some((s) => KEY(s.invoice_no) === KEY(t) && KEY(s.customer) === KEY(CUSTOMER));

    let add = 0, skip = 0, money = 0, noNet = 0;
    for (const t of tickets.sort((a, b) => a.date.localeCompare(b.date))) {
        if (already(t.ticket)) { skip++; continue; }
        const price = t.net ? Math.round((t.amount / t.net) * 1e7) / 1e7 : null;
        if (!t.net) noNet++;
        add++; money = r2(money + t.amount);
        console.log(`  ${REALLY ? 'add ' : 'would add'} ${t.date}  ticket ${t.ticket.padEnd(6)} ${String(t.net || '—').padStart(7)} lb  $${String(t.amount).padStart(10)}${price ? `  ($${price.toFixed(4)}/lb)` : '  (no net weight — amount only)'}`);
        if (REALLY) {
            await sales.addSale({
                // NO terms here: Jarvis's `terms` is the SHIPMENT term and it
                // only accepts LC or TT (sales.js TERMS). "Due on receipt" is
                // a QuickBooks PAYMENT term, and pushInvoice already puts it
                // on every invoice it creates. Passing it here threw
                // "terms must be LC or TT" on the first row (2026-09-25).
                date: t.date, customer: CUSTOMER, invoice_no: t.ticket,
                item: ITEM, weight: t.net || null, weight_unit: 'lb', price_unit: 'lb',
                invoice_price: price, amount: t.amount,
                note: `FMC tab ticket ${t.ticket}${t.item ? ` · ${t.item}` : ''}`,
                created_by: 'fmc tab import',
            });
        }
    }
    console.log(`\n${REALLY ? 'added' : 'would add'}: ${add} invoices, $${money}${noNet ? ` (${noNet} with no net weight — the line carries the amount only)` : ''}`);
    console.log(`already in Jarvis: ${skip}`);
    console.log(REALLY
        ? 'In Jarvis. Next: node scripts/qb-push-list.js --kind=invoice --customer="FMC METALS" --reason="FMC tab backlog"'
        : 'DRY RUN — nothing written. Add --really.');
    console.log('QuickBooks will link, not duplicate, any ticket her accountant already entered — the invoice number is the ticket number.');
})().catch((e) => { console.error('import-fmc failed:', e.message); process.exit(1); });
