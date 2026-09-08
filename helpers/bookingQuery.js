// ── helpers/bookingQuery.js — a SCHEMA, not a parser ─────────────────────
//
// Apsara, 2026-09-08:
//   "Why would i need to hard code it? Stupid.. Its an AI.. Why would i need
//    to do so much fixes? Why cant yu find that on your own???"
//   "Check comletely research papers, first decide, then fix. dont just keep
//    on doing patch work"
//
// She caught me adding a SECOND regex for word order — "houston bookings"
// beside "bookings from houston" — which guarantees a third report the next
// time she phrases it a third way. This file is the decision that replaces
// that habit. What follows is the reasoning, because the reasoning is the
// part that stops it happening again.
//
// ── WHAT THE LITERATURE SAYS ─────────────────────────────────────────────
//
// 1. SCHEMA-GUIDED DIALOGUE. Rastogi et al., "Towards Scalable Multi-Domain
//    Conversational Agents: The Schema-Guided Dialogue Dataset" (AAAI 2020;
//    DSTC8 Track 4). The whole point of SGD is that a schema gives a NATURAL
//    LANGUAGE DESCRIPTION for every slot and intent, "to help models
//    generalize to unseen API schemas" — zero-shot, on services the model was
//    never trained on. If a described schema generalises to APIs nobody has
//    seen, it certainly generalises to a word order I did not think of.
//
//    The regex I was extending is precisely the thing that benchmark exists
//    to retire. So: the slots below carry their descriptions IN WORDS, and
//    those words are what the model reads. Adding a new way to ask is not a
//    code change. That is the test of whether this was done properly.
//
// 2. SLOT CARRYOVER IS A DECISION, NOT A RULE. Naik, Gupta, Ge, Mathias &
//    Sarikaya, "Contextual Slot Carryover for Disparate Schemas" (Interspeech
//    2018, Amazon Alexa). They reformulate context handling as "a decision to
//    carryover a slot from a set of possible candidates" and report a 9%
//    improvement over a slot-mapping system using HAND-CODED RULES.
//
//    This is exactly her second complaint. "Show me available bookings" then
//    "houston" — the word "available" has to survive into the second turn or
//    she gets every Houston booking including the assigned ones. That is slot
//    carryover, and the measured finding is that rules lose to a decision
//    made over the whole context. So carryover happens in the model call,
//    which sees the previous frame, rather than in a branch here.
//
// 3. ASKING IS NORMAL, NOT A FAILURE. In studies of mixed-initiative
//    collaborative interaction, clarification accounts for ~27% of
//    interactions — more than any other kind. Her "it should ask from which
//    port if not mentioned explicitly" is not a special case to bolt on; it
//    is the single most common thing a competent assistant does. What it must
//    not do is ask when it already knows: one port in play, no question.
//
// 4. STRUCTURED OUTPUT, NOT TEXT WE REGEX. Current practice for production
//    LLM systems is to constrain generation to a JSON schema and validate the
//    result, rather than pattern-matching prose. callGeminiJSON already takes
//    a schema and already validates; this file supplies one.
//
// ── THE DIVISION OF LABOUR THIS FIXES ────────────────────────────────────
//
//   THE MODEL decides what she MEANT: which slots she filled, which she
//   carried over from the last turn, whether she is narrowing or starting
//   again. Meaning includes word order. Word order was never mine to
//   enumerate.
//
//   THIS FILE decides what is TRUE: which rows match, what "next week"
//   actually is in dates, whether a required slot is missing, and what to
//   call the scope when reporting back.
//
// The offline net stays deliberately DUMB and deliberately SMALL. It exists
// so Jarvis still works when Gemini is unreachable — not so that it can
// eventually understand everything. Every time I have grown it, I have been
// solving the wrong problem, and she has had to tell me so.

const bk = require('./booking');

