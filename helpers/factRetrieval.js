// ── helpers/factRetrieval.js — what actually reaches the prompt ─────────────
// Phase 4 of the memory architecture (claude/jarvis-memory-architecture-v2.md).
//
// The rule this replaces was: "every pinned fact, plus the last 15 unpinned."
// Both halves were wrong in ways that get worse over time.
//
//   - Recency did all the work. A rule Apsara restated three times ranked
//     below one she mentioned once last Tuesday, because insertion order was
//     the only signal.
//   - The pinned pool is deliberately uncapped (see helpers/json.js's addFact
//     header — "never forget" was the explicit ask, and capping it would
//     quietly break that promise). But EVERY pinned fact went into EVERY
//     prompt. At 40 facts that is fine. At 400 it is slow, expensive, and —
//     worse — the instructions that matter are buried among hundreds of
//     stale ones. Unbounded growth in a prompt is not "remembering more",
//     it is remembering less usefully.
//
// So: keep everything (nothing here deletes), but SELECT what goes in, under
// a budget, by score. Scoring shape is Generative Agents' (arXiv:2304.03442)
// — recency + importance + relevance, min-max normalised — with a strength
// term added from MemoryBank's insight that repetition should resist decay.
//
// Everything in this file is pure and local. No network, no I/O. That is
// deliberate: retrieval used to sit behind a Gemini embedding call plus a
// Supabase round-trip on every single message, and both were wrapped in
// non-fatal catches, so a memory outage degraded silently to pure recency
// with nothing telling anyone. Semantic relevance is now an OPTIONAL input
// passed in by the caller; when it is missing, this still ranks sensibly on
// what it has instead of collapsing.

const DAY_MS = 86400000;

// Weights.
//
// CALIBRATION NOTE, found by testing rather than by reasoning: recency and
// strength are NOT independent. Confirming a fact also resets its
// last_recalled_at, so a frequently-repeated rule scores near the top on both
// — and at equal weights the pair outvoted relevance. The observable effect
// was that a fact with 0.95 similarity to the question being asked lost to a
// well-worn but unrelated standing rule. That is the wrong answer: relevance
// is the only term that knows anything about the CURRENT question, and the
// two terms beating it were substantially measuring the same thing twice.
//
// So relevance is weighted to win a genuinely strong match on its own, while
// strength still comfortably breaks ties between facts of similar relevance —
// which is what keeps "she has told me this eight times" meaningful without
// letting it drown out "this is literally what she just asked about".
const W = { relevance: 1.6, importance: 0.6, recency: 0.5, strength: 0.7 };

// Share of the budget pinned facts may claim before unpinned ones get a
// look. Not 100%: a prompt that is nothing but standing rules has no room
// for the note that actually answers today's question.
const PINNED_BUDGET_SHARE = 0.6;

// Rough token estimate. Deliberately crude and deliberately OVER-estimating
// (4 chars/token is optimistic for prose, so this errs toward including
// fewer facts). A real tokenizer here would be a dependency and a network of
// its own for a number that only needs to be approximately right.
function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4) + 4;   // +4 for the bullet/label
}

// ── DECAY (MemoryBank, arXiv:2305.10250) ───────────────────────────────────
// R = e^(−t/S), where S is memory strength. Recalling or re-confirming a
// fact raises S and resets t, so the things Jarvis actually uses become
// progressively harder to forget — which is the behaviour Apsara described
// ("remembers forever like a child being taught"), applied honestly: a
// lesson that keeps coming up sticks, one that never comes up again fades
// from ACTIVE USE without ever being destroyed.
// BASE_STRENGTH_DAYS is the time constant for a fact nobody has re-confirmed.
//
// CALIBRATION MATTERS MORE THAN THE FORMULA. MemoryBank uses S = confirmations
// + 1 with t in days, which is tuned for a chat companion: an unconfirmed
// memory falls to R=0.37 after ONE day and crosses the dormancy threshold in
// under two. Applied unchanged here it would put a fact Apsara confirmed
// three times to sleep in under a fortnight — in a business where a rule set
// in June is still live in August. The shape of the curve is right; the
// units are not.
//
// At 30 days: an unconfirmed fact reaches R=0.2 at ~48 days; one confirmed
// three times at ~193 days; one confirmed ten times at ~530. That is roughly
// "if it hasn't come up in about two months and you never repeated it, stop
// putting it in every prompt" — recoverable at any time, since dormant facts
// are retained, still searchable, and resurface on a strong relevance match.
const BASE_STRENGTH_DAYS = 30;
function retention(fact, now = Date.now()) {
    const last = Date.parse(fact.last_recalled_at || fact.recorded_at || fact.created_at || '');
    if (!Number.isFinite(last)) return 1;                 // unknown age → don't penalise
    const days = Math.max(0, (now - last) / DAY_MS);
    const S = BASE_STRENGTH_DAYS * ((fact.confirmations || 0) + 1);
    return Math.exp(-days / S);
}

