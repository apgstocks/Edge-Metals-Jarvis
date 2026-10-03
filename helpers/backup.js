// ── helpers/backup.js — a nightly copy of everything, off the machine ──────
//
// Apsara, 2026-09-02: "What if some day this app goes down?"
//
// THE GAP THIS CLOSES
// -------------------
// Before this, an audit of what survived the VM's disk dying:
//
//   loads      — mostly. Inventory-Overall, the monthly Loads workbooks, every
//                ticket PDF and scale photo are already on Drive.
//   expenses   — same, via the Expenses workbooks.
//   truckers /
//   suppliers  — in Supabase, a separate service.
//
//   payments.json    — NOWHERE. Every payment ever recorded against a load.
//   petty_cash.json  — NOWHERE. The whole cash ledger.
//   bookings, brain/memory, tasks, settings, address book, item types,
//   load drafts, transcripts — NOWHERE.
//
// So the single most valuable thing in the system, who was paid what, existed
// in one file on one machine. The Drive sync was never a backup — it publishes
// DERIVED reports, and you cannot rebuild a payment ledger from a spreadsheet
// of weights.
//
// WHAT THIS IS, AND IS NOT
// ------------------------
// It is a dated archive of the raw JSON stores, one file per night, kept for
// 30 days. It is not continuous replication: the worst case is losing a day's
// entries, not losing everything. That is the cheap 90% of the problem.
//
// CREDENTIALS ARE DELIBERATELY EXCLUDED
// -------------------------------------
// gdrive-sa.json and the gmail-*.json tokens are skipped. They are the keys to
// the mailbox and the Drive this very file writes to, and putting them in that
// Drive means one leaked share link hands someone both the data and the
// credentials. They are re-issuable from the Google console; a payment ledger
// is not. The trade is a slower rebuild, and it is the right way round.
//
// PLAIN JSON, NOT AN ARCHIVE FORMAT
// ---------------------------------
// One readable file, no new dependency, and openable in Drive's own preview.
// The day this matters, someone will be reading it under pressure — a format
// that needs a tool to inspect is a format that fails then.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// Never leaves the machine. Matched on the FILENAME, so a credential file
// cannot be swept in by living somewhere unexpected under data/.
const SECRET_PATTERNS = [
    /^gdrive-sa\.json$/i,
    /^gmail-.*\.json$/i,
    /credentials?\.json$/i,
    /token.*\.json$/i,
    /\.pem$/i, /\.key$/i, /\.p12$/i, /\.jks$/i,
    // ── BANK DATA NEVER LEAVES THE MACHINE ────────────────────────────────
    // Added 2026-09-03, BEFORE the first bank file could exist. Apsara, asked
    // where bank data should sit in the backup: "exclude bank data from the
    // backup."
    //
    // This archive goes to a SHARED Drive folder. Everything else in it is
    // yard paperwork — weights, tickets, what was paid for scrap. A bank
    // transaction history is a different category of thing, and one careless
    // share link is the whole exposure. There is no version of that trade
    // that comes out well.
    //
    // bank-item.json is the more dangerous of the two. It holds the Plaid
    // ACCESS TOKEN, which is not a copy of the data — it is the standing
    // ability to fetch more of it, and it does not expire on its own. The
    // transactions are last month's statement; the token is the key.
    //
    // The consequence, stated plainly rather than buried: these files exist on
    // the VM and nowhere else. If that disk dies they are gone, and re-linking
    // the bank is the only way back. That is why the GCP daily snapshots
    // matter now in a way they did not before — it is the only remaining copy.
    /^bank-item\.json$/i,
    /^bank[-_].*\.json$/i,
];

// Not worth the bytes, or not restorable anyway: lock files are transient,
// caches regenerate, and the binary folders are already on Drive in their own
// right (photos and PDFs live under the load subfolders).
const SKIP_DIRS = new Set(['voice-cache', 'logs', 'documents_saved', 'node_modules']);
const isSecret = (name) => SECRET_PATTERNS.some((re) => re.test(name));

// Walks data/ and returns { relativePath -> parsed JSON }. A store that fails
// to parse is recorded as an ERROR ENTRY rather than skipped: a backup that
// quietly omits a corrupted file is a backup that tells you everything is fine
// on the night you most need to know it is not.
function collectStores(dir = cfg.DATA_DIR) {
    const out = {};
    const problems = [];
    const walk = (abs, rel) => {
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
        catch (e) { problems.push({ path: rel || '.', error: e.message }); return; }
        for (const e of entries) {
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                walk(path.join(abs, e.name), childRel);
                continue;
            }
            if (!e.name.endsWith('.json')) continue;      // .lock, .bak, stray files
            if (isSecret(e.name)) continue;
            try {
                out[childRel] = JSON.parse(fs.readFileSync(path.join(abs, e.name), 'utf8'));
            } catch (err) {
                problems.push({ path: childRel, error: err.message });
            }
        }
    };
    walk(dir, '');
    return { stores: out, problems };
}

