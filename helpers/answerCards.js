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
function portIn(text) {
    const t = String(text || '').toLowerCase();
    const keys = Object.keys(PORT_ALIASES).sort((a, b) => b.length - a.length);
    for (const k of keys) {
        // Word-bounded: "la" must not match inside "atlanta".
        if (new RegExp('\\b' + k.replace('.', '\\.') + '\\b').test(t)) return PORT_ALIASES[k];
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
    if (!ABOUT_BOOKINGS.test(q)) return null;
    // An instruction is acting ON something already on screen. Redrawing the
    // panel underneath her at that moment is how "the first one" comes to
    // mean a different booking than the one she is looking at.
    if (IS_INSTRUCTION.test(q)) return null;

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
    const port = portIn(q);
    if (!port && namesSomewhere(q)) return null;

    const rows = bookingRows(port);
    if (!rows.length) return null;
    return {
        kind: 'bookings',
        title: port ? `Bookings — ${port}` : 'Bookings',
        rows,
    };
}

module.exports = { cardsFor, bookingRows, portIn, namesSomewhere, PORT_ALIASES };
