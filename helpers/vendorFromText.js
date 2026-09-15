// ── helpers/vendorFromText.js — who is this expense for? ─────────────────
// Apsara, 2026-09-15: "if they say salay santiago-it means that salary for
// santiago..when they type in app-it should read the description and ask user
// whether they mean salary for santiago????" — and, asked how: "ai assistant
// should handle that".
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────
// Her expenses record a person in two different places. "Weekly salary
// Santiago" carries the name in the DESCRIPTION with the vendor field empty;
// "Hose" carries it in the VENDOR field. helpers/tools.js's find_expenses now
// searches both, so a question is answered correctly either way — but that is
// a query-time patch on an entry-time problem. Every report that groups by
// vendor still shows the salary under nobody, for ever.
//
// So this catches it where it happens: at the moment the expense is typed,
// while she is still looking at it and can say yes.
//
// ── THE DIVISION OF LABOUR, WHICH IS THE WHOLE DESIGN ───────────────────
// This codebase's standing rule: the MODEL decides what was MEANT,
// DETERMINISTIC code decides WHICH ENTITY and what is TRUE, and nothing is
// written without her yes. All three apply here:
//
//   MEANING      "Is a person or company named in this text, and which word
//                is it?" A regex cannot do this. "Salary Santiago" has a
//                name; "Salary paid $200 for tools" does not, and "tools" is
//                the trap any capitalised-word or last-word heuristic falls
//                into. The model is genuinely better at it.
//
//   ENTITY       Whether that name is someone already on file is NOT a
//                judgement call. It is checked against the vendors she has
//                used before, with helpers/nameMatch.js's exact-after-
//                normalisation rule — never fuzzy, because a near miss here
//                files money against the wrong person.
//
//   CONSENT      It returns a QUESTION. Nothing is written. The client asks
//                and she answers, exactly like every other consequential
//                thing in this app.
//
// ── IT MUST NEVER BLOCK RECORDING AN EXPENSE ────────────────────────────
// No API key, a quota wall, a timeout, malformed JSON — every one of them
// returns "no suggestion" and the expense saves exactly as typed. An expense
// she cannot record because a suggestion service was down would be a far
// worse bug than the one this fixes. callGeminiJSON already returns null for
// every failure; this adds a timeout on top, because a hung request is the
// one failure that does not return anything at all.

const { callGeminiJSON } = require('./gemini');
const { normalizeName } = require('./nameMatch');

// Short. This runs while she is typing, and a suggestion that arrives after
// she has saved is no suggestion at all.
const TIMEOUT_MS = 4000;

const norm = (s) => normalizeName(s);

// Every vendor she has already used, most-used first. Used BOTH as a check
// on the model's answer and as a hint in the prompt — a name she has typed
// before is far likelier than one she has not.
function knownVendors(expenses) {
    const counts = new Map();
    for (const e of (expenses || [])) {
        const v = String((e && e.vendor) || '').trim();
        if (!v) continue;
        const k = norm(v);
        const cur = counts.get(k) || { name: v, n: 0 };
        cur.n += 1;
        counts.set(k, cur);
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).map((x) => x.name);
}

function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
        promise.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
               .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
}

function buildPrompt(description, known) {
    return [
        'You are reading one line typed into an expense form at a scrap yard.',
        'Decide whether it names a PERSON or a COMPANY that the money was paid to.',
        '',
        `The line: ${JSON.stringify(String(description || ''))}`,
        '',
        known.length
            ? `Names already used as vendors here, most common first: ${JSON.stringify(known.slice(0, 40))}`
            : 'No vendors have been recorded yet.',
        '',
        'Rules:',
        '1. Only answer with a name if the text really names someone paid. "Weekly salary Santiago" names Santiago. "Salary paid $200 for tools" names NOBODY — "tools" is a thing, not a person.',
        '2. Materials, parts, fuel, services and places are NOT vendors. Diesel, hose, scrap, gate, forklift, Oakland are not names.',
        '3. If one of the known names above appears, prefer that exact spelling.',
        '4. If you are not confident, return null. A wrong guess is worse than no guess: it files money against the wrong person.',
        '',
        'Return JSON only: {"vendor": string|null, "confidence": "high"|"low"}',
    ].join('\n');
}

// ── THE ONLY EXPORT THAT MATTERS ────────────────────────────────────────
// Returns { suggest: false } or a QUESTION for the client to ask. Never
// writes, never throws.
async function suggestVendor(description, { expenses = null, vendor = null, ask = null } = {}) {
    // She typed a vendor. Second-guessing that would be worse than useless.
    if (String(vendor || '').trim()) return { suggest: false, why: 'vendor_already_set' };

    const text = String(description || '').trim();
    // Too short to contain both a reason and a name.
    if (text.length < 4) return { suggest: false, why: 'too_short' };

    const rows = expenses || require('./expenses').loadExpenses();
    const known = knownVendors(rows);

    // `ask` is injectable so the tests never reach the real Gemini — and so a
    // test cannot spend her quota. Production never passes one.
    const call = ask || ((prompt) => callGeminiJSON(prompt));
    const out = await withTimeout(Promise.resolve().then(() => call(buildPrompt(text, known))), TIMEOUT_MS);

    // EVERY failure lands here: no key, quota, timeout, bad JSON. The expense
    // must still save exactly as typed.
    if (!out || typeof out !== 'object') return { suggest: false, why: 'no_answer' };

    const name = String(out.vendor || '').trim();
    if (!name) return { suggest: false, why: 'no_name_in_text' };
    // A "name" the model lifted verbatim from a word that is plainly not one
    // still has to clear the next test, so low confidence is simply dropped.
    if (out.confidence && out.confidence !== 'high') return { suggest: false, why: 'unsure' };

    // ── THE NAME HAS TO BE IN THE TEXT ───────────────────────────────────
    // Deterministic, and it is the guard that matters: a model asked for a
    // name will sometimes produce a plausible one that was never typed. If
    // the word is not in what she wrote, it is invented, and inventing a
    // payee is the one outcome worse than suggesting nothing.
    if (!norm(text).includes(norm(name))) return { suggest: false, why: 'not_in_text' };

    // Is this someone already on file? Exact after normalisation, never
    // fuzzy — nameMatch.js's rule, for the reason it gives: a near miss
    // resolves to the wrong company.
    const match = known.find((k) => norm(k) === norm(name)) || null;

    return {
        suggest: true,
        // Her spelling when she has one, so the vendor column does not grow
        // "santiago" beside "Santiago".
        vendor: match || name,
        known: !!match,
        question: match
            ? `Is this for ${match}?`
            : `Is this for ${name}? That would be a new vendor.`,
    };
}

module.exports = { suggestVendor, knownVendors, buildPrompt, TIMEOUT_MS };
