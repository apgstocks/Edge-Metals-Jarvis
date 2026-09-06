// ── helpers/bookingRequest.js — asking a carrier for space ────────────────
//
// Apsara, 2026-09-06: "if i say jarvis,send a mail to say yurim,asking for a
// booking -it should ask how many containers... It can learn the pattern of
// how generally i ask for booking in my mail and then mimic my behaviour-the
// tone."
//
// WHAT ALREADY EXISTED
// --------------------
// Nearly all of it. workflow/actions.js:draftEmailForConfirm resolves the
// recipient from her address book, drafts the body through Gemini WITH
// helpers/writingStyle.js applied (that is the tone mimicry, already wired),
// stages an await_email_confirm pending, and sends only on "yes". It also
// carries real scar tissue — a hallucinated "mike@example.com" recipient and
// an invented "I miss you" body, both caught live in August and both now
// guarded.
//
// So the tone half of her request has been working for weeks. What did not
// exist is the ONE QUESTION: a booking request with no container count in it
// was drafted anyway, and a carrier reading "please book us space" with no
// quantity replies asking how many — which is a day lost.
//
// WHY A COUNT AND NOT A FORM
// --------------------------
// The temptation is to ask for count, size, port of loading, port of
// discharge, commodity and ready date. That is a form read aloud, and she has
// already told me what she thinks of those: "I want how a human asissyant
// will handle it."
//
// A human assistant who has sent these mails for years asks the ONE thing
// that changes every time and infers the rest from the last one. So: the
// count is asked, and everything else is left to the drafter, which grounds
// itself in the real previous correspondence with that same contact. If the
// last three mails to Yurim were 40HC out of Houston, the fourth reads like
// them without anyone being interrogated about it.

// Is she asking someone FOR a booking?
//
// Deliberately narrow, and the cost of being wrong is asymmetric: a missed
// detection drafts the mail she asked for (today's behaviour), while a false
// positive interrupts an unrelated email with "how many containers?" — which
// is the kind of thing that makes people stop using an assistant.
//
// So it needs BOTH a request verb and booking vocabulary. "Ask Yurim for a
// booking", "request space from MSC", "see if Yurim can give us a booking".
const ASKING = /\b(ask(?:ing)?|request(?:ing)?|enquir\w*|inquir\w*|check(?:ing)?|see)\b/i;
const FOR_A_BOOKING = /\b(?:for\s+(?:a\s+|the\s+|some\s+)?)?(booking|bookings|space|allocation|slot|slots)\b/i;

