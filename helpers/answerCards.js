// ── helpers/answerCards.js — the structured half of an answer ─────────────
//
// Apsara, 2026-09-06: "like JARVIS in iron man, a screen should appear, where
// it shows me all relevant answer to my question as jarvis is talking back.
// For eg: If i ask any available bookings from Houston? It should show
// Booking number, ERD, cut off."
//
// WHY THIS IS NOT PARSED OUT OF WHAT JARVIS SAYS
// ----------------------------------------------
// The obvious implementation is to take the reply — "Two bookings from
// Houston: 274150389, cutoff 07/13..." — and pull the fields back out of the
// sentence with a regex. That is the wrong direction of travel and it fails
// in a specific way: the moment the wording changes, or the model summarises
// three bookings as "a few", the table silently loses rows while still
// looking like a table. A screen that is confidently incomplete is worse
// than no screen.
//
// So the rows come from the SAME STORE the answer came from, looked up
// deterministically from the question. The spoken reply and the panel are
// two renderings of one set of facts, not one derived from the other. They
// cannot disagree, because neither is downstream of the other.
//
// AND THE NUMBERING IS LOAD-BEARING
// ---------------------------------
// "forward the first booking to Sher Trucking" only means something if
// something was numbered. The `n` on each row is what a follow-up refers to,
// which is why it is part of the data rather than a detail of how the
// dashboard happens to draw a list.

const { loadBookings } = require('./json');

// Ports as they are spoken, mapped to how they are written in the bookings.
// "Houston" is the same either way; "LA" and "Los Angeles" are not, and she
// says both.
const PORT_ALIASES = {
    la: 'LOS ANGELES',
    'l.a.': 'LOS ANGELES',
    losangeles: 'LOS ANGELES',
    lax: 'LOS ANGELES',
    oakland: 'OAKLAND',
    houston: 'HOUSTON',
    savannah: 'SAVANNAH',
    charleston: 'CHARLESTON',
    seattle: 'SEATTLE',
    tacoma: 'TACOMA',
    'long beach': 'LONG BEACH',
    longbeach: 'LONG BEACH',
    newark: 'NEWARK',
    norfolk: 'NORFOLK',
    busan: 'BUSAN',
};

// Is this a question about bookings at all? Deliberately generous on the
// noun and strict about it being a QUESTION rather than an instruction —
// "forward booking 27476 to Sher" should not redraw the table underneath the
// thing she is about to act on.
const ABOUT_BOOKINGS = /\b(booking|bookings|container|containers|vessel|vessels|cutoff|cutoffs|erd|sailing)\b/i;
const IS_INSTRUCTION = /\b(forward|assign|send|message|email|tell|notify|dispatch|book)\b/i;

const ymd = (s) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
    return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : '';
};

// Finds a port named anywhere in the question.
//
// Longest alias first. Worth being honest about: NO CURRENT PAIR OF ALIASES
// needs this — a mutation removing the sort left every test passing, because
// no alias is a word-bounded prefix of another today. It is kept because the
// list will grow ("newark" beside "new york", say) and the failure it
// prevents is silent: the wrong port, quietly, with a full-looking table.
// Recorded rather than dressed up as something the tests prove.
// ── THE PORTS WE ACTUALLY SHIP TO, NOT THE ONES I THOUGHT OF ─────────────
// Apsara, 2026-09-06: "my user doesnt know about nouns."
//
// PORT_ALIASES is fifteen ports I typed out from memory. Everything else —
// Mobile, Jacksonville, Nhava Sheva, Qingdao, every discharge port in Asia
// she actually ships to — hit namesSomewhere(), returned null, and showed
// her no panel at all. A hardcoded port list in a freight application whose
// booking store already records every port it uses is me deciding in advance
// which places her business is allowed to trade with.
//
// So the vocabulary is DERIVED FROM THE DATA. Every port_of_loading and
// port_of_discharge in bookings.json is a word she can say, automatically,
// for ever. PORT_ALIASES stays on top of it for the spoken forms that are
// not written anywhere ("LA" for LOS ANGELES) — data cannot supply those.
//
// Two things stop this widening into nonsense:
//   · a stoplist, because real ports are also ordinary English words. MOBILE
//     is a port in Alabama; "send it to my mobile" must not become a port
//     filter. So is READING, and BAR HARBOR, and PROGRESO.
//   · a length floor, because a two-letter port code inside another word is
//     exactly the "atlanta"/"LA" collision the word boundary is there for,
//     and short strings collide far more often than they help.
const PORT_STOPWORDS = new Set([
    'MOBILE', 'READING', 'PROGRESS', 'PROGRESO', 'RICHMOND', 'VICTORIA',
    'ALBANY', 'SALEM', 'CONCORD', 'DOVER', 'MADISON', 'FRANKLIN', 'MARION',
]);

let _portCache = null;
let _portCacheAt = 0;
const PORT_CACHE_MS = 30 * 1000;

