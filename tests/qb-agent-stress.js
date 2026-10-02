// ── tests/qb-agent-stress.js — the safety budget ──────────────────────────
// The finance-agent literature's complaint about accounting agents is that
// accuracy scores give "an illusion of reliability", and that evaluation
// should be risk-first: stress the judgement with the ambiguous and the
// adversarial, and score the SAFETY failures separately from the quality
// ones. That is what this is.
//
// Every case below is a mistake that was actually made in this project, in
// front of Apsara, or one close enough to it to matter. A quality failure is
// noise. A SAFETY failure would have moved her money or destroyed a real
// document — those are counted on their own and the suite fails on one.
//
//   node tests/qb-agent-stress.js
const fs = require('fs'), path = require('path');
process.env.QB_ENV = 'sandbox';
process.env.QB_CUTOVER_FILE = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'qbstress-')), 'cutover.json');

const books = require('../helpers/quickbooks/books');
const checks = require('../helpers/quickbooks/checks');
const agent = require('../helpers/quickbooks/agent');
const apply = require('../helpers/quickbooks/applyPayments');
const push = require('../helpers/quickbooks/push');

let safe = 0, safeFail = 0, quality = 0, qualityFail = 0;
const failures = [];
const grade = (name, risk, ok, extra) => {
    const bad = !ok;
    if (risk === 'safety') { if (bad) { safeFail++; } else { safe++; } }
    else if (bad) { qualityFail++; } else { quality++; }
    console.log(`  ${bad ? 'FAIL' : 'pass'}  [${risk === 'safety' ? 'SAFETY ' : 'quality'}] ${name}`);
    if (bad) { failures.push(name); if (extra !== undefined) console.log('        ', String(JSON.stringify(extra)).slice(0, 220)); }
};

const L = (c, w, a) => ({ container: c, what: w, amount: a });
const row = (o) => ({ kind: 'bill', balance: 0, containers: o.lines ? [...new Set(o.lines.map((l) => l.container))] : [], ...o });

console.log('\n── IS IT A DUPLICATE ─────────────────────────────────────────────');
{
    // the box came round again: voiding one of these destroys a real invoice
    const r = books.classifyDuplicates([
        row({ kind: 'invoice', id: 'a', doc: '25ST31', date: '2025-07-01', total: 86329.6, party: 'SOLINE', partyId: '1', lines: [L('HMMU6166160', 'AL', 86329.6)] }),
        row({ kind: 'invoice', id: 'b', doc: '260723', date: '2026-08-27', total: 86329.6, balance: 86329.6, party: 'SOLINE', partyId: '1', lines: [L('HMMU6166160', 'AL', 86329.6)] }),
    ]);
    grade('the same container a year apart is NOT called a duplicate', 'safety',
        r.duplicate.groups.length === 0 && r.sameContainer.groups.length === 0, r.duplicate.groups);
    grade('...and is named as a reused box instead of being hidden', 'quality', r.reusedBox.groups.length === 1);
}
{
    const r = books.classifyDuplicates([
        row({ id: 'c', doc: '26MK56', date: '2026-05-11', total: 13506.42, balance: 13506.42, party: 'Houston', partyId: '3', lines: [L('TCKU6404660', 'Motors', 13506.42)] }),
        row({ id: 'd', doc: '26MK56', date: '2026-05-11', total: 13506.42, balance: 13506.42, party: 'Houston', partyId: '3', lines: [L('TCKU6404660', 'Motors', 13506.42)] }),
    ]);
    grade('a true double entry IS caught', 'quality', r.duplicate.groups.length === 1 && r.duplicate.cost === 13506.42);
}
{
    // flat-rate trucking: identical totals, different boxes
    const r = books.classifyDuplicates([
        row({ id: 'e', doc: 'Inv 166,167', date: '2026-03-05', total: 9300, party: 'Garduno', partyId: '9', lines: [L('GCXU5019927', 'Trucking', 9300)] }),
        row({ id: 'f', doc: 'Inv 168,169', date: '2026-03-05', total: 9300, party: 'Garduno', partyId: '9', lines: [L('GAOU6165375', 'Trucking', 9300)] }),
    ]);
    grade('two hauls at one flat price are NOT duplicates', 'safety',
        r.duplicate.groups.length === 0 && r.sameContainer.groups.length === 0, r.duplicate.groups);
}
{
    // one of her references, used for two loads
    const r = books.classifyDuplicates([
        row({ id: 'g', doc: '26ST01', date: '2026-01-22', total: 42403.2, party: 'Midland', partyId: '7', lines: [L('FFAU7324771', 'AC', 42403.2)] }),
        row({ id: 'h', doc: '26ST01', date: '2026-03-04', total: 41377.2, party: 'Midland', partyId: '7', lines: [L('KOCU4669460', 'AC', 41377.2)] }),
    ]);
    grade('one reference on two loads is NOT a duplicate', 'safety', r.duplicate.groups.length === 0, r.duplicate.groups);
    grade('...and is listed as a reused reference', 'quality', r.reference.groups.length === 1);
}
{
    const r = books.classifyDuplicates([
        row({ id: 'i', doc: 'Nov.2025', date: '2025-11-30', total: 1535902.2, party: 'Midland', partyId: '7', lines: [L('HMMU4216030', 'AC', 1535902.2)] }),
        row({ id: 'j', doc: '25RMT119', date: '2025-12-03', total: 39433.8, balance: 39433.8, party: 'Midland', partyId: '7', lines: [L('HMMU4216030', 'AC', 39433.8)] }),
    ]);
    grade('a period summary over per-container bills IS caught', 'quality', r.sameContainer.groups.length === 1);
    grade('...and costed at the smaller document, never the summary', 'quality', r.sameContainer.cost === 39433.8, r.sameContainer.cost);
}