// The stores that would be unrecoverable if this file did not exist. Called
// out by name in the archive so a restore can be sanity-checked at a glance —
// "is payments in here?" should not require reading the whole thing.
// ── WIDENED 2026-10-02: "Protect the data of edge yard no matter what" ────
// The five originally named here were not all of the yard's money, and this
// list is the ONLY safety net that names stores: critical_missing is how a
// vanished store gets noticed, so a store absent from here can disappear
// silently while the archive still looks complete.
//
// What was missing, and why each belongs:
//
//   bill_payments.json   money OUT to suppliers, every advance included. Its
//                        own store precisely so it is not confused with
//                        payments.json — which means payments.json being
//                        present proves nothing about it.
//   sales_receipts.json  money IN from customers: whether a load was paid for.
//   trucker_bills.json   what is owed to haulers.
//   yard_claims.json     claims against loads the yard bought (2026-10-01).
//                        A claim is a thing she argues with a supplier about
//                        a fortnight later, and it exists nowhere else.
//   load_drafts.json     a part-entered load is work already done.
//   item_types.json /
//   item_aliases.json    the grade catalogue and the learned synonyms. Every
//                        load's pricing reads them, and rebuilding means
//                        re-deciding what each metal is and re-teaching every
//                        spelling a supplier uses.
//
// Prepayments are NOT a separate store — they are rows in bill_payments.json
// — and stock is derived from loads, so neither needs naming here.
//
// ── NAMED BY CONFIG KEY, NOT BY FILENAME ─────────────────────────────────
// The first version of this widening wrote the filenames as literals, which
// I had GUESSED. Two of them did not exist (STOCK_FILE, PREPAYMENTS_FILE),
// and a guessed name in THIS list is the worst possible place for one: it
// would sit in critical_missing every single night, so the one alarm that
// means "a store has vanished" would cry wolf until it was ignored — and
// meanwhile a store that really did vanish would be lost in the noise.
//
// Keys, resolved at run time, so a store that gets renamed moves with its
// config entry. A key that is DELETED throws here rather than quietly
// shrinking the safety net: see criticalNames().
const CRITICAL_KEYS = [
    'PAYMENTS_FILE', 'PETTY_CASH_FILE', 'LOADS_FILE', 'OUTBOUND_LOADS_FILE',
    'EXPENSES_FILE', 'BILL_PAYMENTS_FILE', 'SALES_RECEIPTS_FILE',
    'TRUCKER_BILLS_FILE', 'YARD_CLAIMS_FILE', 'LOAD_DRAFTS_FILE',
    'ITEM_TYPES_FILE', 'ITEM_ALIASES_FILE',
];

// Resolved once, loudly. A missing key is a programming error — someone
// removed or renamed a config entry without reading this list — and it must
// not degrade into a shorter list of protected stores.
function criticalNames() {
    const out = [];
    const unknown = [];
    for (const k of CRITICAL_KEYS) {
        const v = cfg[k];
        if (typeof v !== 'string' || !v) { unknown.push(k); continue; }
        out.push(path.basename(v));
    }
    if (unknown.length) {
        // Thrown, not warned. runBackup catches and reports it, so the night
        // this happens she is told the safety net is broken rather than
        // simply getting a thinner one.
        throw new Error(`backup CRITICAL_KEYS not in config: ${unknown.join(', ')}`);
    }
    return out;
}

// Kept as an exported array for the callers and tests that read it.
const CRITICAL = criticalNames();

