// ── helpers/json.js — File storage with proper-lockfile ──────────────────────
// Every write: acquire lock → write temp → rename → release.
// Read-modify-write helpers (mutate*) hold the lock across the full cycle,
// which is what actually prevents lost updates between WA handler / cron / API.

const fs       = require('fs');
const path     = require('path');
const lockfile = require('proper-lockfile');
const cfg      = require('../config');

const LOCK_OPTS = { retries: { retries: 8, minTimeout: 40, maxTimeout: 400 }, stale: 10000, realpath: false };

function ensureFile(filePath, defaultVal) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2), 'utf8');
    }
}

function loadJson(filePath, defaultVal) {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`[JSON] Load failed ${filePath}:`, err.message);
        return defaultVal;
    }
}

async function saveJson(filePath, data) {
    ensureFile(filePath, Array.isArray(data) ? [] : {});
    let release = null;
    try {
        release = await lockfile.lock(filePath, LOCK_OPTS);
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
    } catch (err) {
        console.error(`[JSON] Save failed ${filePath}:`, err.message);
        try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); } catch {}
    } finally {
        if (release) { try { await release(); } catch {} }
    }
}

// Read-modify-write under one lock. mutator(data) returns new data (or mutates in place and returns it).
async function mutateJson(filePath, defaultVal, mutator) {
    ensureFile(filePath, defaultVal);
    let release = null;
    try {
        release = await lockfile.lock(filePath, LOCK_OPTS);
        const data   = loadJson(filePath, defaultVal);
        const result = await mutator(data) ?? data;
        const tmp    = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
        return result;
    } catch (err) {
        console.error(`[JSON] Mutate failed ${filePath}:`, err.message);
        return loadJson(filePath, defaultVal);
    } finally {
        if (release) { try { await release(); } catch {} }
    }
}

// ── Typed loaders (sync reads are fine — writes are the danger) ───────────────
// Bookings always come back with containers[] populated (auto-migrated from
// legacy flat shape). All downstream code — dashboard, brain, actions,
// scheduler — can rely on booking.containers being an array of ≥1 entries.
const loadBookings  = () => {
    const { migrateAll } = require('./containers');
    return migrateAll(loadJson(cfg.BOOKINGS_FILE, {}));
};
const loadWorkflow  = () => loadJson(cfg.WORKFLOW_FILE,  {});
const loadHistory   = () => loadJson(cfg.HISTORY_FILE,   {});

// ── Truckers / Suppliers — now backed by Postgres (Supabase), not flat JSON.
// Both now ASYNC (real DB calls) — every caller across the app needs `await`.
// Row shape maps 1:1 to what the dashboard's contact form already sends:
// { name, locality, whatsapp, email, group_id, preferred_mode }.
async function loadTruckers() {
    const { getSupabase } = require('./supabase');
    const { data, error } = await getSupabase().from('truckers').select('*').order('name');
    if (error) { console.error('[DB] loadTruckers failed:', error.message); return []; }
    return data || [];
}
async function loadSuppliers() {
    const { getSupabase } = require('./supabase');
    const { data, error } = await getSupabase().from('suppliers').select('*').order('name');
    if (error) { console.error('[DB] loadSuppliers failed:', error.message); return []; }
    return data || [];
}
// Upsert by name (case-insensitive) — mirrors the exact behavior the old
// mutateJson-based contactRoutes had: update if a contact with this name
// (any case) exists, otherwise insert new.
async function upsertContact(table, payload) {
    if (!payload?.name) throw new Error('name required');
    const { getSupabase } = require('./supabase');
    const sb = getSupabase();
    const { data: existing } = await sb.from(table).select('id').ilike('name', payload.name).maybeSingle();
    if (existing) {
        const { error } = await sb.from(table).update(payload).eq('id', existing.id);
        if (error) throw error;
    } else {
        const { error } = await sb.from(table).insert(payload);
        if (error) throw error;
    }
}
async function deleteContact(table, name) {
    const { getSupabase } = require('./supabase');
    const { error } = await getSupabase().from(table).delete().ilike('name', name);
    if (error) throw error;
}
const upsertTrucker  = (payload) => upsertContact('truckers', payload);
const deleteTrucker  = (name)    => deleteContact('truckers', name);
const upsertSupplier = (payload) => upsertContact('suppliers', payload);
const deleteSupplier = (name)    => deleteContact('suppliers', name);

// ── Brain state (pending confirmations / actions) ─────────────────────────────
function normalizeBrain(raw) {
    return {
        handholding           : raw.handholding ?? true,
        promoted_at           : raw.promoted_at ?? null,
        pending_confirmations : typeof raw.pending_confirmations === 'object' && raw.pending_confirmations ? raw.pending_confirmations : {},
        proactive_sent        : typeof raw.proactive_sent        === 'object' && raw.proactive_sent        ? raw.proactive_sent        : {},
        pending_actions       : typeof raw.pending_actions       === 'object' && raw.pending_actions       ? raw.pending_actions       : {},
        // One-per-chat pending_actions can't hold two unresolved asks at once
        // (wizard prompt, daily-learning digest, manager-triggered email
        // confirm can all target the same chat). pending_queue holds whatever
        // got bumped instead of silently overwritten — see actions.js's
        // setPending/clearPending. MUST be whitelisted here or it gets wiped
        // on the next unrelated brain.json write, since mutateBrain rebuilds
        // the object from this exact field list every time.
        pending_queue         : typeof raw.pending_queue          === 'object' && raw.pending_queue          ? raw.pending_queue          : {},
    };
}

