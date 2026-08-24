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
const path = require('path');
const cfg  = require('../config');
const { todayLogFile }  = require('./auditlog'); // same date logic auditlog.js itself writes with
const { callGeminiJSON } = require('./gemini');

const LOW_CONFIDENCE = 0.6; // matches brain.js's own SAFE_ACTIONS confidence gate
const MAX_CANDIDATES = 5;   // a wall of 20 suggestions defeats the point of a quick end-of-day review

// ── PHASE 5: read the whole log, not just today ────────────────────────────
// This function used to open exactly one file — today's. Every previous day
// was written and never read again, by anything. The audit log is
// append-only and never pruned precisely so patterns can be found ACROSS
// days, and that was the one thing nothing did with it.
//
// The consequence was not subtle. A pattern has to repeat to be a pattern,
// and the prompt below explicitly refuses to draft a rule from a single
// one-off. But within a single day most real recurring confusions appear
// once or twice — so the check was structurally near-incapable of firing.
// The thing that would make a genuine standing rule obvious ("she has hit
// this same wall every few days for three weeks") was invisible by
// construction.
const LOOKBACK_DAYS = 14;

function logFilesForLookback(days = LOOKBACK_DAYS) {
    const dir = cfg.LOGS_DIR || path.join(cfg.DATA_DIR, 'logs');
    if (!fs.existsSync(dir)) return [];
    // Read the DIRECTORY rather than generating filenames by date — a gap in
    // the sequence (Jarvis offline, no traffic that day) is normal, and
    // generating names would just produce misses to swallow.
    const cutoff = Date.now() - days * 86400000;
    return fs.readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .filter((f) => {
            const t = Date.parse(f.slice(0, 10) + 'T00:00:00Z');
            return Number.isFinite(t) && t >= cutoff;
        })
        .sort()
        .map((f) => path.join(dir, f));
}

function readLogFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

// Every entry across the lookback window, oldest first.
function readLookback(days = LOOKBACK_DAYS) {
    return logFilesForLookback(days).flatMap((f) => readLogFile(f));
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

// Evidence-cited reflection (Generative Agents, arXiv:2304.03442). Each gap
// is numbered so the model can point at the specific entries an insight came
// from, and those citations are carried onto the fact. Without them a
// suggested rule is an assertion with no provenance — you cannot check it,
// and if one of the entries it rested on turns out to be a misread, you
// cannot find the rule that was built on it.
function buildPrompt(gaps, { days = LOOKBACK_DAYS } = {}) {
    const lines = gaps.slice(0, 60)
        .map((g, i) => {
            const day = String(g.at || '').slice(0, 10);
            return `[${i + 1}] ${day} "${(g.text || '').slice(0, 150)}" → ${g.intent} (confidence ${g.confidence ?? 'n/a'})`;
        })
        .join('\n');
    return `You are reviewing ${days} days of operational log for Jarvis, a freight ops WhatsApp assistant. Below are messages Jarvis failed to resolve confidently (NEED_DATA outcomes or low-confidence AI decisions), each with a number and the date it happened.

Look for a REAL, RECURRING pattern — the same kind of phrasing, the same missing context, the same misunderstood shorthand — appearing more than once, ideally on more than one day. Do NOT invent a rule from a single one-off message; that is noise, not a pattern. A pattern that recurs across several days is much stronger evidence than several hits in one afternoon, which is often just one frustrated person rephrasing.

For each genuine recurring pattern, draft ONE short, self-contained fact string that would help Jarvis handle it correctly next time — written so it makes sense on its own months later, with no reference to "today" or to this review. Cite the entry numbers it came from. If you find no real recurring pattern, return an empty array — do not force one.

GAPS:
${lines || '(none)'}

Return ONLY this JSON, nothing else:
{ "candidates": [ { "fact": "the fact string", "because": [1, 5, 9], "days_seen": 3 } ] }`;
}

// Returns [{ fact, because:[entryIndex...], days_seen, evidence:[{at,text,intent}] }].
// Tolerates the OLD flat-string response shape too — the prompt asks for
// objects now, but a model that returns bare strings should degrade to a
// candidate with no citations rather than silently yielding nothing.
async function generateCandidates(gaps, { days = LOOKBACK_DAYS } = {}) {
    if (!gaps.length) return [];
    const result = await callGeminiJSON(buildPrompt(gaps, { days }));
    if (!result || !Array.isArray(result.candidates)) return [];

    return result.candidates.map((c) => {
        if (typeof c === 'string') {
            return c.trim() ? { fact: c.trim(), because: [], days_seen: null, evidence: [] } : null;
        }
        if (!c || typeof c.fact !== 'string' || !c.fact.trim()) return null;
        const because = Array.isArray(c.because)
            ? c.because.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= gaps.length)
            : [];
        return {
            fact: c.fact.trim(),
            because,
            days_seen: Number.isFinite(c.days_seen) ? c.days_seen : null,
            // Resolve the citations to the actual log entries NOW, while the
            // numbering is still meaningful. The indices refer to this
            // prompt's list and mean nothing once it is gone.
            evidence: because.map((n) => {
                const g = gaps[n - 1] || {};
                return { at: g.at || null, messageId: g.messageId || null, text: String(g.text || '').slice(0, 200), intent: g.intent || null };
            }),
        };
    }).filter(Boolean).slice(0, MAX_CANDIDATES);
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

    const entries = readLookback(LOOKBACK_DAYS);
    const gaps    = findGaps(entries);
    if (!gaps.length) {
        console.log(`[LEARNING] No gaps in the last ${LOOKBACK_DAYS} days — nothing to review`);
        return;
    }

    const candidates = await generateCandidates(gaps, { days: LOOKBACK_DAYS });
    if (!candidates.length) {
        console.log(`[LEARNING] ${gaps.length} gap(s) over ${LOOKBACK_DAYS} days, no recurring pattern found — nothing suggested`);
        return;
    }

    // candidates are objects now. The pending carries the full objects so
    // resolveFactBatch can attach evidence to whatever she approves, while
    // `candidateTexts` keeps the plain-string shape that brain.js's
    // pendingFullReminder and the numbered-answer parse already expect —
    // changing that shape would break the reminder tail for a pending that
    // may already be open when this deploys.
    await setPending(managerChatId, {
        type: 'await_fact_batch',
        candidates: candidates.map((c) => c.fact),
        candidateDetails: candidates,
    });

    const list = candidates.map((c, i) => {
        // Say WHY, in her terms. "Seen on 3 days" is the difference between a
        // suggestion she can judge and one she has to take on faith.
        const seen = c.days_seen ? ` _(seen on ${c.days_seen} day${c.days_seen === 1 ? '' : 's'})_` : '';
        return `${i + 1}. ${c.fact}${seen}`;
    }).join('\n');

    await sendToManager(
        `Review — ${candidates.length} suggested addition${candidates.length === 1 ? '' : 's'} from the last ${LOOKBACK_DAYS} days:\n\n${list}\n\n` +
        `Reply with numbers to accept (e.g. "1,3"), "all", or "no" to skip all.`
    );
}

module.exports = { run, readLogFile, readLookback, logFilesForLookback, findGaps, generateCandidates, buildPrompt, LOOKBACK_DAYS };