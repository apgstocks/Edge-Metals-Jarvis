// ── tests/schema-pick.js ──────────────────────────────────────────────────
// Apsara, 2026-09-24: "Make jarvis knowledgeale of all edge metal data" —
// "Leave Edge Yard data.Except Edge Yard data everythig else".
//
// Widening the catalog is only safe if the prompt stops carrying every table.
// The published work on natural-language-to-SQL is consistent that schema
// linking is the main driver of wrong SQL and that irrelevant tables actively
// distract the model — so helpers/data/schemaPick.js prunes.
//
// A pruner has exactly one way to be dangerous: dropping a table the answer
// needed. Section B is that check, and it uses HER OWN worked examples as the
// oracle — every table the gold SQL touches must survive the pruning. That is
// recall measured against real questions rather than against my opinion of
// what the pruner should do.
//
// Section A is the other half: today it must change NOTHING.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const catalog = require(path.join(ROOT, 'helpers/data/dataCatalog'));
const yardCatalog = require(path.join(ROOT, 'helpers/data/yardCatalog'));
const books = require(path.join(ROOT, 'helpers/data/books'));
const pickmod = require(path.join(ROOT, 'helpers/data/schemaPick'));

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// Which tables a query actually reads. Matched as whole words so `bills` does
// not also claim `trucking_bills` — longest names first for the same reason.
function tablesIn(sql, names) {
    const s = String(sql || '').toLowerCase();
    const found = new Set();
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
        if (new RegExp(`(^|[^a-z0-9_])${n.toLowerCase()}([^a-z0-9_]|$)`).test(s)) found.add(n);
    }
    return [...found];
}

// ── A — PRUNING IS LIVE NOW, AND THAT HAPPENED BY ACCIDENT ────────────────
// This section used to assert the opposite: "at today's size it changes
// nothing", because the metals catalog had 11 tables against a FULL_BELOW of
// 14 and the pruner was a deliberate no-op.
//
// On 2026-10-05 the five QuickBooks tables (qb_bills, qb_invoices,
// qb_suppliers, qb_customers, qb_books) took it to 16, past the threshold. So
// from that day a question is sent a SUBSET of the schema for the first time
// — a behaviour change to every question she asks, arrived at as a side
// effect of widening the catalog rather than as a decision.
//
// The old assertions are kept as history in this comment and replaced with
// what has to hold now. Section B's forced-on tests were already the real
// coverage; this section's job is the live default.
section('A — the catalog has outgrown the threshold, so pruning is LIVE');
{
    const all = catalog.tableNames();
    ck(`the metals catalog has ${all.length} tables, at or past the ${pickmod.FULL_BELOW} threshold`,
        all.length >= pickmod.FULL_BELOW, `${all.length} vs ${pickmod.FULL_BELOW}`);

    // THE PROPERTY THAT MATTERS. A smaller schema is worthless if it dropped
    // the one table the answer needed — that is worse than no pruning at all,
    // because the model cannot write the right query and does not know why.
    const NEEDS = [
        ['how much do we owe Inesh', 'qb_suppliers'],
        ['which bills are unfinished', 'bills'],
        ['margin on KOCU4930737', 'margin'],
        ['what did we sell to MK Trading in August', 'sales'],
        ['show me trucking', 'trucking_bills'],
        ['who owes us money', 'qb_customers'],
        ['is quickbooks up to date', 'qb_books'],
        ['what did we make on HMMU7010335', 'qb_bills'],
    ];
    for (const [q, need] of NEEDS) {
        ck(`  "${q}" keeps ${need}`, pickmod.pick(q, catalog).includes(need),
            pickmod.pick(q, catalog).join(','));
    }

    // AND IT MUST STILL FAIL OPEN. A question it cannot read is the case that
    // has to send everything, not the case that sends its best guess.
    for (const q of ['', '   ', 'hmm', 'what about that thing']) {
        const got = pickmod.pick(q, catalog);
        ck(`  "${q || '(empty)'}" falls back to every table`,
            got.length === all.length, `${got.length}/${all.length}`);
    }

    // The yard catalog is still small, so Scout's side is genuinely unchanged
    // — which is the control that proves the switch above is about size and
    // not about something else that moved.
    const y = yardCatalog.tableNames();
    ck(`the yard catalog (${y.length}) is still under the threshold and untouched`,
        y.length < pickmod.FULL_BELOW
        && pickmod.pick('how much do we owe sellers', yardCatalog).length === y.length);
}

section('B — with pruning FORCED ON, her real questions keep what they need');
{
    // fullBelow: 0 makes the pruner engage at any size, which is how the
    // catalog will behave once it is widened. Every example in books.js is a
    // question she actually asks, with the query it means.
    const force = { fullBelow: 0 };
    const all = catalog.tableNames();
    let worstDrop = null;
    for (const ex of books.BOOKS.metals.examples) {
        const needed = tablesIn(ex.sql, all);
        const got = pickmod.pick(ex.q, catalog, force);
        const missing = needed.filter((t) => !got.includes(t));
        if (missing.length && !worstDrop) worstDrop = `${ex.q} -> missing ${missing.join(', ')}`;
        ck(`  "${ex.q}" keeps ${needed.join(', ') || '(none)'}`,
            missing.length === 0, `got ${got.join(', ')}`);
    }
    ck('NO worked example loses a table it needs', worstDrop === null, worstDrop || '');

    // The same for the yard book, since the pruner is shared.
    for (const ex of books.BOOKS.yard.examples) {
        const names = yardCatalog.tableNames();
        const needed = tablesIn(ex.sql, names);
        const got = pickmod.pick(ex.q, yardCatalog, force);
        ck(`  yard: "${ex.q}" keeps what it needs`,
            needed.every((t) => got.includes(t)), `needed ${needed.join(', ')} | got ${got.join(', ')}`);
    }
}

section('C — and it actually prunes when it can');
{
    // Forced on, a pointed question should NOT come back with the whole
    // catalog — otherwise this file is decoration. Recall is checked above;
    // this is the other side of the trade.
    const force = { fullBelow: 0 };
    const all = catalog.tableNames();
    const pointed = pickmod.pick('how much do we owe Inesh', catalog, force);
    ck('a pointed question drops at least one table',
        pointed.length < all.length, `${pointed.length}/${all.length}: ${pointed.join(', ')}`);
    ck('  and keeps bills, which is where the balance lives', pointed.includes('bills'));
}

section('D — it fails OPEN, never closed');
{
    // The dangerous failure is a confident wrong subset. Every uncertain
    // input must come back with everything.
    const force = { fullBelow: 0 };
    const all = catalog.tableNames().length;
    for (const [label, q] of [['empty', ''], ['whitespace', '   '],
                              ['only stop words', 'how much is the total of it all'],
                              ['nothing in the schema', 'qwertyuiop zxcvbnm'],
                              ['null', null]]) {
        ck(`  ${label} -> every table`, pickmod.pick(q, catalog, force).length === all,
            String(pickmod.pick(q, catalog, force).length));
    }
}

section('E — the prompt really is smaller');
{
    const force = { fullBelow: 0 };
    const full = catalog.schemaText(catalog.tableNames()).length;
    const cut = catalog.schemaText(pickmod.pick('how much do we owe Inesh', catalog, force)).length;
    ck(`full schema is ${full} chars, pruned is ${cut}`, cut < full, `${cut} vs ${full}`);
    ck('  and the pruned one still names the bills table',
        /TABLE bills\b/.test(catalog.schemaText(pickmod.pick('how much do we owe Inesh', catalog, force))));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) console.log('  failed: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