// Every port that appears in her bookings, loading or discharge. Uncached on
// purpose — see the note in offline(). The file is small and this runs once
// per utterance.
function allBookings() {
    return Object.values(
        require('./json').loadJson(require('../config').BOOKINGS_FILE, {}) || {});
}
function knownPorts() {
    const s = new Set();
    for (const b of allBookings()) {
        if (b.port_of_loading) s.add(String(b.port_of_loading).trim());
        if (b.port_of_discharge) s.add(String(b.port_of_discharge).trim());
    }
    return [...s];
}

// ── THE SCHEMA ───────────────────────────────────────────────────────────
// Descriptions are written for the MODEL to read, in the words she uses. This
// is the SGD idea applied literally: adding a way of asking means editing a
// sentence here, not adding a branch anywhere.
const SLOTS = {
    location:
        'The port, city or yard she is asking about. Any word order and any '
        + 'phrasing: "bookings from Houston", "Houston bookings", "what have we '
        + 'got in Houston", "anything loading out of Houston" are all the same '
        + 'slot filled with the same value. Null if she named no place. '
        + '"mail", "email" and "inbox" are NOT places.',
    status:
        'Which bookings she wants: "unassigned" when she says available, free, '
        + 'unassigned, needing a supplier, still open; "assigned" when she says '
        + 'already assigned or taken; "any" when she does not narrow it. '
        + 'IMPORTANT: if she asked for available bookings on an earlier turn and '
        + 'is now only naming a place, she still means available — carry it.',
    cutoff_phrase:
        'Her timing words, VERBATIM, if she narrowed by cutoff date: "anywhere '
        + 'next week", "this week", "in 3 days", "tomorrow". Copy her words; do '
        + 'not convert them to dates. Null if she did not narrow by cutoff. '
        + 'Never invent one, and never drop one she gave you.',
    scope:
        '"all" if she explicitly asked for every port at once ("all of them", '
        + '"everywhere", "all ports"), otherwise null.',
};

// ── FILLING IT ───────────────────────────────────────────────────────────
// Model first. `prev` is the frame from her last booking question, handed to
// the model so carryover is a decision made over the whole context rather
// than a rule here — the Naik et al. finding, applied.
//
// Returns null when this was not a question about bookings at all. Null is a
// real answer and means "leave the panel alone".
async function parse(text, opts) {
    const o = opts || {};
    const said = String(text || '').trim();
    if (!said) return null;

    const prompt = [
        'You are reading one sentence from Apsara, who runs a freight desk, and',
        'filling in a small form. Answer ONLY with JSON.',
        '',
        'SHE SAID: ' + said,
        '',
        o.prev ? 'HER LAST BOOKING QUESTION WAS: ' + JSON.stringify(o.prev) : 'NO PREVIOUS BOOKING QUESTION.',
        (function () { const p = knownPorts(); return p.length ? 'PORTS THAT EXIST IN HER DATA: ' + p.join(', ') : ''; })(),
        '',
        'FIELDS:',
        ...Object.keys(SLOTS).map((k) => `  ${k}: ${SLOTS[k]}`),
        '  is_booking_query: true if this sentence is asking WHICH BOOKINGS to show,',
        '    in any phrasing at all. False if it is an instruction to act on one',
        '    (forward, assign, email), a follow-up about a booking already on screen',
        '    (its ERD, its vessel, its cutoff), or anything not about listing bookings.',
        '',
        'CARRYOVER: when she names only a place, or only a date range, she is',
        'NARROWING HER LAST QUESTION, not starting a new one. Copy forward the',
        'fields she did not restate. When she clearly starts a new subject, do not.',
        '',
        'Return: {"is_booking_query": bool, "location": string|null,',
        ' "status": "unassigned"|"assigned"|"any", "cutoff_phrase": string|null,',
        ' "scope": "all"|null}',
    ].filter(Boolean).join('\n');

    let out = null;
    try {
        const { callGeminiJSON, lastGeminiFailure } = require('./gemini');
        const { z } = require('zod');
        const schema = z.object({
            is_booking_query: z.boolean(),
            location: z.string().nullable().optional(),
            status: z.enum(['unassigned', 'assigned', 'any']).optional(),
            cutoff_phrase: z.string().nullable().optional(),
            scope: z.string().nullable().optional(),
        });
        out = await callGeminiJSON(prompt, 1, schema);
        if (!out) {
            const why = typeof lastGeminiFailure === 'function' ? lastGeminiFailure() : 'unknown';
            console.log('[QUERY] model unavailable (' + why + ') — using the offline net');
        }
    } catch (e) {
        console.log('[QUERY] model call failed: ' + (e && e.message) + ' — using the offline net');
    }

    if (!out) return offline(said, o);
    if (!out.is_booking_query) return null;
    return {
        location: out.location || null,
        status: out.status || 'any',
        cutoff_phrase: out.cutoff_phrase || null,
        scope: out.scope === 'all' ? 'all' : null,
        by: 'model',
    };
}