// Ports as written in the bookings, normalised. Cached briefly — cardsFor
// runs on every utterance and loadBookings() reads a file.
function knownPorts() {
    if (_portCache && Date.now() - _portCacheAt < PORT_CACHE_MS) return _portCache;
    const out = new Map();                       // lowercase spoken → UPPERCASE stored
    try {
        const all = loadBookings() || {};
        for (const b of Object.values(all)) {
            for (const v of [b && b.port_of_loading, b && b.port_of_discharge]) {
                const s = String(v || '').trim();
                if (s.length < 4) continue;                    // too short to match safely
                const up = s.toUpperCase();
                if (PORT_STOPWORDS.has(up)) continue;          // also an ordinary word
                out.set(up.toLowerCase(), up);
            }
        }
    } catch (e) {
        // A missing or unreadable store means no derived vocabulary, not a
        // crash on every question she asks.
        console.warn('[CARDS] could not read the ports from bookings:', e.message);
    }
    _portCache = out; _portCacheAt = Date.now();
    return out;
}

function portIn(text) {
    const t = String(text || '').toLowerCase();
    // Aliases and derived ports in ONE list, longest first — so "long beach"
    // beats "beach" and a derived "NHAVA SHEVA" beats a derived "NHAVA",
    // whichever list each came from. Sorting the two separately would let a
    // short alias win over a longer real port name.
    const cands = [
        ...Object.entries(PORT_ALIASES),
        ...knownPorts().entries(),
    ].sort((a, b) => b[0].length - a[0].length);
    for (const [k, v] of cands) {
        // Word-bounded: "la" must not match inside "atlanta".
        if (new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)) return v;
    }
    return '';
}

// Did she name a place at all? Only used to tell "no port mentioned" apart
// from "a port I do not recognise" — two things portIn() reports the same
// way, and which need opposite behaviour.
//
// Deliberately narrow: the word right after from/at/out of/in, and only when
// it is not one of the ordinary words that follow those prepositions in a
// question about bookings. Being wrong here costs a panel, never a wrong
// panel, which is the right direction to fail in.
const NOT_A_PLACE = /^(the|a|an|this|that|these|those|our|my|us|now|there|here|today|tomorrow|yesterday|last|next|week|month|year|it|them|which|what|any|all)$/i;

function namesSomewhere(text) {
    var m = /\b(?:from|at|out of|in|to)\s+([a-z][a-z.\-]{2,})/i.exec(String(text || ''));
    if (!m) return false;
    return !NOT_A_PLACE.test(m[1]);
}

function bookingRows(port) {
    const all = loadBookings() || {};
    const wanted = String(port || '').toUpperCase();
    return Object.values(all)
        .filter((b) => !wanted
            || String(b.port_of_loading || '').toUpperCase().includes(wanted)
            || String(b.port_of_discharge || '').toUpperCase().includes(wanted))
        // Soonest cutoff first. That is the order she cares about — a
        // booking cutting off tomorrow is the one that needs a trucker —
        // and it is also the order that makes "the first one" mean
        // something useful rather than something arbitrary.
        .sort((a, b) => (ymd(a.cutoff_date) || '9999').localeCompare(ymd(b.cutoff_date) || '9999'))
        .map((b, i) => {
            const containers = Array.isArray(b.containers) ? b.containers : [];
            return {
                n: i + 1,                     // what "the first one" refers to
                booking_number: b.booking_number || '',
                carrier: b.carrier || '',
                from: b.port_of_loading || '',
                to: b.port_of_discharge || '',
                vessel: b.vessel_voyage || '',
                erd: b.erd_date || '',
                cutoff: b.cutoff_date || '',
                buyer: b.buyer || '',
                containers: containers.map((c) => ({
                    seq: c.seq,
                    size: c.size || '',
                    number: c.container_number || null,
                    supplier: c.supplier || null,
                    trucker: c.trucker || null,
                    stage: c.stage || null,
                })),
                container_count: containers.length,
                // The two numbers that decide whether it needs attention.
                unassigned: containers.filter((c) => !c.supplier).length,
                not_forwarded: containers.filter((c) => !c.trucker).length,
            };
        });
}

