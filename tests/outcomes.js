// ── tests/outcomes.js ──────────────────────────────────────────────────────
// Apsara, 2026-10-08: "make it learn everything ... so it becomes more
// intelligent as days pass by."
//
// Stage 1 of claude/jarvis-learning-plan-for-approval.md. Jarvis recorded
// what it DECIDED and never what HAPPENED: data/labels.jsonl,
// outcomes.jsonl and audit.jsonl were all MISSING -- not empty, absent.
// Every instrument built to measure Jarvis had never produced a reading.
process.env.JARVIS_TEST = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => path.join(__dirname, '..', p);

const cfg = require(R('config.js'));
const REAL = cfg.OUTCOMES_FILE;
let realMtime = null;
try { realMtime = fs.statSync(REAL).mtimeMs; } catch (e) { realMtime = null; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-out-'));
cfg.OUTCOMES_FILE = path.join(TMP, 'outcomes.jsonl');

const oc = require(R('helpers/outcomes.js'));
const O = oc.OUTCOMES;

let pass = 0, fail = 0;
const failures = [];
const ck = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);
const reset = () => { try { fs.unlinkSync(cfg.OUTCOMES_FILE); } catch (e) {} };

// Her real words, from this project's own history.
const JOEYS_PO = {
    ref: 'msg-emi-02', thread: 'thr-1', from: 'Edge Metals Bose <bose@edgemetals.com>',
    subject: 'Fwd: New P.O. (Edge Metal) EMI-02 & 03',
    summary: 'Robert Han from Metalco is sending additional P.O. EMI-02 and EMI-03 for your review.',
    waiting_on: 'her', needs_reply: true, confidence: 0.7, asked_for: 'additional P.O. EMI-02 and EMI-03',
    is_order: false, importance: 'high', caps: ['short body, attachments unread'], surfaced: true, source: 'replyWatch',
};
const TEAM_BOOKING = {
    ref: 'msg-booking', from: 'Accounting Edge <accounts@edgemetals.com>',
    subject: 'Need booking from LA/BUSAN 2 *40 HC',
    summary: 'Accounting needs a booking for 2x40HC from LA to Busan.',
    waiting_on: 'them', needs_reply: false, confidence: 0.8, surfaced: true, source: 'replyWatch',
};

