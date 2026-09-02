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
    // Review & Generate screen's edit-state history, per container — NOT
    // the saved PDF archive (see helpers/documentsSaved.js for that, a
    // different thing: the finished file vs. the form fields that produced
    // it). Added per Apsara's "Load previous edits" mockup — every real
    // Generate & Download saves the full form state here so a returning
    // visit to the same container can restore it instead of starting blank.
    INVOICE_VERSIONS_FILE: path.join(DATA_DIR, 'invoice_versions.json'),
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
    // Unfinished loads — per Apsara 2026-08-28: "draft needs to be saved and
    // can be edited later." A load being typed is autosaved here once two
    // items carry real content, and can be reopened and finished from any
    // device rather than only the browser it was started in.
    //
    // Its OWN store, for the same reason OUTBOUND_LOADS_FILE is: a `draft`
    // flag on loads.json would put half-finished loads one forgotten filter
    // away from the day's totals, the yard report, the inventory netting and
    // the seller statements. A separate file makes that leak impossible
    // rather than merely unlikely — nothing that reads loads.json can see a
    // draft, because it is not in there. A draft is DELETED, not converted,
    // when the real load is saved.
    LOAD_DRAFTS_FILE: path.join(DATA_DIR, 'load_drafts.json'),
    // Payments against a load — per Apsara 2026-08-28. A load can be settled
    // in instalments, so this is a LEDGER of payments keyed by load, not a
    // paid/unpaid flag on the load itself.
    //
    // Its own store for the same reason as the two above, plus one specific
    // to money: a payment must never be silently rewritten by a load edit.
    // Loads are re-saved wholesale on every edit (see editLoad in
    // helpers/loads.js, which rebuilds the record), so a payments array living
    // on the load would be one dropped field away from erasing a receipt.
    // Keeping payments outside that write path means editing a weight cannot
    // touch what was paid.
    PAYMENTS_FILE: path.join(DATA_DIR, 'payments.json'),
    // Yard assistant transcripts — per Apsara 2026-08-29: "keep on storing the
    // conversations of yard assistant somewhere. so per day one log", then
    // "create a folder inside yard folder as log. put the logs over there."
    //
    // So: data/yard/log/. The yard/ folder is new and deliberately general —
    // anything else the yard feature needs to keep on disk belongs beside it
    // rather than as another loose entry in data/, which already has twenty.
    //
    // A DIRECTORY of one file per day rather than a single growing file. A
    // conversation log only grows, and one file that never stops growing
    // eventually has to be rewritten in full on every append, or read in full
    // to inspect one afternoon. A day per file keeps both cheap and makes
    // "what did it say on the 27th" a matter of opening one small file.
    YARD_DIR: path.join(DATA_DIR, 'yard'),
    YARD_CHAT_DIR: path.join(DATA_DIR, 'yard', 'log'),
    // Yard expenses — per Apsara 2026-08-19 ("for admin access in mobile
    // app, i want expense tracker"). Its own flat store for the same reason
    // OUTBOUND_LOADS_FILE is separate from LOADS_FILE: an expense shares
    // almost nothing with a load (no items, no weights, no scale photos, no
    // PDF/Drive pipeline, no buyer/seller mapping), so bolting a `type`
    // flag onto loads.json would mean special-casing every existing
    // consumer — getInventoryReport, the PDFs, the workbooks — for no gain.
    EXPENSES_FILE: path.join(DATA_DIR, 'expenses.json'),
    // Payments received against invoices — the other half of the receivables
    // ledger (helpers/receivables.js). Deliberately its own append-only store
    // rather than new columns on the Invoice Google Sheet: that sheet is read
    // by several other tools, one invoice can be paid in instalments (a list,
    // not a column), and a payment record must survive an accidental sheet
    // edit. Joined to the sheet by invoice number.
    PAYMENTS_FILE: path.join(DATA_DIR, 'payments.json'),
    // Gmail message ids the payment watcher has already judged — same dedupe
    // pattern as EMAIL_PROCESSED_FILE, kept separate so the two watchers can
    // never mark each other's mail as handled.
    PAYMENT_EMAILS_PROCESSED_FILE: path.join(DATA_DIR, 'payment_emails_processed.json'),
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
    // Petty cash — the physical cash box, per Apsara 2026-09-02: "a new tab
    // called Petty cash. Date and cash amount needs to be entered here. So it
    // is like cash reserve. If i click pay in load and select cash, the
    // invoice amount should be adjusted against this."
    //
    // A LEDGER, like payments, not a single balance field. Every top-up and
    // every cash payment is its own row and the balance is the sum. A stored
    // balance would be one crashed write away from being wrong with no way to
    // tell what it should have been — and with cash there is no bank statement
    // to reconcile against, so the ledger IS the record.
    //
    // ITS OWN FILE, for the same reason PAYMENTS_FILE is: it must not live
    // inside a record that gets rewritten wholesale by an unrelated edit.
    PETTY_CASH_FILE: path.join(DATA_DIR, 'petty_cash.json'),

    // ── what the top-level profile did ────────────────────────────────────
    // Every time a Jarvis session walks past a lock that stops everyone else,
    // a row lands here. It is APPEND-ONLY and nothing in the codebase deletes
    // from it — not even the profile it records, which is the entire point: a
    // profile that can erase a paid load can erase the evidence that money
    // moved, and this is the only trace left once the record is gone.
    //
    // Under DATA_DIR on purpose, so helpers/backup.js sweeps it up with
    // everything else and a copy leaves the machine nightly. A log that only
    // exists on the disk it is meant to outlive is not a log.
    AUDIT_LOG_FILE: path.join(DATA_DIR, 'audit_log.json'),
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
// ── the top-level profile ─────────────────────────────────────────────────
// Apsara 2026-09-03: "create another profile as jarvis with delete option
// enabled even after payments. this is in addition to admin privileges. this
// is like top level profile."
//
// A session logging in with THIS password gets role 'admin' — not a fourth
// role — plus a `super` flag. Deliberate: 'admin' is checked in fourteen
// places across two clients and the server, and a genuinely separate role
// string would have had to be added to every one of them, where missing a
// single check means the TOP-level profile silently sees LESS than admin.
// admin + a flag means every existing check keeps working untouched and only
// the four locks she asked to lift consult the flag.
//
// UNSET BY DEFAULT, and when unset the profile does not exist: no password
// matches it and nothing changes. Set it in .env on the VM, to something
// different from ADMIN_PASSWORD — if the two are equal, the admin password
// would silently grant the ability to erase paid loads, which is precisely
// the separation this profile exists to create. api.js refuses to accept it
// in that case rather than trusting the operator to notice.
const JARVIS_PASSWORD = process.env.JARVIS_PASSWORD || '';
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