// ── THE OFFLINE NET ──────────────────────────────────────────────────────
// DELIBERATELY SMALL, AND IT STAYS SMALL. Its job is that Jarvis remains
// usable when Gemini cannot be reached — not that it eventually understands
// everything. Every time I have grown this kind of code to cover one more
// phrasing, I have been solving the wrong problem.
//
// So it recognises the plainest forms and nothing more. If it misses, the
// caller says it could not tell rather than answering a different question.
function offline(said, o) {
    const t = said.toLowerCase();
    // ── THE PORTS COME FROM THE DATA, HERE, EVERY TIME ───────────────────
    // This used to take them from the caller (answerCards.knownPorts()),
    // which caches. In the harness the cache was populated before the
    // fixtures were written, so it handed back an empty list, "houston"
    // matched nothing, and her answer to Jarvis's own question fell through
    // to the brain as an unrecognised sentence.
    //
    // Two sources of truth for "what ports exist" is one too many, and the
    // one that is a cache will always be the one that is wrong at the moment
    // it matters. Read them where the bookings are.
    const ports = knownPorts();
    const named = ports.find((p) => t.indexOf(String(p).toLowerCase()) !== -1) || null;
    // A SENTENCE THAT POINTS AT SOMETHING IS NOT A REQUEST FOR A LIST.
    // "when is the erd of that booking" contains the word "booking", so the
    // net claimed it, built a fresh query and asked her which port — about a
    // booking she was already looking at. Online the model answers this
    // correctly with is_booking_query:false; the net needs the one rule that
    // covers the whole class, which is that a deictic refers to something
    // already on screen.
    if (/\b(that|this|it|those|these|the one)\b/.test(t)) return null;

    // AND AN ORDER IS NOT A QUESTION. "forward booking HOU111 to Sher
    // Trucking" contains the word "booking", so the net claimed it and asked
    // her which port — in the middle of an instruction that named the booking
    // outright. Reusing answerCards' own instruction test rather than writing
    // a second one: two regexes for "is she telling me to do something" would
    // disagree eventually, and the disagreement would be invisible.
    const { IS_INSTRUCTION } = require('./answerCards');
    if (IS_INSTRUCTION.test(t)) return null;
    const asksList = /\bbookings?\b|\bloads?\b|\bshipments?\b/.test(t);
    // A bare port name right after a booking question is her answering it.
    const bareAnswer = !!(o && o.prev && named && t.split(/\s+/).length <= 3);

    // ── NAMING A PORT IS ITSELF A BOOKING QUESTION ───────────────────────
    // "anything from long beach" has no booking noun and is four words, so
    // neither test above catches it — and it is obviously a request for a
    // list. This is answerCards' existing rule, moved rather than invented:
    // nothing else in this system is organised by port, so a sentence that
    // names one, and is not an order and not pointing at something already on
    // screen, has nothing else it could be about. The vocabulary comes from
    // her data, so it grows without me.
    if (!asksList && !bareAnswer && !named) return null;
    const status = /\b(available|unassigned|free|open|need(?:s|ing)? a supplier)\b/.test(t) ? 'unassigned'
        : /\bassigned\b/.test(t) ? 'assigned'
        : (o && o.prev && o.prev.status) || 'any';
    return {
        location: named || (o && o.prev && bareAnswer ? o.prev.location : null),
        status,
        // The whole sentence is handed over; cutoffWindow decides if there is
        // a window in it. A hand-off, not a parse.
        cutoff_phrase: /\bcut\s*-?\s*off|\bcutoff\b|\bclosing\b/.test(t) ? t : (o && o.prev ? o.prev.cutoff_phrase : null),
        scope: /\b(all|every port|everywhere|all ports)\b/.test(t) ? 'all' : null,
        by: 'offline',
    };
}

