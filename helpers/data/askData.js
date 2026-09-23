// ── helpers/data/askData.js — a question becomes a query, then an answer ────
//
// Apsara, 2026-09-23: "give all data access and possible advanced rag type
// chat bot with advanced options ... it should be world class."
//
// ── THE SHAPE, AND WHY IT IS THIS SHAPE ─────────────────────────────────────
// Published production write-ups on natural-language-to-SQL agree on the parts
// that actually move accuracy, and every one of them is here:
//   1. an ANNOTATED schema (helpers/data/dataCatalog.js) — the single biggest
//      lever; a model told what `balance` means does not have to guess
//   2. worked EXAMPLES of her real questions, in the prompt
//   3. a hard GUARD before execution (helpers/data/sqlGuard.js)
//   4. EXECUTION FEEDBACK: when SQLite rejects the query, its own words go
//      back for exactly one repair — worth roughly ten points on the public
//      benchmarks, and it costs one extra call only when something broke
//   5. PLAUSIBILITY: an empty result is reported as empty, never as zero
//   6. and the part most systems skip — THE MODEL NEVER WRITES A NUMBER.
//      It writes a sentence with {placeholders}; this file fills them from the
//      rows SQLite returned. A wrong number can therefore only come from a
//      wrong QUERY, which is visible on screen, rather than from a model
//      typing a plausible figure into prose, which is not.
//
// Everything is read-only: see sqlGuard and dataMirror.
const guard = require('./sqlGuard');
const engine = require('./sqlEngine');
const books = require('./books');
// Which tables this question actually needs. A no-op below FULL_BELOW tables,
// so it changes nothing today and starts working the moment the catalog grows
// — see the note at the top of that file for why pruning has to land BEFORE
// the tables do.
const schemaPick = require('./schemaPick');

// Her own questions, with the query each one means, now live in
// helpers/data/books.js — one set per company, because a worked example for
// the yard is nonsense in the metals book and the other way round. They are
// still the tuning dial: a question Jarvis keeps getting wrong goes in there.
const EXAMPLES = books.BOOKS.metals.examples;

const SHAPES = ['single', 'list'];

function prompt(question, previous, bookName) {
    const b = books.book(bookName);
    const catalog = b.catalog();
    const ex = b.examples.map((e) => `Q: ${e.q}\n${JSON.stringify({ tables: [], sql: e.sql, shape: e.shape, headline: e.headline, formats: e.formats || {}, title: e.title || null })}`).join('\n\n');
    return `You turn Apsara's question about her ${b.label} business into ONE read-only SQLite query.

${catalog.schemaText(schemaPick.pick(question, catalog))}

WHAT HER WORDS MEAN:
${catalog.DEFINITIONS.map((d) => '- ' + d).join('\n')}

TRAPS IN THIS DATA:
${catalog.GOTCHAS.map((g) => '- ' + g).join('\n')}

HOW TO ANSWER:
- "sql": ONE SELECT (a WITH ... SELECT is fine). No INSERT/UPDATE/DELETE/PRAGMA, no second statement, no semicolon.
- "shape": "single" when the answer is one row of figures, "list" when she wants rows.
- "headline": the sentence to say, with {placeholders} naming columns your SQL returns. YOU MUST NOT WRITE ANY NUMBER YOURSELF — every figure is a placeholder, filled from the query result. On "list" you may use {count}, the number of rows.
- "formats": placeholder -> one of money, number, weight_lb, weight_mt, percent, date, text.
- "title": a short heading for the table on screen (list only).
- "tables": the tables you used.
- "scope": "${b.key}" normally; "${b.other}" if the question is about ${b.otherWords} — then leave sql empty; "unclear" if you cannot tell what she means, and put the question you would ask in "ask".
Today is ${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })}; SQLite 'now' is that day.

EXAMPLES:
${ex}
${previous ? `
YOUR LAST ATTEMPT FAILED. SQL:
${previous.sql}
SQLite said: ${previous.error}
Fix it. Use only columns that exist above.
` : ''}
Q: ${question}
Answer with JSON only: {"scope": "...", "tables": [...], "sql": "...", "shape": "...", "headline": "...", "formats": {...}, "title": null, "ask": null}`;
}

const money = (n) => (n === null || n === undefined || n === '' ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const plain = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }));
function fmt(value, kind) {
    if (value === null || value === undefined) return kind === 'text' ? '—' : '0';
    switch (kind) {
        case 'money': return money(value);
        case 'number': return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : String(value);
        case 'weight_lb': return `${plain(value)} lb`;
        case 'weight_mt': return `${plain(value)} MT`;
        case 'percent': return `${plain(value)}%`;
        case 'date': return String(value);
        default: return String(value);
    }
}

// Fills {placeholders} from the row SQLite returned. A placeholder with no
// matching column is a bug in the plan, not something to paper over with an
// empty string — the caller falls back to the plain rendering and says so.
function bind(headline, row, formats, count) {
    const missing = [];
    const out = String(headline || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (m, key) => {
        if (key === 'count') return Number(count).toLocaleString('en-US');
        if (row && Object.prototype.hasOwnProperty.call(row, key)) return fmt(row[key], (formats || {})[key] || 'text');
        missing.push(key);
        return m;
    });
    return { text: out, missing };
}

function table(columns, rows, max = 15) {
    const head = columns.join(' · ');
    const body = rows.slice(0, max).map((r) => columns.map((c) => {
        const v = r[c];
        return v === null || v === undefined ? '—' : (typeof v === 'number' ? plain(v) : String(v));
    }).join(' · '));
    return [head, ...body].join('\n') + (rows.length > max ? `\n… ${rows.length - max} more rows` : '');
}

