#!/usr/bin/env node
// ── scripts/ask-report.js — is Jarvis actually answering? ─────────────────
//
// Apsara, 2026-09-26: Jarvis "is dumb most of the times". That is a feeling,
// and a feeling cannot be fixed or proved fixed. This turns it into a number.
//
// ── WHY THIS DID NOT EXIST, AND WHAT THAT COST ────────────────────────────
// data/ask_log.json had 22 rows, every one could_not_answer. I read it as her
// experience and told her so. It was tests/yard-ask-tools.js, run eleven
// times: "pay five hundred on edge 99" is a fixture and EDGE_99 is a load
// that deliberately does not exist, so the refusal path can be proved.
//
// Two things came out of that. Rows are now tagged `test` when JARVIS_TEST is
// set, and this report SAYS how many it set aside — an exclusion you cannot
// see is just another way to be misled. And askYard is wrapped so all three
// of its routes log, rather than only the ledger fallback that fires on a
// handful of questions.
//
//   node scripts/ask-report.js                 the last 7 days
//   node scripts/ask-report.js --days=30       a longer window
//   node scripts/ask-report.js --tests         include the test traffic
//   node scripts/ask-report.js --all           everything on file
//
// Read the NEEDS WORK list from the top. Each line is a question she asked
// that did not land. Fixing one is usually one entry in helpers/data/books.js
// — the examples are the tuning dial, and one line there fixes a family.

const path = require('path');
const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const num = (f, d) => {
    const hit = argv.find((a) => a.startsWith(`--${f}=`));
    return hit ? (Number(hit.split('=')[1]) || d) : d;
};

const askLog = require(path.join(ROOT, 'helpers/data/askLog'));

const days = has('--all') ? null : num('days', 7);
const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;
const s = askLog.summary({ since, includeTests: has('--tests') });

const all = askLog.list();
const earliest = all.length ? String(all[0].at).slice(0, 10) : null;

const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');
const bar = (n, of, w = 24) => {
    const filled = of ? Math.round((n / of) * w) : 0;
    return '█'.repeat(filled) + '·'.repeat(w - filled);
};

console.log(`\n  JARVIS — ${days ? `the last ${days} days` : 'everything on file'}`);
console.log(`  ${'─'.repeat(62)}`);

if (!s.questions) {
    console.log('\n  No questions in this window.');
    if (s.test_rows_excluded) console.log(`  (${s.test_rows_excluded} test rows set aside — run with --tests to see them.)`);
    if (earliest) console.log(`  The log starts ${earliest}.`);
    console.log('\n  Nothing to read yet. Use Jarvis for a week and run this again.\n');
    process.exit(0);
}

// ── THE HEADLINE ──────────────────────────────────────────────────────────
console.log(`\n  ${String(s.answered_pct).padStart(3)}%  answered      ${bar(s.by.answered, s.questions)}`);
console.log(`        of ${s.questions} question${s.questions === 1 ? '' : 's'}`
    + (s.avg_ms ? `, ${(s.avg_ms / 1000).toFixed(1)}s each on average` : ''));
if (s.test_rows_excluded) {
    console.log(`\n  ${s.test_rows_excluded} test row${s.test_rows_excluded === 1 ? '' : 's'} set aside (--tests to include).`);
}

// ── WHAT THE REST WERE ────────────────────────────────────────────────────
console.log(`\n  WHAT HAPPENED`);
const LABEL = {
    answered: 'answered',
    nothing_matched: 'looked, found nothing',
    could_not_answer: 'could not work it out',
    yard: 'handed to the other company',
    unclear: 'asked her to clarify',
    failed: 'threw',
};
for (const k of Object.keys(s.by)) {
    if (!s.by[k]) continue;
    console.log(`    ${String(s.by[k]).padStart(4)}  ${pct(s.by[k], s.questions).padStart(4)}  ${LABEL[k] || k}`);
}

// ── WHICH DOOR ────────────────────────────────────────────────────────────
// A route that never answers is a ROUTING problem; a route that answers
// wrongly is a TUNING problem. They need opposite fixes, and the only way to
// tell them apart is to split the number by where the question came in.
if (s.by_source && Object.keys(s.by_source).length > 1) {
    console.log(`\n  BY ENTRY POINT`);
    for (const [k, v] of Object.entries(s.by_source).sort((a, b) => b[1].asked - a[1].asked)) {
        console.log(`    ${k.padEnd(14)} ${String(v.answered).padStart(4)}/${String(v.asked).padEnd(4)} ${pct(v.answered, v.asked).padStart(4)}  ${bar(v.answered, v.asked, 16)}`);
    }
}

// ── THE LIST THAT IS THE WHOLE POINT ──────────────────────────────────────
if (s.needs_work.length) {
    console.log(`\n  NEEDS WORK — questions that did not land, commonest first`);
    for (const r of s.needs_work) {
        console.log(`    ${String(r.times).padStart(3)}x  ${r.what.slice(0, 66)}`);
    }
    console.log(`\n  Fix one by adding it to helpers/data/books.js with the query it`);
    console.log(`  should have written, then: node tests/book-examples.js`);
} else {
    console.log(`\n  Nothing failed in this window.`);
}

if (s.tables_used && s.tables_used.length) {
    console.log(`\n  LEDGERS READ`);
    console.log('    ' + s.tables_used.slice(0, 8).map((t) => `${t.what} ${t.times}`).join(' · '));
}

if (s.repaired) {
    console.log(`\n  ${s.repaired} question${s.repaired === 1 ? '' : 's'} needed a second attempt at the query`
        + ` (${pct(s.repaired, s.questions)}). Each one is two model calls.`);
}
console.log(`\n  ${s.model_calls} model calls in this window.`
    + (earliest ? `  Log starts ${earliest}.` : '') + '\n');