// Returns { kind, title, rows } or null. Null is the normal case — most
// questions have no table behind them, and inventing one would fill the
// screen with noise.
function cardsFor(question) {
    const q = String(question || '');
    if (!q.trim()) return null;

    // An instruction is acting ON something already on screen. Redrawing the
    // panel underneath her at that moment is how "the first one" comes to
    // mean a different booking than the one she is looking at.
    //
    // Moved above the port lookup for readability, NOT for behaviour — I
    // first wrote a comment here claiming the reorder was load-bearing, and
    // mutation said otherwise: moving it back below leaves every test
    // passing, because it still returns before any rows are built. Recorded
    // as it is rather than as the tidier story.
    if (IS_INSTRUCTION.test(q)) return null;

    const port = portIn(q);

    // ── SHE DOES NOT HAVE TO SAY "BOOKING" ───────────────────────────────
    // ABOUT_BOOKINGS is nine nouns I chose. "What's going out of Houston
    // this week", "anything loading in Savannah", "what have we got moving"
    // — none of them contain one, and every one of them got no panel.
    //
    // The widening is deliberately NOT a longer list of verbs, which is the
    // same mistake one size up. It is: a question that names a port we
    // actually ship through, and is not an instruction, is a question about
    // bookings. Nothing else in this system is organised by port, so there
    // is no other thing she could mean — and the port came from the data, so
    // the vocabulary grows on its own.
    if (!ABOUT_BOOKINGS.test(q) && !port) return null;

    // ── A PLACE WE DO NOT KNOW IS NOT "NO PLACE" ─────────────────────────
    // portIn() returns '' both when no port was named and when one was named
    // that we do not recognise — and bookingRows('') means "no filter", so
    // "any bookings from Reykjavik" quietly rendered EVERY booking. She would
    // have been looking at a full table under a question about a port with
    // nothing in it, which is not a smaller mistake than showing nothing.
    //
    // So a place is looked for separately from a KNOWN place. If she named
    // somewhere and it is not a port in the bookings, the honest panel is no
    // panel — Jarvis still answers in words, and the words can say there is
    // nothing there.
    if (!port && namesSomewhere(q)) return null;

    const rows = bookingRows(port);
    if (!rows.length) return null;
    return {
        kind: 'bookings',
        title: port ? `Bookings — ${port}` : 'Bookings',
        rows,
    };
}

// ── A FOLLOW-UP MUST NOT REDRAW THE LIST ─────────────────────────────────
// Apsara, 2026-09-07: "On follow up - why it keeps on saying the same thing
// about booking."
//
// Reproduced in tests/e2e-voice.js, and it is two bugs wearing one coat:
//
//   YOU: show me the bookings from houston
//    ->  Yes — 2 bookings from Houston. Earliest cutoff is next Tuesday...
//   YOU: and the vessel
//    ->  Yes — 4 bookings. Earliest cutoff is this Monday...      <-- again
//
// 1. THE REPETITION. "and the vessel" contains the word "vessel", which is on
//    the ABOUT_BOOKINGS list, so cardsFor treated it as a NEW question about
//    bookings, built a fresh table, and fu.opening() read the same summary
//    sentence out again. Every follow-up the answer layer could not handle
//    came back as the opening line, which is exactly what she is hearing.
//
// 2. THE WORSE ONE. The new table was ALL FOUR bookings, because "and the
//    vessel" names no port to filter on. So the referent set was silently
//    replaced — her two Houston rows became four — and the discourse center
//    moved with it. Her next "the container" resolved to a Long Beach
//    booking she had never mentioned. A repetition is annoying; quietly
//    changing what "that booking" means is dangerous.
//
// THE RULE. A question only replaces the list when it names something that
// would CHANGE which bookings belong on screen: a port, or a booking number,
// or an explicit ask to list them. "And the vessel" names none of those — it
// is a question ABOUT the rows already there, and the rows must stay put.
//
// Deliberately not a length or a wake-word heuristic: "what about Oakland" is
// short and IS a new subject, while "can you tell me what the vessel on that
// one is" is long and is not. What matters is whether she named a new filter.
const LIST_REQUEST = /\b(?:show|list|give|what|which|any|how many)\b[^.?]{0,30}\bbookings?\b/i;

function isFollowUp(question, referents) {
    const q = String(question || '');
    if (!q.trim()) return false;
    // ── AN INSTRUCTION IS NOT A FOLLOW-UP QUESTION ───────────────────────
    // Found 2026-09-07 by section 7 of the e2e, and it would have shipped:
    // "forward HOU111 to Sher Trucking" IS about the rows on screen, so the
    // model answered "yes, still these rows" — quite correctly — and the
    // follow-up branch swallowed it and replied "I don't have that on
    // HOU111" instead of forwarding the booking to a driver.
    //
    // The model was asked the right question and given the wrong job. "Is
    // she still talking about these rows" and "is this a question rather
    // than an order" are different, and only the second one decides whether
    // this branch may answer instead of acting.
    if (IS_INSTRUCTION.test(q)) return false;
    // Nothing on screen means there is nothing to follow up ON.
    if (!referents || !Array.isArray(referents.rows) || !referents.rows.length) return false;
    // A port is a new filter, always.
    if (portIn(q)) return false;
    // An explicit "show me the bookings" is a fresh query even with no port —
    // she is asking for the whole list back.
    if (LIST_REQUEST.test(q)) return false;
    // A booking number is the narrowest new subject there is. Checked against
    // the numbers that actually exist rather than a made-up pattern, so a
    // format nobody anticipated cannot slip through as "not a booking".
    try {
        const all = bookingRows();
        const norm = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (all.some((b) => b.booking_number
            && norm.includes(String(b.booking_number).toUpperCase().replace(/[^A-Z0-9]/g, '')))) return false;
    } catch (e) { /* no bookings is not a reason to redraw */ }
    return true;
}

module.exports = {
    cardsFor, bookingRows, portIn, namesSomewhere, knownPorts, isFollowUp, LIST_REQUEST, IS_INSTRUCTION,
    PORT_ALIASES, PORT_STOPWORDS,
    // Tests need to defeat the 30s cache after writing a fixture store.
    _clearPortCache: () => { _portCache = null; _portCacheAt = 0; },
};
