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
// no,terms,proforma date inv price"), plus two later additions (Customer,
// Item Description). Every other column (Inv Date, Container No., HBL/
// Booking/Seal No., Supplier, Reference, Weight, INVOICE AMT, Commissions,
// RECEIVED AMT, Received Date, Freight Charge, Freight, ETA) is left
// blank — not guessed at, not computed:
//   Consignee        <- the full address-book tag as matched (e.g.
//                        "Joey/Taewon"), NOT the split "Taewon" that goes
//                        on the actual PDF — matches how the real sheet
//                        already uses this column (confirmed against live
//                        data: plain customers like "Rad Metal" appear
//                        identically there, but Joey's rows show
//                        "Joey/Taewon" specifically in this column).
//   Inv No.           <- "<inv_date as YYMMDD>_<this container's code>" —
//                        the code that's now auto-filled into each
//                        container's "Container #" box (which itself may
//                        already carry an item-code segment, e.g.
//                        "AC_26JY01" — see dashboard/documents.html's
//                        deriveItemCode()), joined with an underscore to
//                        match Apsara's real format:
//                        "260819_AC_26JY19" ([date]_[item]_[year][agent
//                        code][number]). This matches the real sheet's
//                        per-row numbering exactly (one running number per
//                        container), not one shared invoice number.
//   Terms             <- payload.trade_terms
//   Customer           <- first line of the buyer/consignee address block
//                        (the company name shown on the PDF) — per
//                        Apsara's explicit request; matches how this
//                        column is already used in the real Invoice sheet
//                        (company names like "TAEWON AUTOMOTIVE CO., LTD").
//   Proforma Date     <- today (server date, when the row is logged)
//   Item Description  <- exactly what was typed into that item's
//                        description box on the proforma — the same text
//                        deriveItemCode() reads client-side to pick the
//                        Inv No.'s item-code segment, logged here as-is
//                        (not the 2-letter code).
//   Inv price         <- this line item's rate
//
// Apsara: if any of this mapping is wrong for how you actually use these
// columns, tell me which one and I'll fix it — better to correct one
// specific column than have me guess and quietly log something wrong into
// a sheet you're relying on.

const cfg = require('../config');
const fs  = require('fs');
const { parseInvNoToken } = require('./nextInvoiceNo');

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

// Reads every existing "Inv No." (column B) already in the Proforma tab —
// used to keep this sheet duplicate-free. Apsara: "there should not be any
// duplicate invoice number in excel sheet edge metals".
async function getExistingInvNos(sheets, spreadsheetId) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!B2:B` });
    const values = res.data.values || [];
    return new Set(values.map((r) => (r[0] || '').trim()).filter(Boolean));
}

// If invNo is already in `existing`, bumps its trailing number (reusing
// the SAME "<year><code><number>" parsing helpers/nextInvoiceNo.js already
// uses for suggesting numbers) until it lands on one that isn't — mutating
// nothing, just returning the number actually safe to log. This is a
// SAFETY NET, not the primary mechanism: helpers/nextInvoiceNo.js already
// tries to hand out a genuinely-unused number up front. This only kicks in
// for genuine collisions — e.g. the same proforma regenerated twice, two
// browser sessions grabbing the same "next" number, or someone typing a
// Container # that happens to already exist in the sheet.
//
// Everything before the LAST space/underscore-separated token is kept as
// the prefix, exactly as given — this now has to survive BOTH the older
// "YYMMDD CODE" (space) shape AND the current "YYMMDD_ITEM_CODE"
// (underscore, e.g. "260819_AC_26JY19") shape, since bumping only the
// trailing running number must never drop the date or item-code segment.
function bumpInvNoUntilUnique(invNo, existing) {
    if (!invNo || !existing.has(invNo)) return invNo;
    const m = /^(.*[\s_])?([^\s_]+)$/.exec(invNo);
    const prefix = m && m[1] ? m[1] : ''; // includes its own trailing separator char, if any
    const codePart = m ? m[2] : invNo;
    const parsed = parseInvNoToken(codePart);

    let candidate = invNo;
    let guard = 0;
    if (parsed) {
        let n = parsed.number;
        while (existing.has(candidate) && guard < 500) {
            n += 1;
            guard += 1;
            const numStr = parsed.numberHadLeadingZero ? String(n).padStart(parsed.numberDigits, '0') : String(n);
            const newCode = `${parsed.yearPrefix}${parsed.code}${numStr}${parsed.suffix}`;
            candidate = `${prefix}${newCode}`;
        }
    } else {
        // Doesn't match the expected code shape — never silently let a
        // duplicate through anyway, just suffix it instead.
        let n = 2;
        while (existing.has(candidate) && guard < 500) {
            candidate = `${invNo}-${n}`;
            n += 1;
            guard += 1;
        }
    }
    return candidate;
}

// body: the same payload POSTed to /api/proforma/generate — see the column
// mapping notes at the top of this file for exactly where each value goes.
async function logProformaToSheet(body) {
    const consignee = (body.consignee_sheet_tag || body.consignee || '').trim();
    const terms = (body.trade_terms || '').trim();
    const proformaDate = todayStr();
    const invDateCompact = (body.inv_date || '').replace(/-/g, '').slice(2); // "2026-08-19" -> "260819"

    // Company name shown on the actual PDF — first line of the buyer/
    // consignee address block (dashboard/documents.html's payload sends
    // this as `consignee_address`, one entry per line, first line always
    // the name per that field's own placeholder text).
    const customerName = Array.isArray(body.consignee_address) && body.consignee_address[0]
        ? String(body.consignee_address[0]).trim() : '';

    // Column order per HEADER_ROW above. Only indices 0 (Consignee), 1 (Inv
    // No.), 8 (Terms), 9 (Customer), 10 (Proforma Date), 14 (Inv price) are
    // ever populated — everything else stays '' per Apsara's explicit
    // scoping.
    const blankRow = () => Array(HEADER_ROW.length).fill('');

    const rows = [];
    for (const container of (body.containers || [])) {
        const containerCode = (container.container_no || '').trim();
        // Underscore-joined per Apsara's real format ("260819_AC_26JY19"),
        // not space-joined — containerCode itself may already carry its own
        // item-code segment (e.g. "AC_26JY01") from the client.
        const invNo = containerCode ? `${invDateCompact}_${containerCode}`.trim() : (body.inv_no || '');
        for (const item of (container.items || [])) {
            const rate = Number(item.rate) || 0;
            const desc = (item.desc || '').trim();
            const row = blankRow();
            row[0] = consignee;
            row[1] = invNo;
            row[8] = terms;
            row[9] = customerName;
            row[10] = proformaDate;
            row[12] = desc;
            row[14] = rate || '';
            rows.push(row);
        }
    }
    if (!rows.length) return { logged: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();

    const existing = await getExistingInvNos(sheets, spreadsheetId);
    const duplicatesBumped = [];
    for (const row of rows) {
        const original = row[1];
        const unique = bumpInvNoUntilUnique(original, existing);
        if (unique !== original) {
            duplicatesBumped.push({ was: original, now: unique });
            console.warn(`[proforma] Edge Metals sheet: Inv No. "${original}" already existed — logged as "${unique}" instead`);
        }
        row[1] = unique;
        existing.add(unique); // also guards against duplicates WITHIN this same batch
    }

    await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${TAB_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
    return { logged: rows.length, spreadsheetId, duplicates_bumped: duplicatesBumped };
}

module.exports = { logProformaToSheet, HEADER_ROW, SHEET_FILE_NAME, TAB_NAME };
