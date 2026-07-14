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
const loadTruckers  = () => loadJson(cfg.TRUCKERS_FILE,  []);
const loadSuppliers = () => loadJson(cfg.SUPPLIERS_FILE, []);

// ── Brain state (pending confirmations / actions) ─────────────────────────────
function normalizeBrain(raw) {
    return {
        handholding           : raw.handholding ?? true,
        promoted_at           : raw.promoted_at ?? null,
        pending_confirmations : typeof raw.pending_confirmations === 'object' && raw.pending_confirmations ? raw.pending_confirmations : {},
        proactive_sent        : typeof raw.proactive_sent        === 'object' && raw.proactive_sent        ? raw.proactive_sent        : {},
        pending_actions       : typeof raw.pending_actions       === 'object' && raw.pending_actions       ? raw.pending_actions       : {},
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
        team_group_id  : process.env.TEAM_GROUP_ID || '',
        gemini_model   : process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
        bot_mode       : 'handholding',
    });
}
const saveSettings = (s) => saveJson(cfg.SETTINGS_FILE, s);

// ── Workflow mutation ─────────────────────────────────────────────────────────
async function updateWorkflow(bkgNo, updates) {
    return mutateJson(cfg.WORKFLOW_FILE, {}, (wf) => {
        if (!wf[bkgNo]) wf[bkgNo] = { bkg_no: bkgNo, step: 'not_started', created_at: new Date().toISOString() };
        Object.assign(wf[bkgNo], updates, { updated_at: new Date().toISOString() });
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
const loadFacts = () => loadJson(cfg.FACTS_FILE, []);
async function addFact(text) {
    await mutateJson(cfg.FACTS_FILE, [], (facts) => {
        facts.push({ text, created_at: new Date().toISOString() });
        if (facts.length > 200) facts.shift();
        return facts;
    });
}

module.exports = {
    loadJson, saveJson, mutateJson,
    loadBookings, loadWorkflow, loadHistory, loadTruckers, loadSuppliers,
    loadBrain, saveBrain, mutateBrain,
    loadAlertsState, saveAlertsState,
    loadSettings, saveSettings,
    updateWorkflow, archiveBooking,
    saveTranscript, loadTranscripts,
    loadFacts, addFact,
};