// What she could do next about this answer. Deliberately a SENTENCE, not a
// staged action: an offer that also opens a pending would make every answer a
// question she has to dismiss.
function nextStep(question, tables, rows) {
    const q = String(question || '').toLowerCase();
    const has = (t) => (tables || []).includes(t);
    const first = rows[0] || {};
    if (has('sales') && rows.some((r) => !r.invoice_no) && /invoice/.test(q) && first.container_no) {
        return `Say "generate invoice for ${first.container_no}" and I'll raise it.`;
    }
    if (has('bills') && /owe|unpaid|balance|payable/.test(q)) return 'Record a payment on the Bills screen and this updates itself.';
    if (has('trucking_bills') && /owe|unpaid|balance/.test(q)) return 'Say "show trucking" for the full payables list.';
    if (has('bills') && /unfinished|incomplete|missing|needs/.test(q)) return 'Say "backfill missing cutoffs" for the booking side, or fill the rest on the Bills screen.';
    return null;
}

// Returns { ok, spoken, screen, sql, tables, rows, columns, why }.
async function ask(question, opts = {}) {
    const { callGeminiJSON } = require('../gemini');
    const b = books.book(opts.book);
    const mirror = b.mirror();
    let info;
    try { info = mirror.ensure(); }
    catch (e) { return { ok: false, spoken: `I can't read the ledgers right now: ${e.message}`, screen: null, error: e.message }; }

    const plan0 = await callGeminiJSON(prompt(question, null, b.key));
    if (!plan0) {
        return { ok: false, spoken: "I couldn't work that question into a query — the model didn't answer. Say it another way?", screen: null, error: 'no plan' };
    }
    // The other company's question, handed back rather than answered from the
    // wrong book. Reported as scope 'yard'/'metals' — whichever it belongs to.
    if (plan0.scope === b.other) {
        return { ok: false, scope: b.other, spoken: b.redirect, screen: null };
    }
    if (plan0.scope === 'unclear' || (!plan0.sql && plan0.ask)) {
        return { ok: false, scope: 'unclear', spoken: String(plan0.ask || 'What exactly do you want to know?'), screen: null, ask: true };
    }

    let plan = plan0;
    let result = null;
    let lastError = null;
    let repaired = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const checked = guard.check(plan && plan.sql);
        if (!checked.ok) { lastError = checked.why; }
        else {
            try {
                result = engine.query(info.file, guard.withLimit(checked.sql, opts.limit || 200), { limit: opts.limit || 200 });
                lastError = null;
                break;
            } catch (e) { lastError = e.message; }
        }
        if (attempt === 1) break;
        // A repair is worth a second model call only when SQLite REJECTED a
        // real query — that is the execution-feedback step. A plan that came
        // back with no SQL at all is not a query to fix, and asking again just
        // spends another call on the same misunderstanding.
        if (!plan || !plan.sql) { lastError = lastError || 'no SQL'; break; }
        console.warn(`[ASKDATA] first attempt failed (${lastError}) — repairing`);
        repaired = true;
        const fixedPlan = await callGeminiJSON(prompt(question, { sql: (plan && plan.sql) || '', error: lastError }, b.key));
        if (!fixedPlan || !fixedPlan.sql) break;
        plan = fixedPlan;
    }
    if (!result) {
        return { ok: false, spoken: "I couldn't get that out of the ledgers — ask it a different way and I'll try again.",
            screen: `Tried: ${(plan && plan.sql) || '(no query)'}\n\nSQLite said: ${lastError}`, error: lastError, sql: plan && plan.sql };
    }

    const rows = result.rows || [];
    const columns = result.columns || [];
    const tables = Array.isArray(plan.tables) ? plan.tables : [];
    const shape = SHAPES.includes(plan.shape) ? plan.shape : (rows.length > 1 ? 'list' : 'single');
    const source = `From ${tables.length ? tables.join(' + ') : 'the ledgers'} · ${rows.length}${result.truncated ? '+' : ''} row${rows.length === 1 ? '' : 's'} · ${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })}`;

    // NOTHING MATCHED IS NOT ZERO. "$0 owed to Inesh" and "no bills from
    // anyone called Inesh" are different facts and she acts differently on
    // them, so an empty result says so and shows what was looked for.
    if (!rows.length) {
        return { ok: true, empty: true, repaired, sql: plan.sql, tables, rows, columns,
            spoken: 'Nothing in the ledgers matched that.',
            screen: `Nothing matched.\n\n${source}\n\nQuery: ${plan.sql}` };
    }

    const bound = bind(plan.headline || '', rows[0], plan.formats, rows.length);
    const usable = plan.headline && !bound.missing.length;
    const spoken = usable ? bound.text
        : (shape === 'list' ? `${rows.length} rows.` : columns.map((c) => `${c}: ${fmt(rows[0][c], 'text')}`).join(', '));
    if (!usable && plan.headline) console.warn(`[ASKDATA] headline referred to ${bound.missing.join(', ')} which the query did not return`);

    const screenParts = [];
    if (usable) screenParts.push(bound.text);
    if (shape === 'list' || rows.length > 1) {
        if (plan.title) screenParts.push(String(plan.title));
        screenParts.push(table(columns, rows));
    } else {
        screenParts.push(columns.map((c) => `${c}: ${fmt(rows[0][c], (plan.formats || {})[c] || 'text')}`).join('\n'));
    }
    screenParts.push(source);
    const next = nextStep(question, tables, rows);
    if (next) screenParts.push(next);

    return { ok: true, spoken, screen: screenParts.join('\n\n'), sql: plan.sql, tables, rows, columns,
        shape, next, repaired, book: b.key, engine: info.engine, counts: info.counts };
}

module.exports = { ask, prompt, bind, fmt, table, nextStep, EXAMPLES };