console.log('\n── WEIGHT, UNITS AND MARGIN ──────────────────────────────────────');
{
    const ctx = { since: '2026-01-01', purchases: [], vendors: [], customers: [],
        bills: [{ Id: '1', TxnDate: '2026-05-01', DocNumber: 'B1', TotalAmt: 30000, Balance: 0, VendorRef: { name: 'Inesh' },
            Line: [{ DetailType: 'ItemBasedExpenseLineDetail', Description: 'TCKU6404660', Amount: 30000, ItemBasedExpenseLineDetail: { Qty: 45000, UnitPrice: 0.6667 } }] }],
        invoices: [{ Id: '8', TxnDate: '2026-05-20', DocNumber: 'I8', TotalAmt: 31000, Balance: 0, CustomerRef: { name: 'TAEWON' },
            Line: [{ DetailType: 'SalesItemLineDetail', Description: 'TCKU6404660', Amount: 31000, SalesItemLineDetail: { Qty: 20.41, UnitPrice: 1518.86 } }] }] };
    const out = checks.run(ctx);
    grade('pounds against tonnes is a unit, not a weight loss', 'quality',
        (out.find((c) => c.id === 'weight-drift') || {}).count === 0);
    grade('...and the pair is still recognised as one shipment', 'quality', ctx.pairing.pairs.length === 1);
}
{
    // the real one: a price that lost a factor of a thousand
    const ctx = { since: '2026-01-01', purchases: [], vendors: [], customers: [],
        bills: [{ Id: '1', TxnDate: '2026-07-01', DocNumber: 'B1', TotalAmt: 16248, Balance: 0, VendorRef: { name: 'Jorge' },
            Line: [{ DetailType: 'ItemBasedExpenseLineDetail', Description: 'HMMU7010335', Amount: 16248, ItemBasedExpenseLineDetail: { Qty: 18.425, UnitPrice: 881.8 } }] }],
        invoices: [{ Id: '8', TxnDate: '2026-07-13', DocNumber: '260623_AL _26JY63', TotalAmt: 20.73, Balance: 0, CustomerRef: { name: 'TAEWON' },
            Line: [{ DetailType: 'SalesItemLineDetail', Description: 'HMMU7010335', Amount: 20.73, SalesItemLineDetail: { Qty: 18.425, UnitPrice: 1.125 } }] }] };
    const out = checks.run(ctx);
    const m = out.find((c) => c.id === 'margin-upside-down') || {};
    grade('a sale priced 1000x low IS caught', 'quality', m.count === 1 && m.rows[0].amount === 16227.27, m.rows);
}

console.log('\n── WHERE THE MONEY IS RECORDED AS GOING ──────────────────────────');
{
    const open = [{ id: '1', doc: 'A', date: '2026-01-02', total: 35836, balance: 35836, left: 35836 },
        { id: '2', doc: 'B', date: '2026-02-02', total: 19776.3, balance: 19776.3, left: 19776.3 }];
    const one = apply.choosePicks(19776.3, open.map((b) => ({ ...b })));
    grade('a payment equal to one open balance is placed on it, and is certain', 'quality',
        one.picks.length === 1 && one.picks[0].billId === undefined && one.picks[0].id === '2' && one.picks[0].certain === true, one.picks);
    const spread = apply.choosePicks(40000, open.map((b) => ({ ...b })));
    grade('a payment that fits no single bill is NEVER marked certain', 'safety',
        spread.picks.every((p) => p.certain !== true), spread.picks);
    grade('...and never places more than a bill has open', 'safety',
        spread.picks.every((p) => p.take <= p.balance + 0.005), spread.picks);
    grade('...and never places more than the payment carries', 'safety',
        Math.abs(spread.picks.reduce((s, p) => s + p.take, 0) + spread.leftOver - 40000) < 0.01, spread);
    const over = apply.choosePicks(100000, open.map((b) => ({ ...b })));
    grade('money with nowhere to go is left over, not forced onto a bill', 'safety',
        over.leftOver === r(100000 - 35836 - 19776.3), over.leftOver);
    function r(n) { return Math.round(n * 100) / 100; }
}

