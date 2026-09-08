// ── helpers/pickFromList.js — choosing one of a few things, out loud ─────
// Apsara, 2026-09-09: "when i hav multiple trucers,it asking to tell name or
// choose from number. when i say one -its not detected. when i again say 1,
// getting detected as 11. also When i say trucker name as Jey, it is
// transcribing as J or Jai or JJ. as a ai,is it that difficult to map like
// chatgpt or claude does?"
//
// The honest answer to the last question, because she deserves one: no, and
// the difficulty was never the model's. The whole of the old resolver was
// seven lines in workflow/brain.js:
//
//     if (/^\d+$/.test(t)) { ...index... }
//     return options.find(o => o === t || o.includes(t)) || null;
//
// Digits only, then a substring test. So "one" failed, "first" failed,
// "number 2" failed, and "Jai" failed — not because understanding her was
// hard, but because NOTHING EVER COMPARED WHAT SHE SAID TO THE LIST ON HER
// SCREEN. That list is two to eight items long. Matching a mis-heard word
// against eight candidates is the easiest job in this codebase, and it simply
// was not being done.
//
// WHY THE SHORT-NAME CASE IS SOLVABLE HERE AND NOT IN THE RECOGNISER
// ------------------------------------------------------------------
// "Jey" comes back as "J", "Jai" or "JJ" because a one-syllable proper noun
// carries almost no acoustic information, and no speech model — Whisper, the
// browser, or anything else — reliably recovers it from the audio alone. This
// is the documented weak point of end-to-end ASR: proper nouns are the main
// source of biasing phrases precisely because they are the thing it gets
// wrong (Zhao et al., Interspeech 2019).
//
// A language model cannot fix audio it never hears. What FIXES it is the
// thing ChatGPT would also be doing in this situation: knowing the small set
// of possible answers and picking the nearest. "Jai" against a closed list of
// {Jey Transport, Sher Trucking, Bayou Haulage} is unambiguous. Against the
// open set of all English words it is hopeless. The list is the whole trick.
//
// AMBIGUITY IS A QUESTION, NEVER A GUESS
// ---------------------------------------
// The old substring test returned the FIRST option containing her text. With
// "Jey Transport" and "Jio Logistics" both on screen, "J" silently picked one
// of them — and there is a truck at the end of this. Every tier below returns
// a match only when exactly ONE candidate survives it. Several survivors
// means null, which the caller turns back into "which one?".
//
// The tiers run widest-confidence first, and each is all-or-nothing:
//   1. she said a position   — "1", "one", "the first one", "number 2", "last"
//   2. exact name
//   3. the name starts with what she said, or a word in it does
//   4. her text appears in the name
//   5. it SOUNDS like one of them   (helpers/nameSuggest's phonetic skeleton)
//   6. it is one or two typos away  (edit distance, scaled to length)

const { phonetic, norm } = require('./nameSuggest');

// ── norm() IS FOR PEOPLE'S NAMES, AND IT STRIPS DIGITS ────────────────────
// Found by tests/pick-from-list.js on the first run: HOU111 and HOU222 both
// normalise to "hou", so choosing between two bookings by number matched
// everything and therefore nothing. nameSuggest.norm exists to compare human
// names, where digits are noise; here half the lists are identifiers, where
// the digits ARE the identity.
//
// So this file keeps its own key: lowercase, letters and digits only. norm()
// and phonetic() are still used, but only for the SOUND tiers, where they
// belong.
function key(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Does this list identify things by code rather than by name? A booking
// number is an identity: HOU111 is not "nearly" HOU222, and fuzzy-matching
// one into the other would forward the wrong container. Sound and
// edit-distance are for names; identifiers get exact comparison only.
function looksLikeIdentifiers(opts) {
    return opts.some((o) => /\d/.test(String(o)));
}

// Spoken positions. Deliberately literal rather than a number parser: she is
// choosing from a list of a few, so "one" through "twenty" and their ordinals
// is the whole of the language that can occur here. A general parser would
// also accept "a hundred and six", which is not a thing anyone says to a list
// of three truckers.
const WORD_NUMBERS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
    eighth: 8, ninth: 9, tenth: 10,
    // What the recogniser actually returns for these, often enough to matter.
    won: 1, tu: 2, too: 2, to: 2, for: 4, ate: 8,
};

// Words that wrap a choice without being part of it.
const FILLER = /^(?:the|a|an|please|pls|number|no\.?|option|item|choice|pick|select|choose|go\s+with|make\s+it|its|it'?s|thats|that'?s|i\s+said|say)\s+/i;
const TRAILING = /\s+(?:one|please|pls|thanks|thank\s+you|then)\s*$/i;

function strip(text) {
    let t = String(text || '').toLowerCase().trim().replace(/[.!?,]+$/g, '');
    let before;
    do { before = t; t = t.replace(FILLER, '').trim(); } while (t !== before);
    // "the first one" -> "first". Only stripped when something remains, so a
    // bare "one" is still the number one.
    const stripped = t.replace(TRAILING, '').trim();
    if (stripped) t = stripped;
    return t;
}