function loadBrain() {
    const brain = normalizeBrain(loadJson(cfg.BRAIN_FILE, {}));
    const now   = Date.now();

    // Auto-expire pending actions
    for (const key of Object.keys(brain.pending_actions)) {
        const a = brain.pending_actions[key];
        const created = a.created_at ? new Date(a.created_at).getTime() : 0;
        const expires = a.expires_at ? new Date(a.expires_at).getTime() : created + cfg.PENDING_EXPIRY_MS;
        if (now > expires) {
            console.log(`[BRAIN] Auto-expired pending action: ${key}`);
            delete brain.pending_actions[key];
        }
    }

    // Prune proactive_sent older than 7 days (3 days for daily_ keys)
    const WEEK = 7 * 86400000, THREE = 3 * 86400000;
    for (const key of Object.keys(brain.proactive_sent)) {
        const maxAge = key.startsWith('daily_') ? THREE : WEEK;
        const ts = new Date(brain.proactive_sent[key]).getTime();
        if (!isNaN(ts) && now - ts > maxAge) delete brain.proactive_sent[key];
    }
    return brain;
}
const saveBrain = (b) => saveJson(cfg.BRAIN_FILE, b);
const mutateBrain = (fn) => mutateJson(cfg.BRAIN_FILE, {}, (raw) => {
    const brain = normalizeBrain(raw);
    fn(brain);
    return brain;
});

// ── Alerts state ──────────────────────────────────────────────────────────────
const loadAlertsState = () => loadJson(cfg.ALERTS_FILE, { snoozed: {}, muted: {}, history: [] });
const saveAlertsState = (s) => saveJson(cfg.ALERTS_FILE, s);

// ── Settings ──────────────────────────────────────────────────────────────────
function loadSettings() {
    return loadJson(cfg.SETTINGS_FILE, {
        manager_number : process.env.MANAGER_NUMBER || '',
        manager_name   : 'Manager',
        internal_team  : [],
        // Yard/scale staff — separate allowlist from internal_team on purpose:
        // these numbers get a distinct 'yard' role in brain.js's normalize(), so a
        // photo from one of them routes to the standalone scale-ticket pipeline
        // instead of the manager/team command grammar. [{name, whatsapp}, ...]
        yard_staff     : [],
        team_group_id  : process.env.TEAM_GROUP_ID || '',
        gemini_model   : process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
        bot_mode       : 'handholding',
        // Applied to every email Jarvis drafts (draft_email or reply_email),
        // dashboard-editable under Settings — see api.js's existing generic
        // PUT /api/settings merge, no new route needed. Comma-separated
        // addresses, empty string means none. Common use: Bcc bose so she
        // still sees replies sent from Apsara's account — see
        // workflow/actions.js's draftEmailForConfirm/draftReplyForConfirm.
        email_cc       : '',
        email_bcc      : '',
        // End-of-day yard report (scheduler.js's eodYardReport job, 8pm
        // America/New_York) — dashboard-editable under Settings > Yard.
        // Seeded with the two addresses Apsara asked for at launch; still
        // fully editable afterward, this is just the starting value.
        yard_report_emails     : 'bose@edgemetals.com, apsara@edgemetals.com',
        yard_whatsapp_group_id : '',
        yard_whatsapp_contacts : '',
        // Floor for helpers/loads.js's nextLoadId — dashboard-editable under
        // Settings > Yard. Per Apsara 2026-08-15. Empty/null means "no
        // floor, just use the scanned max+1 like always." See nextLoadId's
        // own comment for why this doesn't need to be cleared after use.
        next_load_number: null,
        // Master on/off switch for scheduler.js's eodYardReport — per Apsara
        // 2026-08-15 ("there should be an option to enable the daily report
        // sending in dashboard admin access"). Defaults FALSE deliberately:
        // the report already existed in code before this flag was added, so
        // defaulting it OFF means nobody gets an unexpected 8PM email/
        // WhatsApp blast the moment this ships — it only starts sending once
        // someone explicitly turns it on in Settings > Yard.
        yard_report_enabled: false,
    });
}
const saveSettings = (s) => saveJson(cfg.SETTINGS_FILE, s);

