// ── helpers/outcome.js — Outcome ledger (Stage 0 of the learning layer) ──────
// WHY THIS EXISTS
// helpers/auditlog.js records what Jarvis DECIDED: intent, resolvedBy,
// confidence, actionTaken. It records nothing about what happened NEXT —
// whether the manager approved it, corrected it, cancelled it, or silently
// asked again. Without that column there is no label, and without a label
// nothing downstream can be fitted, evaluated, or even measured. Every
// "learning" proposal since August has been blocked on this one missing field.
//
// This module adds it, and nothing else. It does not change any decision, any
// threshold, or any confirmation prompt. It is a recorder.
//
// DESIGN NOTES THAT ARE LOAD-BEARING — do not "tidy" these away:
//
//   source: 'outcome'  — deliberately NOT 'core'. helpers/dailyLearning.js's
//   findGaps() selects `e.source === 'core'` AND a manager/team senderRole
//   before anything reaches the rule-drafting prompt (the MemPoison fix of
//   2026-08-25). Outcome rows carry no sender text and must never be eligible
//   to seed a fact. Renaming this string to 'core' silently reopens that hole.
//
//   No join key is written into brain.js. Outcome rows carry chatId and a
//   timestamp; scripts/label.js pairs each one to the most recent preceding
//   'core' decision on the same chatId. That keeps the message hot path
//   completely untouched — brain.js is not edited by Stage 0 at all.
//
//   Fire-and-forget, same posture as auditlog.js and memory.js: a recording
//   failure must never block or crash message handling.

const { appendAuditLog } = require('./auditlog');

// Closed set on purpose. A free-text outcome column becomes unlabelable within
// a month — that is how these datasets rot.
const OUTCOMES = new Set([
    'approved',   // she said yes to exactly what was proposed, no change
    'rejected',   // she said no / cancelled the proposal outright
    'corrected',  // she supplied a different value instead of yes/no
    'expired',    // the pending timed out unanswered (30-min auto-expiry)
    'superseded', // a fresh command displaced the pending before she answered
]);

function normaliseTarget(t) {
    return String(t == null ? '' : t).toLowerCase().trim() || null;
}

// decidedAt: ISO string of when the proposal was made, when the caller has it.
// Latency is the single most useful derived signal after the label itself — a
// three-second yes and a four-hour yes are not the same evidence.
// NOTE on the signature: this destructures INSIDE the try, not in the
// parameter list. A parameter default (`= {}`) only fires on `undefined` — a
// literal `null` still throws on destructure, which would break the
// fire-and-forget contract at exactly the call site most likely to pass one.
// Caught by tests/outcome-labels.js assertion 3.
async function recordOutcome(opts) {
    try {
        const {
            chatId,
            decisionType,      // the pending type, e.g. 'confirm_forward'
            actionType,        // the trust-ledger action, e.g. 'forward' | 'assign'
            target,            // trucker/supplier name, or null
            outcome,
            decidedAt = null,
            meta = null,
        } = (opts && typeof opts === 'object') ? opts : {};
        if (!OUTCOMES.has(outcome)) {
            console.error(`[OUTCOME] refused unknown outcome "${outcome}" — not recorded`);
            return;
        }
        let latencyMs = null;
        if (decidedAt) {
            const t = new Date(decidedAt).getTime();
            if (Number.isFinite(t)) latencyMs = Math.max(0, Date.now() - t);
        }
        await appendAuditLog({
            source      : 'outcome',
            chatId      : chatId || null,
            decisionType: decisionType || null,
            actionType  : actionType || null,
            target      : normaliseTarget(target),
            outcome,
            latencyMs,
            ...(meta && typeof meta === 'object' ? { meta } : {}),
        });
    } catch (err) {
        console.error('[OUTCOME] record failed:', err.message);
    }
}

module.exports = { recordOutcome, OUTCOMES };
