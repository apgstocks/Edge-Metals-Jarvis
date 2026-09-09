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
// Carriers do not agree on a format. Her real bookings.json holds
// "274150389" (pure digits, Maersk), and MSC writes "MEDUX9988" — five
// letters, which my first pattern's {2,4} silently excluded, so "ask Zimex
// about booking MEDUX9988" was treated as a request for a NEW booking and
// answered with "how many containers?". Widened to cover both shapes, and
// the length floors are what stop it matching an ordinary word.
const ABOUT_AN_EXISTING_ONE = /\b(?:booking|bkg)\s*(?:no\.?|number|#)?\s*(?:[A-Z]{2,6}\d{3,}|\d{6,})/i;

function isRequest(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    if (ABOUT_AN_EXISTING_ONE.test(t)) return false;
    return ASKING.test(t) && FOR_A_BOOKING.test(t);
}

// ── IS SHE ASKING A PERSON, OR ASKING JARVIS? ────────────────────────────
// Apsara, 2026-09-09, with a screenshot: "send email to Wimax asking for
// booking from Houston to Busan with ERD as yesterday and cut off as
// somewhere next week" came back as a BOOKINGS SEARCH whose scope was her
// whole sentence read out to her.
//
// Two faults did that together. helpers/booking.js:localityMatchesPort let a
// 96-character sentence "match" the port of Houston (fixed there). And even
// with a clean capture, "send email to Wimax asking for booking from Houston"
// still ends in the exact shape workflow/brain.js's offline location net is
// looking for — `bookings? from (.+)$` — so the net claims a sentence whose
// verb is SEND.
//
// The api.js comment about "...asking for a booking from HOUSTON" being
// swallowed by the location rule is this same collision, seen from the side
// where Jarvis wrote the sentence. That was worked around by rewording
// Jarvis's own output. Her mouth does not take a patch.
//
// ── WHY isRequest() ALONE IS NOT THE TEST ────────────────────────────────
// The obvious move is to veto the location net whenever isRequest() is true.
// Measured, that is wrong: isRequest matches ASKING + FOR_A_BOOKING, and
// "check bookings from Houston" contains both. Vetoing there would break an
// ordinary search — trading her reported bug for a new one.
//
// The thing that actually separates them is a RECIPIENT. "Ask Yurim for a
// booking" names someone to ask; "check bookings from Houston" asks Jarvis.
// So the test is whether she named a party, and that is a structural question
// about the sentence rather than a list of phrasings — which matters, because
// enumerating phrasings is the thing she has stopped me doing twice: "Why
// would i need to hard code it? Stupid.. Its an AI."
//
// A mail word ("email X", "send a mail to X", "write to X") is the other
// recipient marker, and the clearer one — you do not email a port.
const MAIL_WORD = /\b(?:e-?mail(?:s|ed|ing)?|mail(?:s|ed|ing)?|message|write|drop\s+(?:a\s+)?line)\b/i;

// The thing being asked FOR is never the party being asked. Without this,
// "check the bookings for Houston" reads "bookings" as the recipient and gets
// vetoed as a request — found by running both shapes rather than by reading.
const NOT_A_PARTY = /^(?:bookings?|space|allocation|slots?|containers?|boxes|cutoffs?|erds?|rates?|prices?|the|a|an|any|all|my|our|us|me|it|them|this|that|these|those)$/i;

// "ask Yurim for", "check with MSC about", "request Zimex for"
const ASK_SOMEONE = /\b(?:ask(?:ing)?|request(?:ing)?|check(?:ing)?|chase|enquir\w*|inquir\w*)\s+(?:with\s+)?([A-Za-z][\w&.'-]*)\s+(?:for|about|whether|if|to)\b/i;

// ── AND IT IS DELIBERATELY NOT BUILT ON isRequest() ──────────────────────
// My first version started `if (!isRequest(t)) return false;` and it dropped
// "write to zimex for a booking from houston" — because isRequest's ASKING
// list has no "write", on purpose.
//
// That inheritance was a mistake, and the reason is that the two predicates
// have OPPOSITE failure economics:
//
//   isRequest() decides whether to INTERRUPT her with "how many containers?"
//   on an email she may not have meant as a booking request. A false positive
//   there is an assistant talking over her, so it is right to be narrow.
//
//   THIS decides only whether the offline location net may fast-path the
//   sentence. A false positive here costs nothing at all: the sentence falls
//   through to the model, which reads it properly. That IS the better path —
//   "Why would i need to hard code it? Stupid.. Its an AI." A false NEGATIVE
//   costs her a wrong answer, which is what she photographed.
//
// So this asks its own, looser question: did she name a party, is she talking
// about booking space, and is it not a question about a booking she already
// has. Nothing is inherited from the narrow one.
function isRequestToSomeone(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    // "ask Zimex about booking MEDUX9988" is chasing one she has, and that IS
    // a question for Jarvis to route, not a request for new space.
    if (ABOUT_AN_EXISTING_ONE.test(t)) return false;
    if (!FOR_A_BOOKING.test(t)) return false;
    if (MAIL_WORD.test(t)) return true;
    const m = ASK_SOMEONE.exec(t);
    return !!(m && !NOT_A_PARTY.test(m[1]));
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
//
// SIZE_CORE carries NO \b anchors, because it gets embedded after a count in
// the combo pattern below and "2x40HC" has no word boundary between the "x"
// and the "4" — the anchored version simply failed to match the single most
// compact way she writes this. The trailing \d guard replaces what the
// closing \b was for: it stops "40" matching the first two digits of "4000".
// The optional trailing "s" is for "a couple of 40HCs".
const SIZE_CORE = "(20\\s*(?:ft|')?\\s*(?:gp|dc|st)?|40\\s*(?:ft|')?\\s*(?:hc|hq|gp|dc|st|high\\s*cubes?)?|45\\s*(?:ft|')?\\s*(?:hc|hq)?)s?";
const SIZE = new RegExp('\\b' + SIZE_CORE + '(?!\\d)', 'i');

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
        + '(?:x|\\*|by|of)?\\s*' + SIZE_CORE + '(?!\\d)', 'i').exec(t);
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

// ── THE CUT-OFF ──────────────────────────────────────────────────────────
// Apsara, 2026-09-09: "I want jarvis to communicate in similar terms like
// need bookings from Houston to Busan 1x40HC with cut off as [date].
// [Optional: ERD]"
//
// This corrected an assumption of mine. I had the cutoff coming BACK from the
// forwarder — they tell you the vessel and its cutoff. She does not work that
// way: she STATES the cutoff she needs when she asks, because she already
// knows when the cargo will be ready, and asking for space without saying
// when is how you get offered a vessel that sailed before your metal moved.
//
// So the cutoff is the SECOND thing that changes every time, alongside the
// count, and it is the second thing worth a question.
//
// ── LABELLED, NEVER A BARE DATE ──────────────────────────────────────────
// This reads a cutoff out of a SENTENCE, and the rule is the same one that
// keeps containersIn honest: only take it when she LABELLED it. "Ask Zimex
// for space, send it tomorrow" has a date in it and that date is a SCHEDULE
// for the send — resolveScheduledFor's job, one function over. Reading it as
// a cutoff would put a wrong date in front of a carrier.
//
// Both labels are matched the way the trade writes them: "cut off", "cutoff",
// "cut-off", "CY cutoff", "SI cutoff", "closing"; and for the empty release,
// "ERD", "earliest return", "empty release", "empty pickup".
const CUTOFF_LABEL = /\b(?:cy\s+|si\s+|doc(?:ument(?:ation)?)?\s+)?cut[\s-]?off|closing\s+date|\bclosing\b/i;
const ERD_LABEL = /\berd\b|earliest\s+return(?:\s+date)?|empty\s+(?:release|pick[\s-]?up|pull)/i;

// A date phrase, taken from just after a label. Bounded so it stops at a
// clause end — "cutoff is the 20th, and ERD the 15th" must not hand chrono
// the whole tail and get one date for both.
function afterLabel(text, label) {
    const t = String(text || '');
    const m = label.exec(t);
    if (!m) return null;
    const tail = t.slice(m.index + m[0].length)
        .replace(/^\s*(?:is|as|as\s+of|on|:|=|,|-|–)\s*/i, '');
    // Up to the next clause boundary or the next label, whichever comes first.
    const stop = tail.search(/[,;.]|\band\b|\bwith\b|\berd\b|cut[\s-]?off/i);
    const phrase = (stop === -1 ? tail : tail.slice(0, stop)).trim();
    return phrase || null;
}

// "the 25th", "25th" — a bare day of the month, which chrono-node returns
// null for and which is one of the commonest ways she says a near date.
// Resolved to the NEXT occurrence of that day, because a cutoff she is
// asking a carrier for is always ahead of her.
// ── EVERY DATE IN THIS FILE IS AN LA DATE ────────────────────────────────
// FOUND BY MEASUREMENT, not by reading: "cutoff 20 sep" came back as
// "21 Sep 2026". chrono had it right — 2026-09-20T19:00Z is midday in
// Houston — and then `.getDate()` read it in the SERVER's timezone, which on
// the box I measured on is Asia/Calcutta, where that instant is already the
// 21st at half past midnight.
//
// This is not a quirk of one sandbox. `.getDate()`/`.getFullYear()` on a Date
// is server-local everywhere, and this whole app is written on LA wall-clock
// (helpers/time.js:YARD_TZ, and the header there records the last time that
// slipped). A cutoff date one day out is a booking request for the wrong
// vessel, so the day is taken from Intl in the yard's timezone, exactly the
// way todayLocal already does it, and never from the Date's own accessors.
const YARD_TZ = 'America/Los_Angeles';

// { y, m (1-12), d } as they read on a wall clock in LA.
function laParts(date) {
    const iso = date.toLocaleDateString('en-CA', { timeZone: YARD_TZ }); // YYYY-MM-DD
    const [y, m, d] = iso.split('-').map(Number);
    return { y, m, d, iso };
}

// Midday LA on a given calendar day, as a real instant. Midday because it is
// the furthest any part of a day can be from rolling into a neighbouring one
// under any offset, so nothing downstream can nudge it across midnight.
function laNoon(y, m, d) {
    // Start from a UTC guess and correct by the offset Intl actually reports
    // for that date — DST-aware without hardcoding -7 or -8.
    const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const p = laParts(guess);
    const drift = (p.y - y) * 372 + (p.m - m) * 31 + (p.d - d);
    return drift ? new Date(guess.getTime() - drift * 86400000) : guess;
}

function bareDayOfMonth(phrase, now) {
    const m = /^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?$/i.exec(String(phrase || '').trim());
    if (!m) return null;
    const day = Number(m[1]);
    if (!(day >= 1 && day <= 31)) return null;
    const base = now instanceof Date && !isNaN(now) ? now : new Date();
    const t = laParts(base);
    for (let ahead = 0; ahead <= 2; ahead++) {
        const y = t.y + Math.floor((t.m - 1 + ahead) / 12);
        const mo = ((t.m - 1 + ahead) % 12) + 1;
        // Rolls past a short month — "the 31st" in September is 1 Oct to a
        // JS Date, which is not the date she said, so it is skipped rather
        // than silently answered with the wrong day.
        if (day > new Date(Date.UTC(y, mo, 0)).getUTCDate()) continue;
        const cand = laNoon(y, mo, day);
        if (cand >= base) return cand;
    }
    return null;
}

// ── A HEDGE IS NOT A DATE ────────────────────────────────────────────────
// From her own sentence, 2026-09-09: "cut off us somewhere next week someday
// in next week". chrono-node reads "somewhere next week" and returns Wednesday
// the 16th — a real, specific, confident date that SHE NEVER SAID.
//
// Writing "with cut off as 16 Sep 2026" to a carrier on the strength of
// "somewhere next week" is the whole class of error this file keeps refusing:
// a guess wearing a fact's clothing, in a sentence that commits her. She was
// telling me she does not know yet, which is a perfectly good thing to say and
// the correct response to it is to ask, not to pick a Wednesday.
//
// So a phrase that hedges is treated as no date at all, and the cutoff
// question gets asked — where "skip" is waiting if she still does not know.
const A_HEDGE = /\b(?:somewhere|some\s*day|some\s*time|sometime|around|about|roughly|approx\w*|maybe|perhaps|probably|possibly|ish|or\s+so|early|mid|late|beginning|end)\b/i;

function parseDatePhrase(phrase, now) {
    if (!phrase) return null;
    if (A_HEDGE.test(phrase)) {
        console.log(`[BOOKING-REQ] "${phrase}" hedges — not treating it as a cutoff date`);
        return null;
    }
    return bareDayOfMonth(phrase, now)
        || require('./time').parseNaturalTime(phrase, now)
        || null;
}

// Returns { cutoff, erd } as Dates or nulls. Labelled only — see above.
function datesIn(text, now) {
    return {
        cutoff: parseDatePhrase(afterLabel(text, CUTOFF_LABEL), now),
        erd: parseDatePhrase(afterLabel(text, ERD_LABEL), now),
    };
}

// The same asymmetry as countInAnswer. Once "what cut off?" has been asked
// out loud, the whole reply is the answer and "the 20th" needs no label —
// refusing it and re-asking would be the assistant not listening. Still not a
// guess: a reply with no readable date returns null and is re-asked.
function cutoffInAnswer(text, now) {
    const t = String(text || '').trim();
    if (!t) return null;
    const labelled = datesIn(t, now);
    if (labelled.cutoff) return labelled.cutoff;
    return parseDatePhrase(t.replace(/^\s*(?:it'?s|its|make it|say|around|about)\s+/i, ''), now);
}

// How the date is written TO A CARRIER. Deliberately not MM/DD/YYYY, which is
// what bookings.json stores: this line is read by forwarders in Korea and by
// US carriers, "09/10/2026" means two different days to those two readers,
// and a cutoff read a month wrong is a missed vessel with metal on a chassis.
// "20 Sep 2026" cannot be misread by anyone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function forCarrier(d) {
    if (!(d instanceof Date) || isNaN(d)) return null;
    const p = laParts(d);          // LA, not the server's clock — see laParts.
    return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

// The same date as bookings.json writes it (MM/DD/YYYY), for storing on a
// record rather than putting in front of a carrier.
function forStore(d) {
    if (!(d instanceof Date) || isNaN(d)) return null;
    const p = laParts(d);
    return `${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')}/${p.y}`;
}

// ── WHAT SHE ALWAYS DOES, READ OFF WHAT SHE HAS ACTUALLY DONE ────────────
// Her instruction on gathering the missing pieces was "Both 1 and 3" — ask
// one question at a time for what is missing, AND put it in the draft for her
// to correct. Those are only compatible if the things that can be INFERRED
// are inferred rather than asked, and then shown.
//
// So: measured, not hardcoded. On today's bookings.json every single booking
// discharges at BUSAN and every container is a 40HC, across three different
// load ports — so the destination and the box size are safe to fill in, and
// the LOAD port is not (Houston, Los Angeles and Oakland are all in there).
// That split is a fact about her data, so it is computed from her data: the
// day she starts shipping to Qingdao this follows her without an edit.
//
// A guess is only offered when her history is close to unanimous. A 50/50
// split leaves the field EMPTY — an email that names the wrong discharge port
// is worse than one that leaves the forwarder to ask.
const USUAL_SHARE = 2 / 3;

function commonest(values) {
    const vals = (values || []).map((v) => String(v || '').trim()).filter(Boolean);
    if (!vals.length) return null;
    const tally = new Map();
    for (const v of vals) {
        const k = v.toUpperCase();
        tally.set(k, (tally.get(k) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [k, n] of tally) if (n > bestN) { best = k; bestN = n; }
    if (bestN / vals.length < USUAL_SHARE) return null;
    return { value: best, n: bestN, of: vals.length };
}

// { to, size } — either may be null. `from` is NEVER returned: her load port
// genuinely varies and there is nothing here to infer it from.
function usualRoute(fromPort) {
    let rows = [];
    try {
        rows = Object.values(require('./json').loadBookings() || {});
    } catch (e) {
        console.warn('[BOOKING-REQ] could not read bookings to infer the usual route:', e.message);
        return { to: null, size: null };
    }
    const from = String(fromPort || '').trim().toUpperCase();
    // Same load port first — that is the route she actually runs. Falls back
    // to everything only when that origin is new to her.
    const sameOrigin = from
        ? rows.filter((b) => String(b.port_of_loading || '').trim().toUpperCase() === from)
        : [];
    const pool = sameOrigin.length ? sameOrigin : rows;

    const pod = commonest(pool.map((b) => b.port_of_discharge));
    const size = commonest(pool.flatMap((b) => (b.containers || []).map((c) => c.size)));
    return {
        to: pod ? pod.value : null,
        size: size ? normalizeSize(size.value) : null,
        // Carried so the confirmation line can say WHERE the guess came from.
        // A filled-in field she cannot see the provenance of is a field she
        // will not think to check.
        from_history: !!(pod || size),
        of: pool.length,
        same_origin: sameOrigin.length > 0,
    };
}

// ── THE LINE ─────────────────────────────────────────────────────────────
// Her words: "need bookings from Houston to Busan 1x40HC with cut off as
// [date]. [Optional: ERD]"
//
// Built here as a STRING OF FACTS rather than left to the drafter, for the
// same reason the container count is: every element of it is a commitment to
// a carrier, and a language model rephrasing "1x40HC" as "a container or two"
// costs a booking. writingStyle.js still owns the greeting, the sign-off and
// whether she says "kindly" — it just does not get to touch this sentence.
//
// Anything unknown is simply left out. A half-line that reads "Need bookings
// from HOUSTON to BUSAN 2x40HC" is a real, sendable request; the same line
// with "cut off as undefined" in it is not.
function line({ from, to, count, size, cutoff, erd } = {}) {
    let s = 'Need bookings';
    if (from) s += ` from ${String(from).toUpperCase()}`;
    if (to) s += ` to ${String(to).toUpperCase()}`;
    // "1x40HC" is the trade's own shorthand and it is what she wrote, but it
    // only reads as shorthand WITH a size. "3xcontainers" is not English and
    // not a booking request, so with no size it falls back to plain words.
    if (count) s += size ? ` ${count}x${size}` : ` ${count} container${count === 1 ? '' : 's'}`;
    else if (size) s += ` ${size}`;
    const cut = forCarrier(cutoff);
    if (cut) s += ` with cut off as ${cut}`;
    s += '.';
    const e = forCarrier(erd);
    if (e) s += ` ERD ${e}.`;
    return s;
}

// The question. Short, because it is spoken — and it says what a useful
// answer looks like without demanding that shape.
function ask(who) {
    return `How many containers for ${who || 'them'}? Say the size too if it matters — "two 40 highcubes".`;
}

// The second question, asked only when the cutoff is genuinely missing, and
// only AFTER the count — one at a time, which is her explicit instruction and
// also the only shape that works out loud.
function askCutoff(who) {
    return `What cut off do you need for ${who || 'them'}? Say a date — "the 20th", "next Friday".`;
}

// What is handed to the drafter as "what this email needs to say".
//
// The count and size are stated as FACTS, not as prose to be embellished,
// because they are the two things in the message that must survive contact
// with a language model unchanged. Everything else — greeting, phrasing,
// whether she says "kindly" — is left to writingStyle.js, which learned it
// from her own sent mail.
function details(count, size, original, extra = {}) {
    const bits = [];
    const req = line({
        from: extra.from, to: extra.to, count, size,
        cutoff: extra.cutoff, erd: extra.erd,
    });
    bits.push(`The email must contain this sentence, with these exact figures and dates, in her own words and tone: "${req}"`);
    bits.push('Do not soften, round, re-order or re-word any number, port or date in it — every one of them is a commitment to a carrier.');
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

// ── ANSWERING THE QUESTION ITSELF ────────────────────────────────────────
// containersIn() is deliberately strict: it reads a count out of a SENTENCE,
// where a bare "2" is far more likely to be part of something else than a
// container count, and a wrong number here books the wrong amount of space.
//
// But once "How many containers?" has actually been asked, the whole reply
// is the answer, and "two" or "2" is not just valid — it is what a person
// says. Refusing it and re-asking would be the assistant not listening.
//
// So this is a SEPARATE function used only by the pending resolver, and the
// difference between them is the question having been asked. It is still not
// a guess: something with no number in it at all returns null and is
// re-asked, rather than defaulting to one.
function countInAnswer(text) {
    const t = String(text || '').trim();
    if (!t) return { count: null, size: null };

    // The sentence forms first — "two 40 highcubes", "2 containers" — so a
    // reply that carries a size keeps it.
    const rich = containersIn(t);
    if (rich.count != null) return rich;

    // Then the bare answer. Anchored to the WHOLE reply, so "call me in 2
    // hours" is not read as two containers.
    const bare = new RegExp(
        '^(?:just\\s+|only\\s+)?(\\d{1,3}|' + Object.keys(WORD_NUMBERS).join('|') + ')'
        + '\\s*(?:containers?|boxes|units|cntrs?|please|pls)?\\s*[.!]?$', 'i').exec(t);
    if (bare) {
        const n = /^\d+$/.test(bare[1]) ? Number(bare[1]) : WORD_NUMBERS[bare[1].toLowerCase()];
        if (Number.isFinite(n) && n >= 1 && n <= 99) return { count: n, size: rich.size };
    }
    return { count: null, size: rich.size };
}

// ── CORRECTING THE DRAFT INSTEAD OF THROWING IT AWAY ─────────────────────
// Apsara, 2026-09-09, on how the missing pieces should be gathered: "Both 1
// and 3.." — one question at a time for what is missing, AND everything in
// the draft for her to edit. The second half is this. Without it the only
// thing she can say to a draft with the wrong discharge port is "no", which
// bins the email and the two answers she just gave with it.
//
// ── WHY THE FACTS ARE RE-PARSED AND NOT JUST APPENDED ────────────────────
// The obvious version is to hand her correction to the drafter as extra prose
// and let the model sort it out. That produces a prompt containing BOTH "the
// email must contain: ...to BUSAN..." and "she says Qingdao", which is two
// contradictory instructions and an unpredictable result — on a line that
// commits her to a port. So the correction is parsed into the STATE and the
// sentence is rebuilt from it. Facts veto, the model only refines the prose
// around them.
//
// ── AND IT REFUSES WHEN IT CANNOT NAME THE FIELD ─────────────────────────
// helpers/draftIntent.js states the test that earns this: "could you name the
// FIELD and the NEW VALUE she wants? If not, it is not an amend." Returning
// null here means today's behaviour is unchanged, which is the right default
// — a correction read out of a sentence that was not one would rewrite a
// booking request under her.
//
// The port rule is the tight one, and deliberately. "send it to Zimex" parses
// as a discharge port every bit as well as "to Qingdao" does, and that is the
// exact mistake draftIntent.js records putting the wrong company on a
// financial document. So a port only changes when she either NEGATES the one
// on the draft ("Qingdao not Busan", "not Busan, Qingdao") or labels it
// outright ("POD Qingdao", "discharge port Qingdao"). A bare "to X" is
// refused.
const PORT_WORD = "([A-Za-z][A-Za-z .'-]{2,28}?)";
const POD_LABELLED = new RegExp(
    '\\b(?:pod|discharge(?:\\s+port)?|destination|dest\\.?)\\s*(?:is|as|:|=)?\\s*' + PORT_WORD + '(?=[,.;]|$)', 'i');
const POL_LABELLED = new RegExp(
    '\\b(?:pol|load(?:ing)?\\s+port|port\\s+of\\s+loading|origin|ex|out\\s+of)\\s*(?:is|as|:|=)?\\s*' + PORT_WORD + '(?=[,.;]|$)', 'i');
// "Qingdao not Busan"  /  "not Busan, Qingdao"  /  "not Busan — Qingdao"
const NOT_THIS_THAT = new RegExp('\\b' + PORT_WORD + '\\s*,?\\s+not\\s+' + PORT_WORD + '\\b', 'i');
const NOT_THAT_THIS = new RegExp('\\bnot\\s+' + PORT_WORD + '\\s*(?:,|—|-|but)\\s*' + PORT_WORD + '\\b', 'i');

const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/[.,;]+$/, '');
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

// Returns a patch, or null when nothing in the sentence names a field AND a
// value. `state` is what the draft currently says, which is what makes
// "Qingdao not Busan" resolvable — the negated half has to match something.
function correctionIn(text, state = {}, now) {
    const t = String(text || '').trim();
    if (!t) return null;
    const patch = {};

    const { count, size } = containersIn(t);
    if (count != null && count !== state.count) patch.count = count;
    if (size && !same(size, state.size)) patch.size = size;
    // "make it 40GP" with no number in it — a size on its own, once a draft is
    // in front of her, is a correction to the size on that draft.
    if (!patch.size && count == null) {
        const s = SIZE.exec(t);
        const norm = s ? normalizeSize(s[0]) : null;
        if (norm && !same(norm, state.size)) patch.size = norm;
    }

    const d = datesIn(t, now);
    if (d.cutoff) patch.cutoff = d.cutoff;
    if (d.erd) patch.erd = d.erd;
    // A short bare reply once the draft is up, naming nothing else, points at
    // one of the two figures on the line. Which one is decided by SHAPE, and
    // the rule is worth stating because "make it 3" gets it wrong otherwise:
    //
    //   "make it 3"        → THREE CONTAINERS. A bare number is a quantity.
    //   "make it the 3rd"  → a cutoff. An ordinal is a day of the month.
    //   "sept 25"          → a cutoff. A month name is a date.
    //
    // The first version had no ordinal requirement, so "make it 3" came back
    // as "cut off 3 Oct 2026" — a date she never said, replacing the cutoff
    // she had already given, on a mail to a carrier. Found by printing the
    // patch for a list of her phrasings.
    if (!Object.keys(patch).length) {
        const bare = t.replace(/^\s*(?:no+,?\s*|nope,?\s*|actually,?\s*|make it\s+|cut ?off\s+)/i, '').trim();
        const asCount = /^(\d{1,2})$/.exec(bare);
        if (asCount && Number(asCount[1]) >= 1 && Number(asCount[1]) <= 99
            && Number(asCount[1]) !== state.count) {
            patch.count = Number(asCount[1]);
        } else if (bare.length <= 24 && /\d(?:st|nd|rd|th)\b|[a-z]{3}/i.test(bare)) {
            // Has an ordinal ending or letters — "the 25th", "next friday",
            // "sept 25". A naked number never reaches here.
            const one = parseDatePhrase(bare, now);
            if (one) patch.cutoff = one;
        }
    }

    // Ports. Negation or a label, never a bare "to X" — see above.
    // Which of the two orders matched is decided ONCE, here. Writing it as
    // `neg === NOT_THIS_THAT.exec(t)` compares two freshly-allocated arrays
    // and is therefore always false — so "no, Qingdao not Busan", the exact
    // phrasing this pattern exists for, silently fell through to no
    // correction at all. Found by printing the output over a list of her
    // phrasings rather than by reading the code back.
    const thisThat = NOT_THIS_THAT.exec(t);
    const thatThis = thisThat ? null : NOT_THAT_THIS.exec(t);
    const neg = thisThat || thatThis;
    if (neg) {
        const [, a, b] = neg;
        const wanted = thisThat ? a : b;
        const rejected = thisThat ? b : a;
        // The rejected half has to be what the draft actually says, or this is
        // not a correction to this draft and guessing which field it hits
        // would be inventing one.
        if (same(rejected, state.to)) patch.to = clean(wanted).toUpperCase();
        else if (same(rejected, state.from)) patch.from = clean(wanted).toUpperCase();
    }
    const pod = POD_LABELLED.exec(t);
    if (pod && !same(pod[1], state.to)) patch.to = clean(pod[1]).toUpperCase();
    const pol = POL_LABELLED.exec(t);
    if (pol && !same(pol[1], state.from)) patch.from = clean(pol[1]).toUpperCase();

    return Object.keys(patch).length ? patch : null;
}

// What changed, in words, so a mis-parse is audible rather than silent. The
// same guard draftIntent.js relies on: "what changed is SAID OUT LOUD before
// she is re-asked."
function describeCorrection(patch) {
    const bits = [];
    if (patch.count != null) bits.push(`${patch.count} container${patch.count === 1 ? '' : 's'}`);
    if (patch.size) bits.push(patch.size);
    if (patch.from) bits.push(`out of ${patch.from}`);
    if (patch.to) bits.push(`to ${patch.to}`);
    if (patch.cutoff) bits.push(`cut off ${forCarrier(patch.cutoff)}`);
    if (patch.erd) bits.push(`ERD ${forCarrier(patch.erd)}`);
    return bits.join(', ');
}

module.exports = {
    correctionIn, describeCorrection, forStore,
    isRequest, isRequestToSomeone, containersIn, countInAnswer, ask, askCutoff, details,
    MAIL_WORD, ASK_SOMEONE, NOT_A_PARTY,
    normalizeSize, SIZE_CORE, datesIn, cutoffInAnswer, forCarrier, line,
    usualRoute, commonest, bareDayOfMonth, afterLabel, A_HEDGE,
    ASKING, FOR_A_BOOKING, ABOUT_AN_EXISTING_ONE, WORD_NUMBERS, SIZE,
    CUTOFF_LABEL, ERD_LABEL, USUAL_SHARE,
};
