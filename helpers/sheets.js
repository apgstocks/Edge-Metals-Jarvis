// ── helpers/sheets.js — Google Sheets price list (service account) ──────────
// Reuses the SAME service account as helpers/drive.js. Sheets is a separate
// Google API from Drive, so the auth client here needs its own scope — Drive's
// broad 'drive' scope does NOT automatically grant spreadsheets.values.get.
//
// PREREQUISITE (must be done by hand, cannot be scripted from here):
// The target Google Sheet must be shared with the service account's email
// (the "client_email" field inside data/gdrive-sa.json) as Viewer. Service
// accounts have no personal Drive/Sheets access — same constraint as the
// Shared Drive setup in helpers/drive.js, just for Sheets instead of Drive.
//
// Sheet layout assumed (per tab): row 1 = header ("Item", "Price"), then one
// row per line item. Tabs read: Los Angeles, Houston, San Antonio — hardcode
// list below if more cities get added later.

const fs  = require('fs');
const cfg = require('../config');

const PRICE_TABS = ['Los Angeles', 'Houston', 'San Antonio'];

let sheetsClient = null;

function getSheets() {
    if (sheetsClient) return sheetsClient;
    if (!fs.existsSync(cfg.GDRIVE_KEYFILE)) {
        throw new Error(`Service account keyfile missing: ${cfg.GDRIVE_KEYFILE}`);
    }
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
        keyFile: cfg.GDRIVE_KEYFILE,
        scopes : ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    return sheetsClient;
}

// Parse one tab's raw rows into [{ item, price }], skipping the header row
// and any blank/malformed rows. Price is kept as the raw string (e.g. "$1.00")
// AND as a parsed float, so callers can display or diff without re-parsing.
function parseRows(rows) {
    if (!rows || rows.length < 2) return [];
    return rows.slice(1)
        .filter(r => r && r[0] != null && String(r[0]).trim() !== '')
        .map(r => {
            const item     = String(r[0]).trim();
            const priceRaw = r[1] != null ? String(r[1]).trim() : '';
            const priceNum = parseFloat(priceRaw.replace(/[^0-9.\-]/g, ''));
            return { item, priceRaw, priceNum: Number.isFinite(priceNum) ? priceNum : null };
        });
}

// Reads all three city tabs in one batched call. Returns:
//   { 'Los Angeles': [{item, priceRaw, priceNum}, ...], 'Houston': [...], 'San Antonio': [...] }
// Throws if PRICE_SHEET_ID isn't configured or the sheet/tabs aren't reachable —
// caller decides whether to fail soft (webhook) or surface the error (API route).
async function readPriceSheet() {
    if (!cfg.PRICE_SHEET_ID) throw new Error('PRICE_SHEET_ID not configured');
    const sheets = getSheets();

    const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: cfg.PRICE_SHEET_ID,
        ranges: PRICE_TABS.map(t => `'${t}'!A:B`),
    });

    const out = {};
    PRICE_TABS.forEach((tab, i) => {
        out[tab] = parseRows(res.data.valueRanges[i]?.values || []);
    });
    return out;
}

module.exports = { readPriceSheet, PRICE_TABS };