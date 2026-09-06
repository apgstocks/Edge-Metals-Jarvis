// ── helpers/voiceMemory.js — what she just asked, and what was on screen ──
//
// Apsara, 2026-09-06: "I want jarvis to remember every command and its
// response as short term memory.. So that i can do follow up questions.
// Basically i am not sure how to handle his memory part."
//
// And then, concretely: three bookings on screen, "when is the next cutoff",
// "what is the ERD", "forward that to trucker". Every one of those is a
// sentence that means nothing on its own.
//
// TWO KINDS OF MEMORY, AND CONFLATING THEM IS THE MISTAKE
// -------------------------------------------------------
// 1. The TRANSCRIPT — what was said, as text. Handed to the model, which is
//    good at resolving "what about the ERD" from context.
// 2. The REFERENT SET — the rows that were actually on screen, structured
//    and ranked. "The first one" is a position in a LIST, not a phrase in a
//    sentence, and asking a language model to count rows in prose it was
//    handed is exactly the kind of thing that fails silently. On this path a
//    miscount forwards a container to the wrong trucker.
//
// That split is Centering Theory (Grosz, Joshi & Weinstein 1995): each
// utterance makes available a RANKED list of discourse entities, and the
// antecedent of a reference is predicted by rank. helpers/answerCards.js
// already builds exactly that — rows sorted by soonest cutoff, each carrying
// `n` — with a comment saying "what the first one refers to". The list was
// already a referent set. Nothing was keeping it.
//
// WHY THE ORDINAL IS RESOLVED HERE AND NOT BY THE MODEL
// -----------------------------------------------------
// Because two things downstream cannot see a transcript at all:
// answerCards.cardsFor() is a regex over the utterance, and the brain's
// policy layer is ~1200 lines of pattern matching over session state. Both
// need a sentence that stands on its own.
//
// The literature is clear that rewriting for a model that CAN see history
// makes things slightly worse, not better — Ishii et al. 2022 measured
// end-to-end at 84.5 F1 against 82.9 for a rewrite pipeline, on every
// configuration they tried. So: rewrite deterministically ONLY for the blind
// components, and hand the model the raw history to resolve the rest.
//
// WHY IT LIVES ON THE SERVER
// --------------------------
// A client that posts its own transcript can post a stale or replayed one,
// and the last step of this flow sends a WhatsApp message to a real driver.
// The referent set is minted where the rows were minted.

// Turns kept. Six matches what helpers/yardAsk.js already slices to, and
// there is no reason for two windows of different lengths. Longer is not
// better: Laban et al. (2025) measured a 39% average drop from single-turn
// to multi-turn across 200k simulated conversations, and the mechanism is
// early commitment to a wrong assumption — a failure that MORE context
// feeds rather than starves.
const TURN_CAP = 6;
const TEXT_CAP = 300;

// The referent set expires far sooner than the session does. A list of
// bookings is stale long before a conversation is, and the failure mode of
// keeping it is precise: "the first one" resolving to something that left
// the screen twenty minutes ago. workflow/brain.js already carries a comment
// about menuContext never expiring and a bare "1" days later still selecting
// from a menu she saw last week — that bug, found and named, is this one.
const REFERENT_TTL_MS = 10 * 60 * 1000;

let turns = [];
let referents = null;

function remember(role, text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return;
    turns.push({ role, text: t.slice(0, TEXT_CAP), ts: Date.now() });
    if (turns.length > TURN_CAP) turns = turns.slice(-TURN_CAP);
}

// Called only when a NEW list was rendered. answerCards returns null for
// instructions, which is what stops "forward the first one" from replacing
// the very list it refers to.
function setReferents(cards) {
    if (!cards || !Array.isArray(cards.rows) || !cards.rows.length) return;
    referents = { kind: cards.kind, title: cards.title, ts: Date.now(), rows: cards.rows };
}

function currentReferents() {
    if (!referents) return null;
    if (Date.now() - referents.ts > REFERENT_TTL_MS) { referents = null; return null; }
    return referents;
}

