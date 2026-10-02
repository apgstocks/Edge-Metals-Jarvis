// tests/quickbooks-agent.js — QB Agent.
// Apsara, 2026-10-02: "auto resolves discrepancy … whose only job is to make
// qb perfect." Perfect is not "nothing open" — some bills are genuinely
// unpaid. Perfect is a list of invariants, each with a number that should be
// zero, and an honest answer about which ones the agent may close itself.
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
let pass = 0, fail = 0; const failures = [];
const ck = (n, ok, extra) => { if (ok) { pass++; console.log('  PASS ', n); } else { fail++; failures.push(n); console.log('  FAIL ', n, extra === undefined ? '' : String(JSON.stringify(extra)).slice(0, 220)); } };

const agent = require('../helpers/quickbooks/agent');

// ── the invariants are data, and honest about who can close them ──────────
ck('every invariant says what correct means and who can get there',
   agent.INVARIANTS.length > 0 && agent.INVARIANTS.every((i) => i.id && i.title && i.who && i.why), agent.INVARIANTS);
ck('the bank gap is marked blocked, not pending — no app can read that queue',
   (agent.INVARIANTS.find((i) => i.id === 'bankGap') || {}).who === 'blocked');
ck('duplicates are hers, because a void cannot be undone',
   (agent.INVARIANTS.find((i) => i.id === 'duplicates') || {}).who === 'her');
ck('re-coding and merging payables are proposals, never silent writes',
   ['miscoded', 'payableAccounts'].every((id) => (agent.INVARIANTS.find((i) => i.id === id) || {}).who === 'proposal'));

// ── the queue: only reversible AND certain work is `do` ───────────────────
const surveyed = {
    year: 2026, invariants: {
        unallocated: { number: 4982800.77, count: 130, worst: [{ party: 'Midland', amount: 2186938.2 }] },
        duplicates: { number: 194857.29, count: 10 },
        miscoded: { number: 411276.27, count: 16, fixable: { count: 7, money: 145757.93 }, noPayee: { count: 9, money: 265518.34 } },
        payableAccounts: { number: 3, accounts: [{ name: 'Accounts Payable', balance: -57224.15 }, { name: 'Vendor Payable', balance: -5154868.75 }] },
        bankGap: { number: null, banks: [] },
    },
};
const q = agent.queue(surveyed);
const by = (id) => q.find((x) => x.id === id) || {};
ck('placing loose payments is the one thing it does alone', by('allocate').verdict === 'do', by('allocate'));
ck('...and it says plainly that no money moves', /No money moves/.test(by('allocate').note || ''));
ck('duplicates are asked, never voided', by('duplicates').verdict === 'ask');
ck('miscoded cheques are proposed, with the profit warning', by('miscoded').verdict === 'propose'
   && /reported profit/.test(by('miscoded').note || ''), by('miscoded'));
ck('...and the ones with no payee are counted separately, never guessed',
   /9 have none/.test(by('miscoded').detail || ''), by('miscoded').detail);
ck('two payable accounts are proposed, and the API refusal is named',
   by('payableAccounts').verdict === 'propose' && /refuses an account merge/.test(by('payableAccounts').note || ''));
ck('the bank queue is listed as blocked, with the way in', by('bankGap').verdict === 'blocked'
   && /Banking screen/.test(by('bankGap').note || ''));
ck('the queue is biggest money first', q.filter((x) => x.money).every((x, i, a) => !i || a[i - 1].money >= x.money));

// ── cost already booked without a bill ────────────────────────────────────
// The one case the ordinary duplicate check cannot see: no document exists,
// so nothing is found, and a new bill doubles the cost.
const miscoded = { fixable: { rows: [{ id: '501', date: '2026-02-10', amount: 20000, containers: ['MRKU2278150'] }] },
    noPayee: { rows: [{ id: '502', date: '2026-03-01', amount: 9000, containers: ['TCKU6404660'] }] } };
ck('a container whose cost is already on a cheque is caught',
   /count it twice/.test((agent.costAlreadyBooked('MRKU2278150', miscoded) || {}).why || ''));
ck('...including one on a cheque with no payee', !!agent.costAlreadyBooked('TCKU6404660', miscoded));
ck('...and a container with no cheque behind it is clear', agent.costAlreadyBooked('HMMU1234567', miscoded) === null);

// ── the shape of the run ──────────────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'agent.js'), 'utf8');
ck('only `do` items are ever executed', /if \(item\.verdict !== 'do'\)/.test(src));
ck('the run is dry unless told otherwise', /dryRun: !really/.test(src));
ck('nothing in the agent voids, deletes or merges',
   !/riskyOps/.test(src) && !/operation=void/.test(src) && !/operation=delete/.test(src));
const routes = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'routes.js'), 'utf8');
ck('letting the agent write needs RUN typed', /!== 'RUN'/.test(routes));
ck('the survey itself is open — reading the scoreboard needs no padlock',
   /app\.get\('\/api\/qb\/agent'/.test(routes));

// ── the account read that was silently truncated ──────────────────────────
const booksSrc = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'books.js'), 'utf8');
ck('the chart of accounts is paged, not cut off at a hundred',
   /startposition \$\{start\} maxresults 1000`, \{ env \}\);[\s\S]{0,200}Account \|\| \[\]/.test(booksSrc) || /for \(let start = 1; ; start \+= 1000\)[\s\S]{0,300}from Account where Active = true/.test(booksSrc));

console.log(`\nquickbooks-agent: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