// Dormant = not injected into prompts, but NOT deleted and NOT unsearchable.
// This is the only mechanism in the whole design that removes something from
// Jarvis's working view, so the bar is deliberately high: it must be
// unpinned, low-importance, AND long-unused. A pinned fact is never dormant,
// full stop — that is what pinning means.
const DORMANT_RETENTION = 0.2;
const DORMANT_MAX_IMPORTANCE = 6;
function isDormant(fact, now = Date.now()) {
    if (fact.pinned) return false;
    if ((fact.importance || 5) >= DORMANT_MAX_IMPORTANCE) return false;
    return retention(fact, now) < DORMANT_RETENTION;
}

function normalise(values) {
    const finite = values.filter((v) => Number.isFinite(v));
    if (!finite.length) return values.map(() => 0);
    const min = Math.min(...finite), max = Math.max(...finite);
    if (max === min) return values.map(() => (Number.isFinite(min) ? 0.5 : 0));
    return values.map((v) => (Number.isFinite(v) ? (v - min) / (max - min) : 0));
}

// relevanceByText: optional Map/object of text -> 0..1 cosine similarity.
function scoreFacts(facts, { relevanceByText = null, now = Date.now() } = {}) {
    const list = facts || [];
    if (!list.length) return [];
    const rel = list.map((f) => {
        if (!relevanceByText) return 0;
        const v = relevanceByText instanceof Map ? relevanceByText.get(f.text) : relevanceByText[f.text];
        return Number.isFinite(v) ? v : 0;
    });
    const imp = list.map((f) => (Number.isFinite(f.importance) ? f.importance : 5));
    const rec = list.map((f) => retention(f, now));
    const str = list.map((f) => Math.log1p(f.confirmations || 0));   // diminishing returns

    const nRel = normalise(rel), nImp = normalise(imp), nRec = normalise(rec), nStr = normalise(str);
    return list.map((f, i) => ({
        fact: f,
        score: W.relevance * nRel[i] + W.importance * nImp[i] + W.recency * nRec[i] + W.strength * nStr[i],
        parts: { relevance: nRel[i], importance: nImp[i], recency: nRec[i], strength: nStr[i] },
    })).sort((a, b) => b.score - a.score);
}

// Returns { pinned, unpinned, dropped, truncated, tokensUsed }.
//
// `truncated` is the important one. The old behaviour silently dropped
// whatever did not fit, which meant a standing instruction could stop being
// applied with nothing anywhere saying so — the same silent-degradation
// shape as the semantic search returning [] on failure. Callers are expected
// to SURFACE this, not swallow it.
function selectForPrompt(facts, { budgetTokens = 1200, relevanceByText = null, now = Date.now() } = {}) {
    const live = (facts || []).filter((f) => (f.status || 'active') === 'active');

    // Dormant facts are held back unless they are strongly relevant right
    // now — a fact nobody has needed for months is exactly the thing that
    // should still surface the moment it becomes the answer.
    const STRONG_RECALL = 0.8;
    const relOf = (f) => {
        if (!relevanceByText) return 0;
        const v = relevanceByText instanceof Map ? relevanceByText.get(f.text) : relevanceByText[f.text];
        return Number.isFinite(v) ? v : 0;
    };
    const dropped = [];
    const eligible = live.filter((f) => {
        if (!isDormant(f, now) || relOf(f) >= STRONG_RECALL) return true;
        dropped.push({ fact: f, why: 'dormant' });
        return false;
    });

    const pinnedRanked = scoreFacts(eligible.filter((f) => f.pinned), { relevanceByText, now });
    const looseRanked = scoreFacts(eligible.filter((f) => !f.pinned), { relevanceByText, now });

    const pinnedBudget = Math.floor(budgetTokens * PINNED_BUDGET_SHARE);
    const pinned = [];
    let used = 0, pinnedTruncated = 0;
    for (const { fact } of pinnedRanked) {
        const t = estimateTokens(fact.text);
        if (used + t > pinnedBudget) { pinnedTruncated++; dropped.push({ fact, why: 'budget' }); continue; }
        pinned.push(fact); used += t;
    }
    const unpinned = [];
    for (const { fact } of looseRanked) {
        const t = estimateTokens(fact.text);
        if (used + t > budgetTokens) { dropped.push({ fact, why: 'budget' }); continue; }
        unpinned.push(fact); used += t;
    }

    return {
        pinned, unpinned, dropped,
        // Only PINNED truncation is reported to her. An unpinned fact not
        // fitting is ordinary selection working as designed; a PINNED one not
        // fitting means a standing rule she deliberately marked "always
        // apply" is not being applied, and she needs to know that.
        truncated: pinnedTruncated,
        tokensUsed: used,
    };
}

module.exports = {
    scoreFacts, selectForPrompt, retention, isDormant, estimateTokens,
    W, PINNED_BUDGET_SHARE, DORMANT_RETENTION, DORMANT_MAX_IMPORTANCE, BASE_STRENGTH_DAYS,
};
