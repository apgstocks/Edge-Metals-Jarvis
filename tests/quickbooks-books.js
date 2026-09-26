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

// ── what she owes is a BALANCE, not a sum of documents (2026-09-26) ────────
// Apsara, at a $10.7M figure for what she owes: "What thr hell?" Summing
// bills with a balance double-counts every prepayment already sitting on the
// vendor. These pin the shape that keeps the two apart.
const os = require('os');
{
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'books.js'), 'utf8');
    ck('the overview asks QuickBooks for the vendor and customer balances', /partyBalances/.test(src2) && /owe:/.test(src2));
    ck('...and reports the unapplied gap rather than hiding it', /unapplied:/.test(src2));
    ck('open items are scoped to the year she asked for', /openItems\(env, \{ year: y \}\)/.test(src2));
    ck('...and anything older is counted and named, not dropped', /older: \{ count: older\.length/.test(src2));
}

// ── WHAT COUNTS AS A DUPLICATE (2026-09-26) ───────────────────────────────
// Apsara, shown the first list of them: "how they are duplicate? No.."
// She was right. The first version keyed on the document number and the
// amount, and on her books neither identifies anything: a reference is reused
// across loads, and a flat trucking rate repeats all day. The container is
// what identifies a line, so that is what these pin.
{
    const L = (c, w, a) => ({ container: c, what: w, amount: a });
    const rows = [
        // a real duplicate: same container, same grade, same money, twice
        { kind: 'bill', id: '5', doc: '26MK56', date: '2026-05-11', total: 13506.42, balance: 13506.42, party: 'Houston', partyId: '3', containers: ['TCKU6404660'], lines: [L('TCKU6404660', 'Motors', 13506.42)] },
        { kind: 'bill', id: '6', doc: '26MK56', date: '2026-05-11', total: 13506.42, balance: 13506.42, party: 'Houston', partyId: '3', containers: ['TCKU6404660'], lines: [L('TCKU6404660', 'Motors', 13506.42)] },
        // a period summary entered alongside the per-container bill
        { kind: 'bill', id: '1', doc: 'Nov.2025', date: '2025-11-30', total: 1535902.2, balance: 0, party: 'Midland', partyId: '7', containers: ['HMMU4216030'], lines: [L('HMMU4216030', 'AUTO CAST', 1535902.2)] },
        { kind: 'bill', id: '2', doc: '25RMT119', date: '2025-12-03', total: 39433.8, balance: 39433.8, party: 'Midland', partyId: '7', containers: ['HMMU4216030'], lines: [L('HMMU4216030', 'AUTO CAST', 39433.8)] },
        // two trucking bills, same day, same flat price, DIFFERENT containers
        { kind: 'bill', id: '3', doc: 'Inv 166,167', date: '2026-03-05', total: 9300, balance: 0, party: 'Garduno', partyId: '9', containers: ['GCXU5019927'], lines: [L('GCXU5019927', 'Trucking', 9300)] },
        { kind: 'bill', id: '4', doc: 'Inv 168,169', date: '2026-03-05', total: 9300, balance: 0, party: 'Garduno', partyId: '9', containers: ['GAOU6165375'], lines: [L('GAOU6165375', 'Trucking', 9300)] },
        // one reference, two loads — her numbering, not a duplicate
        { kind: 'bill', id: '7', doc: '26ST01', date: '2026-01-22', total: 42403.2, balance: 42403.2, party: 'Mid2', partyId: '8', containers: ['FFAU7324771'], lines: [L('FFAU7324771', 'AUTO CAST', 42403.2)] },
        { kind: 'bill', id: '8', doc: '26ST01', date: '2026-03-04', total: 41377.2, balance: 41377.2, party: 'Mid2', partyId: '8', containers: ['KOCU4669460'], lines: [L('KOCU4669460', 'AUTO CAST', 41377.2)] },
    ];
    const r = books.classifyDuplicates(rows);
    ck('the same container for the same money twice IS a duplicate',
       r.duplicate.groups.length === 1 && r.duplicate.cost === 13506.42, r.duplicate);
    ck('two trucking bills at the same flat price on one day are NOT',
       !r.duplicate.groups.some((g) => g.party === 'Garduno') && !r.sameContainer.groups.some((g) => g.party === 'Garduno'), r.sameContainer.groups);
    ck('one reference used for two different loads is NOT a duplicate',
       !r.duplicate.groups.some((g) => g.party === 'Mid2') && r.reference.groups.some((g) => g.party === 'Mid2'), r.reference.groups);
    ck('a period summary beside the per-container bill IS caught',
       r.sameContainer.groups.length === 1 && r.sameContainer.groups[0].party === 'Midland', r.sameContainer.groups);
    ck('...and is marked as a summary, which is the shape the real problem took',
       r.sameContainer.summaries === 1 && r.sameContainer.groups[0].summary === true);
    ck('...costed at the SMALLER document, never the summary',
       r.sameContainer.cost === 39433.8, r.sameContainer.cost);
    const src3 = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'books.js'), 'utf8');
    ck('containers for this come from the LINES, never the memo', /r\.lines\.map\(\(l\) => l\.container\)/.test(src3));
}

console.log(`\nquickbooks-books: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
