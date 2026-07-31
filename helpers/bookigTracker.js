// ── helpers/bookingTracker.js — Live "Booking" Google Sheet sync ────────────
// Mirrors every booking (created via email watcher or manual dashboard
// entry) into a Google Sheet, one row per booking_number, upserted on every
// create/update. Reuses the same service account as helpers/drive.js and
// helpers/sheets.js.
//
// PREREQUISITE (manual, Apsara's side): the target sheet must be shared with
// that service account's client_email as EDITOR — not just Viewer, which is
// what the read-only price-list sheet uses. Writing needs Editor.
//
// Upsert strategy: read column A (Booking Number) on every call to find an
// existing row; update in place if found, append if not. No local row-index
// cache — re-scanning column A is simple and stays correct even if someone
// manually reorders rows by hand. Freight booking volume is small enough
// that this scan is cheap.
//
// Fire-and-forget posture, same as helpers/auditlog.js — a sheet-sync
// failure must NEVER block or fail a booking create/update. Every error
// path here is caught and logged internally, never thrown to the caller.

const fs  = require('fs');
const cfg = require('../config');
const { loadBookings } = require('./json');

const TAB    = 'Booking';
const HEADER = ['Booking Number', 'Port of Loading', 'Port of Discharge', 'ERD', 'Cutoff', 'Capacity'];

let sheetsClient = null;
function getSheetsWrite() {
    if (sheetsClient) return sheetsClient;
    if (!fs.existsSync(cfg.GDRIVE_KEYFILE)) {
        throw new Error(`Service account keyfile missing: ${cfg.GDRIVE_KEYFILE}`);
    }
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
        keyFile: cfg.GDRIVE_KEYFILE,
        // Read+write — deliberately NOT reusing helpers/sheets.js's client,
        // which is scoped spreadsheets.readonly for the price list. Keeping
        // this a separate client with its own (wider) scope means the
        // price-list reader's permissions stay exactly as narrow as before.
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    return sheetsClient;
}

function bookingToRow(b) {
    return [
        b.booking_number    || '',
        b.port_of_loading   || '',
        b.port_of_discharge || '',
        b.erd_date          || '',
        b.cutoff_date       || '',
        b.container_size    || '',
    ];
}

// Row number (1-indexed, matching real sheet rows) a booking currently
// occupies, or null if not present yet. Row 1 is always the header.
async function findRow(sheets, bkg) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: cfg.BOOKING_TRACKER_SHEET_ID,
        range: `'${TAB}'!A:A`,
    });
    const col = res.data.values || [];
    for (let i = 1; i < col.length; i++) { // i=0 is the header row — skip it
        if ((col[i][0] || '').trim().toUpperCase() === bkg.toUpperCase()) return i + 1;
    }
    return null;
}

// Lazily writes the header row if row 1 is empty — so a brand-new tab only
// needs to exist, not be pre-populated by hand. Never overwrites row 1 if
// anything is already there (assumed to already be the header).
async function ensureHeader(sheets) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: cfg.BOOKING_TRACKER_SHEET_ID,
        range: `'${TAB}'!A1:F1`,
    });
    if (res.data.values?.[0]?.length) return;
    await sheets.spreadsheets.values.update({
        spreadsheetId: cfg.BOOKING_TRACKER_SHEET_ID,
        range: `'${TAB}'!A1:F1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER] },
    });
}

// Upsert one booking by number. Reads the CURRENT full record from
// bookings.json rather than trusting a partial object the caller might
// have in hand — bookings.json is the single source of truth, this only
// mirrors it, never originates data.
async function syncBookingToSheet(bkgNo) {
    try {
        if (!cfg.BOOKING_TRACKER_SHEET_ID) {
            console.warn('[BOOKING-TRACKER] BOOKING_TRACKER_SHEET_ID not configured — skipping sync');
            return;
        }
        const bookings = loadBookings();
        const b = bookings[bkgNo];
        if (!b) {
            console.warn(`[BOOKING-TRACKER] ${bkgNo} not found in bookings.json — skipping sync`);
            return;
        }

        const sheets = getSheetsWrite();
        await ensureHeader(sheets);
        const row         = bookingToRow(b);
        const existingRow = await findRow(sheets, bkgNo);

        if (existingRow) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: cfg.BOOKING_TRACKER_SHEET_ID,
                range: `'${TAB}'!A${existingRow}:F${existingRow}`,
                valueInputOption: 'RAW',
                requestBody: { values: [row] },
            });
        } else {
            await sheets.spreadsheets.values.append({
                spreadsheetId: cfg.BOOKING_TRACKER_SHEET_ID,
                range: `'${TAB}'!A:F`,
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values: [row] },
            });
        }
        console.log(`[BOOKING-TRACKER] Synced ${bkgNo} → ${existingRow ? `row ${existingRow} updated` : 'appended'}`);
    } catch (err) {
        console.error(`[BOOKING-TRACKER] Sync failed for ${bkgNo}:`, err.message);
    }
}

module.exports = { syncBookingToSheet };