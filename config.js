// ── config.js ─────────────────────────────────────────────────────────────────
// Single source of truth: paths, constants, env, dynamic settings.
// No cloud SDKs. Everything reads from ./data (gitignored) or env.

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

// Display name used ONLY by the Loads/Yard feature (mobile app + the
// nightly yard report) — per Apsara 2026-08-16: first said rename
// everywhere, then corrected to "no. just in mobile app and yard, it is
// edge trading." Everything else (WhatsApp bot menu/persona, price lists,
// outbound email sign-offs) stays "Edge Metals" — that rename was reverted,
// see workflow/brain.js, workflow/actions.js, helpers/pricelist.js. Only
// scheduler.js's buildYardReportText/eodYardReport reads this constant;
// mobile-app/www/index.html has no access to this file so its two
// "Edge Trading" instances (title, login tagline) are hardcoded by hand.
const COMPANY_NAME = 'Edge Trading';

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT     = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Memory lives in its own subfolder — deliberately separate from facts.json.
// facts.json = corrections/standing instructions (accuracy for data answers).
// memory/    = session continuity + rolling conversation summaries + durable
//              business-context notes (ongoing situations, not corrections).
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
const LOGS_DIR = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
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
    TRUST_LEDGER_FILE: path.join(DATA_DIR, 'trust_ledger.json'),
    MEMORY_SESSIONS_FILE: path.join(MEMORY_DIR, 'sessions.json'),
    MEMORY_CONTEXT_FILE : path.join(MEMORY_DIR, 'business_context.json'),
    MEMORY_EMBEDDINGS_FILE: path.join(MEMORY_DIR, 'embeddings.json'),
    // Saved name→email directory for draft_email/reply_email — see
    // helpers/emailContacts.js. Added 2026-08-03.
    EMAIL_CONTACTS_FILE: path.join(DATA_DIR, 'email_contacts.json'),
    // helpers/pricelist.js's loadContacts()/addContact()/removeContact() have
    // referenced cfg.PRICELIST_CONTACTS_FILE since that file was written, but
    // this constant never actually existed here — confirmed via GitHub audit
    // (grep -c "PRICELIST_CONTACTS_FILE" config.js on main → 0) while
    // building the email-contacts feature alongside it. Real bug, not
    // hypothetical: loadContacts() silently returned [] (loadJson catches
    // the resulting fs.existsSync(undefined) throw), but addContact()/
    // removeContact() would hard-crash on ensureFile(undefined, ...), which
    // sits outside mutateJson's own try/catch. Combined with api.js having
    // NO /api/pricelist/contacts routes at all (also fixed alongside this),
    // the dashboard's "Price list contacts" tab has been fully non-functional
    // in production — added here to close the gap.
    PRICELIST_CONTACTS_FILE: path.join(DATA_DIR, 'price_contacts.json'),
    // THIRD instance of the same missing-constant bug, found 2026-08-03
    // while wiring the pricelist send-city/webhook API routes: pricelist.js's
    // checkForChangesAndNotify() has referenced cfg.PRICELIST_SNAPSHOT_FILE
    // since it was written, and that function has ALREADY been running
    // daily via scheduler.js's pricelistFallback cron (0 6 * * *) since this
    // whole feature was deployed — meaning it has been silently
    // crash-failing every single morning (ensureFile(undefined, ...) throws
    // outside mutateJson's own try/catch, caught one level up by
    // pricelistFallback's try/catch, logged as "[SCHED] pricelist fallback
    // failed" and otherwise invisible). No snapshot has ever actually been
    // established, so real price changes have never once been detected by
    // this safety net. Same root-cause pattern as PRICELIST_CONTACTS_FILE
    // above — fixed together for the same reason.
    PRICELIST_SNAPSHOT_FILE: path.join(DATA_DIR, 'price_snapshot.json'),
    // Structured yard "load" records — date/seller/item table/gross-tare-net
    // weight, created via the dashboard's Add New Load form (camera-captured
    // weights, not WhatsApp). Separate from SCALE_TICKETS_FILE on purpose: that
    // one is a quick single-photo capture from WhatsApp, this is the full
    // structured record with line items and a generated PDF. Revisit merging
    // them later if that turns out to be wanted — kept apart for now since the
    // shapes and entry points are genuinely different.
    LOADS_FILE: path.join(DATA_DIR, 'loads.json'),
    // Outbound loads — the MIRROR of LOADS_FILE above (2026-08-16, per
    // Apsara: "loads sent to Eccomelt... how many loads for this month,
    // item wise, how much amount spent"). LOADS_FILE tracks INBOUND scrap
    // purchases at the yard (seller = outside party, buyer = fixed "Edge
    // Trading" constant — see helpers/loads.js's field-mapping note).
    // OUTBOUND_LOADS_FILE tracks the reverse: Edge Trading SELLING/shipping
    // material OUT to a real buyer (Eccomelt, or anyone else — general-
    // purpose per Apsara, not Eccomelt-specific). Deliberately its own
    // store, not a `direction` flag bolted onto loads.json — LOADS_FILE's
    // whole schema, validation, PDF/Drive integration, and inventory report
    // all hard-assume buyer is the fixed constant; reusing it here would
    // mean either breaking that assumption for every existing caller or
    // special-casing around it everywhere, for zero benefit over a
    // deliberately separate, much simpler store.
    OUTBOUND_LOADS_FILE: path.join(DATA_DIR, 'outbound_loads.json'),
    // Yard scale-ticket photos — standalone store, deliberately separate from
    // BOOKINGS_FILE/WORKFLOW_FILE. Added for the yard/scale-staff camera-photo
    // feature: yard staff text a photo of the digital scale ticket, Gemini reads
    // it, result lands here — never written onto a booking or container record.
    SCALE_TICKETS_FILE: path.join(DATA_DIR, 'scale_tickets.json'),
    // Custom item-type descriptions typed via the load form's "Others…"
    // free-text box — per Apsara 2026-08-15 ("when something gets added in
    // others, it should get added to existing list of description"). Starts
    // empty; helpers/itemTypes.js merges this with the hardcoded
    // ITEM_DESC_OPTIONS base list on the client so a custom description
    // typed once becomes a normal selectable option afterward instead of
    // requiring "Others…" every time.
    ITEM_TYPES_FILE: path.join(DATA_DIR, 'item_types.json'),
};

