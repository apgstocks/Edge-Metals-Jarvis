#!/usr/bin/env node
// ── scripts/log-digest.js — yesterday, as the logs saw it ───────────────────
//
// Apsara, 2026-09-20: "I want to have an agent which reads all the logs and
// suggest improvements next day".
//
//   node scripts/log-digest.js                 # yesterday
//   node scripts/log-digest.js --day 2026-09-19
//   node scripts/log-digest.js --today
//   node scripts/log-digest.js --full          # every problem, not the top 15
//   node scripts/log-digest.js --ai            # add a written summary (Gemini)
//
// READ-ONLY. It opens log files, counts, and prints.
//
// ── WHY THE MODEL IS AN OPTION AND NOT THE PRODUCT ──────────────────────────
// "An agent that suggests improvements" is easy to build badly: hand the log
// to a model, print what it says, and get fluent unfalsifiable advice. The
// first time it invents a problem she stops reading the report, and then the
// report is worth less than nothing because it looks like coverage.
//
// So the facts are computed and printed with or without --ai: what broke, how
// often, when it started, whether it is NEW. The model, when asked for, reads
// those same grouped facts and writes a paragraph. If it is unavailable the
// report is unchanged apart from the paragraph.
//
// ── WHAT MAKES THIS WORTH RUNNING AT ALL ────────────────────────────────────
// On 2026-09-19 every email with an attachment threw, on all three send
// paths, with 134 test files green. `[sale-invoice] send failed: Cannot read
// properties of undefined (reading 'replace')` was in data/logs/pm2-error.log
// the first time anyone pressed Send. Nobody reads that file. She found it.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const cfg = require(path.join(ROOT, 'config'));
const logDigest = require(path.join(ROOT, 'helpers/logDigest'));
const { getLADate } = require(path.join(ROOT, 'helpers/time'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const flag = (f, d) => { const i = argv.indexOf('--' + f); return i === -1 ? d : argv[i + 1]; };

// LA day, like every other date decision in this app (helpers/time.js). A
// report headed "yesterday" that runs on UTC midnight reports half of two days.
const laDay = (offsetDays = 0) => {
    const d = getLADate();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DAY = flag('day', has('today') ? laDay(0) : laDay(-1));
const LOGS = cfg.LOGS_DIR || path.join(cfg.DATA_DIR, 'logs');

const bar = (s = 62) => '  ' + '─'.repeat(s);
const say = (...a) => console.log(...a);

// ── YESTERDAY'S SIGNATURES, TO ANSWER "IS THIS NEW?" ────────────────────────
// A fault that started yesterday is one somebody's change caused yesterday,
// which is the cheapest moment it will ever be to fix. Without a comparison
// every line looks equally old.
const dayBefore = (() => {
    const d = new Date(`${DAY}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
})();

const pm2Files = [path.join(LOGS, 'pm2-out.log'), path.join(LOGS, 'pm2-error.log')];
const lines = logDigest.readLines(pm2Files);

if (!lines.length) {
    say('');
    say('  No pm2 logs found under ' + LOGS);
    say('');
    say('  That is not necessarily a problem — it means this box has not run');
    say('  Jarvis under pm2, or ecosystem.config.js has not been used:');
    say('');
    say('      pm2 start ecosystem.config.js');
    say('');
    process.exit(0);
}

const prev = logDigest.digest(lines, { onDay: dayBefore });
const d = logDigest.digest(lines, { onDay: DAY, previousSignatures: prev.items.map((i) => i.sig) });
const t = logDigest.timings(lines, { onDay: DAY });

let audit = { intents: [], unparsed: 0 };
try { audit = logDigest.decisions(fs.readFileSync(path.join(LOGS, `${DAY}.jsonl`), 'utf8')); }
catch (e) { /* a day with no decisions is a quiet day, not an error */ }

// ── THE REPORT ──────────────────────────────────────────────────────────────
say('');
say(`  JARVIS — ${DAY}`);
say(bar());
say(`  log lines read        ${d.lines_considered}`);
say(`  distinct problems     ${d.distinct_problems}`);
say(`  total occurrences     ${d.total_occurrences}`);
say(`  NEW since ${dayBefore}   ${d.new_today}`);
if (Object.keys(d.by_kind).length) {
    say('');
    for (const [k, n] of Object.entries(d.by_kind).sort((a, b) => b[1] - a[1])) {
        say(`  ${k.padEnd(18)} ${n}`);
    }
}

if (!d.distinct_problems) {
    say('');
    say('  Nothing errored, nothing fell back silently. A clean day.');
} else {
    const shown = has('full') ? d.items : d.items.slice(0, 15);
    say('');
    say('  WORST FIRST');
    say(bar());
    for (const i of shown) {
        const tag = i.is_new ? ' ← NEW' : '';
        say('');
        say(`  [${i.kind}] x${i.count}${tag}`);
        say(`      ${i.why}`);
        say(`      first ${i.first || '?'}   last ${i.last || '?'}   (${i.file})`);
        say(`      ${i.sample.replace(/\s+/g, ' ').slice(0, 180)}`);
        if (i.frame) say(`      ${i.frame}`);
    }
    if (!has('full') && d.items.length > shown.length) {
        say('');
        say(`  … and ${d.items.length - shown.length} more — run with --full`);
    }
}

// ── TIMINGS ─────────────────────────────────────────────────────────────────
// helpers/pdfTiming.js has printed these since 2026-09-16 and nothing has
// ever read one, so "why is generating slow today" has never been answerable
// from data.
if (t.length) {
    say('');
    say('  DOCUMENT GENERATION');
    say(bar());
    for (const x of t) {
        say(`  ${x.label.padEnd(26)} n=${String(x.count).padStart(3)}  `
          + `median ${String(x.median).padStart(5)}ms   max ${String(x.max).padStart(6)}ms   `
          + `${x.total_s}s total`);
    }
}

// ── WHAT THE ASSISTANT DID ──────────────────────────────────────────────────
if (audit.intents.length) {
    say('');
    say('  DECISIONS');
    say(bar());
    for (const i of audit.intents.slice(0, 12)) {
        const by = Object.entries(i.resolvedBy).map(([k, n]) => `${k}=${n}`).join(' ');
        say(`  ${i.intent.padEnd(28)} ${String(i.count).padStart(4)}   ${by}`);
    }
    if (audit.unparsed) say(`  (${audit.unparsed} unreadable line(s) in the audit log)`);
}

// ── AND ONLY THEN, AN OPINION ───────────────────────────────────────────────
// Given the grouped facts above and nothing else — not the raw log, which is
// where a model starts inventing container numbers it half-read.
(async () => {
    if (!has('ai')) {
        say('');
        say('  Add --ai for a written summary of the above.');
        say('  Read-only — nothing was changed.');
        say('');
        return;
    }
    if (!d.distinct_problems) {
        say('');
        say('  Nothing to summarise.');
        say('');
        return;
    }
    const facts = d.items.slice(0, 20).map((i) =>
        `${i.kind} x${i.count}${i.is_new ? ' NEW' : ''}: ${i.sample.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
    const prompt = [
        'These are grouped error signatures from one day of a freight and scrap-metal',
        'trading app. Each line is: kind, how many times, whether it is new, and one sample.',
        '',
        facts,
        '',
        'In at most 150 words: which ONE of these would you fix first, and why.',
        'Refer only to what is above — do not invent details, numbers or causes.',
        'If the evidence does not support a recommendation, say so plainly.',
    ].join('\n');

    say('');
    say('  SUGGESTED, BY THE MODEL — grounded in the grouped facts above,');
    say('  and worth exactly as much as they are.');
    say(bar());
    try {
        const { callGeminiJSON } = require(path.join(ROOT, 'helpers/gemini'));
        const out = await callGeminiJSON(
            prompt + '\n\nReturn ONLY: { "fix_first": "...", "why": "..." }');
        if (out && out.fix_first) {
            say(`  ${String(out.fix_first).trim()}`);
            say('');
            say(`  ${String(out.why || '').trim().replace(/(.{72}\s)/g, '$1\n  ')}`);
        } else {
            say('  The model returned nothing usable. The figures above stand on their own.');
        }
    } catch (e) {
        say(`  Model unavailable (${e.message}). The figures above stand on their own.`);
    }
    say('');
    say('  Read-only — nothing was changed.');
    say('');
})();
