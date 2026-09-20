// ── helpers/briefIntent.js — is this "brief me"? ────────────────────────────
// Kept out of brain.js's regex wall so it can be tested phrase by phrase.
// Closed list on purpose: "update" alone or "status" alone already mean
// other things in this app (a booking's status, updating a record), so only
// whole phrases that can mean nothing but "tell me where things stand".
const LEAD = /^(?:(?:ok(?:ay)?|hey|so|jarvis|good\s+(?:morning|afternoon|evening))[,.!\s]+)*/;
const TAIL = /(?:[,\s]+(?:please|jarvis|for\s+today|today|now))*[?.!]*$/;
const CORE = [
    'brief me', 'briefing', 'my briefing', 'the briefing', 'morning briefing', 'daily briefing',
    'give me (?:a|the|my) (?:briefing|brief|rundown|status report|summary|update)',
    'morning (?:brief|report|update|summary)', 'daily (?:brief|report|update|summary)',
    'status report', 'rundown', 'catch me up', "what'?s (?:on )?(?:for )?today", "what'?s on", "what is on",
    'what is (?:on )?(?:for )?today', 'what do i need to know',
    // NOT "what needs my attention": that is her inbox question
    // (show_pending_replies) and tests/integration.js holds it there.
    'how are we (?:looking|doing)', 'where do we stand', 'sitrep',
];
const RE = new RegExp('^(?:' + CORE.join('|') + ')$', 'i');

// Greetings and "what's up", said on their own or run together the way the
// recogniser hands them over ("what's up today good morning good morning",
// Apsara's recording 2026-09-20), are a request for the briefing: that is
// what Jarvis in the film does with "good morning".
const GREETING_ONLY = /^(?:(?:good\s+(?:morning|afternoon|evening)|what'?s\s+up|whats\s+up|sup|hey|hi|hello|morning|jarvis|ok(?:ay)?|so|today|now|please|there)[\s,.!?]*)+$/;
const HAS_GREETING = /\b(?:good\s+(?:morning|afternoon|evening)|what'?s\s+up|whats\s+up|morning)\b/;

function isBriefRequest(text) {
    let t = String(text || '').toLowerCase().trim();
    if (GREETING_ONLY.test(t) && HAS_GREETING.test(t)) return true;
    // "good morning jarvis" on its own is a greeting — answer it with the brief.
    if (/^(?:(?:hey|ok(?:ay)?)[,\s]+)?good\s+(?:morning|afternoon|evening)(?:[,\s]+jarvis)?[.!?]*$/.test(t)) return true;
    t = t.replace(LEAD, '').replace(TAIL, '').trim();
    return RE.test(t);
}
module.exports = { isBriefRequest };