// ── RUNNING IT ───────────────────────────────────────────────────────────
// Everything below is deterministic. The model said what she meant; this says
// what is true.
function run(frame, now) {
    const f = frame || {};
    // ── THE WORKFLOW RECORD IS WHERE THE SUPPLIER ACTUALLY IS ────────────
    // hasSupplierAssigned(b, wf) needs BOTH. executeAssign writes wf.supplier
    // and the container's own field, never b.supplier — so calling it with one
    // argument, as this did, checks the legacy flat field alone and reports
    // every properly assigned booking as unassigned.
    //
    // That is not a new mistake. helpers/booking.js carries a comment dated
    // 2026-07-16 about the identical bug in getAvailableBookings, confirmed
    // live on booking 272766480. I reintroduced it yesterday by dropping the
    // second argument, in a file written to make this area better.
    const workflow = require('./json').loadWorkflow();

    const rows = allBookings().filter((b) => {
        if (f.location) {
            const want = String(f.location).toUpperCase();
            const from = String(b.port_of_loading || '').toUpperCase();
            const to = String(b.port_of_discharge || '').toUpperCase();
            if (from.indexOf(want) === -1 && to.indexOf(want) === -1) return false;
        }
        const wf = workflow[b.booking_number];
        if (f.status === 'unassigned' && bk.hasSupplierAssigned(b, wf)) return false;
        if (f.status === 'assigned' && !bk.hasSupplierAssigned(b, wf)) return false;
        return true;
    });

    const win = f.cutoff_phrase ? bk.cutoffWindow(f.cutoff_phrase, now) : null;
    const { rows: kept, undated } = bk.withinCutoffWindow(rows, win);

    return {
        rows: win ? kept : rows,
        window: win,
        undated: win ? undated : 0,
        ports: [...new Set(rows.map((b) => b.port_of_loading).filter(Boolean))],
    };
}

// ── WHEN TO ASK ──────────────────────────────────────────────────────────
// Clarification is the most common move a collaborative assistant makes, but
// only when there is genuinely something to clarify. One port in play means
// the question is theatre and the answer is simply given.
function needsPort(frame, result) {
    const f = frame || {};
    if (f.location) return null;
    if (f.scope === 'all') return null;
    const ports = (result && result.ports) || [];
    if (ports.length < 2) return null;
    return ports;
}

// What scope was actually answered, in her words, so a narrower or wider
// answer than she asked for is visible rather than silent.
function describe(frame, result) {
    const f = frame || {};
    const title = (s) => String(s || '').replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    const bits = [];
    if (f.status === 'unassigned') bits.push('unassigned');
    else if (f.status === 'assigned') bits.push('assigned');
    bits.push(f.location ? `from ${title(f.location)}` : 'across every port');
    if (result && result.window) bits.push(`cutting off ${result.window.label}`);
    return bits.join(' ');
}

module.exports = { SLOTS, parse, offline, run, needsPort, describe };
