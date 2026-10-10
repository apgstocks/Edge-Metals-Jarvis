// ── helpers/outcomes.js ────────────────────────────────────────────────────
//
// Apsara, 2026-10-08: "make it learn everything ... so it becomes more
// intelligent as days pass by."
//
// STAGE 1 OF claude/jarvis-learning-plan-for-approval.md, and nothing else in
// that plan is possible without it.
//
// WHAT WAS MISSING. Jarvis records what it DECIDED and never what HAPPENED.
// data/labels.jsonl, outcomes.jsonl and audit.jsonl were all MISSING -- not
// empty, absent. Every instrument built to measure Jarvis had never produced
// a reading. So improvement only ever happened when she complained and a rule
// got written by hand, which is the real reason it does not feel intelligent.
//
// The signal is already in front of us and being thrown away. "this can be
// ignored" and "they just asked for booking, why it needs to come to
// whatsapp?" are labelled training examples; today they exist only in a chat
// log that nothing reads.
//
// ── APPEND-ONLY, AND THAT IS THE WHOLE DESIGN ─────────────────────────────
// Every data-loss scar in this repo is one write clobbering another:
// saveStore's field allowlist has silently eaten six fields, and mutateJson
// contends on a lock. A log that is only ever APPENDED to cannot clobber
// anything, needs no lock, and survives two processes writing at once --
// POSIX guarantees an O_APPEND write under the pipe-buffer size is atomic,
// and these lines are a few hundred bytes.
//
// A correction is never an edit to an earlier line. It is a NEW line that
// refers to it. The history of what Jarvis thought is as valuable as the
// verdict, and an edit would destroy it.
//
// ── WHAT IS NOT STORED ────────────────────────────────────────────────────
// Not the email body. The message id is enough to re-read it, and a log that
// accumulates her customers' correspondence is a liability that grows by
// itself. Fields, ids and verdicts only.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const MAX_BYTES = 8 * 1024 * 1024;   // one generation kept, same as crashlog

// Every line carries a kind. Decisions and outcomes are separate kinds so a
// reader can tell "what Jarvis thought" from "what she did" without guessing,
// and so a new outcome kind never invalidates old decisions.
const DECISION = 'decision';
const OUTCOME = 'outcome';

// The outcomes that actually exist as signals in this system today. Listed
// explicitly rather than left free-text: an open vocabulary becomes nine
// spellings of the same thing and then nothing can be counted.
const OUTCOMES = Object.freeze({
    REPLIED: 'replied',            // she answered the mail -- it mattered
    IGNORED: 'ignored',            // "ignore 3" -- shown and should not have been
    CORRECTED: 'corrected',        // she changed a figure or a reading
    APPROVED: 'approved',          // a drafted document went out on her yes
    DECLINED: 'declined',          // she said no to a draft
    EXPIRED: 'expired',            // nothing happened before it went stale
    MISSED: 'missed',              // she acted on mail Jarvis never surfaced
});

function rotateIfBig() {
    try {
        const st = fs.statSync(cfg.OUTCOMES_FILE);
        if (st.size < MAX_BYTES) return;
        fs.renameSync(cfg.OUTCOMES_FILE, cfg.OUTCOMES_FILE + '.1');
    } catch (e) { /* absent, or cannot rotate: appending still works */ }
}

// Never throws, never blocks a caller. A learning log that can break the
// pipeline it learns from is not worth having -- the same rule the heartbeat
// follows, for the same reason.
function append(row) {
    try {
        rotateIfBig();
        fs.mkdirSync(path.dirname(cfg.OUTCOMES_FILE), { recursive: true });
        fs.appendFileSync(cfg.OUTCOMES_FILE, JSON.stringify(row) + '\n');
        return true;
    } catch (e) {
        console.warn('[OUTCOMES] could not append (non-fatal):', e.message);
        return false;
    }
}