// ── Env ───────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-2.5-flash-lite';
const API_PORT       = parseInt(process.env.API_PORT || '8080');
const API_TOKEN      = process.env.API_TOKEN || '';        // simple bearer token for dashboard API
const APP_PASSWORD   = process.env.APP_PASSWORD || '';     // password gate for the web app (browser sessions)
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || '';   // separate, LOWER-privileged tier — Loads tab only (see api.js login)
const SUPABASE_URL   = process.env.SUPABASE_URL || '';     // semantic memory store — Project Settings > API
const SUPABASE_KEY   = process.env.SUPABASE_KEY || '';     // service_role key (server-side only, never expose to browser)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';   // separate, stronger password — gates WhatsApp QR + Facts admin panel
const SESSION_PATH   = process.env.SESSION_PATH || path.join(DATA_DIR, '.wwebjs_auth');

// Google Drive (booking PDFs) — service-account JSON path
const GDRIVE_KEYFILE          = process.env.GDRIVE_KEYFILE || path.join(DATA_DIR, 'gdrive-sa.json');
const GMAIL_CREDENTIALS_FILE = process.env.GMAIL_CREDENTIALS_FILE || path.join(DATA_DIR, 'gmail-credentials.json');
// Read and write are DIFFERENT Gmail accounts (bose@edgemetals.com reads —
// that's where carrier booking mail arrives; apsara@edgemetals.com sends —
// outbound mail should visibly come from Apsara, not the shared inbox).
// Same OAuth client/credentials file works for both; each account just
// needs its own consent + token, hence two separate token files. Run
// scripts/gmail-auth.js --role=read (signed into bose) and --role=write
// (signed into apsara) once each. GMAIL_TOKEN_FILE (no read/write suffix)
// is kept only as a fallback default if someone hasn't split their .env yet.
const GMAIL_TOKEN_FILE       = process.env.GMAIL_TOKEN_FILE       || path.join(DATA_DIR, 'gmail-token.json');
const GMAIL_READ_TOKEN_FILE  = process.env.GMAIL_READ_TOKEN_FILE  || path.join(DATA_DIR, 'gmail-token-read.json');
const GMAIL_WRITE_TOKEN_FILE = process.env.GMAIL_WRITE_TOKEN_FILE || path.join(DATA_DIR, 'gmail-token-write.json');
// A THIRD token, real gap found 2026-08-05: bose@ only ever sees carrier-
// initiated booking mail — any thread Apsara starts herself (emailing a
// trucker/broker directly from apsara@) never touches bose@'s inbox at all,
// so "reply to X" searches (hardcoded to bose@ via getGmailRead()) are
// structurally blind to it, and can end up matching the wrong thread
// entirely off a coincidental subject/word overlap. This token grants
// READ access to apsara@'s OWN mailbox (separate from GMAIL_WRITE_TOKEN_FILE,
// which is send-only scope and can't list/read anything) — see
// helpers/gmail.js's getGmailSenderRead(). Run scripts/gmail-auth.js
// --role=sender-read, signed into apsara, once. Optional: every caller
// treats a missing file here as "not set up yet" and falls back to the
// existing bose@-only search, so nothing breaks before this is deployed.
const GMAIL_SENDER_READ_TOKEN_FILE = process.env.GMAIL_SENDER_READ_TOKEN_FILE || path.join(DATA_DIR, 'gmail-token-sender-read.json');
const GDRIVE_FOLDER_ID        = process.env.GDRIVE_FOLDER_ID || '';        // Shared Drive root ID (0A...)
const GDRIVE_UPLOAD_FOLDER_ID = process.env.GDRIVE_UPLOAD_FOLDER_ID || ''; // Folder inside the Shared Drive where PDFs land
// Optional dedicated folder for yard scale-ticket photos — falls back to
// GDRIVE_UPLOAD_FOLDER_ID if unset, so the yard feature works with zero new
// Drive setup; set this later if you want ticket photos filed separately from
// booking PDFs. See helpers/drive.js's uploadScaleTicketImage().
const GDRIVE_SCALE_TICKETS_FOLDER_ID = process.env.GDRIVE_SCALE_TICKETS_FOLDER_ID || '';

