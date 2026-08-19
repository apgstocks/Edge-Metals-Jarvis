// ── helpers/proformaSheetLog.js — Log every generated Proforma into a
// dedicated "Edge Metals" Google Sheet ────────────────────────────────────
// Added per Apsara: "once proforma generated.i want a new sheet called
// Edge Metals should be generated first time then in first tab named
// proforma,i want proforma should be placed columnwise [...]" — the column
// list she gave is an EXACT match for the header row of the existing
// Invoice Google Sheet (cfg.INVOICE_SHEET_ID, already read by
// helpers/nextInvoiceNo.js) — confirmed by fetching that real sheet's
// header row, not assumed from memory.
//
// This creates a SEPARATE, NEW spreadsheet (not the existing Invoice
// sheet) named "Edge Metals", with a first tab named "Proforma", inside
// the SAME Shared Drive booking PDFs already live in (cfg.GDRIVE_FOLDER_ID)
// — created via the Drive API directly, NOT sheets.spreadsheets.create().
// A service account has ZERO personal Drive storage quota; parenting the
// new file straight into the Shared Drive at creation time sidesteps that
// entirely — same reasoning already documented in helpers/drive.js for
// booking PDFs. If this spreadsheet already exists (e.g. a prior proforma
// already created it), it's found and reused, never re-created.
//
// GRAIN: one row per (container × item) in a generated proforma, matching
// the real Invoice sheet's own grain — confirmed there: multiple
// containers under one shipment show up as separate consecutive rows
// (e.g. 25JY84 / 85 / 86 / 87 / 88), not one row per proforma.
//
// COLUMN MAPPING — per Apsara's explicit follow-up ("Fill consignee,inv
// no,terms,proforma date inv price"), ONLY these five columns are
// populated. Every other column (Inv Date, Container No., HBL/Booking/Seal
// No., Supplier, Customer, Reference, Item Description, Weight, INVOICE
// AMT, Commissions, RECEIVED AMT, Received Date, Freight Charge, Freight,
// ETA) is left blank — not guessed at, not computed:
//   Consignee        <- the full address-book tag as matched (e.g.
//                        "Joey/Taewon"), NOT the split "Taewon" that goes
//                        on the actual PDF — matches how the real sheet
//                        already uses this column (confirmed against live
//                        data: plain customers like "Rad Metal" appear
//                        identically there, but Joey's rows show
//                        "Joey/Taewon" specifically in this column).
//   Inv No.           <- "<inv_date as YYMMDD> <this container's code>" —
//                        the code that's now auto-filled into each
//                        container's "Container #" box per Apsara's prior
//                        request. This matches the real sheet's per-row
//                        numbering exactly (one running number per
//                        container), not one shared invoice number.
//   Terms             <- payload.trade_terms
//   Proforma Date     <- today (server date, when the row is logged)
//   Inv price         <- this line item's rate
//
// Apsara: if any of this mapping is wrong for how you actually use these
// columns, tell me which one and I'll fix it — better to correct one
// specific column than have me guess and quietly log something wrong into
// a sheet you're relying on.

const cfg = require('../config');
const fs  = require('fs');

const SHEET_FILE_NAME = 'Edge Metals';
const TAB_NAME = 'Proforma';
const HEADER_ROW = [
    'Consignee', 'Inv No.', 'Inv Date', 'HBL  No.', 'Booking  No.', 'Container No.',
    'Seal No.', 'Supplier', 'Terms', 'Customer', 'Proforma Date', 'Reference',
    'Item Description', 'Weight', 'Inv price', 'Commissions', '', 'INVOICE AMT',
    'RECEIVED AMT', 'Received Date', 'Freight Charge', 'Freight', ' ', 'COMMISSIONS', '', 'ETA',
];

let sheetsClient = null;
let driveClient = null;

function getAuth(scopes) {
    if (!fs.existsSync(cfg.GDRIVE_KEYFILE)) throw new Error(`Service account keyfile missing: ${cfg.GDRIVE_KEYFILE}`);
    const { google } = require('googleapis');
    return new google.auth.GoogleAuth({ keyFile: cfg.GDRIVE_KEYFILE, scopes });
}
function getSheets() {
    if (sheetsClient) return sheetsClient;
    const { google } = require('googleapis');
    sheetsClient = google.sheets({ version: 'v4', auth: getAuth(['https://www.googleapis.com/auth/spreadsheets']) });
    return sheetsClient;
}
function getDrive() {
    if (driveClient) return driveClient;
    const { google } = require('googleapis');
    driveClient = google.drive({ version: 'v3', auth: getAuth(['https://www.googleapis.com/auth/drive']) });
    return driveClient;
}

