// tests/qb-snapshot.js — her books, on disk, for the question channel.
//
// Apsara picked the WhatsApp question channel (2026-10-05) over three other
// builds. Until this, "how much do we owe Inesh" on her phone was answered
// from JARVIS's bills ledger — and QuickBooks is the system of record. The two
// disagree on purpose: QuickBooks holds entries her accountant made by hand,
// $4,982,800.77 of payments recorded against no bill, and the 2026 duplicates.
// A confident figure from the wrong book is how she quotes a supplier wrong.
//
// It reads a SNAPSHOT FILE, never the API: a phone cannot wait for 610 bills,
// and must still get an answer when the token is mid-refresh.
const fs = require('fs'), path = require('path'), os = require('os');
process.env.QB_ENV = 'sandbox';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qbsnap-'));
process.env.QB_SNAPSHOT_FILE = path.join(tmp, 'snap.json');
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 240)); } };

const snap = require('../helpers/quickbooks/snapshot');
const catalog = require('../helpers/data/dataCatalog');
const mirror = require('../helpers/data/dataMirror');
const engine = require('../helpers/data/sqlEngine');

// ── with no snapshot at all ───────────────────────────────────────────────
// "You owe nothing" is the dangerous answer here. It must say it has not read
// the books.
ck('with no snapshot, read() is null not an empty shell', snap.read() === null);
ck('...and the age is null, not zero', snap.ageMinutes() === null);
const empty = mirror.ensure({ force: true });
const q0 = (sql) => { const r = engine.query(empty.file, sql); return (r && r.rows) ? r.rows : r; };
ck('...the qb tables still EXIST, so a question gets an answer not a crash',
   empty.counts.qb_bills === 0 && empty.counts.qb_suppliers === 0 && empty.counts.qb_books === 1, empty.counts);
const books0 = q0('SELECT as_of, minutes_old, owe FROM qb_books')[0];
ck('...and qb_books says as_of is NULL, which is how a reply can say "never read"',
   books0.as_of === null && books0.minutes_old === null && books0.owe === null, books0);

// ── a snapshot on disk ────────────────────────────────────────────────────
const AT = new Date(Date.now() - 90 * 60000).toISOString();
fs.writeFileSync(process.env.QB_SNAPSHOT_FILE, JSON.stringify({
    at: AT, env: 'production', since: '2026-01-01',
    bills: [
        { qb_id: '1', doc_no: 'MID-1', date: '2026-03-01', supplier: 'Midland Metals', container_no: 'HMMU7010335', containers: 1, total: 16248, balance: 16248, payable_account: 'Vendor Payable', paid_by: 0 },
        { qb_id: '2', doc_no: 'MID-2', date: '2026-03-02', supplier: 'Midland Metals', container_no: 'TRHU1969614', containers: 1, total: 20000, balance: 0, payable_account: 'Vendor Payable', paid_by: 1 },
        { qb_id: '3', doc_no: 'FEE', date: '2026-03-03', supplier: 'Bank', container_no: null, containers: 0, total: 50, balance: 50, payable_account: 'Accounts Payable', paid_by: 0 },
    ],
    invoices: [
        { qb_id: '9', doc_no: '38868', date: '2026-04-01', customer: 'TAEWON PRECEISION', container_no: 'HMMU7010335', containers: 1, total: 20.73, balance: 0, due: '2026-05-01' },
        { qb_id: '10', doc_no: '38900', date: '2026-04-02', customer: 'SOLINE', container_no: 'TRHU1969614', containers: 1, total: 25000, balance: 25000, due: '2026-05-02' },
    ],
    suppliers: [
        { name: 'Midland Metals', balance: 1000, unapplied_paid: 2186938.2, active: true },
        { name: 'Inesh Cores Chapin', balance: 60000, unapplied_paid: 0, active: true },
    ],
    customers: [
        { name: 'TAEWON AUTOMOTIVE CO', balance: 0, unapplied_received: 27099.79, active: true },
        { name: 'TAEWON PRECEISION', balance: 27099.79, unapplied_received: 0, active: true },
        { name: 'SOLINE', balance: 25000, unapplied_received: 0, active: true },
    ],
    totals: { owe: 61000, owed: 52099.58, unapplied_paid: 2186938.2, unapplied_received: 27099.79, bills: 3, invoices: 2, over_applied: 0 },
    over_applied: [],
}));
mirror.invalidate();
const built = mirror.ensure({ force: true });
const q = (sql) => { const r = engine.query(built.file, sql); return (r && r.rows) ? r.rows : r; };

