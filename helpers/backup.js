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
const CRITICAL = ['payments.json', 'petty_cash.json', 'loads.json', 'outbound_loads.json', 'expenses.json'];

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
            critical_missing: CRITICAL.filter((c) => !names.includes(c)),
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

module.exports = { collectStores, buildArchive, runBackup, isSecret, CRITICAL, SECRET_PATTERNS, SKIP_DIRS };