// A booking request that is really a question ABOUT an existing booking is
// not one of these. "Ask Yurim about booking DALA123" is chasing a booking
// she already has, and answering it with "how many containers?" is nonsense.
const ABOUT_AN_EXISTING_ONE = /\b(?:booking|bkg)\s*(?:no\.?|number|#)?\s*[A-Z]{2,4}\d{3,}/i;

function isRequest(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    if (ABOUT_AN_EXISTING_ONE.test(t)) return false;
    return ASKING.test(t) && FOR_A_BOOKING.test(t);
}

// ── HOW MANY ─────────────────────────────────────────────────────────────
// She says "two", "2", "2x40HC", "a couple", "two 40 high cubes". Words as
// well as digits, because this answer is spoken as often as typed and
// whisper writes small numbers as words about half the time.
const WORD_NUMBERS = {
    one: 1, a: 1, an: 1, single: 1, two: 2, couple: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20,
};

// Container sizes as they are actually written on a booking request.
const SIZE = /\b(20\s*(?:ft|')?\s*(?:gp|dc|st)?|40\s*(?:ft|')?\s*(?:hc|hq|gp|dc|st|high\s*cubes?)?|45\s*(?:ft|')?\s*(?:hc|hq)?)\b/i;

function normalizeSize(raw) {
    const s = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^20/.test(s)) return '20GP';
    if (/^45/.test(s)) return '45HC';
    if (/^40/.test(s)) return /hc|hq|highcube/.test(s) ? '40HC' : (/gp|dc|st/.test(s) ? '40GP' : '40HC');
    return null;
}

// Returns { count, size } — either may be null. NEVER guesses a count: a
// booking request for the wrong number of containers is a real commitment to
// a carrier, and "she probably meant two" is not a thing worth being wrong
// about at a shipping line.
function containersIn(text) {
    const t = String(text || '');
    let count = null, size = null;

    // "2 x 40HC", "2x40", "two 40 high cubes" — the count and the size in one
    // breath, which is how she actually says it. Matched FIRST so the 40 in
    // "40HC" is never read as the count.
    const combo = new RegExp(
        '\\b(\\d{1,3}|' + Object.keys(WORD_NUMBERS).join('|') + ')\\s*'
        + '(?:x|\\*|by|of)?\\s*' + SIZE.source, 'i').exec(t);
    if (combo) {
        count = /^\d+$/.test(combo[1]) ? Number(combo[1]) : WORD_NUMBERS[combo[1].toLowerCase()];
        size = normalizeSize(combo[2]);
    }

    if (count == null) {
        // "2 containers", "two boxes", or a container word before the number.
        const m = new RegExp(
            '\\b(\\d{1,3}|' + Object.keys(WORD_NUMBERS).join('|') + ')\\s+'
            + '(?:more\\s+)?(?:containers?|boxes|units|cntrs?)\\b', 'i').exec(t)
            || /\b(?:containers?|boxes)\s*[:\-]?\s*(\d{1,3})\b/i.exec(t);
        if (m) count = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUMBERS[m[1].toLowerCase()];
    }

    if (size == null) {
        const s = SIZE.exec(t);
        // Only when it is not the number she just gave as a count — "40" on
        // its own after "how many?" is forty containers, not a 40-footer, and
        // that ambiguity is why the combo pattern runs first.
        if (s && !(count != null && String(count) === s[0].trim())) size = normalizeSize(s[0]);
    }

    // A count of zero, or something absurd, is not an answer. A three-digit
    // container count would be the largest booking her company has ever made
    // and is far more likely to be a misheard year or a phone number.
    if (count != null && (!Number.isFinite(count) || count < 1 || count > 99)) count = null;

    return { count, size };
}

// The question. Short, because it is spoken — and it says what a useful
// answer looks like without demanding that shape.
function ask(who) {
    return `How many containers for ${who || 'them'}? Say the size too if it matters — "two 40 highcubes".`;
}

// What is handed to the drafter as "what this email needs to say".
//
// The count and size are stated as FACTS, not as prose to be embellished,
// because they are the two things in the message that must survive contact
// with a language model unchanged. Everything else — greeting, phrasing,
// whether she says "kindly" — is left to writingStyle.js, which learned it
// from her own sent mail.
function details(count, size, original) {
    const bits = [];
    const box = size ? `${size} container${count === 1 ? '' : 's'}` : `container${count === 1 ? '' : 's'}`;
    bits.push(`Ask them for a booking for ${count} ${box}.`);
    bits.push('State the number of containers explicitly — a booking request without a quantity gets a reply asking for one, which costs a day.');
    // Whatever else she said in the original sentence is kept, but AFTER the
    // count, so a long aside cannot bury the one fact the mail exists to
    // carry. Trimmed of the routing words that were instructions to Jarvis
    // rather than content for the carrier.
    const rest = String(original || '')
        .replace(/^\s*(?:hey\s+)?jarvis[,\s]*/i, '')
        .replace(/\b(?:send|write|draft|shoot)\s+(?:an?\s+)?(?:e-?mail|mail|message)\s+to\s+\S+\s*/i, '')
        .trim();
    if (rest && rest.length > 12) bits.push(`Her original words, for anything else it should carry: "${rest}"`);
    return bits.join(' ');
}

module.exports = {
    isRequest, containersIn, ask, details, normalizeSize,
    ASKING, FOR_A_BOOKING, ABOUT_AN_EXISTING_ONE, WORD_NUMBERS, SIZE,
};
