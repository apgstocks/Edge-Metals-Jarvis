#!/usr/bin/env node
// ── scripts/import-from-sheet.js — deals in her sheet that Jarvis never saw ─
// Apsara, 2026-09-24: "run qb against my live sheet. if anything is missing,
// put a entry".
//
// qb-vs-sheet.js says what QuickBooks is missing. Some of those never reached
// Jarvis either — and Jarvis can only push what it holds. This reads the live
// sheet and creates the MISSING Jarvis rows, so the normal push can then take
// them to QuickBooks. It never edits a row that is already there.
//
//   node scripts/import-from-sheet.js [--since=2026-09-06] [--only=bills|sales] [--really]
//
// Dry run unless --really. Default --since is the bill cutover, because
// before that the ledger is deliberately not Jarvis's story to tell.
require('dotenv').config();
const cfg = require('../config');
const bills = require('../helpers/bills');
const sales = require('../helpers/sales');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const REALLY = process.argv.includes('--really');
const ONLY = (arg('only') || '').toLowerCase();
const SINCE = arg('since') || '2026-09-06';
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const KEY = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) && String(v).trim() !== '' ? n : null; };
const date = (v) => {
    const s = String(v || '').trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return null;
};
async function tab(range) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: cfg.GDRIVE_KEYFILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const api = google.sheets({ version: 'v4', auth });
    return (await api.spreadsheets.values.get({ spreadsheetId: cfg.INVOICE_SHEET_ID, range })).data.values || [];
}

(async () => {
    const plan = { bills: [], sales: [] };

    if (ONLY !== 'sales') {
        const rows = await tab('SHIPMENTS 2026!A1:BJ3000');
        const have = bills.list();
        for (const row of rows.slice(1)) {
            const d = date(row[3]), container = String(row[8] || '').trim(), supplier = String(row[4] || '').trim();
            const amount = num(row[20]);
            if (!d || d < SINCE || !container || !(amount > 0)) continue;
            // already in Jarvis? container is the identity of a bill
            if (have.some((b) => KEY(b.container_no) === KEY(container))) continue;
            const net = num(row[17]), mt = num(row[18]), price = num(row[19]);
            plan.bills.push({ date: d, supplier, container_no: container, seal_no: String(row[9] || '').trim() || null,
                booking_no: String(row[7] || '').trim() || null, invoice_no: String(row[6] || '').trim() || null,
                gross: num(row[11]), truck: num(row[12]), container: num(row[13]), chassis: num(row[14]), boxes: num(row[15]),
                price_unit: price !== null && price < 10 ? 'lb' : 'mt',
                items: [{ description: String(row[10] || '').trim() || 'Scrap', weight: price !== null && price < 10 ? net : mt, price,
                    price_unit: price !== null && price < 10 ? 'lb' : 'mt' }],
                supplier_invoice_amount: amount, note: 'from the sheet (SHIPMENTS 2026)', _amount: r2(amount) });
        }
    }

    if (ONLY !== 'bills') {
        const rows = await tab('Order Details 2026!A1:AZ2000');
        const have = sales.list();
        for (const row of rows.slice(1)) {
            const d = date(row[2]), container = String(row[5] || '').trim(), customer = String(row[9] || '').trim();
            const amount = num(row[15]), no = String(row[1] || '').trim();
            if (!d || d < SINCE || !(amount > 0) || (!container && !no)) continue;
            if (have.some((s) => (container && KEY(s.container_no) === KEY(container)) || (no && KEY(s.invoice_no) === KEY(no)))) continue;
            plan.sales.push({ date: d, customer, container_no: container || null, invoice_no: no || null,
                hbl_no: String(row[3] || '').trim() || null, booking_no: String(row[4] || '').trim() || null,
                reference: String(row[11] || '').trim() || null, item: String(row[12] || '').trim() || 'Scrap',
                weight: num(row[13]), weight_unit: 'mt', price_unit: 'mt', invoice_price: num(row[14]), amount: r2(amount),
                note: 'from the sheet (Order Details 2026)', _amount: r2(amount) });
        }
    }

    const show = (label, list) => {
        console.log(`\n${label}: ${list.length}${list.length ? ` · $${r2(list.reduce((s, x) => s + x._amount, 0))}` : ''}`);
        for (const x of list) console.log(`  ${x.date}  ${String(x.supplier || x.customer || '').slice(0, 18).padEnd(18)} ${String(x.container_no || x.invoice_no || '').padEnd(13)} $${x._amount}`);
    };
    show('BILLS the sheet has and Jarvis does not', plan.bills);
    show('SALES the sheet has and Jarvis does not', plan.sales);

    if (!REALLY) { console.log('\nDRY RUN — nothing written. Add --really to create these in Jarvis.'); return; }
    let made = 0;
    for (const b of plan.bills) { const { _amount, ...rec } = b; await bills.addBill({ ...rec, created_by: 'sheet import' }); made++; }
    for (const s of plan.sales) { const { _amount, ...rec } = s; await sales.addSale({ ...rec, created_by: 'sheet import' }); made++; }
    console.log(`\n${made} rows created in Jarvis. They reach QuickBooks on the next push (scripts/qb-sync.js).`);
})().catch((e) => { console.error('import-from-sheet failed:', e.message); process.exit(1); });
