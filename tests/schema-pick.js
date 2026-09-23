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

section('A — at today\'s size it changes nothing');
{
    const all = catalog.tableNames();
    ck(`the metals catalog has ${all.length} tables, under the ${pickmod.FULL_BELOW} threshold`,
        all.length < pickmod.FULL_BELOW, `${all.length} vs ${pickmod.FULL_BELOW}`);
    for (const q of ['how much do we owe Inesh', 'which bills are unfinished',
                     'margin on KOCU4930737', 'what did we sell to MK Trading in August',
                     'show me trucking', '']) {
        const got = pickmod.pick(q, catalog);
        ck(`  "${q || '(empty)'}" still sends every table`,
            got.length === all.length, `${got.length}/${all.length}`);
    }
    const y = yardCatalog.tableNames();
    ck(`the yard catalog (${y.length}) is untouched too`,
        pickmod.pick('how much do we owe sellers', yardCatalog).length === y.length);
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
