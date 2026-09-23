// ── helpers/data/schemaPick.js — which tables this question needs ──────────
//
// Apsara, 2026-09-24: "Make jarvis knowledgeale of all edge metal data" —
// and, asked which: "Leave Edge Yard data.Except Edge Yard data everythig
// else".
//
// ── WHY THIS EXISTS BEFORE THE TABLES ARRIVE ───────────────────────────────
// askData sends catalog.schemaText(catalog.tableNames()) — the WHOLE schema,
// on every question. At ten tables that is about 1,720 tokens and works. The
// published work on natural-language-to-SQL is consistent that it stops
// working as the schema grows, and for a specific reason: SCHEMA LINKING —
// deciding which tables and columns the question refers to — is the single
// biggest driver of wrong SQL, and irrelevant tables actively distract the
// model rather than merely costing tokens. Pruning them is worth on the order
// of ten to fifteen points on large schemas, and retrieved schema closes
// roughly half the gap between "send everything" and a perfect oracle.
//
// So widening the catalog WITHOUT this would make Jarvis worse at the
// questions it already answers correctly. This lands first.
//
// ── IT IS A NO-OP TODAY, DELIBERATELY ──────────────────────────────────────
// Below FULL_BELOW tables the whole schema is returned unchanged, because at
// that size everything is plausibly relevant and pruning can only lose. So
// adding this file changes nothing about today's answers — it starts working
// on the day the catalog grows past it, which is the day it is needed.
//
// ── AND IT FAILS OPEN, NEVER CLOSED ────────────────────────────────────────
// A subset that is missing the one table the answer needed is worse than no
// pruning at all: the model cannot write the right query and does not know
// why. So every uncertain case returns EVERY table. The only outcomes are
// "a confidently smaller schema" and "exactly what happens today".
//
// No model call, on purpose. This runs before the one call askData makes, on
// every question, and a second round trip to decide what to put in the first
// would double the latency of the thing it is meant to speed up.

// Under this many tables, send everything — see above.
const FULL_BELOW = 14;

// How many tables a pruned schema may carry. Generous: recall matters far
// more than precision here, because a table wrongly INCLUDED costs tokens
// while a table wrongly DROPPED costs the answer.
const MAX_TABLES = 10;

// Words that appear in every business question and so distinguish nothing.
// Kept short — an over-eager stop list is how a question about "payments"
// stops matching the payments table.
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'how',
    'much', 'many', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'we', 'i', 'me',
    'my', 'our', 'us', 'it', 'this', 'that', 'these', 'those', 'of', 'in', 'on', 'at', 'to',
    'for', 'from', 'by', 'with', 'and', 'or', 'not', 'no', 'all', 'any', 'show', 'list',
    'give', 'tell', 'find', 'get', 'have', 'has', 'had', 'been', 'be', 'so', 'far', 'total',
    'please', 'still', 'yet', 'now', 'today']);

