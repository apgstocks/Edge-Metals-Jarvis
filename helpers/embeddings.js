// ── helpers/embeddings.js — Semantic memory via Supabase + pgvector ─────────
// v2: replaced the original flat-JSON + in-process cosine-scan implementation
// with a real vector database (Postgres + the open-source pgvector extension,
// hosted on Supabase's free tier). Same reasoning as before — this is genuine
// RAG, not keyword matching — now on infrastructure that doesn't accumulate
// forever in a JSON file and actually indexes for fast similarity search.
//
// Deliberately uses @google/genai (the newer Gemini SDK) ONLY here, not
// @google/generative-ai (which helpers/gemini.js uses for everything else).
// Reason: reliable control over embedding output dimension (768, via
// Matryoshka truncation) is confirmed to work on the newer SDK; the older
// one's support for this is undocumented/inconsistent. Keeping this as an
// isolated dependency means zero risk to the existing, stable JSON-generation
// path in gemini.js.
//
// External function signatures (storeEmbedding, searchSimilar) are UNCHANGED
// from the v1 flat-JSON version — helpers/memory.js and helpers/context.js
// need no edits at all for this swap.

const cfg = require('../config');

const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMENSIONS = 768; // must match the `vector(768)` column in Supabase — see supabase_setup.sql
const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SIMILARITY = 0.55;

function getSupabase() {
    return require('./supabase').getSupabase();
}

let genAI = null;
function getGenAI() {
    if (!genAI) {
        if (!cfg.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
        const { GoogleGenAI } = require('@google/genai');
        genAI = new GoogleGenAI({ apiKey: cfg.GEMINI_API_KEY });
    }
    return genAI;
}

async function embedText(text, taskType = 'RETRIEVAL_DOCUMENT') {
    const response = await getGenAI().models.embedContent({
        model: EMBED_MODEL,
        content: text,
        config: { taskType, outputDimensionality: EMBED_DIMENSIONS },
    });
    const vector = response?.embedding?.values;
    if (!Array.isArray(vector) || vector.length !== EMBED_DIMENSIONS) {
        throw new Error(`Embedding returned ${vector?.length ?? 0} dims, expected ${EMBED_DIMENSIONS}`);
    }
    return vector;
}

// Store a piece of text (session summary, etc.) as searchable long-term
// memory. Failure here is non-fatal by design — memory is a nice-to-have,
// never a dependency for the app's core operation.
async function storeEmbedding({ chatId, text, type = 'summary' }) {
    const clean = String(text || '').trim();
    if (!clean) return;
    try {
        const vector = await embedText(clean, 'RETRIEVAL_DOCUMENT');
        const { error } = await getSupabase().from('memory_embeddings').insert({
            chat_id: chatId, text: clean, type, embedding: vector,
        });
        if (error) throw error;
    } catch (e) {
        console.error('[EMBEDDINGS] store failed (non-fatal):', e.message);
    }
}

// Semantic search via the match_memory_embeddings Postgres function (see
// supabase_setup.sql). Returns [] on any failure rather than throwing, so a
// memory-layer hiccup never blocks the actual conversation.
async function searchSimilar(queryText, { chatId = null, topK = DEFAULT_TOP_K, minSimilarity = DEFAULT_MIN_SIMILARITY } = {}) {
    const clean = String(queryText || '').trim();
    if (!clean) return [];
    try {
        const queryVector = await embedText(clean, 'RETRIEVAL_QUERY');
        const { data, error } = await getSupabase().rpc('match_memory_embeddings', {
            query_embedding: queryVector,
            match_threshold: minSimilarity,
            match_count: topK,
            filter_chat_id: chatId,
        });
        if (error) throw error;
        return (data || []).map(row => ({
            id: row.id, chatId: row.chat_id, text: row.text, type: row.type,
            created_at: row.created_at, similarity: row.similarity,
        }));
    } catch (e) {
        console.error('[EMBEDDINGS] search failed (non-fatal):', e.message);
        return [];
    }
}

module.exports = { storeEmbedding, searchSimilar };
