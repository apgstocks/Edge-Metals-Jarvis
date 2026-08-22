// ── helpers/pendingArbiter.js — "is this an answer, or a new request?" ───────
//
// WHY THIS EXISTS
//
// Jarvis asks a question ("what's the cargo?", "which trucker?", "reply with
// numbers to accept"). Until it gets an answer, that question is an open
// PENDING on the chat. The old rule was blunt: while a pending is open, the
// next message IS the answer. That rule is right most of the time and wrong
// in the one moment that matters — when Apsara changes the subject.
//
// Live examples, all real, all within three days:
//   - review open, she asks "Do we have any booking available for Houston?"
//     → answered with "Reply with numbers (e.g. 1,3), all, or no."
//   - review open, she asks "check whether we received any mail from zimex
//     recently" → same canned nag, question never answered.
//   - cargo-details open, she sends a brand-new quote request → the command
//     got stored as the cargo description.
//
// Her framing (2026-08-22) is the clearest statement of the goal:
// Jarvis should behave like JARVIS in Iron Man. Tony interrupts JARVIS
// mid-task constantly and JARVIS just handles it — answers the new thing,
// keeps the old thread, never once replies "please respond with 1 or 3".
// That single behaviour is most of the gap between what this system does
// and what she is asking for.
//
// WHAT THIS REPLACES
//
// workflow/brain.js's detectFreshCommand — which only recognizes TWO
// hard-coded quote grammars via regex. Anything phrased differently is still
// swallowed. Extending it means writing a new pattern for every phrasing a
// human might use, which is the treadmill Apsara explicitly rejected
// (2026-08-22: "I don't want to hardcode anything. Let AI decide. both are
// same meaning"). Whether a sentence answers a question is a matter of
// MEANING, so it belongs to the model, not to a regex.
//
// DESIGN POSTURE — FAIL SAFE, NOT FAIL SMART
//
// The verdict is only allowed to CHANGE behaviour in one direction. Unless
// the model says NEW_REQUEST with real confidence, the caller keeps doing
// exactly what it does today. UNCLEAR, a low score, a malformed response, a
// timeout, a missing API key and an outright crash all resolve to the same
// place: today's behaviour, unchanged.
//
// That asymmetry is deliberate. The two mistakes are not equal:
//   - Wrongly treating an ANSWER as a new request loses data she typed —
//     a cargo description or container number silently discarded, and the
//     original question asked all over again.
//   - Wrongly treating a NEW REQUEST as an answer produces the nag she is
//     already getting today. Annoying, visible, and she can escape with
//     "cancel".
// The first is worse and invisible, so the bar for NEW_REQUEST is set high
// and everything ambiguous falls back to the safe side.

const { callGeminiJSON } = require('./gemini');

// zod (MIT) — validates the shape of the model's answer. Loaded defensively
// for the same reason chrono is in helpers/time.js: if `npm install` has not
// been run on the VM, this must degrade to the previous hand-rolled checks
// rather than crash Jarvis on startup. A forgotten install step should never
// be an outage on a live ops system.
let VerdictSchema = null;
try {
    const { z } = require('zod');
    VerdictSchema = z.object({
        verdict: z.enum(['ANSWER', 'NEW_REQUEST', 'UNCLEAR']),
        // Gemini occasionally omits confidence entirely, or sends it as a
        // string. Coerce and default rather than failing the whole response
        // over a field that only gates one branch — and clamp to 0..1 so a
        // stray 95 (meaning 95%) can never sail past the 0.75 threshold.
        confidence: z.coerce.number().min(0).max(1).optional().default(0),
        reasoning: z.string().optional().default(''),
    });
} catch (e) {
    console.warn('[ARBITER] zod not installed — using built-in shape checks. Run `npm install` to enable stricter validation.');
}

// Below this, treat the verdict as UNCLEAR regardless of what it claims.
// 0.75 is deliberately stricter than brain.js's own 0.6 SAFE_ACTIONS gate:
// this decision can discard something she typed, so it earns a higher bar.
const MIN_CONFIDENCE = 0.75;

