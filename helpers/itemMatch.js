// ── helpers/itemMatch.js — "did you mean Al combo?" ─────────────────────────
//
// Apsara, 2026-09-16: "Warn me if al combo and aluminium combo,remember my
// selection-then next time let ai decide based on knowldge".
//
// The order in that sentence is the design. WARN (never merge silently),
// REMEMBER (helpers/itemAliases.js), then let the model act on what it has
// been taught. This file does the first and the third.
//
// ── THE DIVISION OF LABOUR, WHICH IS THE WHOLE THING ────────────────────────
// This codebase's standing rule, already applied to expense vendors in
// helpers/vendorFromText.js:
//
//   MEANING       "Are these two names the same material?" is a judgement
//                 about scrap, not about strings. "Al combo" and "Aluminium
//                 combo" are one pile; "Al 6061" and "Al 6063" are two alloys
//                 that differ by ONE character and sell for different money.
//                 No edit distance can tell those apart. The model can.
//
//   WHICH ENTITY  Deterministic. A suggestion is only ever a description that
//                 ALREADY EXISTS in her stock — checked against the list, not
//                 taken on the model's word. A name it invents is discarded.
//
//   CONSENT       It returns a QUESTION. Nothing is joined until she answers,
//                 and her answer is what gets stored. The model's own opinion
//                 is never written as settled (see itemAliases.remember).
//
// ── WHAT "LET AI DECIDE" DOES AND DOES NOT MEAN ─────────────────────────────
// It means: stop asking about pairs she has already ruled on, and use the
// model to pick the ONE candidate worth asking about instead of listing six.
// It does not mean the model may join two materials on its own. The day it
// does, a stock figure becomes wrong with nobody having agreed to it, and the
// only clue is a number that looks plausible.
//
// ── IT MUST NEVER BLOCK RECORDING A SALE ────────────────────────────────────
// No API key, a timeout, bad JSON — every failure returns "no suggestion" and
// the load saves exactly as typed. A sale that cannot be recorded because a
// suggestion service was down is a far worse bug than an unmatched row.

const { callGeminiJSON } = require('./gemini');
const aliases = require('./itemAliases');

// Short: this runs while she is saving, and a suggestion that arrives after
// the load is recorded is no suggestion at all.
const TIMEOUT_MS = 4000;

const norm = aliases.norm;

function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
        promise.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
               .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
}

// ── THE CHEAP, CERTAIN CASES FIRST ──────────────────────────────────────────
// Before any model call: if one name is wholly contained in the other once
// case and punctuation are stripped ("alcombo" inside "aluminiumcombo" — no),
// or they share every token but one, it is worth asking about. This is only
// used to RANK which candidate to ask about; it never decides anything.
function affinity(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.8;
    const tok = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const A = tok(a), B = tok(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared += 1;
    // Jaccard. Blunt, and that is fine — it picks a question, not an answer.
    return shared / (A.size + B.size - shared);
}

function buildPrompt(unknown, candidates) {
    return [
        'You are looking at a scrap metal yard\'s inventory.',
        '',
        `Someone recorded material leaving the yard described as: ${JSON.stringify(unknown)}`,
        'Nothing has ever been recorded as COMING IN under that exact description.',
        '',
        `Descriptions that DO exist in stock: ${JSON.stringify(candidates.slice(0, 40))}`,
        '',
        'Which ONE of those, if any, is the same material under a different name?',
        '',
        '1. Only answer with a description copied EXACTLY from the list above.',
        '2. Abbreviations and spelled-out forms of the same metal are the same material: "Al combo" and "Aluminium combo", "Cu wire" and "Copper wire", "SS" and "Stainless".',
        '3. DIFFERENT GRADES OR ALLOYS ARE NOT THE SAME MATERIAL, however similar the text. "Al 6061" and "Al 6063" differ by one character and are different alloys worth different money. "Copper #1" and "Copper #2" are different grades. When the difference is a number, a grade or an alloy code, answer null.',
        '4. If you are not confident, answer null. A wrong match makes a stock figure quietly false, which is worse than leaving a row unmatched where somebody can see it.',
        '',
        'Return JSON only: {"match": string|null, "confidence": "high"|"low", "why": string}',
    ].join('\n');
}

// ── THE ONLY EXPORT THAT MATTERS ────────────────────────────────────────────
// Returns { ask: false } or a QUESTION for the client to put to her.
//
//   unknown      the description recorded on the way OUT
//   knownDescs   descriptions that exist in stock (came IN)
//   ask          injectable, so tests never reach the real Gemini and can
//                never spend her quota. Production passes none.
async function suggestItemMatch(unknown, knownDescs, { ask = null } = {}) {
    const name = String(unknown || '').trim();
    if (!name) return { ask: false, why: 'empty' };

    const known = [...new Set((knownDescs || []).map((d) => String(d || '').trim()).filter(Boolean))];
    if (!known.length) return { ask: false, why: 'nothing_in_stock' };

    // Already the same thing by her own earlier decision — nothing to ask.
    const already = known.find((k) => aliases.canonicalKey(k) === aliases.canonicalKey(name));
    if (already) return { ask: false, why: 'already_matched', match: already };

    // Candidates she has NOT already ruled on. This is the "remember my
    // selection" half: a pair she called different must never be raised
    // again, or the prompts become noise and the one that matters gets
    // clicked through with the rest.
    const open = known.filter((k) => !aliases.settled(name, k));
    if (!open.length) return { ask: false, why: 'all_decided' };

    // Ranked so the model is asked about a short, plausible list rather than
    // the whole catalogue — and so that with no model at all, the best guess
    // is still the top of this list.
    const ranked = open
        .map((k) => ({ k, score: affinity(name, k) }))
        .sort((a, b) => b.score - a.score);

    const call = ask || ((prompt) => callGeminiJSON(prompt));
    const out = await withTimeout(
        Promise.resolve().then(() => call(buildPrompt(name, ranked.map((r) => r.k)))),
        TIMEOUT_MS,
    );

    // EVERY failure lands here: no key, quota, timeout, bad JSON. The caller
    // carries on and the row simply stays unmatched, which is visible.
    if (!out || typeof out !== 'object') return { ask: false, why: 'no_answer' };
    if (out.confidence && out.confidence !== 'high') return { ask: false, why: 'unsure' };

    // ── THE GUARD THAT MATTERS ───────────────────────────────────────────
    // A model asked to pick from a list will occasionally return something
    // close to a list entry rather than the entry. Matched back against the
    // real descriptions; anything else is discarded rather than shown, because
    // offering a material that does not exist is worse than offering nothing.
    const picked = String(out.match || '').trim();
    if (!picked) return { ask: false, why: 'no_match' };
    const real = open.find((k) => norm(k) === norm(picked));
    if (!real) return { ask: false, why: 'not_in_stock' };

    return {
        ask: true,
        unknown: name,
        match: real,
        why: String(out.why || '').slice(0, 200) || null,
        question: `Is "${name}" the same material as "${real}"?`,
    };
}

module.exports = { suggestItemMatch, affinity, buildPrompt, TIMEOUT_MS };
