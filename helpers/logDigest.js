// ── helpers/logDigest.js — what yesterday's logs are trying to tell her ─────
//
// Apsara, 2026-09-20: "I want to have an agent which reads all the logs and
// suggest improvements next day".
//
// ── WHY THIS IS WORTH BUILDING, WITH TODAY AS THE EVIDENCE ──────────────────
// On 2026-09-19 every email with an attachment threw — this screen, the
// WhatsApp "send the documents for X", and the proforma send — because
// buildMimeMessage read a property nothing had ever set. 134 test files were
// green. It was found when she pressed Send and read the error to me.
//
// The log had it. `[sale-invoice] send failed: Cannot read properties of
// undefined` was sitting in data/logs/pm2-error.log the first time anyone
// tried. Nobody reads that file, so the first reader was her.
//
// ── EVIDENCE FIRST, OPINION LAST ────────────────────────────────────────────
// The temptation with "an agent that suggests improvements" is to hand a log
// to a model and print what it says. That produces confident, fluent,
// unfalsifiable advice, and the day it invents a problem is the day she stops
// reading the report.
//
// So this file computes FACTS: what errored, how many times, when it started,
// whether it is new since yesterday. A model may summarise those facts
// afterwards (see scripts/log-digest.js), clearly marked, and if the model is
// unavailable the report is still worth reading. The numbers are the product.
//
// ── THE MARKERS THAT MATTER MOST ARE NOT ERRORS ─────────────────────────────
// This codebase is unusually good about naming its own silent failures — the
// paths where something went wrong and the caller carried on with plausible
// data. `[JSON] Save failed`, `wrote WITHOUT the lock`, `non-fatal`,
// `could not read payments`. Those never reach a user as an error, which is
// exactly why they need reading. They are ranked above ordinary exceptions.

const fs = require('fs');
const path = require('path');

