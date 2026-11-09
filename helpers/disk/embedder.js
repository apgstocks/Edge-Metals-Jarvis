// ── helpers/disk/embedder.js — text -> vector, for the notes layer ─────────
// An embedder is { model, embed(text) -> Promise<number[]> }. `model` is the tag stored with every vector;
// notes.js only compares vectors that carry the same tag, so changing anything below (model, dimensions,
// task type) means changing the tag, which makes old notes fall back to keyword search until re-embedded.
//
// gemini()  the real one. It repeats the call in helpers/embeddings.js (embedText) EXACTLY: same SDK, same
//           model, same 768 dimensions, `contents` (plural) in and `embeddings[0].values` out. That file records a
//           bug where a wrong key name made every call fail silently for weeks, so the length is checked on
//           every call and a wrong answer throws instead of being stored.
//           NOT TESTED AGAINST THE LIVE API from where it was written (no key there). First real use should be
//           `node scripts/notes.js check`, which embeds two sentences and prints their similarity.
// stub()    deterministic hashed bag-of-words, for tests only. It measures shared WORDS, not meaning. Nothing in
//           production may use it; scripts/notes.js refuses it unless JARVIS_TEST=1.
const { tokens } = require('./text');

const GEMINI_MODEL = 'gemini-embedding-001';
const GEMINI_DIMS = 768;
const GEMINI_TASK = 'SEMANTIC_SIMILARITY';   // note-to-note closeness, not query-to-document

function gemini(opts) {
    const { apiKey } = opts || {};
    let client = null;
    return {
        model: `${GEMINI_MODEL}@${GEMINI_DIMS}:${GEMINI_TASK}`,
        async embed(text) {
            const clean = String(text == null ? '' : text).trim();
            if (!clean) throw new Error('nothing to embed');
            if (!client) {
                const key = apiKey || require('../../config').GEMINI_API_KEY;
                if (!key) throw new Error('GEMINI_API_KEY missing');
                const { GoogleGenAI } = require('@google/genai');
                client = new GoogleGenAI({ apiKey: key });
            }
            const response = await client.models.embedContent({
                model: GEMINI_MODEL,
                contents: clean,
                config: { taskType: GEMINI_TASK, outputDimensionality: GEMINI_DIMS },
            });
            const vector = response && response.embeddings && response.embeddings[0] && response.embeddings[0].values;
            if (!Array.isArray(vector) || vector.length !== GEMINI_DIMS) {
                throw new Error(`Embedding returned ${vector ? vector.length : 0} dims, expected ${GEMINI_DIMS}`);
            }
            return vector;
        },
    };
}

function stub(opts) {
    const { dims = 96 } = opts || {};
    const h = (w) => { let x = 2166136261; for (let i = 0; i < w.length; i++) { x ^= w.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x; };
    return {
        model: `stub-hash-${dims}`,
        async embed(text) {
            const v = new Array(dims).fill(0);
            for (const w of tokens(text)) { const x = h(w); v[x % dims] += (x >>> 16) & 1 ? 1 : -1; }
            if (!v.some((n) => n !== 0)) v[0] = 1;   // a note made only of stopwords still gets a (meaningless) vector rather than a crash
            return v;
        },
    };
}

module.exports = { gemini, stub, GEMINI_MODEL, GEMINI_DIMS, GEMINI_TASK };