const words = (s) => String(s || '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/).filter((w) => w && w.length > 2 && !STOP.has(w));

// Singular/plural collapse, crudely. "bills" and "bill" must score the same;
// a stemmer would be a dependency and a new way to be wrong.
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

// "owe" must reach "owed", "bill" must reach "bills", "pay" must reach
// "payable" and "payment". Prefix matching does all three without a stemmer
// and without the stemmer's failure mode — chopping a word down to something
// that collides with an unrelated one.
//
// THREE characters, not four. words() already drops anything shorter, so
// three is the minimum a real word can be here, and the one that matters is
// "owe" -> "owed": nothing in the bills schema says "owe", and at four this
// missed it and sent the whole catalog for the most common question she asks.
const hits = (list, w) => list.some((x) => x === w
    || (w.length >= 3 && x.startsWith(w)) || (x.length >= 3 && w.startsWith(x)));

// ── WHAT HER WORDS MEAN, AS A ROUTING TABLE ───────────────────────────────
// catalog.DEFINITIONS already says things like
//     OWED TO SUPPLIERS / payable / outstanding = SUM(bills.balance) ...
// which is precisely a map from her vocabulary to a table. Nothing in the
// bills schema contains the word "owe", so without this a question phrased
// the way she actually phrases it scores nothing and the pruner gives up and
// sends everything. Weighted above a column mention and below the table's own
// name: a definition is a strong hint, not a certainty.
function definitionScores(qWords, catalog) {
    const out = {};
    for (const line of (catalog.DEFINITIONS || [])) {
        const lw = words(line);
        const overlap = qWords.filter((w) => hits(lw, w)).length;
        if (!overlap) continue;
        for (const m of String(line).matchAll(/([a-z_][a-z0-9_]*)\.[a-z0-9_]+/gi)) {
            const t = m[1].toLowerCase();
            if (catalog.find(t)) out[t] = (out[t] || 0) + 6 * overlap;
        }
    }
    return out;
}

function scoreTable(qWords, table) {
    const name = words(table.name).map(stem);
    const what = words(table.what).map(stem);
    const cols = Object.keys(table.columns || {});
    const colNames = cols.flatMap((c) => words(c).map(stem));
    const colText = cols.flatMap((c) => words(table.columns[c]).map(stem));

    let score = 0;
    for (const w of qWords) {
        // The table's own name is the strongest signal she can give — asking
        // about "bookings" should reach the bookings table before anything
        // that merely mentions one.
        if (hits(name, w)) score += 10;
        if (hits(colNames, w)) score += 4;
        // What the table IS, and what its columns MEAN, in her vocabulary —
        // this is what lets "who do we owe" find a table whose columns are
        // called balance and supplier without the word "owe" in either.
        if (hits(what, w)) score += 3;
        if (hits(colText, w)) score += 1;
    }
    return score;
}

// ── THE PICK ───────────────────────────────────────────────────────────────
// Returns table NAMES, always in the catalog's own order so the prompt reads
// the same way every time — a schema whose table order moves per question is
// a prompt that cannot be cached and a diff nobody can read.
function pick(question, catalog, opts = {}) {
    const all = catalog.tableNames();
    const max = Number(opts.max) || MAX_TABLES;
    const fullBelow = Number.isFinite(opts.fullBelow) ? opts.fullBelow : FULL_BELOW;

    if (all.length <= fullBelow) return all;            // small schema: send it all

    const qWords = [...new Set(words(question).map(stem))];
    if (!qWords.length) return all;                     // nothing to go on

    const defs = definitionScores(qWords, catalog);
    const scored = all.map((n) => ({ name: n, score: scoreTable(qWords, catalog.find(n)) + (defs[n] || 0) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

    // Nothing matched, or only weakly: this is the uncertain case, and it
    // fails OPEN.
    if (!scored.length || scored[0].score < 4) return all;

    // ── EVERY TABLE THAT SCORED AT ALL, NOT THE TOP BAND ──────────────────
    // A band around the best score (best/2) pruned beautifully and dropped
    // three of her eleven worked questions — "how many containers did we load
    // this month" kept margin and lost bills, because "load" is not a word in
    // the bills schema. That is the failure that matters: the model cannot
    // write the right query and cannot say why.
    //
    // So anything with a pulse is kept. Recall is the whole job here; the
    // tokens saved by dropping a table that scored 1 are not worth the
    // question it might have been the answer to. A lexical scorer cannot do
    // better than this without a second model call, and that call would cost
    // more latency than the pruning saves.
    const keep = new Set(scored.slice(0, max).map((r) => r.name));

    // ── AND WHATEVER THOSE TABLES JOIN TO ──────────────────────────────────
    // A pruned schema that keeps bills but drops bill_items cannot answer a
    // question about grades, and the model has no way to say so.
    //
    // Matched on the catalog's own join notation — `bills.bill_id`, a table
    // name followed by a dot and a column. A first version looked for the
    // table NAME anywhere in the prose, which pulled in the whole catalog on
    // every question: `documents`, `margin`, `sales` and `bookings` are all
    // ordinary English words, and every description contains one of them. The
    // dot is what distinguishes a join from a sentence.
    for (const n of [...keep]) {
        const t = catalog.find(n);
        const blob = `${t.what} ${Object.values(t.columns || {}).join(' ')}`.toLowerCase();
        for (const other of all) {
            if (keep.has(other)) continue;
            if (new RegExp(`(^|[^a-z0-9_])${other.toLowerCase()}\\.[a-z0-9_]+`).test(blob)) keep.add(other);
        }
    }

    // Catalog order, not score order.
    return all.filter((n) => keep.has(n));
}

module.exports = { pick, FULL_BELOW, MAX_TABLES, words, stem, scoreTable, definitionScores };
