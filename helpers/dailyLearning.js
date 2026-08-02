// ── helpers/dailyLearning.js — Nightly pattern review → candidate facts ─────
// Reads the day's append-only audit log (helpers/auditlog.js), looks for
// recurring failure patterns (repeated NEED_DATA outcomes, or AI decisions
// below the confidence bar), and asks Gemini to draft candidate facts in the
// SAME format workflow/actions.js's rememberFact already uses.
//
// Candidates are NEVER written directly to facts.json. They're staged as a
// pending confirmation and only become real facts if the manager explicitly
// approves them — same human-in-the-loop posture as forward/assign
// confirmations and everything else consequential in this app. This is
// Jarvis SUGGESTING what it might be getting wrong, not Jarvis rewriting its
// own behavior unsupervised overnight.
//
// Deliberately scoped to WhatsApp-conversation gaps (source: 'core' entries
// from brain.js) — email_watcher log entries never have a numeric confidence
// or NEED_DATA intent, so they're naturally excluded by the filter below,
// no special-casing needed.

const fs   = require('fs');
const { todayLogFile }  = require('./auditlog'); // same date logic auditlog.js itself writes with
const { callGeminiJSON } = require('./gemini');

const LOW_CONFIDENCE = 0.6; // matches brain.js's own SAFE_ACTIONS confidence gate
const MAX_CANDIDATES = 5;   // a wall of 20 suggestions defeats the point of a quick end-of-day review

function readLogFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

// Failure-shaped entries only — NEED_DATA outcomes, or an AI decision that
// came in under the confidence bar. Successful replies/silences are not
// candidates for a new rule.
function findGaps(entries) {
    return entries.filter(e =>
        e.intent === 'NEED_DATA' ||
        (e.resolvedBy === 'ai' && typeof e.confidence === 'number' && e.confidence < LOW_CONFIDENCE)
    );
}

function buildPrompt(gaps) {
    const lines = gaps.slice(0, 30)
        .map(g => `- "${(g.text || '').slice(0, 150)}" → ${g.intent} (confidence ${g.confidence ?? 'n/a'})`)
        .join('\n');
    return `You are reviewing one day's operational log for Jarvis, a freight ops WhatsApp assistant. Below are messages Jarvis failed to resolve confidently today (NEED_DATA outcomes or low-confidence AI decisions).

Look for a REAL, RECURRING pattern — the same kind of phrasing, the same missing context, the same misunderstood shorthand — appearing more than once. Do NOT invent a rule from a single one-off message; that is noise, not a pattern.

For each genuine recurring pattern you find, draft ONE short, self-contained fact string that would help Jarvis handle it correctly next time — written so it makes sense on its own later, without today's context (same style as an explicit "remember: X" correction). If you find no real recurring pattern, return an empty array — do not force one.

TODAY'S GAPS:
${lines || '(none)'}

Return ONLY this JSON, nothing else:
{ "candidates": ["fact string 1", "fact string 2", ...] }`;
}

async function generateCandidates(gaps) {
    if (!gaps.length) return [];
    const result = await callGeminiJSON(buildPrompt(gaps));
    if (!result || !Array.isArray(result.candidates)) return [];
    return result.candidates
        .filter(c => typeof c === 'string' && c.trim().length > 0)
        .slice(0, MAX_CANDIDATES);
}

// Main entry — called once nightly by scheduler.js. sendToManager and
// setPending are passed in rather than imported directly, avoiding a
// circular require with workflow/actions.js (which itself pulls in several
// helpers/*.js files that would loop back here).
async function run({ sendToManager, setPending, managerChatId }) {
    if (!managerChatId) {
        console.warn('[LEARNING] No manager number configured — skipping');
        return;
    }

    const entries = readLogFile(todayLogFile());
    const gaps    = findGaps(entries);
    if (!gaps.length) {
        console.log('[LEARNING] No gaps logged today — nothing to review');
        return;
    }

    const candidates = await generateCandidates(gaps);
    if (!candidates.length) {
        console.log(`[LEARNING] ${gaps.length} gap(s) logged today, no recurring pattern found — nothing suggested`);
        return;
    }

    await setPending(managerChatId, { type: 'await_fact_batch', candidates });

    const list = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
    await sendToManager(
        `End-of-day review — ${candidates.length} suggested addition${candidates.length === 1 ? '' : 's'} based on today's gaps:\n\n${list}\n\n` +
        `Reply with numbers to accept (e.g. "1,3"), "all", or "no" to skip all.`
    );
}

module.exports = { run, readLogFile, findGaps, generateCandidates };