// ── helpers/customerFocus.js — "they" means the customer we were just talking about ─────────────────────────────
// Apsara, 2026-11-13: "contextual memory should be there, mimicking the human brain." Jarvis already keeps a BOOKING in focus per chat
// (session.activeBooking). Nothing did that for a CUSTOMER, so "what do they owe?" right after a customer came up had nothing to attach to.
//
// HOW A PERSON DOES IT, AND SO DOES THIS:
//   * a strong, specific cue sets the focus: a customer she NAMED, and that resolves to exactly ONE known customer. A loose or ambiguous
//     name sets nothing (a hazy memory is not a memory to act on).
//   * the focus fades: after FOCUS_MIN minutes it is gone, as the thread of a conversation is.
//   * a newer customer replaces it, and a sentence that NAMES someone is never rewritten (the name she said always wins).
//   * it only fills in WORDS ("they" -> "Rad Metal") for questions that already exist. It never acts: nothing is chased, held, paid or sent
//     because of a focus. Every action still goes through its own confirmation.
//
// A SEPARATE SLOT beside session.activeBooking (session.focusCustomer). Booking focus is not read or written here.
// EDGE METALS ONLY: customers come from the Edge Metals sales ledger and its follow-up log. A name that is only an Edge Yard party is not a
// known customer here, so it never becomes a focus and nothing crosses between the two companies.
// Never throws: a failure here must leave Jarvis behaving exactly as before.
const FOCUS_MIN = () => Number(process.env.JARVIS_CUSTOMER_FOCUS_MIN) || 60;
const keyOf = (name) => String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ');
const words = (s) => keyOf(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
const NOISE = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of']);
const core = (s) => words(s).filter((w) => !NOISE.has(w));

function defaults() {
    return {
        sales: () => require('./sales').listWithTotals(),
        chaserLog: () => require('./paymentChaser').readLog(),
    };
}
/** Every customer we know by name, as { key -> display }. */
function known(src = defaults()) {
    const m = new Map();
    try { for (const s of (src.sales() || [])) if (s && s.customer) m.set(keyOf(s.customer), String(s.customer).trim()); } catch (_) { /* none */ }
    try { for (const [k, v] of Object.entries(src.chaserLog() || {})) if (k[0] !== '_' && !m.has(k)) m.set(k, (v && v.customer) || k); } catch (_) { /* none */ }
    return m;
}
/** The ONE known customer this name means, or null. Exact (case and spacing aside) first; else the same words (ignoring Inc/LLC); else null. */
function match(name, src = defaults()) {
    const k = keyOf(name); if (!k) return null;
    const all = known(src);
    if (all.has(k)) return all.get(k);
    const want = core(name); if (!want.length) return null;
    const hits = [...all.values()].filter((d) => { const have = core(d); return have.length === want.length && have.every((w, i) => w === want[i]); });
    const uniq = [...new Set(hits.map(keyOf))];
    return uniq.length === 1 ? hits[0] : null;
}

/** Put this customer in focus for this chat. Only a strong match (exactly one known customer) is kept. */
function note(chatId, name, { now = Date.now(), src } = {}) {
    try {
        const who = match(name, src); if (!who) return false;
        require('./context').updateSession(chatId, { focusCustomer: { name: who, at: now } });
        return true;
    } catch (_) { return false; }
}
/** The customer in focus right now, or null (none, or it has faded). */
function current(session, now = Date.now()) {
    const f = session && session.focusCustomer;
    if (!f || !f.name || !Number.isFinite(Number(f.at))) return null;
    return now - Number(f.at) <= FOCUS_MIN() * 60000 ? String(f.name) : null;
}

const PRON = '(?:they|he|she|the customer|them|him|her)';
const POSS = '(?:their|his|her|the customer\'s)';
const OWE = [
    new RegExp(`^(?:so\\s+|and\\s+)?(?:what|how much)(?:'s|\\s+is|\\s+do|\\s+does)?\\s+${PRON}\\s+owe(?:s)?(?:\\s+(?:us|me|now|still))?\\s*\\??$`),
    new RegExp(`^(?:so\\s+|and\\s+)?(?:what(?:'?s| is)\\s+)?${POSS}\\s+(?:balance|outstanding)\\s*\\??$`),
    new RegExp(`^(?:so\\s+|and\\s+)?do\\s+${PRON}\\s+(?:still\\s+)?owe\\s+(?:us\\s+|me\\s+)?(?:anything|any\\s*thing|money)\\s*\\??$`),
];
const CASE = [
    new RegExp(`^(?:so\\s+|and\\s+)?(?:show\\s+(?:me\\s+)?)?${POSS}\\s+(?:case|case file|history|timeline)\\s*\\??$`),
    new RegExp(`^(?:so\\s+|and\\s+)?(?:what(?:'?s| is)\\s+)?(?:going on|happening|the status|the story)\\s+(?:with|for)\\s+${PRON}\\s*\\??$`),
    new RegExp(`^(?:so\\s+|and\\s+)?how\\s+are\\s+we\\s+(?:with|doing with)\\s+${PRON}\\s*\\??$`),
];
/** A pronoun question about the customer in focus -> the same question with the name in it. null when there is no focus or it is not one of these shapes. */
function resolve(text, session, now = Date.now()) {
    try {
        const who = current(session, now); if (!who) return null;
        const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
        if (!t || t.length > 80) return null;
        if (OWE.some((r) => r.test(t))) return { text: `what does ${who} owe`, customer: who, kind: 'owe' };
        if (CASE.some((r) => r.test(t))) return { text: `case ${who}`, customer: who, kind: 'case' };
        return null;
    } catch (_) { return null; }
}

/** "case Rad Metal" / "case file for Rad Metal" -> { name }. Only the shape; whether the name is a known customer is for the caller. */
function parseCaseCommand(text) {
    const m = String(text || '').trim().match(/^case(?:\s+file)?\s+(?:for\s+|of\s+)?(.{2,80}?)\s*[?.!]*$/i);
    return m ? { name: m[1].trim() } : null;
}

module.exports = { note, current, resolve, match, known, parseCaseCommand, FOCUS_MIN, keyOf };