// ── Workflow mutation ─────────────────────────────────────────────────────────
async function updateWorkflow(bkgNo, updates) {
    return mutateJson(cfg.WORKFLOW_FILE, {}, (wf) => {
        if (!wf[bkgNo]) wf[bkgNo] = { bkg_no: bkgNo, step: 'not_started', created_at: new Date().toISOString() };
        const now = new Date().toISOString();
        // stage_entered_at tracks ONLY step transitions — distinct from updated_at,
        // which touches on every field edit. This is what stall detection reads:
        // "how long has this booking sat in its CURRENT stage", not "when was it
        // last touched at all" (those are very different signals).
        if (updates.step && updates.step !== wf[bkgNo].step) {
            updates = { ...updates, stage_entered_at: now };
        }
        Object.assign(wf[bkgNo], updates, { updated_at: now });
        if (!wf[bkgNo].stage_entered_at) wf[bkgNo].stage_entered_at = wf[bkgNo].created_at || now;
        return wf;
    });
}

// ── Archive ───────────────────────────────────────────────────────────────────
async function archiveBooking(bkgNo, reason = 'manual') {
    const bookings = loadBookings();
    if (!bookings[bkgNo]) return false;
    const wf = loadWorkflow();

    await mutateJson(cfg.HISTORY_FILE, {}, (history) => {
        history[bkgNo] = {
            ...bookings[bkgNo],
            archived_at    : new Date().toISOString(),
            archive_reason : reason,
            final_step     : wf[bkgNo]?.step || 'not_started',
        };
        return history;
    });
    await mutateJson(cfg.BOOKINGS_FILE, {}, (b) => { delete b[bkgNo]; return b; });
    await mutateJson(cfg.WORKFLOW_FILE, {}, (w) => { delete w[bkgNo]; return w; });
    console.log('[ARCHIVE]', bkgNo, '→ history (' + reason + ')');
    return true;
}

// ── Transcripts (replaces Firestore) — capped at last 30 per chat ─────────────
async function saveTranscript(chatId, entry) {
    await mutateJson(cfg.TRANSCRIPTS_FILE, {}, (all) => {
        if (!all[chatId]) all[chatId] = [];
        all[chatId].push(entry);
        if (all[chatId].length > 30) all[chatId] = all[chatId].slice(-30);
        return all;
    });
}
function loadTranscripts(chatId, n = 5) {
    const all = loadJson(cfg.TRANSCRIPTS_FILE, {});
    return (all[chatId] || []).slice(-n);
}

// ── Facts (long-term memory, replaces Firestore facts collection) ─────────────
// pinned facts (2026-08-16, per Apsara: "i never want it to forget... i want
// infra to be in a way that it remembers forever like a child being taught")
// — helpers/context.js's formatForAI used to feed the AI only the most
// recent 15 facts by insertion order, so a genuinely durable standing rule
// could silently fall out of the prompt the moment 15 newer facts were
// added, with nothing telling anyone it happened. `pinned: true` facts are
// exempt from that recency window (see formatForAI) — read on EVERY AI call,
// permanently.
//
// "Remembers forever" also means the 200-cap below must NEVER evict a
// pinned fact, full stop — not "usually", not "until the whole store is
// pinned". Only the unpinned pool (one-off/ambient notes, not standing
// instructions) is capped; once that pool is exhausted, the pinned pool is
// simply allowed to keep growing past 200. A real business will accumulate
// dozens of standing rules over its lifetime, not thousands — token cost
// from that growth is a real, worth-monitoring trade-off, not a free lunch,
// but it's the honest cost of an actual "never forget" guarantee rather
// than a cap that quietly breaks the promise once enough lessons pile up.
//
// Per the same "child being taught" framing, `rememberFact`/`resolveFactBatch`
// in workflow/actions.js (the WhatsApp "remember X" command and AI-detected
// corrections the manager confirms) now call addFact with pinned=true by
// default — a correction Apsara actually voiced is exactly the kind of
// lesson meant to stick permanently, not decay out after 15 newer facts,
// without her having to remember to separately pin it every time. Manual
// adds from the dashboard's Facts tab still default the pin checkbox
// checked for the same reason, but stay a deliberate per-fact choice there.
const loadFacts = () => loadJson(cfg.FACTS_FILE, []);
async function addFact(text, pinned = false) {
    await mutateJson(cfg.FACTS_FILE, [], (facts) => {
        facts.push({ text, pinned: !!pinned, created_at: new Date().toISOString() });
        if (facts.length > 200) {
            const idx = facts.findIndex((f) => !f.pinned);
            if (idx >= 0) facts.splice(idx, 1);
            // else: every fact is pinned — let the store exceed 200 rather
            // than silently breaking "never forget" by evicting one anyway.
        }
        return facts;
    });
}
async function setFactPinned(index, pinned) {
    let ok = false;
    await mutateJson(cfg.FACTS_FILE, [], (facts) => {
        if (index >= 0 && index < facts.length) { facts[index].pinned = !!pinned; ok = true; }
        return facts;
    });
    return ok;
}

module.exports = {
    loadJson, saveJson, mutateJson,
    loadBookings, loadWorkflow, loadHistory, loadTruckers, loadSuppliers,
    upsertTrucker, deleteTrucker, upsertSupplier, deleteSupplier,
    loadBrain, saveBrain, mutateBrain,
    loadAlertsState, saveAlertsState,
    loadSettings, saveSettings,
    updateWorkflow, archiveBooking,
    saveTranscript, loadTranscripts,
    loadFacts, addFact, setFactPinned,
};