'use strict';
// Re-ranks cross-chat session-summary matches by similarity PLUS recency.
// Facts already rank this way (helpers/factRetrieval.js); summaries were
// plain similarity, so a three-month-old chat could outrank last week's on a
// 2% edge. Pure and read-only: it only reorders matches already found and
// never adds, drops or rewrites one. OFF unless JARVIS_SUMMARY_RECENCY=1,
// because it changes the text the AI sees on every classification.
// No importance signal: nothing measurable and non-fixed exists for a summary.
const { BASE_STRENGTH_DAYS } = require('./factRetrieval');
// Recency may add at most this much to a 0..1 similarity: enough to settle a
// near-tie, too little to lift a weak match over a clearly better one. This
// number is my judgement (not Apsara's, not measured); facts use a bigger
// recency weight because they are ranked against each other, not against a
// similarity floor.
const RECENCY_SHARE = 0.15;
const DAY_MS = 86400000;

const enabled = () => process.env.JARVIS_SUMMARY_RECENCY === '1';

function score(m, now) {
    const t = Date.parse(m.created_at || '');
    const rec = Number.isFinite(t) ? Math.exp(-Math.max(0, (now - t) / DAY_MS) / BASE_STRENGTH_DAYS) : 1;
    return (Number(m.similarity) || 0) + RECENCY_SHARE * rec;
}

function rank(matches, { now = Date.now(), limit = 3, force = false } = {}) {
    const list = Array.isArray(matches) ? matches : [];
    if (!force && !enabled()) return list.slice(0, limit);
    return list.map((m, i) => ({ m, i, s: score(m, now) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, limit).map(x => x.m);
}
module.exports = { rank, score, enabled };
