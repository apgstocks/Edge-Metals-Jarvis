// ── helpers/yardChatLog.js — a daily transcript of the yard assistant ───────
//
// Per Apsara 2026-08-29: "keep on storing the conversations of yard assistant
// somewhere. so per day one log."
//
// ONE FILE PER DAY, and JSON LINES rather than a JSON array.
//
// A transcript only ever grows. A single .json array has to be read in full,
// parsed, appended to and rewritten in full on every single message — which
// gets slower all year and, worse, turns every append into a moment where a
// crash can truncate the whole history. JSONL appends one line and touches
// nothing that came before, so a failure can cost at most the line being
// written. Reading a day back is one small file rather than a year of them.
//
// BEST EFFORT, ALWAYS. Logging must never break answering: every call here is
// wrapped, and a failure is reported to the server console and then dropped.
// A lost log line is a nuisance; a question that errors because the log was
// unwritable is a broken feature.
//
// This is a record of what was ASKED and ANSWERED — not a cache. Nothing reads
// it back to shape a reply, so it cannot influence future answers.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// Local date, not UTC. new Date().toISOString() rolls over at midnight UTC,
// which is early evening in Texas — an afternoon's conversation would be split
// across two files and "today's log" would be the wrong one for several hours
// of every working day.
function localDay(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function logPathFor(day) {
    return path.join(cfg.YARD_CHAT_DIR, `${day}.jsonl`);
}

// Appends one exchange. Returns the file it went to, or null if it could not
// be written — callers ignore it; it exists for the tests.
function logExchange(entry = {}) {
    try {
        if (!fs.existsSync(cfg.YARD_CHAT_DIR)) fs.mkdirSync(cfg.YARD_CHAT_DIR, { recursive: true });
        const now = new Date();
        const row = {
            at: now.toISOString(),
            question: String(entry.question || ''),
            answer: String(entry.answer || ''),
            // Whether the assistant reckoned the data covered the question.
            // Worth keeping: a run of false is the signal that the brief is
            // missing something people keep asking for — which is exactly how
            // the missing payment dates were found.
            have_data: entry.have_data !== false,
            ok: entry.ok !== false,
            asked_by: entry.role || null,
            // Which client, so a phone-only problem is separable from the
            // website without guessing.
            source: entry.source || null,
        };
        fs.appendFileSync(logPathFor(localDay(now)), JSON.stringify(row) + '\n', 'utf8');
        return logPathFor(localDay(now));
    } catch (err) {
        console.warn('[YARD-CHAT] could not write the transcript:', err.message);
        return null;
    }
}

// Which days have a transcript, newest first.
function listDays() {
    try {
        return fs.readdirSync(cfg.YARD_CHAT_DIR)
            .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
            .map((f) => f.replace(/\.jsonl$/, ''))
            .sort()
            .reverse();
    } catch (err) { return []; }
}

// One day's conversation, oldest first — the order it happened in.
//
// A malformed line is SKIPPED rather than aborting the read. A single bad
// append (a crash mid-write) should cost that one line, not the whole day's
// transcript, which is the entire reason for choosing JSONL.
function readDay(day) {
    try {
        const file = logPathFor(String(day || '').trim());
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
    } catch (err) { return []; }
}

module.exports = { logExchange, listDays, readDay, localDay, logPathFor };
