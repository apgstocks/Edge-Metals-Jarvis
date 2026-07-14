// ── config.js ─────────────────────────────────────────────────────────────────
// Single source of truth: paths, constants, env, dynamic settings.
// No cloud SDKs. Everything reads from ./data (gitignored) or env.

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT     = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    BOOKINGS_FILE    : path.join(DATA_DIR, 'bookings.json'),
    WORKFLOW_FILE    : path.join(DATA_DIR, 'workflow.json'),
    TASKS_FILE       : path.join(DATA_DIR, 'tasks.json'),
    TASKS_HISTORY_FILE: path.join(DATA_DIR, 'tasks_history.json'),
    HISTORY_FILE     : path.join(DATA_DIR, 'history.json'),
    TRUCKERS_FILE    : path.join(DATA_DIR, 'truckers.json'),
    SUPPLIERS_FILE   : path.join(DATA_DIR, 'suppliers.json'),
    BRAIN_FILE       : path.join(DATA_DIR, 'brain.json'),
    ALERTS_FILE      : path.join(DATA_DIR, 'alerts.json'),
    SETTINGS_FILE    : path.join(DATA_DIR, 'settings.json'),
    TRANSCRIPTS_FILE : path.join(DATA_DIR, 'transcripts.json'),
    FACTS_FILE       : path.join(DATA_DIR, 'facts.json'),
};

// ── Env ───────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-2.5-flash-lite';
const API_PORT       = parseInt(process.env.API_PORT || '8080');
const API_TOKEN      = process.env.API_TOKEN || '';        // simple bearer token for dashboard API
const APP_PASSWORD   = process.env.APP_PASSWORD || '';     // password gate for the web app (browser sessions)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';   // separate, stronger password — gates WhatsApp QR + Facts admin panel
const SESSION_PATH   = process.env.SESSION_PATH || path.join(DATA_DIR, '.wwebjs_auth');

// Google Drive (booking PDFs) — service-account JSON path
const GDRIVE_KEYFILE          = process.env.GDRIVE_KEYFILE || path.join(DATA_DIR, 'gdrive-sa.json');
const GDRIVE_FOLDER_ID        = process.env.GDRIVE_FOLDER_ID || '';        // Shared Drive root ID (0A...)
const GDRIVE_UPLOAD_FOLDER_ID = process.env.GDRIVE_UPLOAD_FOLDER_ID || ''; // Folder inside the Shared Drive where PDFs land

// Default fallback groups (used only when a contact has no group and no number)
const GROUP_TRUCKER  = process.env.GROUP_TRUCKER  || '';
const GROUP_SUPPLIER = process.env.GROUP_SUPPLIER || '';

// ── Workflow constants ────────────────────────────────────────────────────────
const WORKFLOW_STAGES = [
    'not_started',
    'supplier_assigned',
    'forwarded',
    'empty_dropped',
    'load_ready',
    'picked_up',
    'ingate_received',
    'done',
];

const STEP_LABELS = {
    not_started        : 'Not Started',
    supplier_assigned  : 'Assigned to Supplier',
    forwarded          : 'Forwarded to Trucker',
    empty_dropped      : 'Empty Dropped',
    load_ready         : 'Load Ready',
    picked_up          : 'Picked Up',
    ingate_received    : 'Ingated',
    done               : 'Complete',
};

// Stage index for dashboard progress bar (7-dot rail)
const STAGE_INDEX = {
    not_started        : 0,
    supplier_assigned  : 1,
    forwarded          : 2,
    empty_dropped      : 3,
    load_ready         : 4,
    picked_up          : 5,
    ingate_received    : 6,
    done               : 6,
};

const TERMINAL_STEPS      = ['ingate_received', 'done', 'archived'];
const MAX_REMINDERS       = 3;
const URGENT_CUTOFF_DAYS  = 3;
const PENDING_EXPIRY_MS   = 2 * 60 * 60 * 1000; // pending actions auto-expire after 2h

// ── Dynamic settings ──────────────────────────────────────────────────────────
function getSettings() {
    try {
        if (fs.existsSync(FILES.SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(FILES.SETTINGS_FILE, 'utf8'));
        }
    } catch {}
    return {
        manager_number : process.env.MANAGER_NUMBER || '',
        manager_name   : 'Manager',
        internal_team  : [],
        team_group_id  : process.env.TEAM_GROUP_ID || '',
        bot_mode       : 'handholding',
    };
}

const getManagerNumber = () => (getSettings().manager_number || process.env.MANAGER_NUMBER || '').replace(/\D/g, '');
const getTeamGroupId   = () => getSettings().team_group_id || process.env.TEAM_GROUP_ID || '';

// ── Menus ─────────────────────────────────────────────────────────────────────
const MAIN_MENU = [
    'Jarvis — Edge Metals Operations',
    '',
    '1. Bookings',
    '2. Forward booking to trucker',
    '3. Assign supplier to booking',
    '4. Check supplier for pickup',
    '5. Show truckers and suppliers',
    '6. Reports',
    '',
    'Type a number or describe what you need.',
].join('\n');

const BOOKINGS_MENU = [
    'Bookings — What would you like?',
    '',
    '1. Urgent cutoffs',
    '2. All active bookings',
    '3. Available bookings (no supplier assigned)',
    "4. This week's bookings",
    '5. Specific booking status',
    '6. Archived bookings',
    '',
    'Or type a booking number directly.',
].join('\n');

module.exports = {
    ROOT, DATA_DIR, ...FILES,
    GEMINI_API_KEY, GEMINI_MODEL,
    API_PORT, API_TOKEN, APP_PASSWORD, ADMIN_PASSWORD, SESSION_PATH,
    GDRIVE_KEYFILE, GDRIVE_FOLDER_ID, GDRIVE_UPLOAD_FOLDER_ID,
    GROUP_TRUCKER, GROUP_SUPPLIER,
    WORKFLOW_STAGES, STEP_LABELS, STAGE_INDEX, TERMINAL_STEPS,
    MAX_REMINDERS, URGENT_CUTOFF_DAYS, PENDING_EXPIRY_MS,
    getSettings, getManagerNumber, getTeamGroupId,
    MAIN_MENU, BOOKINGS_MENU,
    // ── LLM manager intent — Phase 1 ─────────────────────────────────────────
    LLM_MANAGER_ENABLED : process.env.LLM_MANAGER_ENABLED !== 'false',  // default ON; set 'false' to kill
    GEMINI_MODEL        : process.env.GEMINI_MODEL        || 'gemini-2.5-flash',
    LLM_TIMEOUT_MS      : parseInt(process.env.LLM_TIMEOUT_MS      || '2000', 10),
    LLM_CONFIDENCE_HIGH : parseFloat(process.env.LLM_CONFIDENCE_HIGH || '0.85'),
    LLM_CONFIDENCE_LOW  : parseFloat(process.env.LLM_CONFIDENCE_LOW  || '0.5'),
};