// ── helpers/nameSuggest.js ───────────────────────────────────────────────
// Apsara, 2026-09-07: "If i say send mail to jeyshree.. It got transcripted as
// jayashree. I want it to check email for any matching thing auto adjusting
// spelling. then ask."
//
// THE RULE THIS FILE IS BUILT AROUND, AND IT IS NOT NEW
// ----------------------------------------------------
// helpers/nameMatch.js refuses fuzzy matching on purpose, and its reasoning
// is correct and stays correct:
//
//     "No edit distance, no similarity score, no Levenshtein, no Fuse.js.
//      Those match things that are merely SIMILAR, and in this business a
//      near-miss resolves to the wrong company and a real quote request or
//      email goes to them."
//
// That rule is about RESOLUTION — matching that silently decides who gets the
// email. It is not about SUGGESTION. She asked for the second thing and drew
// the line herself: "then ask".
//
// So the split this file exists to enforce:
//     nameMatch.js  — decides. Exact, normalised, never fuzzy.
//     nameSuggest.js — proposes. Fuzzy, ranked, and its output is NEVER a
//                      recipient. It is a question.
//
// Nothing here may be wired anywhere that sends without a confirmation. If a
// future caller uses a suggestion as an address, the guarantee is gone and
// nameMatch.js's warning comes true through the back door.
//
// WHY PHONETIC AND NOT JUST EDIT DISTANCE
// ---------------------------------------
// The failure is a SPEECH one. Whisper heard "Jayashree" for "Jeyshree" —
// those are the same name, romanised two ways, and they SOUND identical.
// Edit distance alone gives 3 edits on 9 characters, which is the same
// distance as several names that sound nothing alike. A phonetic key gets it
// exactly right, and Indian names romanised from a spoken original are the
// case it handles best: the consonant skeleton is stable and the vowels are
// where the spellings disagree.
//
// The key drops vowels after the first letter, folds the aspirated digraphs
// that romanisation moves around (sh/ch/ph/th/kh/gh/dh/bh), and collapses
// doubles. "jeyshree" and "jayashree" both reduce to the same skeleton.
// "Sher" and "Yurim" do not come near it.

// Consonant digraphs, longest first so "sh" is taken before "s". Folded to
// single markers so the vowel strip below cannot break them apart.
const DIGRAPHS = [
    ['sch', 'S'], ['sh', 'S'], ['ch', 'C'], ['ph', 'F'], ['th', 'T'],
    ['kh', 'K'], ['gh', 'G'], ['dh', 'D'], ['bh', 'B'], ['jh', 'J'],
    ['zh', 'J'], ['ck', 'K'], ['qu', 'K'], ['ss', 'S'], ['tt', 'T'],
];

function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

// The consonant skeleton. First letter kept whatever it is — the initial is
// the one sound a listener almost never mishears, and keeping it stops
// "Jeyshree" reaching for "Ashree".
function phonetic(s) {
    let t = norm(s);
    if (!t) return '';
    for (const [from, to] of DIGRAPHS) t = t.split(from).join(to);
    t = t.replace(/y/g, 'i').replace(/w/g, 'v').replace(/z/g, 's');
    const first = t[0];
    const rest = t.slice(1).replace(/[aeiou]/g, '');
    // Collapse runs: "ssr" and "sr" are the same skeleton.
    const collapsed = (first + rest).replace(/(.)\1+/g, '$1');
    return collapsed;
}

// Levenshtein, iterative, two rows. Used as a SECOND opinion on the raw
// spelling, never on its own.
function editDistance(a, b) {
    const s = norm(a), t = norm(b);
    if (s === t) return 0;
    if (!s.length || !t.length) return Math.max(s.length, t.length);
    let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
    for (let i = 1; i <= s.length; i += 1) {
        const cur = [i];
        for (let j = 1; j <= t.length; j += 1) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
            );
        }
        prev = cur;
    }
    return prev[t.length];
}

function similarity(a, b) {
    const longest = Math.max(norm(a).length, norm(b).length);
    if (!longest) return 0;
    return 1 - (editDistance(a, b) / longest);
}

// ── THE THRESHOLDS, AND WHY THEY ARE HIGH ────────────────────────────────
// A suggestion costs her one "no". A suggestion that is confidently wrong and
// gets a distracted "yes" costs a customer's email going to a stranger. The
// asymmetry is enormous, so these are set to miss rather than to reach.
const MIN_LEN = 4;          // "Al" and "Raj" are too short to guess from
const MIN_SIMILARITY = 0.62; // raw-spelling floor even when phonetics agree
const NEAR_SIMILARITY = 0.80; // close enough on spelling alone

// Returns [{ name, record, score, why }], best first, or [] for nothing worth
// asking about. NEVER returns a best guess "to be helpful" — an empty list is
// a valid and common answer, and the caller falls back to asking her outright.
function suggest(query, records, opts) {
    const o = opts || {};
    const getName = o.getName || ((r) => (typeof r === 'string' ? r : r && r.name));
    const q = norm(query);
    if (q.length < MIN_LEN) return [];

    const qp = phonetic(query);
    const out = [];

    for (const r of records || []) {
        const name = getName(r);
        const n = norm(name);
        if (!n || n.length < MIN_LEN) continue;
        // An exact normalised match is nameMatch.js's job, not this file's.
        // Returning it here would let a caller treat a decision as a
        // suggestion and ask her about something already certain.
        if (n === q) continue;

        // ── SHE SAYS A FIRST NAME; THE CONTACT IS A FULL NAME ────────────
        // "send mail to Jeyshree" against a record called "Jayashree Menon".
        // Comparing the whole strings gives a similarity of about a half and
        // two different phonetic skeletons, so the first version of this
        // matched nothing at all — the very case it was written for.
        //
        // So each PART is compared too, and the best part wins. That is how a
        // person reads it: the surname she did not say is not evidence
        // against the first name she did.
        //
        // Parts shorter than MIN_LEN are skipped, so an initial ("R.") or a
        // suffix ("Inc") cannot become the thing that matched.
        const parts = [name, ...String(name).split(/[\s,._-]+/)]
            .filter((x) => norm(x).length >= MIN_LEN);
        let sim = 0;
        let sameSound = false;
        for (const part of parts) {
            const ps = similarity(query, part);
            if (ps > sim) sim = ps;
            if (qp && phonetic(part) === qp) sameSound = true;
        }
        // FIRST LETTER MUST AGREE. Cheap, and it is the sound a listener
        // almost never gets wrong. Without it "Jeyshree" reaches "Ashree"
        // and "Sher" reaches "Cher" — both plausible on distance alone.
        // Checked against the part that matched, not the whole record, or
        // "Menon" losing its initial would veto a good first-name hit.
        if (!parts.some((p2) => norm(p2)[0] === q[0])) continue;

        let why = null;
        if (sameSound && sim >= MIN_SIMILARITY) why = 'sounds the same';
        else if (sim >= NEAR_SIMILARITY) why = 'spelled almost the same';
        if (!why) continue;

        // Phonetic agreement outranks raw spelling: the failure being
        // corrected is a MIS-HEARING, so two names that sound identical are
        // better evidence than two that merely look alike.
        out.push({ name, record: r, score: (sameSound ? 1 : 0) + sim, why });
    }

    return out.sort((a, b) => b.score - a.score).slice(0, o.limit || 4);
}

module.exports = { suggest, phonetic, similarity, editDistance, norm,
                   MIN_LEN, MIN_SIMILARITY, NEAR_SIMILARITY };
