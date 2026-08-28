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

// One-time move of anything written before the folder changed to
// data/yard/log/ on 2026-08-29. Runs at most once per process and only if the
// old directory is actually there, so it costs nothing on a fresh install.
//
// MOVES rather than copies, and never overwrites a file that already exists at
// the destination — a transcript is a record, and a migration that can silently
// replace one is worse than one that leaves a stray file behind.
let migrated = false;
function migrateLegacyDir() {
    if (migrated) return;
    migrated = true;
    try {
        const legacy = path.join(path.dirname(cfg.YARD_DIR), 'yard-chat');
        if (!fs.existsSync(legacy) || legacy === cfg.YARD_CHAT_DIR) return;
        fs.mkdirSync(cfg.YARD_CHAT_DIR, { recursive: true });
        let moved = 0;
        for (const f of fs.readdirSync(legacy)) {
            if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
            const to = path.join(cfg.YARD_CHAT_DIR, f);
            if (fs.existsSync(to)) continue;
            fs.renameSync(path.join(legacy, f), to);
            moved += 1;
        }
        if (moved) console.log(`[YARD-CHAT] moved ${moved} transcript(s) into ${cfg.YARD_CHAT_DIR}`);
        if (!fs.readdirSync(legacy).length) fs.rmdirSync(legacy);
    } catch (err) {
        console.warn('[YARD-CHAT] could not move the old transcripts:', err.message);
    }
}

// Appends one exchange. Returns the file it went to, or null if it could not
// be written — callers ignore it; it exists for the tests.
function logExchange(entry = {}) {
    try {
        migrateLegacyDir();
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
        queueDriveSync(localDay(now));
        return logPathFor(localDay(now));
    } catch (err) {
        console.warn('[YARD-CHAT] could not write the transcript:', err.message);
        return null;
    }
}

// Which days have a transcript, newest first.
function listDays() {
    try {
        migrateLegacyDir();
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

// ── Mirror to the Drive yard folder ────────────────────────────────────────
// Per Apsara 2026-08-29: the log folder belongs inside the yard folder in
// Drive. The LOCAL jsonl stays the thing that is appended to — appending over
// the network on every message would make answering wait on Drive, and a bad
// signal at the yard would lose lines. This mirrors the day's file up
// afterwards, replacing it, so the newest upload simply wins.
//
// DEBOUNCED. A conversation is a burst of messages; uploading the whole file
// after each one would be a dozen uploads of nearly identical content. One
// upload a minute after the talking stops covers it.
//
// FAIL SOFT, like everything else here. No Drive, no credentials, no signal —
// the local transcript is still written and the question is still answered.
const SYNC_DEBOUNCE_MS = 60 * 1000;
let syncTimer = null;
let syncing = false;

async function syncDayToDrive(day) {
    const target = day || localDay();
    const file = logPathFor(target);
    if (!fs.existsSync(file)) return null;
    if (syncing) return null;                 // never overlap two uploads
    syncing = true;
    try {
        const { uploadYardChatLog } = require('./drive');
        const out = await uploadYardChatLog(target, fs.readFileSync(file));
        console.log(`[YARD-CHAT] mirrored ${target}.jsonl to the Drive yard folder/log`);
        return out;
    } catch (err) {
        console.warn(`[YARD-CHAT] could not mirror ${target}.jsonl to Drive:`, err.message);
        return null;
    } finally {
        syncing = false;
    }
}

function queueDriveSync(day) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncDayToDrive(day).catch(() => {}); }, SYNC_DEBOUNCE_MS);
    // unref so a pending mirror can never hold the process open — it matters
    // for the test suite and for a clean shutdown.
    if (syncTimer.unref) syncTimer.unref();
}

module.exports = { logExchange, listDays, readDay, localDay, logPathFor, syncDayToDrive };
