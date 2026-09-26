// ── tests/ask-log-report.js ───────────────────────────────────────────────
// Apsara, 2026-09-26: Jarvis "is dumb most of the times".
//
// There was no way to check, and worse, the one place that looked like
// evidence was lying. data/ask_log.json held 22 rows, all could_not_answer. I
// read that as her experience and told her so. It was tests/yard-ask-tools.js
// run eleven times — "pay five hundred on edge 99" is a fixture, and EDGE_99
// is a load that deliberately does not exist so the refusal path can be
// proved.
//
// ── SO THIS FILE GUARDS THE THREE THINGS THAT MISLED ME ───────────────────
//
//   1. COVERAGE. Only the ledger FALLBACK inside yardAsk.js logged anything —
//      the last resort, which fires on a handful of questions. askYard's own
//      three routes (the chat box and two voice paths) recorded nothing, so
//      the main path was invisible and the log was a biased sample of the
//      worst cases. Section A.
//
//   2. TEST TRAFFIC. Rows are tagged when JARVIS_TEST is set and excluded by
//      default — and the count of what was excluded is reported, because an
//      exclusion you cannot see is just a quieter way to be misled. Section B.
//
//   3. DOUBLE COUNTING. A ledger-answered question writes TWO rows: the
//      wrapper's and the fallback's. Counting both would show one success and
//      one something-else for a single question, quietly halving the number.
//      Section C.
//
// And the rule underneath all of it: logging must never be able to break
// answering. Section D.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-asklog-'));
process.env.DATA_DIR = TMP;
delete process.env.JARVIS_TEST;          // section B sets it deliberately

const ROOT = path.join(__dirname, '..');
const askLog = require(path.join(ROOT, 'helpers/data/askLog'));

