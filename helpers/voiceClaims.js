// ── helpers/voiceClaims.js — what a spoken sentence is NOT ─────────────────
//
// Apsara's screen recording, 2026-09-20 06:54, on the build that had just
// shipped the briefing:
//
//   "what's up today good morning good morning" → "one booking from Houston"
//   "WhatsApp what needs my attention"          → "the earliest booking cuts off…"
//   "is there any mail that we have received"   → "7 ports have those. Which one?"
//   "or or or"                                  → "I cannot answer that question"
//
// One cause for the first three: /api/voice/ask runs its BOOKINGS machinery
// (the follow-up answerer, the booking-query form, the port question) BEFORE
// the brain ever sees the sentence, and with a Houston list still on screen
// every sentence looked like a follow-up to it. The briefing, the inbox and
// the Metals reports all live in the brain, so they never got a turn.
//
// This file answers one question for the voice route: does this sentence
// belong to the brain outright? If so the bookings machinery stands aside.
// Plus two speech-specific repairs: Chrome writes "what's up" as "WhatsApp",
// and a noise capture ("or or or") is not a question.

const { isBriefRequest } = require('./briefIntent');

// ── "WhatsApp" is how Chrome spells "what's up" ────────────────────────────
// Only where it cannot be the app: not after "a/the/on/via/by/send/to/in",
// and only before a question/greeting word or the end. "send a WhatsApp to
// NTG" is untouched.
function normalizeHeard(text) {
    let t = String(text || '');
    t = t.replace(/(^|[^a-z'])(?<!\b(?:a|the|on|via|by|send|to|in|through)\s)whats?\s*app\b(?=\s+(?:whats?\s*app|today|jarvis|good|what|how|any|is|are|with)\b|\s*[?.!,]*\s*$)/gi,
        (m, pre) => pre + "what's up");
    // "good morning good morning" → one; a repeated greeting is the
    // recogniser catching her twice, not two requests.
    t = t.replace(/\b(good\s+(?:morning|afternoon|evening))(?:[\s,.!]+\1\b)+/gi, '$1');
    t = t.replace(/\b(what's up)(?:[\s,.!]+\1\b)+/gi, '$1');
    // "What's up, what needs my attention?" — the greeting is not part of
    // the question, and left on the front it defeats every rule that expects
    // the question to start the sentence.
    t = t.replace(/^\s*(?:(?:hey|ok(?:ay)?|so|jarvis)[,\s]+)*what's up[,.!?\s]+(?=(?:what|how|any|is|are|show|check|do|did|who|when|where|tell|give|open|reply|send|brief|catch)\b)/i, '');
    return t.replace(/\s{2,}/g, ' ').trim();
}

// ── noise ──────────────────────────────────────────────────────────────────
const FILLER = new Set(['or', 'uh', 'um', 'umm', 'hmm', 'hm', 'mm', 'ah', 'er', 'erm', 'eh', 'oh', 'and', 'the', 'a', 'so', 'but', 'like']);
function isNoise(text) {
    const w = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    return w.length > 0 && w.every((x) => FILLER.has(x));
}

// ── urgent cutoffs — shared with brain.js so the two cannot drift ─────────
function isUrgentCutoffQuestion(t) {
    const s = String(t || '').toLowerCase().trim().replace(/[.!]+$/, '');
    return /^(?:(?:show|tell|give)\s+(?:me\s+)?(?:the\s+)?|list\s+|any\s+)?urgent\s+cut\s*-?\s*offs?\??$/.test(s)
        || /^(?:any|what(?:'s|\s+is|\s+are)?(?:\s+the)?)\s+cut\s*-?\s*offs?\s+(?:today|this\s+week|coming\s+up|soon)\??$/.test(s)
        || /^what(?:'s|\s+is)\s+cutting\s+off(?:\s+(?:today|soon|this\s+week))?\??$/.test(s);
}

// ── her inbox ─────────────────────────────────────────────────────────────
// Mail words, or the phrases that mean "what is waiting on ME". "Which
// bookings need attention" is a bookings question and is left alone.
function isInboxQuestion(t) {
    const s = String(t || '').toLowerCase();
    return /\b(?:e-?mails?|mails?|inbox|mailbox|digest|unreplied)\b/.test(s)
        || /\b(?:needs?|require|requires)\s+my\s+(?:attention|reply|response)\b/.test(s)
        || /\bwaiting\s+(?:on|for)\s+me\b/.test(s)
        || /\bwhat(?:'s|\s+is)\s+pending\s+on\s+me\b/.test(s);
}

// Does the brain own this sentence outright?
function brainOwns(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (isBriefRequest(t)) return 'brief';
    if (isUrgentCutoffQuestion(t)) return 'urgent_cutoffs';
    try { if (require('./metalsReports').reportIn(t)) return 'metals_report'; } catch (e) { /* none */ }
    if (isInboxQuestion(t)) return 'inbox';
    return null;
}

module.exports = { normalizeHeard, isNoise, isUrgentCutoffQuestion, isInboxQuestion, brainOwns };
