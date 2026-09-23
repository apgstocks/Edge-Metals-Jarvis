#!/usr/bin/env node
// ── scripts/import-supplier-tab.js ─────────────────────────────────────────
// A supplier's running account, as she keeps it on his own tab of the
// Shipments workbook: wires out, loads in, a balance carried down the page.
// Apsara, 2026-09-23, on Mario Elder: "upload mario elder sheet with wire as
// vendor prepayment ... and packing list under one date as single bill".
//
// So: every `wire` row becomes an ADVANCE against him (Jarvis already has
// advances — money that is credit until a load is there to apply it to), and
// the `load` rows of one date become ONE bill whose lines are that day's
// grades, which is what the packing list is.
//
//   node scripts/import-supplier-tab.js <tab.csv> --supplier="Mario" [--bank=BofA]
//                                       [--mode=Wire] [--since=2026-01-01] [--really]
//
// CSV columns: date,kind,item,gross,tare,net,price,amount   (kind = wire|load)
// Dry run unless --really. Nothing here touches QuickBooks: that is a
// separate push, so the rows can be checked in Jarvis first.
require('dotenv').config();
const fs = require('fs');
const bills = require('../helpers/bills');
const billPayments = require('../helpers/billPayments');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const REALLY = process.argv.includes('--really');
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) && String(v).trim() !== '' ? n : null; };

function readCsv(file) {
    const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const cols = head.split(',').map((c) => c.trim().toLowerCase());
    return lines.filter((l) => l.trim()).map((l) => {
        const cells = l.split(',');
        const row = {}; cols.forEach((c, i) => { row[c] = (cells[i] || '').trim(); });
        return row;
    });
}

