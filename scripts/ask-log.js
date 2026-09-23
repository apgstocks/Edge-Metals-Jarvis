#!/usr/bin/env node
// ── scripts/ask-log.js — read the question log ─────────────────────────────
//
// After a week of asking Jarvis things, this is the page to read. It says how
// many questions were answered, how many it could not answer, what they cost
// in model calls, and — the part that matters — THE LIST OF QUESTIONS IT
// FAILED, most frequent first. Each of those is one line in EXAMPLES in
// helpers/data/askData.js away from working.
//
//   node scripts/ask-log.js                  everything on file
//   node scripts/ask-log.js --since=2026-09-20
//   node scripts/ask-log.js --recent=30      the last 30 questions in order
const path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };

const askLog = require(path.join(ROOT, 'helpers/data/askLog'));
const since = arg('since', null);
const s = askLog.summary({ since });

if (!s.questions) {
    console.log(`\nNo questions logged${since ? ` since ${since}` : ''} yet. Ask Jarvis something like "how much do we owe our suppliers".`);
    process.exit(0);
}

console.log(`\n${s.questions} questions${since ? ` since ${since}` : ''} (${s.first_at ? s.first_at.slice(0, 10) : '?'} → ${s.last_at ? s.last_at.slice(0, 10) : '?'})`);
console.log(`  answered ${s.by.answered} · nothing matched ${s.by.nothing_matched} · could not answer ${s.by.could_not_answer}`
    + ` · sent to Scout ${s.by.yard} · asked her back ${s.by.unclear} · broke ${s.by.failed}`);
console.log(`  ${s.model_calls} model calls · ${s.repaired} queries needed a second try · ${s.avg_ms === null ? '?' : s.avg_ms}ms average`);

if (s.tables_used.length) {
    console.log(`\nLedgers used: ${s.tables_used.map((t) => `${t.what} ${t.times}`).join(' · ')}`);
}
if (s.needs_work.length) {
    console.log('\nCouldn\'t answer these — each one is a line in EXAMPLES in helpers/data/askData.js:');
    for (const f of s.needs_work) console.log(`  ${String(f.times).padStart(3)}×  ${f.what}`);
} else {
    console.log('\nNothing failed. Either it is working or nobody has asked it anything hard yet.');
}

const recent = Number(arg('recent', 0));
if (recent) {
    console.log(`\nLast ${recent}:`);
    for (const r of askLog.recent(recent)) {
        console.log(`  ${r.at.slice(5, 16).replace('T', ' ')} [${r.outcome}${r.repaired ? ', repaired' : ''}] ${r.question}`);
        if (r.sql) console.log(`      ${r.sql.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
}
console.log('');
