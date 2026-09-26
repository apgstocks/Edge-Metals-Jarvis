// tests/quickbooks-books.js — her books, read into Jarvis.
// Apsara, 2026-09-26: "user should able to feel content with jarvis quickbook
// without needing to open qb ... jarvis should be supreme of qb."
// No network here: these pin the reading of what QuickBooks sends back, which
// is where a wrong number would come from, and the read-only promise.
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 200)); } };

const books = require('../helpers/quickbooks/books');

// ── the P&L report, as QuickBooks shapes it ────────────────────────────────
// Nested Rows, the figure in the LAST column, thousands separators in the
// string. Reading the first column or forgetting the commas is how a page
// ends up showing 17 instead of 17,484,407.91.
const report = { Header: { ReportName: 'ProfitAndLoss' }, Rows: { Row: [
    { Rows: { Row: [ { type: 'Data', ColData: [{ value: 'Sales of Product Income' }, { value: '17,484,404.91' }] } ] },
      Summary: { ColData: [{ value: 'Total Income' }, { value: '17,484,407.91' }] } },
    { Summary: { ColData: [{ value: 'Total Cost of Goods Sold' }, { value: '14,348,575.18' }] } },
    { Summary: { ColData: [{ value: 'Gross Profit' }, { value: '3,135,832.73' }] } },
    { Summary: { ColData: [{ value: 'Total Expenses' }, { value: '341,702.64' }] } },
    { Summary: { ColData: [{ value: 'Net Income' }, { value: '2,794,130.09' }] } },
] } };
const flat = books.flattenReport(report);
ck('a nested report is read down to every summary line', flat['Total Income'] === 17484407.91 && flat['Gross Profit'] === 3135832.73, flat);
ck('...thousands separators do not silently truncate the figure', flat['Total Cost of Goods Sold'] === 14348575.18, flat['Total Cost of Goods Sold']);
ck('...and a data row inside a section is read too', flat['Sales of Product Income'] === 17484404.91, flat);

// ── containers live in line descriptions, memos and private notes ──────────
ck('a container in a line description is found',
   books.containersIn({ Line: [{ Description: 'Auto cast MSCU3669357' }] }).join() === 'MSCU3669357');
ck('...in a private note too', books.containersIn({ PrivateNote: 'roll to KOCU4324560' }).join() === 'KOCU4324560');
ck('...several, without repeats', books.containersIn({ Line: [{ Description: 'TXGU8523095 TXGU8523095' }, { Description: 'CAIU9902327' }] }).length === 2);
ck('...and a number that is not a container is not one', books.containersIn({ Line: [{ Description: 'PO#4302973 25AQ02' }] }).length === 0);

// ── one document, shaped for the screen ────────────────────────────────────
const doc = books.shapeDoc({ Id: '38950', DocNumber: '251127 25AQ02', TxnDate: '2025-12-02', TotalAmt: 26173.44, Balance: 0,
    CustomerRef: { value: '523', name: 'ALQARYAN INTERNATIONAL' },
    Line: [{ Description: 'Copper MSCU3669357', Amount: 26173.44, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { name: 'Copper' } } },
           { DetailType: 'SubTotalLineDetail', Amount: 26173.44 }] }, 'CustomerRef', 'invoice');
ck('a document carries its number, party and money', doc.doc === '251127 25AQ02' && doc.party === 'ALQARYAN INTERNATIONAL' && doc.total === 26173.44, doc);
ck('...a settled document reads as zero open, not as unknown', doc.balance === 0, doc.balance);
ck('...the subtotal line is not shown as a line of its own', doc.lines.length === 1 && doc.lines[0].amount === 26173.44, doc.lines);
ck('...and the container comes with it', doc.containers.join() === 'MSCU3669357', doc.containers);
const noBal = books.shapeDoc({ Id: '1', TxnDate: '2026-01-01', TotalAmt: 10, VendorRef: { name: 'X' } }, 'VendorRef', 'payment');
ck('a document with no balance field says null, never 0', noBal.balance === null, noBal.balance);

// ── the read-only promise ──────────────────────────────────────────────────
// This file can be called from a web request. If it ever flipped the global
// write switch, a report could open the door for a push happening in the same
// second — so it must not contain the switch at all.
const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'books.js'), 'utf8');
ck('nothing here touches the global write switch', !/QB_PROD_WRITES\s*=/.test(src));
ck('...and nothing here POSTs to QuickBooks', !/request\(\s*'POST'/.test(src) && !/client\.request\('P/.test(src));
ck('a name with an apostrophe cannot break the query', /replace\(\/'\/g, "''"\)/.test(src));

console.log(`\nquickbooks-books: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