let cachedSpreadsheetId = null; // resolved once per process, same lifetime pattern as helpers/sheets.js's client cache

async function findExistingSheet(drive) {
    if (!cfg.GDRIVE_FOLDER_ID) throw new Error('GDRIVE_FOLDER_ID not configured');
    const q = [
        `name = '${SHEET_FILE_NAME}'`,
        `mimeType = 'application/vnd.google-apps.spreadsheet'`,
        'trashed = false',
    ].join(' and ');
    const res = await drive.files.list({
        q, fields: 'files(id, name)', pageSize: 5,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
        corpora: 'drive', driveId: cfg.GDRIVE_FOLDER_ID,
    });
    return res.data.files?.[0]?.id || null;
}

async function createSheet(drive) {
    const res = await drive.files.create({
        requestBody: {
            name: SHEET_FILE_NAME,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: [cfg.GDRIVE_FOLDER_ID],
        },
        fields: 'id',
        supportsAllDrives: true,
    });
    return res.data.id;
}

async function ensureProformaTab(sheets, spreadsheetId) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const sheetsList = meta.data.sheets || [];
    const tab = sheetsList.find((s) => s.properties.title === TAB_NAME);

    if (!tab) {
        if (sheetsList.length === 1) {
            // Freshly-created spreadsheet has exactly one default tab
            // ("Sheet1") — rename it in place rather than leaving a stray
            // extra tab around.
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{
                    updateSheetProperties: {
                        properties: { sheetId: sheetsList[0].properties.sheetId, title: TAB_NAME },
                        fields: 'title',
                    },
                }] },
            });
        } else {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
            });
        }
    }

    // Only write the header row if row 1 is currently empty — never
    // clobber a header that's already there (e.g. if Apsara edits it by
    // hand later).
    const headerCheck = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!A1:Z1` });
    if (!headerCheck.data.values || !headerCheck.data.values.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId, range: `${TAB_NAME}!A1`, valueInputOption: 'RAW',
            requestBody: { values: [HEADER_ROW] },
        });
    }
}

async function getOrCreateSpreadsheetId() {
    if (cachedSpreadsheetId) return cachedSpreadsheetId;
    const drive = getDrive();
    let id = await findExistingSheet(drive);
    if (!id) id = await createSheet(drive);
    await ensureProformaTab(getSheets(), id);
    cachedSpreadsheetId = id;
    return id;
}

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// body: the same payload POSTed to /api/proforma/generate — see the column
// mapping notes at the top of this file for exactly where each value goes.
async function logProformaToSheet(body) {
    const consignee = (body.consignee_sheet_tag || body.consignee || '').trim();
    const terms = (body.trade_terms || '').trim();
    const proformaDate = todayStr();
    const invDateCompact = (body.inv_date || '').replace(/-/g, '').slice(2); // "2026-08-19" -> "260819"

    // Column order per HEADER_ROW above. Only indices 0 (Consignee), 1 (Inv
    // No.), 8 (Terms), 10 (Proforma Date), 14 (Inv price) are ever
    // populated — everything else stays '' per Apsara's explicit scoping.
    const blankRow = () => Array(HEADER_ROW.length).fill('');

    const rows = [];
    for (const container of (body.containers || [])) {
        const containerCode = (container.container_no || '').trim();
        const invNo = containerCode ? `${invDateCompact} ${containerCode}`.trim() : (body.inv_no || '');
        for (const item of (container.items || [])) {
            const rate = Number(item.rate) || 0;
            const row = blankRow();
            row[0] = consignee;
            row[1] = invNo;
            row[8] = terms;
            row[10] = proformaDate;
            row[14] = rate || '';
            rows.push(row);
        }
    }
    if (!rows.length) return { logged: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${TAB_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
    return { logged: rows.length, spreadsheetId };
}

module.exports = { logProformaToSheet, HEADER_ROW, SHEET_FILE_NAME, TAB_NAME };
