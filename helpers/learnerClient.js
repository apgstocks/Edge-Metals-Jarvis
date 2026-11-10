// ── helpers/learnerClient.js — Jarvis's side of the learner (shadow only) ─────────────────────
// Apsara, 2026-11-10: "I can't keep on teaching it based on fixed rules" -> the learner (learner/, Python, DSPy) predicts what she
// would decide from her OWN past decisions, and we measure how often that matches what really happened.
//
// SHADOW ONLY, AND FAIL-SILENT. Off unless JARVIS_LEARNER_URL is set. A call has a short timeout and NEVER throws: if the service is
// down, slow or wrong, Jarvis behaves exactly as it did. The return value is information; nothing here may change a decision.
// Whether to ever ACT on a prediction is a later step, per kind of decision, with her yes.
const TIMEOUT_MS = Number(process.env.JARVIS_LEARNER_TIMEOUT_MS) || 2500;
const url = () => String(process.env.JARVIS_LEARNER_URL || '').replace(/\/+$/, '');
const on = () => !!url() && !!process.env.JARVIS_LEARNER_TOKEN;

async function call(method, p, body) {
    if (!on()) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url() + p, { method, signal: ctl.signal,
            headers: { 'Content-Type': 'application/json', 'X-Learner-Token': process.env.JARVIS_LEARNER_TOKEN },
            body: body ? JSON.stringify(body) : undefined });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) { return null; } finally { clearTimeout(timer); }
}

/** Predict. null when off or unreachable; otherwise {decision|null, confidence, reason, abstained}. */
const judge = (kind, caseData, ref) => call('POST', '/judge', { kind, case: caseData, ref: ref == null ? null : String(ref) });
/** She decided: this is now an example. */
const example = (kind, caseData, decision, { ref, reason, by } = {}) => call('POST', '/example', { kind, case: caseData, decision, ref, reason, by });
/** What really happened for a case we predicted. */
const actual = (ref, decision) => call('POST', '/actual', { ref: String(ref), decision });
const report = () => call('GET', '/report');

module.exports = { judge, example, actual, report, on };
