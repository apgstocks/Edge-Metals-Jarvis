// ── helpers/factReplica.js — durable off-VM copy of facts.json ─────────────
//
// Apsara, 2026-08-25: "how to implement supabase".
//
// THE DECISION THIS ENCODES, because it is not the one originally asked for:
//
// Supabase was chosen to be the SOURCE OF TRUTH for facts, for a specific and
// correct reason — one store means a delete cannot half-succeed, which was
// the root cause of F1 (a fact deleted from facts.json kept its vector row
// and was resurrected into the next prompt by semantic recall).
//
// That reason no longer holds. Phase 1 closed F1 twice over: deleteFactById
// now removes the vector row, AND helpers/context.js filters every semantic
// hit against the local believable set, so a stale row cannot reach a prompt
// even when the delete never landed. Making Supabase primary today would buy
// atomicity for a race that is already fenced, and would cost three things
// that are not cheap:
//
//   1. Every memory read becomes a network call. Phase 4 deliberately made
//      retrieval pure and local for exactly this reason — the old path awaited
//      a Gemini embed plus a Supabase RPC on every single message, both
//      wrapped in non-fatal catches, so an outage degraded memory silently.
//   2. Writes would start failing when Supabase is down. Right now Apsara can
//      always teach Jarvis something. That is a real availability property.
//   3. It becomes untestable from any machine without network access, which
//      is every machine this codebase is developed on.
//
// What is genuinely unsolved is DURABILITY. Every fact she has ever taught
// Jarvis lives in one JSON file on one VM (35.233.131.198) with no backup of
// any kind. Lose that disk and the entire memory is gone — years of standing
// rules, with nothing to restore from.
//
// So: local stays primary, Supabase becomes a replica. Reads never touch the
// network, writes never depend on it, and there is an off-VM copy that can
// rebuild facts.json exactly. If Supabase-primary is ever genuinely wanted,
// this replica is the migration's first half already done.

const cfg = require('../config');

// Every column in public.facts, in normaliseFact() order. Kept explicit
// rather than spreading the whole record: a future local-only field (a cache,
// a scratch flag) must not silently become a schema mismatch that fails every
// replication with a PostgREST error nobody reads.
function toRow(fact) {
    return {
        id: fact.id,
        text: fact.text,
        pinned: !!fact.pinned,
        status: fact.status || 'active',
        valid_from: fact.valid_from || null,
        valid_until: fact.valid_until || null,
        recorded_at: fact.recorded_at || null,
        created_at: fact.created_at || null,
        supersedes: Array.isArray(fact.supersedes) ? fact.supersedes : [],
        superseded_by: fact.superseded_by || null,
        change_reason: fact.change_reason || null,
        retracted_at: fact.retracted_at || null,
        origin: fact.origin || 'manager',
        authority: fact.authority || 'act',
        derived_from: Array.isArray(fact.derived_from) ? fact.derived_from : [],
        proposed_by: fact.proposed_by || null,
        confirmations: Number.isFinite(fact.confirmations) ? fact.confirmations : 0,
        recall_count: Number.isFinite(fact.recall_count) ? fact.recall_count : 0,
        last_recalled_at: fact.last_recalled_at || null,
        importance: Number.isFinite(fact.importance) ? fact.importance : 5,
        replicated_at: new Date().toISOString(),
    };
}

function configured() {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_KEY);
}

// ── PUSH ───────────────────────────────────────────────────────────────────
// Upsert on the app's own id, so this is idempotent: replicating the same
// fact twice is a no-op, and a fact edited locally overwrites its own row
// rather than creating a second copy.
//
// A RETRACTED fact is replicated like any other. That is deliberate — the
// whole point of a soft delete is that the record survives, so a backup that
// silently dropped retracted facts would restore a memory Apsara could no
// longer audit or undo.
async function push(facts) {
    if (!configured()) return { skipped: 'not-configured' };
    const rows = (facts || []).filter((f) => f && f.id).map(toRow);
    if (!rows.length) return { replicated: 0 };

    const { getSupabase } = require('./supabase');
    // Chunked: PostgREST has a request size limit, and a single 2000-row
    // payload fails as one unit. Chunking means a partial failure still
    // leaves most of the backup current.
    const CHUNK = 200;
    let replicated = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error } = await getSupabase().from('facts').upsert(slice, { onConflict: 'id' });
        if (error) throw new Error(`facts replica upsert failed at row ${i}: ${error.message}`);
        replicated += slice.length;
    }
    return { replicated };
}

// Replicate ONE fact, fire-and-forget. This is what the write paths in
// helpers/json.js call.
//
// NEVER awaited by a caller, and never allowed to throw outward: a backup
// that can block Apsara from teaching Jarvis something is worse than no
// backup. Failure is logged loudly enough to notice in pm2 logs, and the
// nightly full push below repairs whatever any single failure missed — which
// is the property that makes fire-and-forget acceptable here rather than
// merely convenient.
function replicate(fact) {
    if (!configured() || !fact || !fact.id) return Promise.resolve();
    return push([fact]).catch((e) => {
        console.error('[REPLICA] fact replication failed (non-fatal, nightly sync will repair):', e.message);
    });
}