// ── ONE SIGNATURE PER KIND OF PROBLEM ───────────────────────────────────────
// Ten thousand lines of "failed for HMMU7060866", "failed for TCLU9988776" is
// ONE problem, not ten thousand. Numbers, ids, container numbers, paths,
// hex blobs and timings are replaced so the same fault collapses to one row
// with a count — which is also what makes "is this new?" answerable.
function signature(line) {
    return String(line)
        .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<ts>')
        .replace(/\b[A-Z]{4}\d{7}\b/g, '<container>')
        .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
        .replace(/\/[\w./-]{8,}/g, '<path>')
        .replace(/\b\d+(\.\d+)?ms\b/g, '<ms>')
        .replace(/\b\d[\d,]*(\.\d+)?\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

// ── WHAT COUNTS AS WORTH REPORTING ──────────────────────────────────────────
// Ordered: the first match wins, so a line that is both an error AND a known
// silent-failure marker is reported as the silent failure, which is the more
// useful thing to know about it.
//
// `weight` is how far up the report it goes. It is not a severity score
// pretending to be science — it is a statement about which of these she would
// want to read first, and it is written down so it can be argued with.
const KINDS = [
    {
        kind: 'lost-write',
        weight: 100,
        why: 'Something was saved and may not have been. This is the one that loses her data.',
        test: /\[JSON\] Save failed|wrote WITHOUT the lock|Unlocked fallback also failed/i,
    },
    {
        kind: 'silent-fallback',
        weight: 80,
        why: 'A failure that was swallowed on purpose so the request could continue. Nobody saw it.',
        test: /non-fatal|falling back|could not read|failed to save|Failed to save|skipped a message|fail(ed)? soft/i,
    },
    {
        kind: 'crash',
        weight: 70,
        why: 'An unhandled throw. pm2 restarts the process; the request that caused it did not finish.',
        test: /SUITE CRASHED|UnhandledPromiseRejection|FATAL|Error: .*\n?\s+at /i,
    },
    {
        kind: 'error',
        weight: 50,
        why: 'A route or job reported a failure.',
        test: /\berror\b|\bfailed\b|\bthrew\b|cannot read properties|is not a function|undefined/i,
    },
    {
        kind: 'warning',
        weight: 20,
        why: 'Logged as worth noticing but not a failure.',
        test: /\bwarn(ing)?\b|does not fit|still does not/i,
    },
];

function classify(line) {
    for (const k of KINDS) if (k.test.test(line)) return k;
    return null;
}

// pm2 writes `2026-09-19T05:30:56: the line` when time:true. Not every line
// has one (a stack trace's continuation lines do not), so a missing timestamp
// inherits the last one seen rather than being dropped.
const TS = /^(\d{4}-\d{2}-\d{2}[T ][\d:]{8})/;

// A stack frame, with or without pm2's timestamp in front of it.
const FRAME = /^(\d{4}-\d{2}-\d{2}[T ][\d:]{8}:?\s*)?\s+at\s+\S/;

// ── READING A DAY ───────────────────────────────────────────────────────────
// `files` is injected so this is testable without a log directory, and so the
// caller decides which day's files to open — the pm2 logs are one long file,
// the audit log is one per day, and only the caller knows which is wanted.
function readLines(files) {
    const out = [];
    for (const f of files) {
        let text;
        try { text = fs.readFileSync(f, 'utf8'); }
        catch (e) { continue; }          // a log that is not there is not an error
        for (const raw of text.split('\n')) {
            if (!raw.trim()) continue;
            out.push({ file: path.basename(f), raw });
        }
    }
    return out;
}

// ── THE DIGEST ──────────────────────────────────────────────────────────────
// `onDay` is a YYYY-MM-DD string; lines outside it are ignored, because a
// report headed "yesterday" that quietly includes last month is one she will
// act on wrongly exactly once.
function digest(lines, { onDay = null, previousSignatures = [] } = {}) {
    const seenBefore = new Set(previousSignatures);
    const groups = new Map();
    let stamp = null;
    let considered = 0;
    let lastErr = null;

    for (const { file, raw } of lines) {
        const m = TS.exec(raw);
        if (m) stamp = m[1];
        const day = stamp ? stamp.slice(0, 10) : null;
        if (onDay && day && day !== onDay) continue;
        // A line before the first timestamp in the file has no day at all.
        // Counted, never attributed: guessing it belongs to `onDay` is how a
        // report about Tuesday quietly includes Monday's crash.
        if (onDay && !day) continue;
        considered += 1;

        // ── A STACK FRAME BELONGS TO THE ERROR ABOVE IT ─────────────────
        // "Cannot read properties of undefined" is not actionable; the same
        // message plus "at buildMimeMessage (helpers/gmail.js:487)" is the
        // whole diagnosis. pm2 writes each frame as its own timestamped line,
        // so without this the one useful part of an exception is either
        // dropped or counted as a separate problem.
        //
        // Only the FIRST frame is kept. A forty-frame trace in a daily report
        // is a wall she scrolls past, and the first frame is where it threw.
        if (FRAME.test(raw)) {
            if (lastErr && !lastErr.frame) {
                lastErr.frame = raw.replace(TS, '').replace(/^:\s*/, '').trim().slice(0, 160);
            }
            continue;
        }

        const kind = classify(raw);
        if (!kind) { lastErr = null; continue; }

        const sig = signature(raw.replace(TS, '').replace(/^:\s*/, ''));
        if (!groups.has(sig)) {
            groups.set(sig, {
                sig, kind: kind.kind, weight: kind.weight, why: kind.why,
                count: 0, first: stamp, last: stamp, file,
                sample: raw.slice(0, 400),
                is_new: !seenBefore.has(sig),
            });
        }
        const g = groups.get(sig);
        g.count += 1;
        g.last = stamp || g.last;
        lastErr = g;
    }

    // ── THE ORDER SHE SHOULD READ THEM IN ───────────────────────────────
    // Weight first, then NEW before familiar, then by count. New matters
    // because a fault that started yesterday is one somebody's change caused
    // yesterday, and that is the cheapest possible moment to fix it.
    const items = [...groups.values()].sort((a, b) =>
        (b.weight - a.weight)
        || ((b.is_new ? 1 : 0) - (a.is_new ? 1 : 0))
        || (b.count - a.count));

    const byKind = {};
    for (const i of items) byKind[i.kind] = (byKind[i.kind] || 0) + i.count;

    return {
        day: onDay,
        lines_considered: considered,
        distinct_problems: items.length,
        total_occurrences: items.reduce((t, i) => t + i.count, 0),
        new_today: items.filter((i) => i.is_new).length,
        by_kind: byKind,
        items,
    };
}

// ── TIMINGS, WHICH ARE A DIFFERENT QUESTION ─────────────────────────────────
// helpers/pdfTiming.js already prints `[PDF-TIME] invoice both total 812ms —
// …`. Nothing reads it, so "why is generating slow today" has never once been
// answerable from data. Min/median/max per label, and the count, so a slow
// day is distinguishable from a slow document.
function timings(lines, { onDay = null } = {}) {
    const byLabel = new Map();
    let stamp = null;
    for (const { raw } of lines) {
        const m = TS.exec(raw);
        if (m) stamp = m[1];
        if (onDay && (!stamp || stamp.slice(0, 10) !== onDay)) continue;
        const t = /\[PDF-TIME\]\s+(.+?)\s+total\s+(\d+)ms/.exec(raw);
        if (!t) continue;
        const label = t[1].trim();
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label).push(Number(t[2]));
    }
    const out = [];
    for (const [label, ms] of byLabel) {
        ms.sort((a, b) => a - b);
        out.push({
            label, count: ms.length,
            min: ms[0], median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1],
            total_s: Math.round(ms.reduce((t, x) => t + x, 0) / 100) / 10,
        });
    }
    return out.sort((a, b) => b.median - a.median);
}

// ── WHAT THE ASSISTANT ACTUALLY DID ─────────────────────────────────────────
// The audit log is one JSON object per decision. Grouped by intent and by how
// it was resolved, because "the model guessed 40 times yesterday" and "the
// model guessed twice" are different businesses.
function decisions(jsonlText) {
    const byIntent = new Map();
    let unparsed = 0;
    for (const line of String(jsonlText || '').split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch (err) { unparsed += 1; continue; }
        const intent = String(e.intent || e.action_taken || 'unknown');
        if (!byIntent.has(intent)) byIntent.set(intent, { intent, count: 0, resolvedBy: {} });
        const g = byIntent.get(intent);
        g.count += 1;
        const by = String(e.resolvedBy || 'unknown');
        g.resolvedBy[by] = (g.resolvedBy[by] || 0) + 1;
    }
    return {
        unparsed,
        intents: [...byIntent.values()].sort((a, b) => b.count - a.count),
    };
}

module.exports = { signature, classify, digest, timings, decisions, readLines, KINDS, TS };
