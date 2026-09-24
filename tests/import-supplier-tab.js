// tests/import-supplier-tab.js — the supplier-tab importer, on a throwaway ledger.
// Proves the thing that went wrong on Hugo: a load with a value but no weight
// or price must still come out as a bill for that value, not $0.00.
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabimport-'));
process.env.BILLS_FILE = path.join(dir, 'bills.json');
process.env.SALES_FILE = path.join(dir, 'sales.json');
process.env.BILL_PAYMENTS_FILE = path.join(dir, 'bill-payments.json');
process.env.PAYMENTS_FILE = path.join(dir, 'payments.json');
process.env.DATA_DIR = dir;
const bills = require('../helpers/bills');
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); } };

(async () => {
    // a load with a value and nothing else — Hugo's whole tab looks like this
    const bare = await bills.addBill({ date: '2026-06-17', supplier: 'Hugo', price_unit: 'lb',
        items: [{ description: 'Mix load', weight: null, price: null }], created_by: 'supplier tab import' });
    ck('without a stated amount the bill really is $0 — the bug she saw', !(Number(bills.withTotals(bare).amount) > 0), bills.withTotals(bare).amount);

    await bills.editBill(bare.id, { supplier_invoice_amount: 20493.31 });
    const fixedRow = bills.list().find((b) => b.id === bare.id);
    ck('stating the amount repairs it in place', Number(bills.withTotals(fixedRow).amount) === 20493.31, bills.withTotals(fixedRow).amount);
    ck('...and the grade line is still there', (fixedRow.items || []).length === 1 && fixedRow.items[0].description === 'Mix load');

    const priced = await bills.addBill({ date: '2026-08-03', supplier: 'Mario', price_unit: 'lb',
        items: [{ description: 'Sealed units', weight: 11831, price: 0.5, price_unit: 'lb' }],
        supplier_invoice_amount: 5915.5, created_by: 'supplier tab import' });
    ck('weight x price and the stated amount agree when both are given', Number(bills.withTotals(priced).amount) === 5915.5, bills.withTotals(priced).amount);

    const stated = await bills.addBill({ date: '2026-09-04', supplier: 'Hugo', price_unit: 'lb',
        items: [{ description: 'Al wheels to nur metals', weight: 37689, price: 1.6, price_unit: 'lb' }, { description: 'Clad wheels', weight: 549, price: 1.04, price_unit: 'lb' }],
        supplier_invoice_amount: 60873.36, created_by: 'supplier tab import' });
    ck('one date, several grades, one bill', (stated.items || []).length === 2 && Number(bills.withTotals(stated).amount) === 60873.36, bills.withTotals(stated).amount);

    // ── a line that states its own amount ──────────────────────────────────
    // Hugo's tab gives a value per load and no weight or price anywhere, and
    // a QuickBooks line needs a figure of its own (2026-09-24: 23 of his 25
    // bills blocked with 'grade "53 trailer loaded" has no amount').
    const whole = await bills.addBill({ date: '2026-01-07', supplier: 'Hugo', price_unit: 'lb',
        items: [{ description: '53 trailer loaded', amount: 19750.6 }],
        supplier_invoice_amount: 19750.6, created_by: 'supplier tab import' });
    const wt = bills.withTotals(whole);
    ck('a line may state its own amount', wt.items[0].amount === 19750.6, wt.items[0]);
    ck('...and the bill still totals right', Number(wt.amount) === 19750.6, wt.amount);
    ck('...with no invented weight or price', wt.items[0].weight === null && wt.items[0].price === null, wt.items[0]);

    const both = await bills.addBill({ date: '2026-01-08', supplier: 'Hugo', price_unit: 'lb',
        items: [{ description: 'Sealed units', weight: 1000, price: 0.5, price_unit: 'lb', amount: 999 }] });
    ck('weight x price still wins when it can be worked out', bills.withTotals(both).items[0].amount === 500, bills.withTotals(both).items[0]);

    const two = await bills.addBill({ date: '2026-08-24', supplier: 'Hugo', price_unit: 'lb',
        items: [{ description: 'Al wheels to nur metals', amount: 61504 }, { description: 'sa TO Houston Junk', amount: 23295.75 }],
        supplier_invoice_amount: 84799.75 });
    ck('two stated lines on one date add up', Number(bills.withTotals(two).amount) === 84799.75, bills.withTotals(two).amount);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nimport-supplier-tab: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
