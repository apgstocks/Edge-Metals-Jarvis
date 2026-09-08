// ── helpers/genericTerm.js ───────────────────────────────────────────────
// Apsara, 2026-09-07: "When i say forward booking to trucker, it says it
// cannot forward that booking to tracker."
//
// Reproduced in the harness, and it is three failures with one cause:
//
//   "forward booking to trucker"   -> No booking found for BOOKING.
//   "forward HOU111 to trucker"    -> Trucker "trucker" not found.
//   "forward the booking to tracker" (mis-transcribed) -> half-worked
//
// A GENERIC NOUN IS NOT AN IDENTIFIER
// -----------------------------------
// "Booking" is not a booking number and "trucker" is not a haulier's name.
// When she uses the bare word she is not naming an entity at all — she is
// saying "the one we are talking about", or "show me the list". The
// extraction took her category word and looked it up as a proper noun, found
// nothing, and reported the nothing back to her with the word quoted, which
// reads as if Jarvis had never heard of the concept.
//
// The right behaviour already EXISTS in workflow/actions.js — say "forward
// HOU111" with no trucker and it offers the list. All that was missing was
// recognising that "trucker" means the same as saying no name at all.
//
// AND "TRACKER" IS THE SAME WORD
// ------------------------------
// The recogniser hears "trucker" as "tracker" — the same class of failure as
// "jeyshree" for "Jayashree", and helpers/nameSuggest.js already has the tool
// for it. Both reduce to the consonant skeleton trKr, so the phonetic key
// catches the mis-hearing without a list of every way Whisper might spell it.
//
// CORRECTION TO MYSELF, 2026-09-08. I over-claimed above. On the POLICY route
// "tracker" never reaches this file as "tracker" at all: brain.js runs
// fuzzyCorrectKeywords over the sentence first, "trucker" is already in
// COMMAND_KEYWORDS, and a one-edit distance fixes it before extraction. That
// machinery predates me by weeks. Mutation testing is what exposed it — two
// mutations here survived, and the reason was not weak tests but a guard that
// had nothing left to guard on the path I was looking at.
//
// The phonetic key still earns its place, on the OTHER route: when the AI
// classifies the sentence, trucker_name is lifted from the raw text and no
// keyword correction has run over it. So it stays — but as the net for the
// AI route, which is what it actually is, not as the fix for a bug that was
// already fixed elsewhere.
//
// THE ORDER THAT KEEPS THIS SAFE
// ------------------------------
// A real record ALWAYS wins. If she has a haulier actually called "Driver
// Logistics", or a booking whose number normalises to one of these words,
// the lookup finds it and this file is never consulted. Only when the lookup
// has already failed does the question "was that even a name?" get asked.
// Reversing that order would make a generic-sounding real company
// unreachable, which is a worse bug than the one being fixed.

const { phonetic, norm } = require('./nameSuggest');

// Kept narrow on purpose. "Carrier" is deliberately ABSENT from the trucker
// list: MSC and Maersk are carriers, the word means something specific in her
// data, and folding it in here would turn a real question about a shipping
// line into a request for a trucker list.
const GENERIC = {
    trucker: ['trucker', 'truckers', 'driver', 'drivers', 'transporter',
              'transporters', 'hauler', 'haulers', 'trucking', 'the trucker'],
    booking: ['booking', 'bookings', 'load', 'loads', 'shipment', 'shipments',
              'the booking', 'that booking', 'this booking'],
    supplier: ['supplier', 'suppliers', 'seller', 'sellers', 'vendor', 'vendors',
               'the supplier'],
};

// Phonetic keys computed once. This is what makes "tracker" reach "trucker"
// without anybody having to think of "tracker" in advance.
const KEYS = {};
for (const kind of Object.keys(GENERIC)) {
    KEYS[kind] = new Set(GENERIC[kind].map((w) => phonetic(w)).filter(Boolean));
}

// True when `word` is the CATEGORY rather than a name within it.
//
// Returns false for anything empty — an absent name is already handled by the
// caller's own "no name given" path, and answering true here would be a
// second route to the same place.
function isGeneric(word, kind) {
    const w = norm(word);
    if (!w) return false;
    const list = GENERIC[kind];
    if (!list) return false;
    if (list.some((g) => norm(g) === w)) return true;
    // The mis-heard spellings. Length-guarded so a two-letter fragment cannot
    // collide its way into a category.
    if (w.length < 4) return false;
    return KEYS[kind].has(phonetic(word));
}

// Convenience for the call sites: hand it what she said and get back either
// the name (a real one) or null, which every caller already treats as "she
// did not name one, offer the list".
function nameOrNull(word, kind) {
    return isGeneric(word, kind) ? null : (word || null);
}

module.exports = { isGeneric, nameOrNull, GENERIC };
