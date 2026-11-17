// ── helpers/taughtRecall.js — put what she TAUGHT into the prompt, read-only ──────
// Apsara, 2026-11-15: "yes" to "recall in decisions: brain.js doesn't call the teach agent's recall,
// so a rule you teach isn't used when Jarvis handles an email."
//
// WHAT THIS IS. One function: recallFor({ text, role }) -> a short prompt block, or null.
// It reads the Edge Metals partition of the disk (notes she taught with scripts/notes.js) and
// finds the ones that relate to the message in front of Jarvis.
//
// WHAT THIS IS NOT.
//   * Not a rule engine. A hit is ADVISORY: the block tells the model so, in words, and
//     nothing here changes a gate, an action or a threshold. A meaning match may shape what
//     Jarvis asks or says; it is never the only reason to act alone (helpers/disk/notes.js).
//   * Not for outsiders. What she taught is internal guidance. Truckers, suppliers and
//     anyone else get nothing, and the lookup is not even attempted for them (helpers/context.js
//     "OUTSIDERS GET ONLY THEIR OWN JOBS").
//   * Not for Edge Yard. brain.js is the Edge Metals assistant; the company is fixed here, not
//     passed in, so a caller cannot ask for the other partition by mistake (CLAUDE.md rule 5).
//   * Not on by default. OFF unless JARVIS_TAUGHT_RECALL=1, like JARVIS_PARTY_ANSWER.
//
// FAILURE IS SILENT AND CHEAP. No notes -> no embedding call at all. A slow or failing
// embedder -> keyword search after EMBED_TIMEOUT_MS, so a WhatsApp reply is never held up by it.
// Any other error -> null, logged. A recall problem must never become a "Jarvis didn't reply".
const COMPANY = 'edge_metals';
const ALLOWED_ROLES = new Set(['manager', 'team']);   // the people who may teach are the people who may be reminded
const EMBED_TIMEOUT_MS = 2500;
const K = 3;
const MIN_SCORE = 0.5;

let embedderOverride = null;      // tests only
let embedderCache = null;

function enabled() { return process.env.JARVIS_TAUGHT_RECALL === '1'; }

function getEmbedder() {
    if (embedderOverride) return embedderOverride;
    if (!embedderCache) embedderCache = require('./disk/embedder').gemini();
    return embedderCache;
}

function withTimeout(embedder, ms) {
    return {
        model: embedder.model,
        embed: (t) => new Promise((resolve, reject) => {
            const h = setTimeout(() => reject(new Error('embedding took longer than ' + ms + 'ms')), ms);
            Promise.resolve().then(() => embedder.embed(t)).then(
                (v) => { clearTimeout(h); resolve(v); },
                (e) => { clearTimeout(h); reject(e); });
        }),
    };
}

/** @returns {Promise<string|null>} the text of the prompt block, or null when there is nothing to add */
async function recallFor({ text, role } = {}) {
    if (!enabled()) return null;
    if (!ALLOWED_ROLES.has(role)) return null;
    const q = typeof text === 'string' ? text.trim() : '';
    if (!q) return null;
    try {
        const partition = require('./diskStore').getDisk().for(COMPANY);
        if (!partition.notes.size()) return null;                       // nothing taught yet: spend nothing
        const embedder = withTimeout(getEmbedder(), EMBED_TIMEOUT_MS);
        let vector = null;
        try { vector = await embedder.embed(q); } catch (e) { console.warn('[TAUGHT] embedder unavailable, using keywords:', e.message); }
        const hits = partition.notes.search({ vector, model: vector ? embedder.model : undefined, text: q, k: K, minScore: MIN_SCORE });
        if (!hits || !hits.length) return null;
        return hits.map((h) => '- (said ' + (String(h.at || '').slice(0, 10) || 'earlier') + ') ' + h.text).join('\n');
    } catch (e) {
        console.error('[TAUGHT] recall failed (non-fatal):', e.message);
        return null;
    }
}

module.exports = { recallFor, enabled, COMPANY, _setEmbedder: (e) => { embedderOverride = e; } };