(async () => {

// ══════════════════════════════════════════════════════════════════════════
section('A — every answer path logs, and it is the FUNCTION that does it');
// ══════════════════════════════════════════════════════════════════════════
{
    const yardSrc = fs.readFileSync(path.join(ROOT, 'helpers/yardAsk.js'), 'utf8');

    // Wrapped, not instrumented per caller. Three routes call askYard today
    // (api.js 2167, 2541, 3571) and a fourth must not be able to skip this.
    ck('askYard is a wrapper that logs', /async function askYard\([\s\S]{0,1400}?askLog'\)\.record\(/.test(yardSrc));
    ck('  around the real implementation', /async function askYardInner\(/.test(yardSrc));
    // ── PROVED BY CALLING IT, NOT BY READING IT ──────────────────────────
    // The first version of this matched /\} finally \{/ in the source. A
    // mutation that broke the coverage while leaving those four characters in
    // place survived it — the check was shaped like the code rather than like
    // the behaviour. askYard('') takes the EARLIEST return, before the brief,
    // before any model call: if that one is logged, the wrapper is genuinely
    // outside all eight.
    const { askYard } = require(path.join(ROOT, 'helpers/yardAsk'));
    const beforeEarly = askLog.list().length;
    const early = await askYard('');
    await new Promise((r) => setTimeout(r, 80));     // the log is fire-and-forget
    const wrote = askLog.list().slice(beforeEarly);
    ck('  the EARLIEST return is logged too', wrote.length === 1,
       `${wrote.length} rows for one call — a return that skips the log is a path that goes invisible`);
    ck('    as the question it was', early.ok === false && wrote[0] && wrote[0].source === 'scout-ask',
       JSON.stringify(wrote[0] || null));
    ck('    and it carries how long it took', wrote[0] && Number.isFinite(wrote[0].ms),
       'the 22 rows that misled me had ms: null, so nothing could be said about speed');

    // The three routes must still just call askYard — if one starts calling
    // askYardInner it escapes the log.
    const apiSrc = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
    ck('  and no route reaches past the wrapper', !/askYardInner/.test(apiSrc),
       'calling the inner function directly is how a path goes dark');

    const routes = (apiSrc.match(/await askYard\(/g) || []).length;
    ck(`  all ${routes} askYard routes are therefore covered`, routes >= 3, String(routes));

    // It must not slow the answer down or be able to fail it.
    ck('the log is not awaited', !/await require\('\.\/data\/askLog'\)\.record\(/.test(
        yardSrc.slice(yardSrc.indexOf('} finally {'), yardSrc.indexOf('async function askYardInner'))),
       'a question should not wait on a file write');
}

// ══════════════════════════════════════════════════════════════════════════
section('B — test traffic is tagged, excluded, and SAID to be excluded');
// ══════════════════════════════════════════════════════════════════════════
{
    // A DELTA, not an absolute. Section A now calls askYard(''), which writes
    // a row of its own — a check that breaks when an earlier section writes
    // one more thing is a check that gets deleted rather than understood.
    const before = askLog.summary().questions;
    const beforeAll = askLog.summary({ includeTests: true }).questions;

    process.env.JARVIS_TEST = '1';
    await askLog.record({ kind: 'data', source: 'scout-ask', question: 'a rehearsal', outcome: 'could_not_answer' });
    delete process.env.JARVIS_TEST;
    await askLog.record({ kind: 'data', source: 'scout-ask', question: 'a real one', outcome: 'answered', ms: 1200 });

    const rows = askLog.list();
    ck('a row written under JARVIS_TEST is tagged', rows.find((r) => r.question === 'a rehearsal').test === true);
    ck('  and one written without it is not', rows.find((r) => r.question === 'a real one').test === false);

    const s = askLog.summary();
    ck('the summary counts only the real one', s.questions === before + 1,
       `${before} -> ${s.questions}, expected one more`);
    ck('  and says how many it set aside', s.test_rows_excluded === 1, String(s.test_rows_excluded),
       'an exclusion you cannot see is just a quieter way to be misled');
    ck('  --tests brings them back',
       askLog.summary({ includeTests: true }).questions === beforeAll + 2);
    ck('  and then reports nothing as excluded', askLog.summary({ includeTests: true }).test_rows_excluded === 0);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — one question, counted once');
// ══════════════════════════════════════════════════════════════════════════
{
    const before = askLog.summary().questions;
    // Exactly what a ledger-answered question writes: the wrapper's row, then
    // the fallback's more detailed one, same question.
    await askLog.record({ kind: 'data', source: 'scout-ask', question: 'oldest unpaid load', outcome: 'answered', via_ledger: true, ms: 1600 });
    await askLog.record({ kind: 'data', source: 'scout', question: 'oldest unpaid load', outcome: 'answered', tables: ['yard_loads'], ms: 1500 });

    const s = askLog.summary();
    ck('two rows for one question count as one', s.questions === before + 1,
       `${before} -> ${s.questions}`);
    ck('  and it is the DETAILED row that survives',
       (s.tables_used || []).some((t) => t.what === 'yard_loads'),
       'the wrapper row carries no tables; keeping it would lose which ledger was read');

    // A wrapper row with no ledger twin must NOT be dropped — that is the
    // ordinary case and dropping it would hide most of the traffic.
    await askLog.record({ kind: 'data', source: 'scout-ask', question: 'a lone brief answer', outcome: 'answered', ms: 800 });
    ck('a wrapper row with no twin is kept', askLog.summary().questions === s.questions + 1);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — the number, and the list to act on');
// ══════════════════════════════════════════════════════════════════════════
{
    await askLog.record({ kind: 'data', source: 'jarvis', question: 'what did we sell last week', outcome: 'could_not_answer', ms: 900 });
    await askLog.record({ kind: 'data', source: 'jarvis', question: 'what did we sell last week', outcome: 'could_not_answer', ms: 950 });

    const s = askLog.summary();
    ck('there is a single percentage to quote', Number.isFinite(s.answered_pct), String(s.answered_pct));
    ck('  and it matches the counts', s.answered_pct === Math.round((s.by.answered / s.questions) * 100),
       `${s.answered_pct}% vs ${s.by.answered}/${s.questions}`);

    // A route that never answers is a ROUTING problem; one that answers
    // wrongly is a TUNING problem. Opposite fixes, so they must be separable.
    ck('the number splits by entry point', Object.keys(s.by_source).length >= 2,
       JSON.stringify(s.by_source));
    ck('  and each carries its own hit rate',
       Object.values(s.by_source).every((v) => Number.isFinite(v.asked) && Number.isFinite(v.answered)));

    ck('the failures are listed commonest first',
       s.needs_work[0] && s.needs_work[0].what === 'what did we sell last week' && s.needs_work[0].times === 2,
       JSON.stringify(s.needs_work.slice(0, 2)));
    ck('  and an answered question is not in that list',
       !s.needs_work.some((r) => r.what === 'a lone brief answer'));
}

// ══════════════════════════════════════════════════════════════════════════
section('E — logging can never break answering');
// ══════════════════════════════════════════════════════════════════════════
{
    // record() already swallows its own errors. Prove it, because the wrapper
    // in yardAsk.js is in a finally — a throw there would replace a perfectly
    // good answer with an exception.
    let threw = null;
    try { await askLog.record(null); } catch (e) { threw = e.message; }
    ck('a malformed entry does not throw', threw === null, threw);

    const cfg = require(path.join(ROOT, 'config'));
    const saved = fs.readFileSync(cfg.ASK_LOG_FILE, 'utf8');
    fs.writeFileSync(cfg.ASK_LOG_FILE, '{ this is not json');
    let threw2 = null;
    try { askLog.summary(); } catch (e) { threw2 = e.message; }
    ck('a corrupt log file does not throw on read', threw2 === null, threw2);
    fs.writeFileSync(cfg.ASK_LOG_FILE, saved);

    // And the report itself must survive an empty log rather than dividing by
    // zero — it is the first thing she will run, before there is any data.
    const rpt = fs.readFileSync(path.join(ROOT, 'scripts/ask-report.js'), 'utf8');
    ck('the report handles an empty window', /if \(!s\.questions\)/.test(rpt));
    ck('  and says so plainly rather than printing 0%', /Nothing to read yet/.test(rpt));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