// Address book — real need found 2026-08-05: quote-request messages to
// truckers need full pickup/delivery address blocks (yard/company name +
// street + city/state/zip), which Apsara currently retypes by hand every
// time from a running Google Doc. That Doc is free-text, not a table — one
// [Name/alias1/alias2] label line followed by a multi-line address block,
// blank-line separated. Reuses the SAME Drive service account already set
// up for booking PDFs (helpers/drive.js's exportDocAsText) — no new OAuth
// scope needed, just share this specific Doc with the service account's
// email (see data/gdrive-sa.json's client_email) as Viewer, same
// prerequisite as helpers/sheets.js's price list. The Doc is the source of
// truth — syncing overwrites Jarvis's stored copy, it never merges/preserves
// a Jarvis-side edit, since nobody edits addresses from inside Jarvis.
const ADDRESS_BOOK_DOC_ID   = process.env.ADDRESS_BOOK_DOC_ID   || '1u-hKBqVvqS1GIpckUXWbT5AQtTGWjWK69rre5IlSHio';
const ADDRESS_BOOK_FILE     = path.join(DATA_DIR, 'address_book.json');

// Multi-trucker quote requests — built 2026-08-05 per Apsara: "get quote
// from LA to Richmond" fans a quote ask out to one or more truckers (over
// whichever channel each one actually uses — WhatsApp group, WhatsApp DM,
// or email), tracks each trucker's reply independently, reminds on a fixed
// 30/60/90-minute schedule if no price comes back, and escalates to the
// manager after that. See helpers/quoteRequests.js for the full design.
// Own flat-array store, same pattern as address_book.json — one row per
// quote request, each holding an array of per-trucker "legs".
const QUOTE_REQUESTS_FILE = path.join(DATA_DIR, 'quote_requests.json');
// Contact quote requests — built 2026-08-16 per Apsara: a separate tab from
// the trucker lane-quote feature above ("these are just truckers... I want
// another tab where there is quote request and have whatsapp/email support
// for quote"). Same request/leg shape and reminder/escalation machinery as
// QUOTE_REQUESTS_FILE (see helpers/contactQuoteRequests.js's header for why
// it's a SEPARATE store rather than a generalized version of the trucker
// one), but the recipient is resolved against helpers/emailContacts.js
// and/or helpers/addressBook.js instead of workflow/truckers.js — any saved
// person/company, not just truckers. Own flat-array store, same pattern as
// quote_requests.json.
const CONTACT_QUOTE_REQUESTS_FILE = path.join(DATA_DIR, 'contact_quote_requests.json');
// Quote-request contacts (buyers/companies) — 2026-08-16 per Apsara: "i
// should have quotes contact where i have separate group/whatsapp/email
// mimicking trucker implementation." Replaces the earlier design (resolving
// recipients by merging helpers/emailContacts.js + helpers/addressBook.js)
// with a dedicated record per contact — name/group_id/whatsapp/email/
// preferred_mode, same shape as a trucker record — so
// helpers/quoteRequests.js's resolveTruckerChannel can be reused unchanged.
// See helpers/contacts.js's own header for the full reasoning.
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
// General sent-email reply tracking — 2026-08-06, per Apsara: "notification
// bell icon in website for reply thread". Separate from QUOTE_REQUESTS_FILE
// on purpose: quote requests already have their own full reply-tracking
// model (per-trucker legs, reminder schedule, price detection) that doesn't
// apply here — this is a much simpler "did anyone reply to this one-off
// email yet" flag for the general draftEmailForConfirm/sendDraftedEmail
// flow, which previously tracked nothing at all after sending. See
// helpers/emailThreads.js.
const EMAIL_THREADS_FILE = path.join(DATA_DIR, 'email_threads.json');
// Fixed reminder schedule (minutes since the request was sent to that
// trucker) — per Apsara: "first reminder @30 minutes. next @60 min.
// another. then ask manager to send reminder." Kept as an ordered array so
// scheduler.js can look up "what's the next stage after this one" generically
// instead of hardcoding three separate branches.
const QUOTE_REMINDER_SCHEDULE_MIN = [30, 60, 90];

