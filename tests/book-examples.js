// ── tests/book-examples.js ────────────────────────────────────────────────
// Apsara, 2026-09-26: Jarvis "is dumb most of the times".
//
// The examples in helpers/data/books.js are the tuning dial — askData.js says
// so in its own comment: "one line there fixes a whole family of questions".
// On the day she said that, the dial was at SIX per book, for 7 yard tables
// and 10 metals tables. Worse, all six yard examples were money questions:
// not one counted anything, which is why "how many loads this week" came back
// could_not_answer. A model shown six SUM() queries and asked for a COUNT is
// being asked to invent a shape.
//
// ── WHY A BAD EXAMPLE IS WORSE THAN A MISSING ONE ─────────────────────────
// An example is not documentation. It is the pattern the model copies. SQL in
// here that references a column which does not exist does not fail loudly —
// it teaches the model to write that column, and the failure surfaces later
// as a confident wrong answer to a question nobody tested. So every example
// is EXECUTED against the real mirror schema here, and this file is the
// reason the next forty can be added safely.
//
// ── WHAT IT CHECKS ────────────────────────────────────────────────────────
//
//   1. The SQL runs. Against the schema the mirror actually builds, not a
//      remembered one — the yard catalog gained price_unit on 2026-09-24 and
//      the columns move whenever a store does.
//
//   2. Every {placeholder} in the headline is really SELECTed. This one is
//      subtle and it is the one that reaches her: askData fills placeholders
//      from the returned row, so a headline naming a column the query does
//      not produce prints the literal text "{owed}" on screen. Nothing throws.
//
//   3. No example writes. The guard in sqlGuard.js is the real defence, but
//      an example that even LOOKS like a write is a pattern the model will
//      copy toward.
//
//   4. The two books stay separated. A yard example that queries `bills`
//      would teach Scout to read Edge Metals' ledger — CLAUDE.md rule 5, and
//      the separation is most of what this app is for.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-books-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const eng = require(path.join(ROOT, 'helpers/data/sqlEngine'));
const { book } = require(path.join(ROOT, 'helpers/data/books'));

// The aliases the SELECT list actually produces. Read from the SQL text
// rather than from a result row, because a query that legitimately returns
// NOTHING on a given dataset still has to have the right shape — and on a
// fresh fixture store most of these return nothing.
function aliasesOf(sql) {
    const m = String(sql).match(/^\s*SELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\s+FROM\s/i);
    if (!m) return [];
    return m[1].split(/,(?![^()]*\))/).map((p) => {
        const t = p.trim();
        const as = t.match(/\sAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
        if (as) return as[1].toLowerCase();
        const bare = t.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
        return bare ? bare[1].toLowerCase() : null;
    }).filter(Boolean);
}

const BOOKS = [
    { key: 'yard',   mirror: 'helpers/data/yardMirror', catalog: 'helpers/data/yardCatalog', min: 20 },
    { key: 'metals', mirror: 'helpers/data/dataMirror', catalog: 'helpers/data/dataCatalog', min: 20 },
];