function buildPrompt(messageText, pendingQuestion) {
    return `You are the dispatcher for a freight/export company's WhatsApp assistant. The manager was asked a question and has not answered it yet. A new message just arrived from her. Decide ONE thing: is this new message the ANSWER to the open question, or is she asking for something else entirely?

THE OPEN QUESTION JARVIS ASKED HER:
${pendingQuestion}

HER NEW MESSAGE:
${messageText}

How to decide:
- ANSWER — the message supplies what the question asked for. Judge by meaning, not by format. A cargo description, a weight, a container number, an email address, a company name, a digit, "all", "yes", a correction to a name she got wrong — these answer their respective questions even when phrased casually or incompletely. If it plausibly reads as her responding to what was asked, it is an ANSWER.
- NEW_REQUEST — she has moved on and wants something else: asking about bookings, mail, money, an address, requesting a quote, telling you to send or check something. The giveaway is that it makes complete sense on its own as a fresh instruction or question, and makes no sense as a response to the open question above.
- UNCLEAR — it could genuinely be either, or you cannot tell. Use this freely. It is a safe, useful answer, not a failure.

Critical bias: when torn between ANSWER and NEW_REQUEST, choose ANSWER. Misreading her answer as a new request throws away what she typed and re-asks the same question; misreading a new request as an answer is merely a visible annoyance she can undo. Only choose NEW_REQUEST when the message clearly stands on its own as a different topic.

A question is not an answer. If she is ASKING something (do we have, did we get, who owes, where is, what's the status) and the open question wanted a value, that is NEW_REQUEST — unless the open question itself was a yes/no or a pick-one, where a short reply may well be her choosing.

Return ONLY this JSON, nothing else:
{ "verdict": "ANSWER" | "NEW_REQUEST" | "UNCLEAR", "confidence": 0.0, "reasoning": "one short sentence" }`;
}

// Returns 'ANSWER' | 'NEW_REQUEST' | 'UNCLEAR'.
// NEVER throws and never returns null — every failure path resolves to
// 'UNCLEAR', which callers must treat as "keep today's behaviour".
async function classifyAgainstPending(messageText, pendingQuestion) {
    const text = String(messageText || '').trim();
    if (!text || !pendingQuestion) return 'UNCLEAR';

    // Don't spend a Gemini call on input that cannot be a real new request.
    // A bare digit, "all", "yes"/"no", a couple of characters — these are
    // answer-shaped by construction, and every pending's own parser has
    // already had first refusal at them before this is ever reached.
    if (text.length < 12 || /^[\d\s,.\-]+$/.test(text)) return 'UNCLEAR';

    try {
        // With zod present, a wrong-shaped response burns a retry inside
        // callGeminiJSON instead of arriving here as junk. Without it, the
        // hand-rolled checks below still catch everything they did before —
        // the validation is an upgrade, never a dependency.
        const res = await callGeminiJSON(buildPrompt(text, pendingQuestion), 2, VerdictSchema);
        const verdict = res && typeof res.verdict === 'string' ? res.verdict.toUpperCase().trim() : null;
        if (verdict !== 'ANSWER' && verdict !== 'NEW_REQUEST' && verdict !== 'UNCLEAR') return 'UNCLEAR';

        // Only NEW_REQUEST has to clear the confidence bar, because it is the
        // only verdict that changes what the caller does. ANSWER and UNCLEAR
        // both land on today's behaviour anyway, so gating them buys nothing.
        if (verdict === 'NEW_REQUEST') {
            const conf = typeof res.confidence === 'number' ? res.confidence : 0;
            if (conf < MIN_CONFIDENCE) {
                console.log(`[ARBITER] NEW_REQUEST at ${conf} is below ${MIN_CONFIDENCE} — treating as UNCLEAR`);
                return 'UNCLEAR';
            }
            console.log(`[ARBITER] NEW_REQUEST (${conf}): ${res.reasoning || 'no reasoning given'}`);
        }
        return verdict;
    } catch (err) {
        // Includes the no-API-key case, a network failure, and a Gemini
        // outage. Jarvis must keep working exactly as it does today when the
        // model is unreachable — this feature is an improvement layered on
        // top, never a new dependency for basic operation.
        console.error('[ARBITER] Failed, falling back to existing behaviour:', err.message);
        return 'UNCLEAR';
    }
}

module.exports = { classifyAgainstPending, buildPrompt, MIN_CONFIDENCE };
