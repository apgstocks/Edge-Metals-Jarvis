// ── scripts/import-preview.js — read her workbook, write nothing ────────────
//
// Apsara, 2026-09-18: "i want to upload this — whatever in shipments tab to
// Bill and Order Details to Invoice tab", and, asked how it should be handed
// over: preview first, confirm after.
//
// So this is the preview, and it is a SCRIPT rather than a route on purpose:
// the decision to write 492 bills into live data should not be one click away
// from reading a file. The route comes after she has seen this and said go,
// and will build its preview from the same helpers/sheetImport.js, so what
// she approves is what gets written.
//
//   node scripts/import-preview.js <workbook.xlsx> [out.md]

const fs = require('fs');
const path = require('path');
const si = require(path.join(__dirname, '..', 'helpers/sheetImport'));

const FENCE = '```';

function clean(o) {
    const c = { ...o };
    delete c._rows; delete c._row; delete c._stored;
    return c;
}

(async () => {
    const src = process.argv[2];
    const out = process.argv[3] || path.join(__dirname, '..', 'IMPORT-PREVIEW.md');
    if (!src || !fs.existsSync(src)) {
        console.error('usage: node scripts/import-preview.js <workbook.xlsx> [out.md]');
        process.exit(1);
    }

    const r = await si.readWorkbook(fs.readFileSync(src));
    const L = [];
    const p = (s) => L.push(s === undefined ? '' : s);

    p('# Import preview — ' + path.basename(src));
    p();
    p('**Nothing has been written.** This is what the import would create.');
    p();
    p('## Totals');
    p();
    p('| | |');
    p('|---|---|');
    p('| Bills — from ' + (r.sheets.shipments ? r.sheets.shipments.name : '?') + ' | **' + r.summary.bills + '** |');
    p('| — of those, multi-grade containers | ' + r.summary.bills_multi_grade + ' |');
    p('| — of those, local deliveries (no container) | ' + r.summary.bills_local_delivery + ' |');
    p('| Invoices — from ' + (r.sheets.orders ? r.sheets.orders.name : '?') + ' | **' + r.summary.sales + '** |');
    p('| Rows skipped | ' + r.summary.rows_skipped + ' |');
    p('| Values it could not read | ' + r.summary.unreadable_values + ' |');
    p('| Invoice totals disagreeing with weight × price | ' + r.summary.total_mismatches + ' |');
    p();
    if (r.sheets.shipments && r.sheets.orders) {
        p('Every mapped column was found in both sheets — '
          + r.sheets.shipments.headersMatched + '/' + r.sheets.shipments.headersTotal + ' and '
          + r.sheets.orders.headersMatched + '/' + r.sheets.orders.headersTotal + '.');
        p();
    }

    p('## Rows that were skipped');
    p();
    p('Only rows that say nothing at all. A blank container is NOT a reason to skip — that means a local delivery, and those are imported and marked as such. Row numbers are as in Excel, so they can be checked.');
    p();
    const why = {};
    r.skipped.forEach((s) => { const k = s.sheet + ' — ' + s.why; (why[k] = why[k] || []).push(s.row); });
    Object.entries(why).forEach(([k, rows]) => {
        p('- **' + rows.length + '** in ' + k);
        p('  - rows: ' + rows.slice(0, 40).join(', ') + (rows.length > 40 ? ' …' : ''));
    });
    p();

    p('## Values it could not read');
    p();
    p('Junk sitting in date columns. The row is still imported — only that one value is dropped.');
    p();
    p('| Sheet | Row | Field | What is there |');
    p('|---|---|---|---|');
    r.problems.slice(0, 30).forEach((x) => p('| ' + x.sheet + ' | ' + x.row + ' | ' + x.field + ' | ' + x.why + ' |'));
    if (r.problems.length > 30) { p(); p('…and ' + (r.problems.length - 30) + ' more.'); }
    p();

    if (r.mismatches.length) {
        p('## Invoice totals that do not add up');
        p();
        p('The sheet states a total that disagrees with weight × price. Reported, never corrected — which is right is her call.');
        p();
        p('| Row | Invoice | Sheet says | weight × price | Difference |');
        p('|---|---|---|---|---|');
        r.mismatches.slice(0, 25).forEach((m) => p('| ' + m.row + ' | ' + m.invoice_no + ' | ' + m.sheet_says + ' | ' + m.weight_x_price + ' | ' + m.difference + ' |'));
        p();
    }

    p('## What is deliberately NOT imported');
    p();
    p('**Derived figures** — Total, NET, MT, INVOICE AMT, COMM Amount. Jarvis computes these from the parts. A typed total stored beside the arithmetic that produces it means that, the first time they disagree, there is no way to tell which is right.');
    p();
    p('**The selling side of the Shipments sheet** — Customer, Invoice nbr, Pier pass, Balance, Entry from bank, Loan Deduc, Paid by Edge, FAS, INVOICE PRICE, Buyer selling Amount, FRIEGHT, Edge Net, Wire Charge, Commissions, EDGE NET. A supplier bill has no home for any of it, and it is the same money the Invoice side already carries.');
    p();
    p('**RECEIVED AMT and Received Date** — those are payments, not invoices. They belong in the receipts ledger; on the invoice row they would give two answers to "has this been paid".');
    p();

    p('## Samples');
    p();
    const single = r.bills.find((b) => !b.items);
    const multi = r.bills.find((b) => b.items && b.items.length > 2);
    if (single) { p('### A single-grade bill'); p(); p(FENCE + 'json'); p(JSON.stringify(clean(single), null, 1)); p(FENCE); p(); }
    if (multi) {
        p('### A multi-grade container, grouped into ONE bill');
        p();
        p('Her sheet puts one row per grade. Row-per-bill would have split this into ' + multi.items.length + ' separate bills.');
        p();
        p(FENCE + 'json'); p(JSON.stringify(clean(multi), null, 1)); p(FENCE); p();
    }
    const local = r.bills.find((b) => !b.container_no);
    if (local) {
        p('### A local delivery');
        p();
        p('No container number, because it went by truck — Apsara, 2026-09-19: "if container number not there, it just means that it is local delivery." Imported and marked, not skipped.');
        p();
        p(FENCE + 'json'); p(JSON.stringify(clean(local), null, 1)); p(FENCE); p();
    }
    if (r.sales[0]) { p('### An invoice row'); p(); p(FENCE + 'json'); p(JSON.stringify(clean(r.sales[0]), null, 1)); p(FENCE); }

    fs.writeFileSync(out, L.join('\n') + '\n');
    console.log('Preview written to ' + out);
    console.log(JSON.stringify(r.summary, null, 1));
})().catch((e) => { console.error('FAILED:', e && e.stack); process.exit(1); });