(async () => {

for (const b of BOOKS) {
    section(`${b.key} — every worked example`);
    const bk = book(b.key);
    const file = require(path.join(ROOT, b.mirror)).ensure().file;
    const cat = require(path.join(ROOT, b.catalog));
    const tableNames = cat.TABLES.map((t) => t.name);

    // ── THE DIAL IS TURNED ────────────────────────────────────────────────
    // Six was the number on the day she called it dumb. This is not a style
    // rule: few-shot count is the strongest single lever on text-to-SQL
    // accuracy, well ahead of which model is behind it.
    ck(`${b.key}: at least ${b.min} worked examples`, bk.examples.length >= b.min,
       `${bk.examples.length} — it was 6 on 2026-09-26, which is what "dumb" looked like`);

    let ranOk = 0;
    const sqlBad = [], phBad = [], writeBad = [], crossBad = [], titleBad = [];
    const shapes = {};

    for (const ex of bk.examples) {
        shapes[ex.shape] = (shapes[ex.shape] || 0) + 1;

        // 1. IT RUNS.
        try { eng.query(file, ex.sql); ranOk += 1; }
        catch (e) { sqlBad.push(`${ex.q} -> ${String(e.message).slice(0, 90)}`); continue; }

        // 2. EVERY PLACEHOLDER IS SELECTED. {count} is supplied by askData
        // itself for a list, so it is never a column.
        const al = aliasesOf(ex.sql);
        const ph = [...String(ex.headline || '').matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).filter((p) => p !== 'count');
        const miss = ph.filter((p) => !al.includes(p));
        if (miss.length) phBad.push(`${ex.q} -> {${miss.join('}, {')}} never selected; selects [${al.join(', ')}]`);

        // 3. READ ONLY.
        if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i.test(ex.sql)) {
            writeBad.push(ex.q);
        }

        // 4. THE BOOKS STAY APART. Every table an example names must belong
        // to THIS book's catalog.
        for (const m of String(ex.sql).matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
            if (!tableNames.includes(m[1])) crossBad.push(`${ex.q} -> reads ${m[1]}, not a ${b.key} table`);
        }

        // A list with no title renders a table with no heading.
        if (ex.shape === 'list' && !ex.title) titleBad.push(ex.q);
    }

    ck(`  all ${bk.examples.length} execute against the real mirror schema`,
       sqlBad.length === 0, sqlBad.join('\n        '));
    ck('  every headline placeholder is really selected',
       phBad.length === 0, phBad.join('\n        '));
    ck('  no example writes', writeBad.length === 0, writeBad.join(', '));
    ck(`  no example reads the other company's ledger`,
       crossBad.length === 0, crossBad.join('\n        '));
    ck('  every list example has a title', titleBad.length === 0, titleBad.join(', '));

    // ── THE SHAPES SHE ASKS IN ────────────────────────────────────────────
    // The specific gap behind "how many loads this week": six examples, all
    // aggregate money, no COUNT anywhere. Named explicitly so removing the
    // counting examples turns this red rather than quietly regressing.
    const qs = bk.examples.map((e) => e.q.toLowerCase());
    const sqls = bk.examples.map((e) => e.sql.toUpperCase());
    ck('  it knows how to COUNT', sqls.some((s) => /COUNT\(\*\)|COUNT\(DISTINCT/.test(s)));
    ck('    including "how many"', qs.some((q) => /^how many/.test(q)),
       'the question that came back could_not_answer on 2026-09-23');
    ck('  it knows relative periods', sqls.some((s) => /'NOW', 'LOCALTIME'/.test(s)));
    ck('    this week, not only this month',
       sqls.some((s) => /WEEKDAY 0/.test(s)) || qs.some((q) => /this week|last week/.test(q)));
    ck('  it can look one row up by id',
       sqls.some((s) => /WHERE (UPPER|LOWER)\([A-Z_]+\) = '/.test(s)),
       '"show me load EDGE_12" / "what is the margin on KOCU4930737"');
    ck('  it can rank and take a superlative',
       sqls.some((s) => /ORDER BY/.test(s) && /LIMIT 1|DESC/.test(s)));
    ck('  both shapes are represented', (shapes.single || 0) >= 5 && (shapes.list || 0) >= 3,
       JSON.stringify(shapes));

    // ── THE RATE TRAP ─────────────────────────────────────────────────────
    // price_unit landed on 2026-09-24: a row may be quoted per tonne, so two
    // `price` values are not comparable and AVG(price) is meaningless. There
    // must be an example showing the safe form, or the model will average the
    // column it can see.
    const rate = bk.examples.find((e) => /per pound|per lb/i.test(e.q));
    ck('  a "per pound" example exists', !!rate,
       'without one the model averages price, which price_unit makes wrong');
    if (rate) {
        ck('    and it divides amount by weight rather than averaging price',
           /SUM\(amount\)\s*\/\s*NULLIF\(SUM\(net_lb\)/i.test(rate.sql) && !/AVG\(\s*price/i.test(rate.sql),
           rate.sql.slice(0, 120));
    }

    // Duplicated questions waste prompt budget and teach nothing.
    ck('  no two examples ask the same question', new Set(qs).size === qs.length,
       qs.filter((q, i) => qs.indexOf(q) !== i).join(', '));
}

section('the bench fixture is honest');
// ══════════════════════════════════════════════════════════════════════════
// scripts/ask-eval.js reads tests/fixtures/ask-questions.json and scores an
// answer against each question's `expect`. An expectation naming a table that
// does not exist can never be met OR missed usefully — it just reports a
// failure forever, or worse, gets deleted because "that test is always red".
// The fixture is data, and data that drives a check needs a check.
{
    const fixture = require(path.join(ROOT, 'tests/fixtures/ask-questions.json'));
    const yardTables = require(path.join(ROOT, 'helpers/data/yardCatalog')).TABLES.map((t) => t.name);
    const metalsTables = require(path.join(ROOT, 'helpers/data/dataCatalog')).TABLES.map((t) => t.name);

    ck('the bench has grown past the 34 it had on 2026-09-26', fixture.length >= 70,
       `${fixture.length} questions`);

    const dataQs = fixture.filter((x) => (x.kind || 'data') === 'data');
    const noExpect = dataQs.filter((x) => !x.expect);
    ck('  every DATA question carries an expectation', noExpect.length === 0,
       noExpect.map((x) => x.q).join(' | '));
    // Text questions search her mail and documents. There is no deterministic
    // thing to assert about the answer, and inventing one would be a check
    // that fails when the mailbox changes. They are read by eye, deliberately.

    const badTable = [];
    for (const x of fixture) {
        const names = (x.book || 'metals') === 'yard' ? yardTables : metalsTables;
        for (const t of ((x.expect || {}).tables || [])) {
            if (!names.includes(t)) badTable.push(`${x.q} -> expects ${t}, not a ${x.book || 'metals'} table`);
        }
    }
    ck('  every expected table exists in that book\'s catalog', badTable.length === 0,
       badTable.join('\n        '));

    // The gap that let "how many loads this week" go unnoticed: the yard had
    // seven bench questions and not one of them counted anything.
    const yardQs = fixture.filter((x) => x.book === 'yard');
    ck('  the yard is no longer an afterthought', yardQs.length >= 20, `${yardQs.length} yard questions`);
    ck('    and it is asked to COUNT', yardQs.some((x) => /^how many/i.test(x.q)),
       'the shape that came back could_not_answer');

    // A question whose expectation is a SCOPE is testing the company line —
    // CLAUDE.md rule 5. Both directions must be covered or only one is.
    const toYard = fixture.filter((x) => ((x.expect || {}).scope) === 'yard');
    const toMetals = fixture.filter((x) => ((x.expect || {}).scope) === 'metals');
    ck('  both companies hand the other\'s question back', toYard.length >= 2 && toMetals.length >= 2,
       `${toYard.length} expect a yard redirect, ${toMetals.length} expect metals`);

    ck('  no duplicate question within a book',
       (() => {
           const seen = new Set(); let dup = false;
           for (const x of fixture) { const k = `${x.book || 'metals'}|${x.kind || 'data'}|${x.q.toLowerCase()}`; if (seen.has(k)) dup = true; seen.add(k); }
           return !dup;
       })());
}

section('the prompt stays affordable');
{
    // Every example is sent on every question. Examples are the best lever on
    // accuracy AND a per-question cost on her bill and on voice latency, so
    // the ceiling is deliberate: this is the tradeoff, written down, rather
    // than a number that drifts upward one commit at a time.
    for (const b of BOOKS) {
        const bk = book(b.key);
        const chars = bk.examples.reduce((a, e) => a + e.q.length + e.sql.length + (e.headline || '').length, 0);
        ck(`${b.key}: examples are under 12k characters`, chars < 12000,
           `${chars} chars ≈ ${Math.round(chars / 4)} tokens on EVERY question`);
    }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