ck('the snapshot is read back', !!snap.read() && snap.read().env === 'production');
ck('its age is reported in minutes, so an answer can say how stale it is',
   snap.ageMinutes() >= 89 && snap.ageMinutes() <= 91, snap.ageMinutes());
ck('the mirror loads every qb table',
   built.counts.qb_bills === 3 && built.counts.qb_invoices === 2 && built.counts.qb_suppliers === 2 && built.counts.qb_customers === 3, built.counts);

// ── THE $10.7M LESSON, AS A TEST ──────────────────────────────────────────
// Adding up open bills gave $10.7M when the real figure was $5.3M, because
// payments recorded against no bill leave the bills they paid reading open.
const bySupplier = q('SELECT ROUND(SUM(balance), 2) AS owed FROM qb_suppliers')[0].owed;
const byBill = q('SELECT ROUND(SUM(balance), 2) AS owed FROM qb_bills')[0].owed;
ck('the two ways of totalling what she owes DO disagree, as on her real books',
   bySupplier !== byBill, { bySupplier, byBill });
ck('...and the party balance is the smaller, correct one', bySupplier === 61000, bySupplier);
// The annotated schema is the single biggest accuracy lever in text-to-SQL,
// so the trap is written into the catalog the model is handed — not left in a
// comment somewhere.
// askData.js sends three blocks: schemaText(picked tables), DEFINITIONS and
// GOTCHAS. The trap belongs in the blocks the model is actually handed, so
// this checks all three the way askData assembles them — a warning that lives
// only in a source comment is decoration.
const prompt = [catalog.schemaText(catalog.tableNames()),
    catalog.DEFINITIONS.join('\n'), catalog.GOTCHAS.join('\n')].join('\n');
ck('the catalog tells the model which one to use, in the words of the incident',
   /NEVER answer "what do we owe" by adding up qb_bills\.balance/.test(prompt));
ck('...and it states the real figures, so the warning is not abstract',
   /\$10\.7M/.test(prompt) && /\$5\.3M/.test(prompt));
ck('...and warns that a snapshot is not live', /qb_books\.minutes_old/.test(prompt));
ck('...and that the two books use different names for the same party',
   /TAEWON AUTOMOTIVE CO/.test(prompt));
ck('...and that a container only identifies a load for about 120 days',
   /120 days/.test(prompt));
ck('her own vocabulary routes to the right table', /qb_suppliers\.balance/.test(catalog.DEFINITIONS.join(' ')));
ck('the qb tables are all described, so the mirror and the schema cannot drift',
   ['qb_bills', 'qb_invoices', 'qb_suppliers', 'qb_customers', 'qb_books'].every((t) => catalog.find(t)));

// ── the questions she actually asks ───────────────────────────────────────
const owe = q("SELECT name, ROUND(balance, 2) AS owed, ROUND(unapplied_paid, 2) AS unmatched FROM qb_suppliers WHERE lower(name) LIKE '%inesh%'")[0];
ck('"how much do we owe Inesh" answers from her books', owe && owe.owed === 60000, owe);
const midland = q("SELECT ROUND(balance,2) AS owed, ROUND(unapplied_paid,2) AS unmatched FROM qb_suppliers WHERE name = 'Midland Metals'")[0];
ck('...and a supplier with money paid-but-unmatched carries that figure alongside',
   midland.owed === 1000 && midland.unmatched === 2186938.2, midland);

// has TAEWON paid — the balance alone is a trap: the money is on the other record
const taewon = q("SELECT name, ROUND(balance,2) AS owes, ROUND(unapplied_received,2) AS paid_unmatched FROM qb_customers WHERE lower(name) LIKE '%taewon%' ORDER BY name");
ck('"has Taewon paid" surfaces BOTH records, not one', taewon.length === 2, taewon);
ck('...showing the debt on one and the unmatched money on the other',
   taewon.some((r) => r.owes > 0 && r.paid_unmatched === 0) && taewon.some((r) => r.owes === 0 && r.paid_unmatched > 0), taewon);

// ── the question QuickBooks itself cannot answer ──────────────────────────
const perContainer = q("SELECT b.container_no, ROUND(SUM(b.total),2) AS cost, (SELECT ROUND(SUM(i.total),2) FROM qb_invoices i WHERE i.container_no = b.container_no) AS revenue FROM qb_bills b WHERE b.container_no IS NOT NULL GROUP BY b.container_no ORDER BY b.container_no");
ck('cost and revenue join on the container — the thing QuickBooks has no concept of',
   perContainer.length === 2, perContainer);