// ── "MISSING" MEANT TWO DIFFERENT THINGS (2026-10-03) ────────────────────
// critical_missing was computed as "this name is not in the archive", which
// cannot tell apart:
//
//   a store that VANISHED      — it was in last night's archive and is gone.
//                                That is an emergency.
//   a store never yet WRITTEN  — the feature has not been used, so the file
//                                has never existed. That is a Tuesday.
//
// Both produced the same warning. On a fresh data directory ELEVEN critical
// stores report missing, and the three that showed up on her live VM —
// sales_receipts, trucker_bills, yard_claims — are almost certainly features
// not yet used rather than data lost.
//
// I read that warning and told her twice, forcefully, that her Edge Yard data
// was not being backed up and would not come back. That was a false alarm,
// and it is precisely what the note above CRITICAL_KEYS warned would happen:
// "it would sit in critical_missing every single night, so the one alarm that
// means 'a store has vanished' would cry wolf until it was ignored".
//
// So the two are separated by MEMORY. A store that has ever been seen in a
// previous archive is expected forever after; its absence is `vanished` and
// that is the alarm. A store never seen is `not_yet_used` and says nothing.
//
// The ledger of what has been seen is kept in the backup log, which already
// exists and is already trimmed. No new store, no new failure mode.
function seenBefore() {
    try {
        const rows = require('./backupWatch').readLog();
        const seen = new Set();
        for (const r of (Array.isArray(rows) ? rows : [])) {
            for (const n of (r && Array.isArray(r.stores_present) ? r.stores_present : [])) seen.add(n);
        }
        return seen;
    } catch (e) {
        // Unreadable history means we cannot prove a store ever existed. The
        // safe reading is NOT to raise an emergency on that basis — a false
        // "your data vanished" is worse than a quiet night, because the next
        // one gets ignored.
        return null;
    }
}

function splitMissing(presentNames, critical, seen) {
    const missing = critical.filter((n) => !presentNames.has(n));
    if (!seen) return { vanished: [], not_yet_used: missing, history: 'unreadable' };
    return {
        vanished: missing.filter((n) => seen.has(n)),
        not_yet_used: missing.filter((n) => !seen.has(n)),
        history: 'read',
    };
}

function buildArchive(now = new Date()) {
    const { stores, problems } = collectStores();
    const names = Object.keys(stores);
    return {
        _meta: {
            kind: 'jarvis-data-backup',
            version: 1,
            taken_at: now.toISOString(),
            // The yard's day, so a backup's name lines up with the day's work
            // rather than with UTC's idea of it.
            date: require('./time').todayLocal(now),
            data_dir: cfg.DATA_DIR,
            store_count: names.length,
            // Present and readable, at the time of writing. Absent from this
            // list means it was missing or unparseable — see problems.
            critical_present: CRITICAL.filter((c) => names.includes(c)),
            // ── THE TWO KINDS OF ABSENT ──────────────────────────────────
            // vanished:     was in a previous archive, is not here now. ALARM.
            // not_yet_used: never seen in any archive — the feature has not
            //               been used and the file has never existed. Quiet.
            // critical_missing is kept as the union so older readers (the
            // restore script, the tests, last week's archives) are unchanged.
            ...(() => {
                const present = new Set(names);
                const split = splitMissing(present, CRITICAL, seenBefore());
                return {
                    critical_missing: [...split.vanished, ...split.not_yet_used],
                    critical_vanished: split.vanished,
                    critical_not_yet_used: split.not_yet_used,
                    store_history: split.history,
                };
            })(),
            // What this archive actually holds, so TOMORROW can tell a store
            // that vanished from one that was never there. This is the memory
            // the split above reads.
            stores_present: names,
            problems,
            note: 'Credentials are deliberately excluded. Re-issue them from the Google console on restore.',
        },
        stores,
    };
}

// Uploads one dated archive and trims anything older than `keep` days.
//
// A DATED NAME, not one rolling file. uploadInventoryBackupXlsx replaces its
// file in place, which is right for a live snapshot and wrong here: if a bad
// write corrupts a store on Monday, a single rolling backup is corrupt by
// Tuesday. Dated copies mean there is always a version from before the damage.
async function runBackup({ keep = 30, now = new Date() } = {}) {
    const drive = require('./drive');
    const archive = buildArchive(now);
    const name = `jarvis-data-${archive._meta.date}.json`;
    const body = Buffer.from(JSON.stringify(archive, null, 2), 'utf8');

    const file = await drive.uploadBackupJson(name, body);
    let trimmed = 0;
    try {
        trimmed = await drive.trimBackups(keep);
    } catch (e) {
        // A failed trim is untidy, not dangerous — say so and keep the backup.
        console.warn('[BACKUP] could not trim old backups:', e.message);
    }
    console.log(`[BACKUP] ${name} — ${archive._meta.store_count} stores, ${body.length} bytes, ${trimmed} old removed`);
    if (archive._meta.critical_missing.length) {
        console.warn(`[BACKUP] MISSING from this archive: ${archive._meta.critical_missing.join(', ')}`);
    }
    if (archive._meta.problems.length) {
        console.warn('[BACKUP] unreadable stores:', JSON.stringify(archive._meta.problems));
    }
    return { name, file, meta: archive._meta, bytes: body.length, trimmed };
}

module.exports = { collectStores, buildArchive, runBackup, isSecret, CRITICAL, criticalNames, CRITICAL_KEYS, SECRET_PATTERNS, SKIP_DIRS };
