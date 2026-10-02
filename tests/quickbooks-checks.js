// tests/quickbooks-checks.js — the library of what can be wrong.
// Apsara, 2026-10-02: "I want this quickbook agent to be sharp, intelligent
// who can handle any qb problem … with respect to our things."
//
// Sharp is not a better prompt. It is this list, and the discipline that the
// container checks learnt the hard way: a box is only itself for one voyage,
// and both sides must be read over the same window or "bought and never sold"
// is just a count of how much further back the purchases were read.
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 240)); } };

const checks = require('../helpers/quickbooks/checks');

const line = (desc, amount, qty, price, item) => ({ DetailType: 'ItemBasedExpenseLineDetail', Description: desc, Amount: amount,
    ItemBasedExpenseLineDetail: { Qty: qty, UnitPrice: price, ItemRef: { name: item || 'AUTO CAST' } } });
const sline = (desc, amount, qty, price) => ({ DetailType: 'SalesItemLineDetail', Description: desc, Amount: amount,
    SalesItemLineDetail: { Qty: qty, UnitPrice: price, ItemRef: { name: 'AUTO CAST' } } });
const bill = (id, date, vendor, lines, doc) => ({ Id: id, TxnDate: date, DocNumber: doc === undefined ? 'B' + id : doc, TotalAmt: lines.reduce((s, l) => s + l.Amount, 0), Balance: 0, VendorRef: { name: vendor }, Line: lines });
const inv = (id, date, customer, lines, doc) => ({ Id: id, TxnDate: date, DocNumber: doc === undefined ? 'I' + id : doc, TotalAmt: lines.reduce((s, l) => s + l.Amount, 0), Balance: 0, CustomerRef: { name: customer }, Line: lines });

// ── the voyage discipline ─────────────────────────────────────────────────
{
    const bills = [bill('1', '2026-01-10', 'Inesh', [line('MSDU1296129 cores', 56346.92, 45000, 1.2522)])];
    const invoices = [
        inv('9', '2026-01-16', 'MAPRASCO', [sline('MSDU1296129', 31385.48, 45000, 0.6975)]),
        // the same box, fourteen months later: a different voyage entirely
        inv('10', '2027-03-20', 'SOLINE', [sline('MSDU1296129', 60000, 45000, 1.3333)]),
    ];
    const ctx = { bills, invoices, purchases: [], vendors: [], customers: [], since: '2026-01-01' };
    const out = checks.run(ctx);
    const get = (id) => out.find((c) => c.id === id) || {};
    ck('a sale is paired with the purchase of that box in the same voyage', ctx.pairing.pairs.length === 1, ctx.pairing.pairs.length);
    ck('...and the same box a year later is NOT paired to it', ctx.pairing.soldAlone.length === 1 && ctx.pairing.soldAlone[0].id === '10', ctx.pairing.soldAlone);
    ck('selling under cost is caught, at the real difference',
       get('margin-upside-down').count === 1 && get('margin-upside-down').rows[0].amount === 24961.44, get('margin-upside-down').rows);
    ck('...and the unpaired later sale is reported as having no purchase',
       get('sold-not-bought').count === 1, get('sold-not-bought').rows);
}

// ── units, not drift ──────────────────────────────────────────────────────
// A sale in tonnes against a purchase in pounds is a ratio near 1/2000. That
// is a unit, not a weight loss, and reporting it as drift would bury the real
// ones (HMMU6166160 "sold 100% more than bought" was two voyages).
{
    const bills = [bill('1', '2026-05-01', 'Houston', [line('MSMU1850772', 30000, 63653, 0.4713)])];
    const invoices = [
        inv('9', '2026-05-22', 'MAPRASCO', [sline('MSMU1850772', 35000, 50384, 0.6947)]),
    ];
    const out = checks.run({ bills, invoices, purchases: [], vendors: [], customers: [], since: '2026-01-01' });
    const drift = out.find((c) => c.id === 'weight-drift');
    ck('a real weight gap is reported with its percentage',
       drift.count === 1 && /-20\.8%/.test(drift.rows[0].what), drift.rows);

    const unit = checks.run({ since: '2026-01-01', purchases: [], vendors: [], customers: [],
        bills: [bill('2', '2026-05-01', 'Inesh', [line('TCKU6404660', 30000, 45000, 0.6667)])],
        invoices: [inv('8', '2026-05-20', 'TAEWON', [sline('TCKU6404660', 31000, 20.41, 1518.86)])] });
    ck('...but pounds against tonnes is a unit, not drift, and is left alone',
       (unit.find((c) => c.id === 'weight-drift') || {}).count === 0, (unit.find((c) => c.id === 'weight-drift') || {}).rows);
}

// ── the plain ones ────────────────────────────────────────────────────────
{
    const out = checks.run({ since: '2026-01-01', purchases: [{ Id: '5', TxnDate: '2026-02-23', TotalAmt: 25000,
            Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 25000, AccountBasedExpenseLineDetail: { AccountRef: { name: 'Cost of Goods Sold' } } }] }],
        bills: [bill('1', '2026-09-05', 'Mazariegos', [line('X', 100, 1, 100)], '')],
        invoices: [inv('9', '2099-01-01', 'Someone', [sline('Y', 50, 1, 50)])],
        vendors: [{ Id: '121', DisplayName: 'G&C RECYCLING', Balance: 9626.4 }],
        customers: [{ Id: '581', DisplayName: 'G&C Recycling', Balance: 165280.8 }] });
    const get = (id) => out.find((c) => c.id === id) || {};
    ck('a document with no number is named', get('no-reference').count === 1);
    ck('a future-dated document is named', get('future-dated').count === 1);
    ck('money out with no payee is named, with the money', get('payee-missing').count === 1 && get('payee-missing').money === 25000);
    ck('the catch-all cost account is named', get('generic-cogs').count === 1);
    ck('one company on both sides is spotted whatever the spelling', get('both-sides').count === 1, get('both-sides').rows);
}

// ── the library is meant to grow, and says how sure it is ─────────────────
{
    const all = [...checks.CHECKS, ...checks.DOMAIN_CHECKS];
    ck('every check says what it looks for, how sure it is, and why it matters',
       all.every((c) => c.id && c.title && ['certain', 'likely', 'worth a look'].includes(c.sure) && c.why));
    ck('nothing in the library writes to QuickBooks',
       !/client\.request\('POST'/.test(fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'checks.js'), 'utf8')));
    ck('there are checks about HER business, not only bookkeeping',
       checks.DOMAIN_CHECKS.length >= 5 && checks.DOMAIN_CHECKS.some((c) => c.id === 'margin-upside-down'));
}

console.log(`\nquickbooks-checks: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
