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
    let addedW = 0, skipW = 0, moneyW = 0;
    for (const w of wires) {
        const amount = r2(num(w.amount));
        if (haveAdvance(w.date, amount)) { skipW++; continue; }
        addedW++; moneyW = r2(moneyW + amount);
        console.log(`  advance ${w.date} $${amount}`);
        if (REALLY) await billPayments.addAdvance({ date: w.date, amount, mode, bank, supplier,
            note: `from ${supplier} tab`, created_by: 'supplier tab import' });
    }
    let addedB = 0, skipB = 0, moneyB = 0;
    for (const [date, list] of Object.entries(loads).sort()) {
        const items = list.map((l) => ({ description: l.item, gross: num(l.gross), boxes: num(l.tare),
            weight: num(l.net), price: num(l.price), price_unit: 'lb' }));
        const total = r2(list.reduce((s, l) => s + num(l.amount), 0));
        if (haveBill(date, total)) { skipB++; continue; }
        addedB++; moneyB = r2(moneyB + total);
        console.log(`  bill    ${date} $${total}  (${items.length} grades: ${items.map((i) => i.description).join(', ').slice(0, 70)})`);
        if (REALLY) await bills.addBill({ date, supplier, price_unit: 'lb', items,
            note: `${supplier} tab — packing list of ${date}`, created_by: 'supplier tab import' });
    }
    console.log({ advances: addedW, 'advances already there': skipW, bills: addedB, 'bills already there': skipB,
        'advances $': moneyW, 'bills $': moneyB, 'balance': r2(moneyW - moneyB) });
    console.log(REALLY ? 'In Jarvis. QuickBooks is a separate push.' : 'DRY RUN — nothing written. Add --really.');
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