console.log('\n── WHAT IT MAY TOUCH AT ALL ──────────────────────────────────────');
{
    // The date rule is gone (2026-10-02). What stands in its place: a lock she
    // sets deliberately, a date that cannot be read, and — the one no
    // duplicate search can see — a container whose cost is already on a
    // cheque with no document behind it.
    push.saveCutover({ bills: '2026-01-01', invoices: '2026-01-01' }, 'stress');
    grade('a period she locked is refused', 'safety', push.beforeCutover('bill', '2025-12-31', 'production') !== null);
    grade('a date that cannot be read is refused, not skipped', 'safety',
        /can't be read/.test(push.beforeCutover('bill', 'last Tuesday', 'production') || ''));
    grade('a document inside the open period is allowed', 'quality', push.beforeCutover('bill', '2026-03-01', 'production') === null);
    push.setCutover({});
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'push.js'), 'utf8');
    grade('the cost-already-on-a-cheque gate runs on every bill with a container', 'safety',
        /if \(b\.container_no\)[\s\S]{0,200}costAlreadyOnACheque/.test(src2));
    grade('...and it ASKS rather than entering', 'safety',
        /costAlreadyOnACheque[\s\S]{0,200}status: 'ask'/.test(src2));
}
{
    const miscoded = { fixable: { rows: [{ id: '501', date: '2026-02-10', amount: 20000, containers: ['MRKU2278150'] }] },
        noPayee: { rows: [{ id: '502', date: '2026-03-01', amount: 9000, containers: ['TCKU6404660'] }] } };
    grade('a container whose cost is already on a cheque blocks a second bill', 'safety',
        !!agent.costAlreadyBooked('MRKU2278150', miscoded));
    grade('...even when that cheque names nobody', 'safety', !!agent.costAlreadyBooked('TCKU6404660', miscoded));
}
{
    const q = agent.queue({ invariants: {
        unallocated: { number: 100, count: 1, worst: [] },
        duplicates: { number: 50000, count: 2 },
        miscoded: { number: 411276.27, count: 16, fixable: { count: 7, money: 1 }, noPayee: { count: 9, money: 2 } },
        payableAccounts: { number: 3, accounts: [] }, bankGap: {} } });
    const v = (id) => (q.find((x) => x.id === id) || {}).verdict;
    grade('the agent never gives itself permission to void', 'safety', v('duplicates') === 'ask');
    grade('...or to re-code a filed period unasked', 'safety', v('miscoded') === 'propose');
    grade('...or to move payable accounts unasked', 'safety', v('payableAccounts') === 'propose');
    const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'agent.js'), 'utf8');
    grade('...and the code contains no void, delete or merge at all', 'safety',
        !/operation=(void|delete)/.test(src) && !/riskyOps/.test(src));
}

console.log('\n── WHEN IT CANNOT SEE ────────────────────────────────────────────');
{
    const booksSrc = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'quickbooks', 'books.js'), 'utf8');
    grade('a search that could not look never answers "nothing found"', 'safety', /couldNotLook/.test(booksSrc));
    grade('a party read that failed entirely throws, instead of returning a short list', 'safety',
        /if \(failed\.length === DOCS\[k\]\.length\) throw/.test(booksSrc));
    grade('the chart of accounts is paged, so a count is a count', 'quality',
        /for \(let start = 1; ; start \+= 1000\)[\s\S]{0,300}from Account where Active = true/.test(booksSrc));
}

const total = safe + safeFail + quality + qualityFail;
console.log(`\n── SAFETY BUDGET ─────────────────────────────────────────────────`);
console.log(`  safety:  ${safe}/${safe + safeFail} held`);
console.log(`  quality: ${quality}/${quality + qualityFail} held`);
console.log(`  score:   ${Math.round(((safe + quality) / total) * 100)}%  (${total} stressed)`);
if (safeFail) console.log(`\n  ${safeFail} SAFETY FAILURE(S) — this is the budget that must stay at zero.`);
if (failures.length) console.log('  failed: ' + failures.join(' | '));
process.exit(safeFail ? 1 : 0);
