#!/usr/bin/env node
// ── scripts/ask-eval.js — is Jarvis actually answering her questions? ───────
//
// The tests prove the MACHINERY works: the guard refuses writes, the mirror's
// figures are the helpers' figures, a placeholder can only be filled from a
// row. What they cannot prove is the part that decides whether this feature is
// any good — whether the model picks the right table and the right period for
// the way SHE asks a question. That needs her real data and the real model,
// which is exactly what a test must never touch.
//
// So this is the bench. It runs a list of questions end to end and prints, for
// each: the query it wrote, what came back, and how long it took. Run it after
// a deploy, read down the ANSWER column, and anything that looks wrong gets
// its question added to EXAMPLES in helpers/data/askData.js — the examples are
// the tuning dial, and one line there fixes a whole family of questions.
//
//   node scripts/ask-eval.js                      all questions
//   node scripts/ask-eval.js --kind=data          just the ledger ones
//   node scripts/ask-eval.js --book=yard          just Scout's (Edge Yard)
//   node scripts/ask-eval.js --only=margin        matching questions only
//   node scripts/ask-eval.js --file=my.json       her own list
//   node scripts/ask-eval.js --json=out.json      machine-readable, to diff runs
//
// READ ONLY. It asks questions; nothing here writes, sends or generates. It
// does spend Gemini calls — one per question, two when a query needs repairing
// — so the count is printed at the end.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
};
const FILE = arg('file', path.join(ROOT, 'tests/fixtures/ask-questions.json'));
const ONLY = arg('only', null);
const KIND = arg('kind', null);
const BOOK = arg('book', null);   // metals | yard
const OUT = arg('json', null);
const LIMIT = Number(arg('limit', 0)) || 0;

const cut = (s, n) => {
    const t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

(async () => {
    const questions = JSON.parse(fs.readFileSync(FILE, 'utf8'))
        .filter((x) => x && x.q)
        .filter((x) => !KIND || (x.kind || 'data') === KIND)
        .filter((x) => !BOOK || (x.book || 'metals') === BOOK)
        .filter((x) => !ONLY || x.q.toLowerCase().includes(String(ONLY).toLowerCase()));
    const list = LIMIT ? questions.slice(0, LIMIT) : questions;
    if (!list.length) { console.log('No questions matched.'); process.exit(0); }

    const askData = require(path.join(ROOT, 'helpers/data/askData'));
    const askText = require(path.join(ROOT, 'helpers/data/askText'));
    const cfg = require(path.join(ROOT, 'config'));
    if (!cfg.GEMINI_API_KEY) {
        console.error('No GEMINI_API_KEY — this bench needs the real model. Run it where Jarvis runs.');
        process.exit(1);
    }

    // What the ledgers hold right now, so an empty answer can be read as
    // "nothing matched" rather than "the feature is broken".
    let counts = {};
    try { counts = require(path.join(ROOT, 'helpers/data/dataMirror')).ensure().counts; } catch (e) { counts = { error: e.message }; }
    let yardCounts = {};
    try { yardCounts = require(path.join(ROOT, 'helpers/data/yardMirror')).ensure().counts; } catch (e) { yardCounts = { error: e.message }; }
    let textCounts = {};
    try { textCounts = require(path.join(ROOT, 'helpers/data/textIndex')).ensure().counts; } catch (e) { textCounts = { error: e.message }; }
    console.log(`\nLedgers: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`Yard:    ${Object.entries(yardCounts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`Text:    ${Object.entries(textCounts).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);

    const results = [];
    let calls = 0, answered = 0, empty = 0, failed = 0, repairs = 0, expectFail = 0;
    for (const item of list) {
        const kind = item.kind || 'data';
        const t0 = Date.now();
        let out;
        try { out = kind === 'text' ? await askText.ask(item.q) : await askData.ask(item.q, { book: item.book || 'metals' }); }
        catch (e) { out = { ok: false, spoken: `THREW: ${e.message}` }; }
        const ms = Date.now() - t0;
        calls += kind === 'text' ? 1 : (out && out.repaired ? 2 : 1);
        if (out && out.repaired) repairs += 1;

        const status = !out || !out.ok ? (out && out.scope === 'yard' ? 'yard' : 'no-answer')
            : (out.empty ? 'empty' : 'ok');
        if (status === 'ok') answered += 1;
        else if (status === 'empty') empty += 1;
        else if (status !== 'yard') failed += 1;

        // Expectations are optional and are how this becomes a regression
        // bench: once an answer is right, write down what made it right.
        const problems = [];
        const exp = item.expect || {};
        if (exp.scope && (out || {}).scope !== exp.scope) problems.push(`scope ${(out || {}).scope || 'metals'} ≠ ${exp.scope}`);
        if (exp.tables) {
            const got = (out && out.tables) || [];
            for (const t of exp.tables) if (!got.includes(t)) problems.push(`used ${got.join('+') || 'nothing'}, expected ${t}`);
        }
        if (exp.answerMatches && !(new RegExp(exp.answerMatches, 'i')).test((out && out.spoken) || '')) problems.push(`answer did not match /${exp.answerMatches}/`);
        if (exp.minRows && ((out && out.rows) || []).length < exp.minRows) problems.push(`${((out && out.rows) || []).length} rows < ${exp.minRows}`);
        if (problems.length) expectFail += 1;

        results.push({ q: item.q, kind, status, ms, problems,
            tables: (out && out.tables) || ((out && out.used) || []).map((h) => h.kind),
            sql: (out && out.sql) || null, rows: ((out && out.rows) || []).length,
            answer: (out && out.spoken) || '', repaired: !!(out && out.repaired) });

        const mark = problems.length ? '✗' : (status === 'ok' ? '·' : '~');
        console.log(`${mark} [${status}${out && out.repaired ? ', repaired' : ''}] ${cut(item.q, 52).padEnd(53)} ${String(ms + 'ms').padStart(7)}  ${cut((out && out.tables || []).join('+'), 22).padEnd(23)} ${cut((out && out.spoken) || '', 70)}`);
        if (out && out.sql) console.log(`        ${cut(out.sql, 150)}`);
        for (const p of problems) console.log(`        ✗ ${p}`);
    }

    console.log(`\n${list.length} questions · ${answered} answered · ${empty} nothing matched · ${failed} could not answer`
        + ` · ${repairs} needed a second try · ${expectFail} missed an expectation · about ${calls} model calls`);
    console.log('Anything wrong above: add that question (with the query it should have written) to EXAMPLES in helpers/data/askData.js.');
    if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), counts, textCounts, results }, null, 2)); console.log(`Written to ${OUT}`); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