// Google Sheets (price list) — reuses GDRIVE_KEYFILE's service account, just a
// different API/scope (see helpers/sheets.js). Sheet must be shared with that
// SA's client_email as Viewer — same constraint as the Shared Drive above.
const PRICE_SHEET_ID          = process.env.PRICE_SHEET_ID || '';
const BOOKING_TRACKER_SHEET_ID = process.env.BOOKING_TRACKER_SHEET_ID || '';
// Shared secret for the Apps Script → /api/pricelist/webhook call. Required
// because Apps Script's UrlFetchApp can't carry the dashboard's session
// cookie or the API_TOKEN bearer header the same way.
const PRICELIST_WEBHOOK_TOKEN = process.env.PRICELIST_WEBHOOK_TOKEN || '';

// ── Critical-failure alerting — email + SMS, for when WhatsApp or Gemini
// itself is down (so WhatsApp can't be used to notify anyone). Both are
// optional independently; helpers/notify.js skips whichever isn't configured
// rather than erroring, so this can be set up incrementally.
const SMTP_HOST     = process.env.SMTP_HOST || '';
const SMTP_PORT     = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER     = process.env.SMTP_USER || '';
const SMTP_PASS     = process.env.SMTP_PASS || '';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';
const TWILIO_SID        = process.env.TWILIO_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM       = process.env.TWILIO_FROM || ''; // your Twilio phone number
const ALERT_SMS_TO      = process.env.ALERT_SMS_TO || ''; // your real cell number, +1XXXXXXXXXX format
// Backup Gemini API key — tried if the primary fails with an auth-type error.
const GEMINI_API_KEY_BACKUP = process.env.GEMINI_API_KEY_BACKUP || '';