// Her text as a POSITION in the list, or null. 1-based, as spoken.
function positionOf(text, count) {
    const t = strip(text);
    if (!t) return null;
    if (/^last$/.test(t)) return count || null;
    const digits = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
    if (digits) return parseInt(digits[1], 10);
    if (Object.prototype.hasOwnProperty.call(WORD_NUMBERS, t)) return WORD_NUMBERS[t];
    return null;
}

// Levenshtein, small and local. helpers/nameSuggest has one too, but it is not
// exported and duplicating six lines beats exporting an internal for one use.
function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m || !n) return Math.max(m, n);
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]
                : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[n];
}

// Exactly one survivor, or nothing. The single rule that keeps this safe.
function only(matches) {
    return matches.length === 1 ? matches[0] : null;
}

// Returns the chosen option, or null when she must be asked again.
//
// `options` are the strings she was shown, in the order she was shown them —
// so position 1 means the first line on her screen, whatever the underlying
// data order happens to be.
function pick(text, options) {
    const opts = (Array.isArray(options) ? options : []).filter((o) => String(o || '').trim());
    if (!opts.length) return null;
    const raw = String(text || '').trim();
    if (!raw) return null;

    // 1. A POSITION.
    const pos = positionOf(raw, opts.length);
    if (pos != null) {
        // Out of range is NOT a near miss to be rounded into the list. She
        // said 5 of 3; answering with the third would be inventing a choice.
        return (pos >= 1 && pos <= opts.length) ? opts[pos - 1] : null;
    }

    const t = strip(raw);
    const q = key(t);
    if (!q) return null;
    const identifiers = looksLikeIdentifiers(opts);
    // WORDS COME FROM THE ORIGINAL STRING, normalised one at a time. norm()
    // strips whitespace, so norm('Jey Transport') is 'jeytransport' — split
    // that and you get ONE token, and every per-word tier below silently does
    // nothing. That is exactly why "Jai" failed: the phonetic tier was there,
    // ran, and compared against a glued-together word it could never match.
    // A guard that cannot fire looks identical to a guard that fires and
    // decides no.
    const N = opts.map((o) => ({
        o,
        n: key(o),
        words: String(o).split(/[\s/&,.-]+/).map((w) => key(w)).filter(Boolean),
    }));

    // 2. EXACT.
    const exact = only(N.filter((x) => x.n === q));
    if (exact) return exact.o;

    // 3. STARTS WITH — the whole name, or any word in it. This is the tier
    //    that catches "Jey" for "Jey Transport" and "Sher" for "Sher
    //    Trucking", and the one a person would use first.
    const starts = N.filter((x) => x.n.startsWith(q) || x.words.some((w) => w.startsWith(q)));
    if (only(starts)) return only(starts).o;

    // 4. CONTAINS. Weaker, so it only counts if nothing above matched and
    //    exactly one option contains her text — the old code's silent
    //    first-match-wins is precisely what this avoids.
    const contains = N.filter((x) => x.n.indexOf(q) !== -1);
    if (only(contains)) return only(contains).o;

    // ── AND THE FUZZY TIERS STOP HERE FOR IDENTIFIERS ────────────────────
    // Everything above is exact. What follows is "near enough", which is
    // right for a company name someone half-heard and wrong for a booking
    // number: HOU111 is one character from HOU222, and forwarding the wrong
    // container is not a near miss, it is a different truck.
    if (identifiers) return null;

    // 5. SOUNDS LIKE. The mis-heard-name tier: "Jai" and "Jey" reduce to the
    //    same consonant skeleton, as do "tracker" and "trucker" elsewhere in
    //    this codebase.
    const qp = phonetic(t);
    if (qp) {
        const sounds = N.filter((x) => phonetic(x.o) === qp || x.words.some((w) => phonetic(w) === qp));
        if (only(sounds)) return only(sounds).o;
    }

    // 6. A TYPO OR TWO AWAY. Scaled to length so a short word gets a tight
    //    budget — "JJ" must not reach "Jio" on distance alone, or every
    //    two-letter noise burst would select something.
    const budget = q.length <= 3 ? 1 : q.length <= 6 ? 2 : 3;
    const near = N.filter((x) => {
        if (lev(q, x.n) <= budget) return true;
        return x.words.some((w) => lev(q, w) <= budget);
    });
    if (only(near)) return only(near).o;

    return null;
}

// Why nothing matched, for a message she can act on: 'none' when her words
// resemble nothing on the list, 'ambiguous' when they fit more than one.
// Reported rather than folded together, because the two need different
// sentences — "I don't see that one" versus "which of these two".
function why(text, options) {
    const opts = (Array.isArray(options) ? options : []).filter(Boolean);
    const t = strip(text);
    const q = key(t);
    if (!q) return 'none';
    const N = opts.map((o) => key(o));
    const hits = N.filter((n) => n === q || n.startsWith(q) || n.indexOf(q) !== -1
        || phonetic(n) === phonetic(t));
    return hits.length > 1 ? 'ambiguous' : 'none';
}

module.exports = { pick, positionOf, why, WORD_NUMBERS };