// ── PULL ───────────────────────────────────────────────────────────────────
// Read the replica back. Returns records in the exact shape normaliseFact()
// produces, so restore() can write them straight to facts.json.
async function pull() {
    if (!configured()) return [];
    const { getSupabase } = require('./supabase');
    const out = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await getSupabase()
            .from('facts').select('*').order('created_at', { ascending: true })
            .range(from, from + PAGE - 1);
        if (error) throw new Error(`facts replica read failed: ${error.message}`);
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return out.map((r) => {
        const { replicated_at, ...fact } = r;   // replica bookkeeping, not part of a fact
        return fact;
    });
}

// ── SYNC ───────────────────────────────────────────────────────────────────
// Push every local fact. Cheap (an upsert of a few hundred rows) and safe to
// run on any schedule. Its real job is repairing whatever the per-write
// fire-and-forget calls dropped during an outage.
async function syncAll() {
    const { loadFacts } = require('./json');
    const facts = loadFacts();
    const res = await push(facts);
    if (res.replicated) console.log(`[REPLICA] replicated ${res.replicated} fact(s) to Supabase`);
    return res;
}

// ── RESTORE ────────────────────────────────────────────────────────────────
// Rebuild facts.json from the replica. This is the disaster path — the reason
// the whole file exists — and it is deliberately NOT wired into anything that
// runs on its own.
//
// dryRun defaults to TRUE. An automatic restore is how you turn "the VM was
// rebuilt" into "every correction since the last replication is gone, and
// nothing told anyone". A restore should always be a decision someone made,
// having first seen exactly what it would change.
async function restore({ dryRun = true } = {}) {
    const remote = await pull();
    const { loadFacts } = require('./json');
    const local = loadFacts();

    const localIds = new Set(local.map((f) => f.id));
    const remoteIds = new Set(remote.map((f) => f.id));
    const wouldAdd = remote.filter((f) => !localIds.has(f.id));
    const wouldDrop = local.filter((f) => !remoteIds.has(f.id));

    const summary = {
        remote: remote.length,
        local: local.length,
        wouldAdd: wouldAdd.length,
        // Local facts absent from the replica. Usually just facts newer than
        // the last successful replication — which is exactly why this is
        // reported rather than silently overwritten.
        wouldDropLocalOnly: wouldDrop.length,
        wouldDropTexts: wouldDrop.slice(0, 10).map((f) => f.text),
        dryRun,
    };
    if (dryRun) return summary;

    if (!remote.length) {
        throw new Error('Refusing to restore from an EMPTY replica — that would wipe facts.json. Check the Supabase connection and that replication has actually been running.');
    }

    const fs = require('fs');
    // Never overwrite the only other copy without keeping it. If the replica
    // turns out to be stale, this file is the last way back.
    const backup = `${cfg.FACTS_FILE}.pre-restore-${Date.now()}.json`;
    if (fs.existsSync(cfg.FACTS_FILE)) fs.copyFileSync(cfg.FACTS_FILE, backup);
    fs.writeFileSync(cfg.FACTS_FILE, JSON.stringify(remote, null, 2));
    console.log(`[REPLICA] restored ${remote.length} fact(s); previous facts.json saved to ${backup}`);
    return { ...summary, dryRun: false, restored: remote.length, backup };
}

// ── HEALTH ─────────────────────────────────────────────────────────────────
// Answers the question a backup exists to answer and which nothing currently
// asks: is there actually a usable copy, and how stale is it? A backup nobody
// checks is a backup nobody has.
async function status() {
    if (!configured()) return { configured: false };
    try {
        const { getSupabase } = require('./supabase');
        const { count, error } = await getSupabase()
            .from('facts').select('id', { count: 'exact', head: true });
        if (error) throw error;
        const { data } = await getSupabase()
            .from('facts').select('replicated_at').order('replicated_at', { ascending: false }).limit(1);
        const { loadFacts } = require('./json');
        const localCount = loadFacts().length;
        const lastAt = data && data[0] ? data[0].replicated_at : null;
        return {
            configured: true, ok: true,
            remoteCount: count ?? 0, localCount,
            lastReplicatedAt: lastAt,
            // A drift of a few facts is normal between the last write and the
            // nightly sync. A large or persistent drift means replication has
            // been failing and only the log knows.
            drift: localCount - (count ?? 0),
        };
    } catch (e) {
        return { configured: true, ok: false, error: e.message };
    }
}

module.exports = { push, pull, replicate, syncAll, restore, status, toRow, configured };