// Default fallback groups (used only when a contact has no group and no number)
const GROUP_TRUCKER  = process.env.GROUP_TRUCKER  || '';
const GROUP_SUPPLIER = process.env.GROUP_SUPPLIER || '';
const EMAIL_PROCESSED_FILE = path.join(DATA_DIR, 'email_processed.json');
const GMAIL_WATCH_ENABLED  = process.env.GMAIL_WATCH_ENABLED !== 'false'; // default ON — matches LLM_MANAGER_ENABLED's pattern in this same file
const GMAIL_POLL_DAYS_BACK = parseInt(process.env.GMAIL_POLL_DAYS_BACK || '3', 10);
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
    const defaults = {
        manager_number : process.env.MANAGER_NUMBER || '',
        manager_name   : 'Manager',
        internal_team  : [],
        team_group_id  : process.env.TEAM_GROUP_ID || '',
        bot_mode       : 'handholding',
        // Stall-detection thresholds (hours) — how long a booking can sit in a
        // stage before Jarvis proactively checks in. Adjustable here without a
        // code change. See scheduler.js's stallCheck job.
        stall_thresholds_hours: {
            awaiting_supplier    : 12,
            awaiting_forward     : 6,
            awaiting_empty_pickup: 24,
            awaiting_load_ready  : 48,
            awaiting_pickup      : 24,
            awaiting_scale_ticket: 24,
            awaiting_ingate      : 24,
        },
        // How long to wait after a check-in before escalating to the manager
        // if the supplier/trucker hasn't replied.
        stall_escalation_hours: 24,
        // End-of-day yard report recipients — kept in sync with
        // helpers/json.js's loadSettings() defaults on purpose (see that
        // file's comment): both read the same settings.json, from two
        // different call sites (scheduler.js/actions.js use this one).
        yard_report_emails     : 'bose@edgemetals.com, apsara@edgemetals.com',
        yard_whatsapp_group_id : '',
        yard_whatsapp_contacts : '',
    };
    try {
        if (fs.existsSync(FILES.SETTINGS_FILE)) {
            const saved = JSON.parse(fs.readFileSync(FILES.SETTINGS_FILE, 'utf8'));
            return {
                ...defaults, ...saved,
                stall_thresholds_hours: { ...defaults.stall_thresholds_hours, ...(saved.stall_thresholds_hours || {}) },
            };
        }
    } catch {}
    return defaults;
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
    COMPANY_NAME,
    ROOT, DATA_DIR, MEMORY_DIR, LOGS_DIR, ...FILES,
    GEMINI_API_KEY, GEMINI_MODEL,
    API_PORT, API_TOKEN, APP_PASSWORD, ADMIN_PASSWORD, STAFF_PASSWORD, SESSION_PATH,
    SUPABASE_URL, SUPABASE_KEY,
    GDRIVE_KEYFILE, GDRIVE_FOLDER_ID, GDRIVE_UPLOAD_FOLDER_ID, GDRIVE_SCALE_TICKETS_FOLDER_ID,
    ADDRESS_BOOK_DOC_ID, ADDRESS_BOOK_FILE,
    QUOTE_REQUESTS_FILE, CONTACT_QUOTE_REQUESTS_FILE, CONTACTS_FILE, QUOTE_REMINDER_SCHEDULE_MIN, EMAIL_THREADS_FILE,
    GMAIL_CREDENTIALS_FILE, GMAIL_TOKEN_FILE, GMAIL_READ_TOKEN_FILE, GMAIL_WRITE_TOKEN_FILE, GMAIL_SENDER_READ_TOKEN_FILE, EMAIL_PROCESSED_FILE,
    GMAIL_WATCH_ENABLED, GMAIL_POLL_DAYS_BACK,
    PRICE_SHEET_ID, PRICELIST_WEBHOOK_TOKEN,BOOKING_TRACKER_SHEET_ID,
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO,
    TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, ALERT_SMS_TO,
    GEMINI_API_KEY_BACKUP,
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