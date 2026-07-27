// ── helpers/supabase.js — Shared Supabase client singleton ──────────────────
// Used by both helpers/embeddings.js (semantic memory) and helpers/json.js
// (truckers/suppliers, and eventually bookings). One client, one connection
// pool, not a separate instance per module.

const cfg = require('../config');

let client = null;
function getSupabase() {
    if (!client) {
        if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
            throw new Error('SUPABASE_URL / SUPABASE_KEY not configured');
        }
        const { createClient } = require('@supabase/supabase-js');
        client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
    }
    return client;
}

module.exports = { getSupabase };