(async () => {
    const file = process.argv.slice(2).find((x) => !x.startsWith('--'));
    const supplier = arg('supplier');
    if (!file || !supplier) { console.log('usage: import-supplier-tab.js <tab.csv> --supplier="Mario" [--bank=BofA] [--mode=Wire] [--really]'); process.exit(1); }
    const bank = arg('bank') || 'BofA', mode = arg('mode') || 'Wire', since = arg('since') || '2026-01-01';
    const rows = readCsv(file).filter((r) => r.date >= since);

    const wires = rows.filter((r) => r.kind === 'wire');
    const loads = {};
    for (const r of rows.filter((x) => x.kind === 'load')) (loads[r.date] = loads[r.date] || []).push(r);

    // What is already there — this can be run twice without doubling anything.
    const haveBill = (date, total) => bills.list().some((b) => String(b.supplier || '').trim().toUpperCase() === supplier.toUpperCase()
        && String(b.date || '').slice(0, 10) === date && Math.abs(r2(bills.withTotals(b).amount) - total) < 0.02);
    const haveAdvance = (date, amount) => billPayments.list().some((p) => String(p.supplier || '').trim().toUpperCase() === supplier.toUpperCase()
        && String(p.date || '').slice(0, 10) === date && Math.abs(r2(p.amount) - amount) < 0.02);

    console.log(`${REALLY ? 'IMPORTING' : 'DRY RUN'} · ${supplier} · ${wires.length} wires, ${Object.keys(loads).length} loads`);
    let addedW = 0, skipW = 0, moneyW = 0, skipWmoney = 0;
    for (const w of wires) {
        const amount = r2(num(w.amount));
        if (haveAdvance(w.date, amount)) { skipW++; skipWmoney = r2(skipWmoney + amount); continue; }
        addedW++; moneyW = r2(moneyW + amount);
        console.log(`  advance ${w.date} $${amount}`);
        if (REALLY) await billPayments.addAdvance({ date: w.date, amount, mode, bank, supplier,
            note: `from ${supplier} tab`, created_by: 'supplier tab import' });
    }
    let addedB = 0, skipB = 0, moneyB = 0, skipBmoney = 0, fixed = 0, moneyFix = 0, empty = 0, removed = 0;
    for (const [date, list] of Object.entries(loads).sort()) {
        const items = list.map((l) => ({ description: l.item, gross: num(l.gross), boxes: num(l.tare),
            weight: num(l.net), price: num(l.price), price_unit: 'lb' }));
        const total = r2(list.reduce((s, l) => s + num(l.amount), 0));
        // ── THE AMOUNT MUST TRAVEL ON ITS OWN ─────────────────────────────
        // A bill's amount is DERIVED from weight x price (bills.js compute()).
        // Half these tabs carry a value and no weight or price at all, so the
        // first import of Hugo's tab created 19 bills reading $0.00 and
        // "no supplier price yet" (2026-09-24, she spotted it on the new
        // page). supplier_invoice_amount is the field that states a figure
        // outright — compute() prefers it over its own arithmetic.
        // Apsara, 2026-09-24: "If amont is empty,it shouldnt be there." A row
        // with no value is not a bill; it is a line she has not finished. It
        // is left in the tab and reported here, never written to the ledger.
        if (!(total > 0)) { empty++; console.log(`  skip  ${date} — no amount on the tab (${list.length} line${list.length > 1 ? 's' : ''})`); continue; }
        const stated = { supplier_invoice_amount: total };
        // already imported, but with the amount lost? fix it in place
        const broken = bills.list().find((b) => String(b.supplier || '').trim().toUpperCase() === supplier.toUpperCase()
            && String(b.date || '').slice(0, 10) === date
            && String(b.created_by || '') === 'supplier tab import'
            && !(Number(bills.withTotals(b).amount) > 0));
        if (broken) {
            fixed++; moneyFix = r2(moneyFix + total);
            console.log(`  ${REALLY ? 'fix  ' : 'would fix'} ${date} $${total} (was $0 — amount had not been carried over)`);
            if (REALLY) await bills.editBill(broken.id, stated);
            continue;
        }
        if (haveBill(date, total)) { skipB++; skipBmoney = r2(skipBmoney + total); continue; }
        addedB++; moneyB = r2(moneyB + total);
        console.log(`  bill    ${date} $${total}  (${items.length} grades: ${items.map((i) => i.description).join(', ').slice(0, 70)})`);
        if (REALLY) await bills.addBill({ date, supplier, price_unit: 'lb', items, ...stated,
            note: `${supplier} tab — packing list of ${date}`, created_by: 'supplier tab import' });
    }
    // The balance is the SUPPLIER'S account, so it counts what was already in
    // Jarvis too. Counting only the new rows makes it look wrong by exactly
    // the rows that were right (2026-09-24: Hugo, off by the $9,517.20 bill
    // already entered for HMMU4098359).
    // --remove-empty: take out rows an earlier run of THIS importer created
    // with no amount. Only ever its own rows (created_by), only ever the ones
    // still reading zero, and only when she asks for it.
    if (process.argv.includes('--remove-empty')) {
        const junk = bills.list().filter((b) => String(b.created_by || '') === 'supplier tab import'
            && String(b.supplier || '').trim().toUpperCase() === supplier.toUpperCase()
            && !(Number(bills.withTotals(b).amount) > 0));
        for (const b of junk) {
            removed++;
            console.log(`  ${REALLY ? 'remove' : 'would remove'} ${b.date} ${b.id} — no amount`);
            if (REALLY) await bills.deleteBill(b.id);
        }
        if (!junk.length) console.log('  nothing to remove — no empty rows from this importer');
    }
    console.log({ advances: addedW, 'advances already there': skipW, bills: addedB, 'bills already there': skipB,
        'bills whose amount was repaired': fixed, 'repaired $': moneyFix,
        'tab rows with no amount, left out': empty, 'empty rows removed': removed,
        'advances $': moneyW, 'bills $': moneyB,
        'already there $': r2(skipWmoney + skipBmoney),
        'balance of new rows only': r2(moneyW - moneyB),
        'HIS ACCOUNT BALANCE': r2((moneyW + skipWmoney) - (moneyB + skipBmoney + moneyFix)) });
    console.log(REALLY ? 'In Jarvis. QuickBooks is a separate push.' : 'DRY RUN — nothing written. Add --really.');
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