// ── Documents (Invoice / Proforma / Verification) — added 2026-08-19 per
// Apsara: "i want invoice,proforma,verification in separate tabs under
// documents". Ports the Commercial Invoice + Proforma + carrier/commission
// verification tools that previously only existed in a separate Flask app
// (apgstocks/Edge-internal on PythonAnywhere) into this, the real live
// system. INVOICE_SHEET_ID is the SAME Google Sheet that Flask app read
// from (source of truth for consignee/container/HBL/commission data) —
// hardcoded default matches invoice_gen.py's GOOGLE_SHEET_ID exactly, same
// pattern as ADDRESS_BOOK_DOC_ID's hardcoded default above. Must be shared
// with the service account's client_email as Viewer, same prerequisite as
// PRICE_SHEET_ID/ADDRESS_BOOK_DOC_ID.
const INVOICE_SHEET_ID     = process.env.INVOICE_SHEET_ID     || '1QsCeuqeRKODuouzO2PfKbxG9qJpN8yAbIurSzhI--6s';
const INVOICE_MAIN_GID     = process.env.INVOICE_MAIN_GID     || '571096144';
const INVOICE_PACKING_GID  = process.env.INVOICE_PACKING_GID  || '1340048377';

// Customer pricing memory (Proforma tab) — pricing-only, NOT a full
// address/profile store, since buyer addresses already have a working
// source: ADDRESS_BOOK_DOC_ID/ADDRESS_BOOK_FILE above via
// helpers/addressBook.js. Same flat-JSON-store pattern as
// address_book.json / quote_requests.json.
const PROFORMA_PRICING_FILE = path.join(DATA_DIR, 'proforma_pricing.json');
// Save-a-copy archive for generated Invoice/Proforma PDFs — mirrors the
// datewise/container-wise (invoice) and flat (proforma) folder layout
// Apsara originally asked for in the Flask app, kept identical here for
// continuity. Local disk, not Drive — unlike Load PDFs (helpers/drive.js),
// these documents aren't shared with truckers/suppliers over WhatsApp, so
// there's no existing Drive-upload need driving that choice; browsed
// in-dashboard via GET /api/documents/saved instead.
const DOCUMENTS_SAVED_DIR = path.join(DATA_DIR, 'documents_saved');
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
// Emails already assessed by workflow/replyWatch.js's needs-a-reply scan.
// Separate from EMAIL_PROCESSED_FILE on purpose: that one tracks the
// booking-PDF intake, and the two scans look at completely different mail.
// Sharing one store would make each silently suppress the other's work.
const REPLY_WATCH_FILE = path.join(DATA_DIR, 'reply_watch.json');
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
    API_PORT, API_TOKEN, APP_PASSWORD, ADMIN_PASSWORD, STAFF_PASSWORD, JARVIS_PASSWORD, SESSION_PATH,
    SUPABASE_URL, SUPABASE_KEY,
    GDRIVE_KEYFILE, GDRIVE_FOLDER_ID, GDRIVE_UPLOAD_FOLDER_ID, GDRIVE_SCALE_TICKETS_FOLDER_ID,
    ADDRESS_BOOK_DOC_ID, ADDRESS_BOOK_FILE,
    QUOTE_REQUESTS_FILE, CONTACT_QUOTE_REQUESTS_FILE, CONTACTS_FILE, QUOTE_REMINDER_SCHEDULE_MIN, EMAIL_THREADS_FILE,
    GMAIL_CREDENTIALS_FILE, GMAIL_TOKEN_FILE, GMAIL_READ_TOKEN_FILE, GMAIL_WRITE_TOKEN_FILE, GMAIL_SENDER_READ_TOKEN_FILE, EMAIL_PROCESSED_FILE, REPLY_WATCH_FILE,
    GMAIL_WATCH_ENABLED, GMAIL_POLL_DAYS_BACK,
    PRICE_SHEET_ID, PRICELIST_WEBHOOK_TOKEN,BOOKING_TRACKER_SHEET_ID,
    INVOICE_SHEET_ID, INVOICE_MAIN_GID, INVOICE_PACKING_GID,
    PROFORMA_PRICING_FILE, DOCUMENTS_SAVED_DIR,
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