const bad = perContainer.find((r) => r.container_no === 'HMMU7010335');
ck('...and it finds the invoice priced 1000x under its cost ($20.73 against $16,248)',
   bad && bad.cost === 16248 && bad.revenue === 20.73, bad);
ck('a fee bill with no container is left out of the join, not counted as a loss',
   !perContainer.some((r) => r.container_no === null));

const notSold = q("SELECT COUNT(DISTINCT container_no) AS n FROM qb_bills b WHERE b.container_no IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qb_invoices i WHERE i.container_no = b.container_no)")[0];
ck('bought-but-not-invoiced is answerable', notSold.n === 0, notSold);

// ── staleness must move the mirror ────────────────────────────────────────
const sigBefore = mirror.signature();
fs.writeFileSync(process.env.QB_SNAPSHOT_FILE, JSON.stringify({ ...JSON.parse(fs.readFileSync(process.env.QB_SNAPSHOT_FILE, 'utf8')), at: new Date().toISOString() }));
ck('rewriting the snapshot changes the mirror signature, so it rebuilds',
   mirror.signature() !== sigBefore, { sigBefore, now: mirror.signature() });

// ── the over-applied clamp ────────────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'snapshot.js'), 'utf8');
ck('a document applied beyond its own value cannot make unapplied money NEGATIVE',
   /Math\.max\(0, raw\)/.test(src));
ck('...and it is counted rather than hidden', /over_applied/.test(src) && /overApplied\.push/.test(src));
ck('containers are read from the LINES, never the memo', /read from the bill LINES|Line \|\| \[\]/.test(src) && !/PrivateNote/.test(src));
ck('the snapshot is written by the nightly run, best-effort',
   /snapshot'\)\.write/.test(fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooksNightly.js'), 'utf8')));
ck('...and the night says so, or says it failed',
   /question channel/.test(fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooksNightly.js'), 'utf8')));
ck('the router knows money questions come from QuickBooks',
   /answered from QuickBooks, which is the system of record/.test(fs.readFileSync(path.join(__dirname, '..', 'workflow', 'brain.js'), 'utf8')));

// ── ADDING THESE TABLES TURNED SCHEMA PRUNING ON ──────────────────────────
// schemaPick has a FULL_BELOW of 14: under that many tables it returns the
// whole catalog and is a no-op, which is all it has ever done. These five
// tables took the catalog from 11 to 16, so from today a question is sent a
// SUBSET — and a subset missing the one table the answer needed is worse than
// no pruning at all. That switch-on was a side effect of this change, not a
// decision, so every question she actually asks is pinned here.
//
// "is quickbooks up to date" failed on the first run: its words reached four
// tables that merely mention QuickBooks and lost the tie-break. Fixed the way
// the file intends — a DEFINITIONS line mapping her vocabulary to the table —
// not by special-casing the scorer.
const schemaPick = require('../helpers/data/schemaPick');
ck('the catalog is now past FULL_BELOW, so pruning really is live',
   catalog.tableNames().length > 14, catalog.tableNames().length);
const MUST_REACH = [
    ['how much do we owe Inesh', 'qb_suppliers'],
    ['what do we owe altogether', 'qb_books'],
    ['who owes us money', 'qb_customers'],
    ['has Taewon paid', 'qb_customers'],
    ['what did we make on HMMU7010335', 'qb_bills'],
    ['which bills are still open in quickbooks', 'qb_bills'],
    ['is quickbooks up to date', 'qb_books'],
    ['when was quickbooks last read', 'qb_books'],
    ['how much have we paid that is not matched', 'qb_suppliers'],
    // the questions that already worked and must not regress
    ['how many containers did we load in August', 'bills'],
    ['what was our margin in August', 'margin'],
    ['what did we pay Sher Trucking last month', 'trucking_bills'],
    ['which bills are not finished', 'bills'],
    ['what is in edge inventory', 'edge_inventory'],
    ['what documents do we have for KOCU4930737', 'documents'],
    ['what came in this month', 'sales_receipts'],
    ['what are we paying per pound for aluminium combo', 'bill_items'],
    ['which bookings are open', 'bookings'],
    ['which containers lost money', 'margin'],
    ['what did we spend last month', 'bills'],
];
const missed = MUST_REACH.filter(([q, need]) => !schemaPick.pick(q, catalog).includes(need));
ck(`every one of ${MUST_REACH.length} real questions still reaches the table its answer needs`,
   missed.length === 0, missed.map(([q, n]) => `${q} -> ${n}`));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\nqb-snapshot: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