// ── RECORDING A DECISION ──────────────────────────────────────────────────
// `ref` is what an outcome will later point at. The Gmail message id is the
// only identifier that is stable across scans, restarts and digests -- a
// digest index is not (it is renumbered every digest) and neither is an
// array position.
function recordDecision(d) {
    if (!d || !d.ref) return false;
    return append({
        kind: DECISION,
        at: new Date().toISOString(),
        ref: String(d.ref),
        thread: d.thread || null,
        from: d.from || null,
        subject: (d.subject || '').slice(0, 160) || null,
        // The judgement, as it was made. Enough to retrieve a similar case
        // later and show what Jarvis thought at the time.
        summary: (d.summary || '').slice(0, 300) || null,
        waiting_on: d.waiting_on || null,
        needs_reply: d.needs_reply === true,
        confidence: typeof d.confidence === 'number' ? d.confidence : null,
        asked_for: (d.asked_for || '') || null,
        is_order: d.is_order === true,
        importance: d.importance || null,
        caps: Array.isArray(d.caps) ? d.caps.slice(0, 6) : null,
        // THE FIELD THE WHOLE LOG EXISTS FOR. Whether it reached her at all:
        // a wrong decision that was never shown and a wrong decision she had
        // to correct are different failures with different fixes.
        surfaced: d.surfaced === true,
        source: d.source || null,
    });
}

// ── RECORDING WHAT SHE DID ────────────────────────────────────────────────
function recordOutcome(o) {
    if (!o || !o.ref || !o.outcome) return false;
    if (!Object.values(OUTCOMES).includes(o.outcome)) {
        console.warn(`[OUTCOMES] refusing an unknown outcome "${o.outcome}" — add it to OUTCOMES first`);
        return false;
    }
    return append({
        kind: OUTCOME,
        at: new Date().toISOString(),
        ref: String(o.ref),
        outcome: o.outcome,
        // Her own words when there are any. The most valuable column in the
        // file: "they just asked for booking.why it needs to come to
        // whatsapp?" explains a correction in a way no enum can.
        said: (o.said || '').slice(0, 300) || null,
        by: o.by || null,
        detail: (o.detail || '') || null,
    });
}

function readAll({ limit = 0 } = {}) {
    let text = '';
    try { text = fs.readFileSync(cfg.OUTCOMES_FILE, 'utf8'); } catch (e) { return []; }
    const rows = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        // A truncated last line (power cut mid-append) must not poison the
        // whole file. Skip it and keep every good row.
        try { rows.push(JSON.parse(t)); } catch (e) { /* skip */ }
    }
    return limit > 0 ? rows.slice(-limit) : rows;
}

// Joins each decision to the outcomes that came after it. The LAST outcome
// for a ref wins: she may ignore an item and then reply to it a day later,
// and the later act is the truer label.
function pairs({ limit = 0 } = {}) {
    const rows = readAll();
    const decisions = new Map();
    const outcomes = new Map();
    for (const r of rows) {
        if (r.kind === DECISION) decisions.set(r.ref, r);          // a rescan re-decides; the newest stands
        else if (r.kind === OUTCOME) outcomes.set(r.ref, r);
    }
    const out = [];
    for (const [ref, d] of decisions) out.push({ ref, decision: d, outcome: outcomes.get(ref) || null });
    return limit > 0 ? out.slice(-limit) : out;
}

// What the log can already tell her, in numbers rather than a feeling. This
// is the thing that was impossible before: a count of how often Jarvis was
// right, measured against what she actually did.
function scoreboard({ limit = 0 } = {}) {
    const ps = pairs({ limit });
    const s = {
        decisions: ps.length, with_outcome: 0, surfaced: 0,
        shown_and_ignored: 0, shown_and_replied: 0,
        not_shown_but_acted: 0, approved: 0, declined: 0, corrected: 0,
    };
    for (const p of ps) {
        if (p.decision.surfaced) s.surfaced++;
        if (!p.outcome) continue;
        s.with_outcome++;
        const o = p.outcome.outcome;
        if (o === OUTCOMES.IGNORED && p.decision.surfaced) s.shown_and_ignored++;
        if (o === OUTCOMES.REPLIED && p.decision.surfaced) s.shown_and_replied++;
        if ((o === OUTCOMES.REPLIED || o === OUTCOMES.MISSED) && !p.decision.surfaced) s.not_shown_but_acted++;
        if (o === OUTCOMES.APPROVED) s.approved++;
        if (o === OUTCOMES.DECLINED) s.declined++;
        if (o === OUTCOMES.CORRECTED) s.corrected++;
    }
    // The two numbers that matter, and they pull against each other: noise is
    // what she sees and did not want, misses are what she wanted and never
    // saw. A system can always cut one by raising the other.
    s.noise = s.shown_and_ignored;
    s.misses = s.not_shown_but_acted;
    return s;
}

module.exports = {
    recordDecision, recordOutcome, readAll, pairs, scoreboard,
    OUTCOMES, DECISION, OUTCOME, MAX_BYTES,
};