// The shape helpers/yardAsk.js already expects.
function history() {
    return turns.map((t) => ({ role: t.role, text: t.text }));
}

function reset() { turns = []; referents = null; }

// ── resolving a reference ────────────────────────────────────────────────
const ORDINALS = {
    first: 1, '1st': 1, one: 1,
    second: 2, '2nd': 2, two: 2,
    third: 3, '3rd': 3, three: 3,
    fourth: 4, '4th': 4, four: 4,
    fifth: 5, '5th': 5, five: 5,
};

// "the first one", "the second booking", "the last one".
const ORDINAL_RE = new RegExp(
    '\\b(?:the\\s+)?(' + Object.keys(ORDINALS).join('|') + '|last)\\s+'
    + '(?:one|booking|row|result|container)\\b', 'i');

// "that booking", "that one", "this container". Only counts when a list is
// live — otherwise "it" is just a pronoun in an ordinary sentence.
// "the one" is NOT in here, and that omission is deliberate. It was, and it
// over-resolved: "that is the one we discussed" became "that is booking
// AAA111 we discussed", turning an ordinary sentence into a command about a
// specific container. "The one" is everyday English; "that booking" and
// "this container" are people pointing at something.
const DEICTIC_RE = /\b(?:(?:that|this)\s+(?:booking|one|container)|the\s+(?:booking|container))\b/i;

// ── AND A BARE "THAT", AFTER AN INSTRUCTION ──────────────────────────────
// Apsara's actual words: "forward that to trucker". Not "that booking" —
// just "that". The pattern above requires a noun after it, so the sentence
// she would really say was not recognised as a reference at all, and the
// booking number never reached the brain.
//
// A bare "that" is far too common to treat as a reference on its own, so it
// only counts DIRECTLY AFTER AN ACTION VERB and only while a list is on
// screen. "Forward that", "send that", "assign that" are pointing at
// something; "I thought that was fine" is not.
const BARE_DEICTIC_RE = /\b(forward|send|assign|dispatch|book|do|use)\s+(that|this|it)\b/i;

// Returns { text, resolved } — `resolved` is null when nothing was changed.
// NEVER guesses: an unresolvable reference is returned untouched, so the
// assistant asks rather than acting on the wrong container. The cost of
// asking is a sentence; the cost of guessing is a truck at the wrong yard.
function resolve(text) {
    const q = String(text || '');
    const set = currentReferents();
    if (!set) return { text: q, resolved: null };

    let row = null;
    let phrase = '';

    const m = ORDINAL_RE.exec(q);
    if (m) {
        phrase = m[0];
        const word = m[1].toLowerCase();
        row = (word === 'last') ? set.rows[set.rows.length - 1] : set.rows[ORDINALS[word] - 1] || null;
    } else if (DEICTIC_RE.test(q) || BARE_DEICTIC_RE.test(q)) {
        // "that booking" is unambiguous ONLY when there is one thing it
        // could mean. With three on screen it is a genuine ambiguity, and
        // the honest response is to ask — the same refusal the brain already
        // makes for a bare digit with two possible sources.
        if (set.rows.length === 1) {
            row = set.rows[0];
            // Whichever pattern matched — replacing the wrong span would
            // leave the pronoun in the sentence alongside the number.
            const m = DEICTIC_RE.exec(q);
            phrase = m ? m[0] : BARE_DEICTIC_RE.exec(q)[2];
        }
        else return { text: q, resolved: null, ambiguous: set.rows.length };
    }

    if (!row) return { text: q, resolved: null };

    const id = row.booking_number || '';
    if (!id) return { text: q, resolved: null };

    return {
        text: q.replace(phrase, 'booking ' + id),
        resolved: { from: phrase, to: id, n: row.n, row },
    };
}

module.exports = {
    remember, setReferents, currentReferents, history, resolve, reset,
    TURN_CAP, REFERENT_TTL_MS,
};