(async () => {
    section('OL — a decision is written down at all');
    reset();
    ck('OL1 a decision is recorded', oc.recordDecision(JOEYS_PO) === true);
    const rows = oc.readAll();
    ck('OL2 one line, of kind "decision"', rows.length === 1 && rows[0].kind === 'decision', JSON.stringify(rows));
    ck('OL3 it keeps the judgement as it was made',
        rows[0].waiting_on === 'her' && rows[0].confidence === 0.7
        && /Robert Han from Metalco/.test(rows[0].summary), JSON.stringify(rows[0]).slice(0, 180));
    // THE FIELD THE WHOLE LOG EXISTS FOR.
    ck('OL4 and whether it ever reached her', rows[0].surfaced === true);
    ck('OL5 a decision with no ref is refused — an outcome could never find it',
        oc.recordDecision({ summary: 'x' }) === false);
    // The email body is NOT stored: a log that accumulates her customers'
    // correspondence is a liability that grows by itself.
    ck('OL6 the email body is not stored', !('body' in rows[0]));

    section('OL — her correction is the label, in her own words');
    reset();
    oc.recordDecision(TEAM_BOOKING);
    // The real words, from 2026-09-17.
    ck('OL7 an outcome is recorded against the decision',
        oc.recordOutcome({ ref: 'msg-booking', outcome: O.IGNORED,
            said: 'they just asked for booking.why it needs to come to whatsapp?no..' }) === true);
    const all = oc.readAll();
    ck('OL8 it is a SECOND line, not an edit of the first',
        all.length === 2 && all[0].kind === 'decision' && all[1].kind === 'outcome',
        JSON.stringify(all.map((r) => r.kind)));
    ck('OL9 her words are kept verbatim — the most valuable column in the file',
        /why it needs to come to whatsapp/.test(all[1].said), all[1].said);
    ck('OL10 an outcome nobody defined is refused, not silently stored',
        oc.recordOutcome({ ref: 'x', outcome: 'sort-of-fine' }) === false);
    ck('OL11 and an outcome with no ref is refused', oc.recordOutcome({ outcome: O.IGNORED }) === false);

    section('OL — joining what Jarvis thought to what she did');
    reset();
    oc.recordDecision(JOEYS_PO);
    oc.recordDecision(TEAM_BOOKING);
    oc.recordOutcome({ ref: 'msg-booking', outcome: O.IGNORED, said: 'this can be ignored' });
    const ps = oc.pairs();
    ck('OL12 every decision appears, with or without an outcome', ps.length === 2);
    const booking = ps.find((p) => p.ref === 'msg-booking');
    const po = ps.find((p) => p.ref === 'msg-emi-02');
    ck('OL13 the corrected one carries her verdict', booking.outcome && booking.outcome.outcome === O.IGNORED);
    ck('OL14 the uncorrected one carries null, not a guess', po.outcome === null);
    // She may dismiss something and act on it a day later. The later act is
    // the truer label.
    oc.recordOutcome({ ref: 'msg-booking', outcome: O.REPLIED, said: 'actually I answered it' });
    ck('OL15 a later outcome supersedes an earlier one',
        oc.pairs().find((p) => p.ref === 'msg-booking').outcome.outcome === O.REPLIED);
    // A rescan re-decides the same email; the newest judgement is the one in
    // force, and the old line stays on disk as history.
    oc.recordDecision({ ...TEAM_BOOKING, confidence: 0.95 });
    ck('OL16 a re-decision supersedes, and the history is still on disk',
        oc.pairs().find((p) => p.ref === 'msg-booking').decision.confidence === 0.95
        && oc.readAll().filter((r) => r.kind === 'decision' && r.ref === 'msg-booking').length === 2);

    section('OL — the two numbers that pull against each other');
    reset();
    // Shown and dismissed = noise. Never shown but she acted = a miss.
    oc.recordDecision({ ...TEAM_BOOKING, ref: 'n1', surfaced: true });
    oc.recordOutcome({ ref: 'n1', outcome: O.IGNORED });
    oc.recordDecision({ ...TEAM_BOOKING, ref: 'n2', surfaced: true });
    oc.recordOutcome({ ref: 'n2', outcome: O.IGNORED });
    oc.recordDecision({ ...JOEYS_PO, ref: 'm1', surfaced: false });
    oc.recordOutcome({ ref: 'm1', outcome: O.REPLIED });
    oc.recordDecision({ ...JOEYS_PO, ref: 'g1', surfaced: true });
    oc.recordOutcome({ ref: 'g1', outcome: O.REPLIED });
    const s = oc.scoreboard();
    ck('OL17 noise is what she saw and did not want', s.noise === 2, JSON.stringify(s));
    ck('OL18 a miss is what she wanted and never saw', s.misses === 1, JSON.stringify(s));
    ck('OL19 a hit is counted separately from both', s.shown_and_replied === 1, JSON.stringify(s));
    ck('OL20 and decisions still awaiting an outcome are not scored as either',
        s.decisions === 4 && s.with_outcome === 4, JSON.stringify(s));

    section('OL — it must never break the pipeline it learns from');
    reset();
    // A truncated last line is what a power cut mid-append leaves behind.
    fs.writeFileSync(cfg.OUTCOMES_FILE, JSON.stringify({ kind: 'decision', ref: 'a', surfaced: true }) + '\n{"kind":"decis');
    ck('OL21 a half-written last line does not poison the file',
        oc.readAll().length === 1 && oc.readAll()[0].ref === 'a', JSON.stringify(oc.readAll()));
    // Unwritable: the caller gets false and carries on. A learning log that
    // can break the scan is not worth having.
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const good = cfg.OUTCOMES_FILE;
    cfg.OUTCOMES_FILE = path.join(blocker, 'outcomes.jsonl');
    ck('OL22 an unwritable log returns false and does not throw',
        oc.recordDecision(JOEYS_PO) === false);
    ck('OL23 and reading it returns nothing rather than throwing', oc.readAll().length === 0);
    cfg.OUTCOMES_FILE = good;

    section('OL — THIS TEST MUST NOT TOUCH HER DATA');
    let nowMtime = null;
    try { nowMtime = fs.statSync(REAL).mtimeMs; } catch (e) { nowMtime = null; }
    ck('OL24 the real outcomes.jsonl is untouched', nowMtime === realMtime,
        `was ${realMtime}, now ${nowMtime}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
