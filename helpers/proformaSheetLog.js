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

// Delegates to the generic ensureTab below (same logic this function used
// to inline itself, now shared) — kept as its own named function since
// getOrCreateSpreadsheetId() below already calls it by name, and other
// files may too. Behavior is unchanged: create-or-find the Proforma tab,
// write its header if blank. ensureTab additionally applies header
// formatting (bold/shaded/frozen row) — see that function's comment.
async function ensureProformaTab(sheets, spreadsheetId) {
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);
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

// 1-based column index -> spreadsheet column letters (1 -> "A", 26 -> "Z",
// 27 -> "AA", ...). Used by ensureTab's header-backfill path below to know
// where to start writing newly-added trailing columns without touching
// what's already there.
function columnLetter(n) {
    let s = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

// Generic version of ensureProformaTab's create-tab-if-missing /
// write-header-if-blank logic, extracted so OTHER logging modules that
// share this same "Edge Metals" spreadsheet (e.g. helpers/panMetalSheetLog.js)
// don't have to duplicate the Sheets API calls. ensureProformaTab itself is
// left untouched above — this is purely additive, nothing about the
// existing Proforma logging path changed.
async function ensureTab(sheets, spreadsheetId, tabName, headerRow) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const sheetsList = meta.data.sheets || [];
    const tab = sheetsList.find((s) => s.properties.title === tabName);
    let sheetId = tab ? tab.properties.sheetId : null;

    if (!tab) {
        if (sheetsList.length === 1 && sheetsList[0].properties.title === 'Sheet1') {
            // Freshly-created spreadsheet's untouched default tab — rename
            // rather than leave a stray "Sheet1" around.
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{
                    updateSheetProperties: {
                        properties: { sheetId: sheetsList[0].properties.sheetId, title: tabName },
                        fields: 'title',
                    },
                }] },
            });
            sheetId = sheetsList[0].properties.sheetId;
        } else {
            const created = await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
            });
            sheetId = created.data.replies[0].addSheet.properties.sheetId;
        }
    }

    const headerCheck = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1:Z1` });
    const existingHeader = (headerCheck.data.values && headerCheck.data.values[0]) || [];
    if (!existingHeader.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId, range: `${tabName}!A1`, valueInputOption: 'RAW',
            requestBody: { values: [headerRow] },
        });
    } else if (existingHeader.length < headerRow.length) {
        // A tab whose header was already written (rows may already be logged
        // under it) later got new trailing columns added to its schema in
        // code — e.g. AJ Transport's "Others" column, added per Apsara after
        // she'd already been running verifications. Backfill ONLY the
        // missing trailing header cells, starting right after the last
        // existing one — never touch or reorder what's already there, since
        // that would misalign every row already logged under the old header.
        const missingLabels = headerRow.slice(existingHeader.length);
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${tabName}!${columnLetter(existingHeader.length + 1)}1`,
            valueInputOption: 'RAW',
            requestBody: { values: [missingLabels] },
        });
    }

    // Header formatting — bold text, a shaded background, and the header
    // row frozen so it stays visible while scrolling. Per Apsara: "headers
    // in tab should be differentiated in my edge metals sheet." Applied on
    // EVERY call, not just when the tab/header is first created, so it
    // reaches tabs that already existed before this was added (Proforma,
    // Pan metal, Jio, Sher) — not just brand-new ones. Cheap and
    // idempotent: re-applying the same formatting to an already-formatted
    // header is a no-op in effect.
    if (sheetId != null) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [
                {
                    repeatCell: {
                        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 0.85, green: 0.89, blue: 0.95 },
                                textFormat: { bold: true },
                            },
                        },
                        fields: 'userEnteredFormat(backgroundColor,textFormat)',
                    },
                },
                {
                    updateSheetProperties: {
                        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                        fields: 'gridProperties.frozenRowCount',
                    },
                },
            ] },
        });
    }
}

// Physically moves an existing column (header cell AND every data value
// beneath it, as one unit) to a new position — used when Apsara wants a
// column's ORDER changed, not just relabeled or appended. Per her Jio
// follow-up (column list ending "...Invoice No." followed by "--> date,
// invoice no ,etc.." — read as: Invoice No. should sit right after Date,
// not trailing at the end where it got appended): unlike
// renameHeaderCellIfMatches (label only) or ensureTab's trailing backfill
// (append only), this uses the Sheets API's moveDimension request, which
// carries a column's data along with it — nothing gets separated from the
// row it belongs to, unlike a naive "read everything, rewrite in new
// order" approach would risk.
//
// Guarded and self-verifying: does nothing if the column's already in the
// right spot; after moving, re-reads the header and throws if it doesn't
// land exactly where expected, rather than letting the caller silently
// start writing new rows in an order that no longer matches the sheet's
// real layout.
async function reorderColumnToPosition(sheets, spreadsheetId, tabName, columnLabel, desiredIndex0Based) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const tab = (meta.data.sheets || []).find((s) => s.properties.title === tabName);
    if (!tab) return { moved: false, reason: 'tab not found' };
    const sheetId = tab.properties.sheetId;

    const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1:Z1` });
    const header = (headerRes.data.values && headerRes.data.values[0]) || [];
    const currentIndex = header.indexOf(columnLabel);
    if (currentIndex === -1) return { moved: false, reason: 'column not found', header };
    if (currentIndex === desiredIndex0Based) return { moved: false, reason: 'already in position' };

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{
            moveDimension: {
                source: { sheetId, dimension: 'COLUMNS', startIndex: currentIndex, endIndex: currentIndex + 1 },
                destinationIndex: desiredIndex0Based,
            },
        }] },
    });

    const verifyRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1:Z1` });
    const newHeader = (verifyRes.data.values && verifyRes.data.values[0]) || [];
    if (newHeader[desiredIndex0Based] !== columnLabel) {
        throw new Error(
            `reorderColumnToPosition: moved "${columnLabel}" on "${tabName}" but it landed at index ${newHeader.indexOf(columnLabel)}, `
            + `not the expected ${desiredIndex0Based} — header is now [${newHeader.join(', ')}]. Stopping rather than writing rows `
            + `in an order that may no longer match the sheet.`
        );
    }
    return { moved: true, header: newHeader };
}

// A deliberate, narrow exception to ensureTab's "never touch an existing
// header cell" rule above — for the rare case a column needs relabeling
// in place, not just a new trailing column appended. Per Apsara's AJ
// Transport column list ("...Rate, Line Haul, Others, Dry Run, Extra
// Scale, Total amount"): the column that used to say "Amount" is now
// "Line Haul" — same column, same underlying figures, purely a label
// change, so unlike inserting/reordering a column this can't misalign any
// row already logged under it. Still guarded: only fires if the cell
// currently holds EXACTLY `expectedOldLabel` — if it holds anything else
// (already renamed, or something unexpected), it's left untouched and
// `renamed: false` comes back so the caller can decide whether that's
// worth surfacing, rather than this silently overwriting a cell that
// might not be what the caller assumed it was.
async function renameHeaderCellIfMatches(sheets, spreadsheetId, tabName, colLetter, expectedOldLabel, newLabel) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!${colLetter}1` });
    const current = (res.data.values && res.data.values[0] && res.data.values[0][0]) || '';
    if (current !== expectedOldLabel) return { renamed: false, current };
    await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${tabName}!${colLetter}1`, valueInputOption: 'RAW',
        requestBody: { values: [[newLabel]] },
    });
    return { renamed: true, current: newLabel };
}

// Per Apsara ("see only header should be in bold and colour" — reported
// against a real screenshot where every data row in the AJ Transport tab
// had picked up the header's bold+shaded look, not just row 1): the header
// formatting above is scoped to row 1 ONLY (startRowIndex:0, endRowIndex:1
// — never touches row 2 onward), so that's not where it comes from.
// Google Sheets itself carries a formatted row's style onto NEW rows
// inserted directly adjacent to it (both the UI and the API's
// insertDataOption:'INSERT_ROWS' do this) — since every data row gets
// inserted right below either the bold header or another already-bled row,
// the formatting cascades down the whole tab over successive verification
// runs even though the code never asked for that. Fix: explicitly reset
// (not just leave alone) the formatting on every row this code just wrote
// — both freshly appended ones and ones overwritten in place by
// upsertRowsByKey below — back to plain/default right after writing it.
// rowRanges: array of [startRow1Indexed, endRow1IndexedInclusive].
async function clearRowFormatting(sheets, spreadsheetId, tabName, rowRanges) {
    if (!rowRanges.length) return;
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const tab = (meta.data.sheets || []).find((s) => s.properties.title === tabName);
    if (!tab) return; // tab vanished between write and here — nothing to clean up
    const sheetId = tab.properties.sheetId;
    const requests = rowRanges.map(([start, end]) => ({
        repeatCell: {
            range: { sheetId, startRowIndex: start - 1, endRowIndex: end },
            cell: { userEnteredFormat: {} },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
    }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// Shared by the verification-log modules (Pan Metal, Jio, Sher, AJ
// Transport) — NOT used by Proforma logging above, which has its own
// deliberately different dedupe rule (bump a colliding Inv No. to a new
// unique one, since that's a running per-container-item ledger, not an
// audit log keyed on one natural key per row).
//
// Per Apsara: "When we rerun verification,why it is rows/columns not
// getting updated?" — every verification tab used to SKIP a row whose key
// (Inv No./Container/Booking No.) was already logged, so re-running
// verification on something already in the sheet (e.g. after a real
// correction, or after a schema change added a new column like AJ
// Transport's Others) never refreshed it. This replaces skip-on-duplicate
// with update-in-place: a key that's already on the sheet gets that exact
// row overwritten with the latest verification result; a new key gets
// appended as before. `candidates` is `[{ key, row }]` — key already
// normalized by the caller (trim-only for Pan Metal's Inv No., trim+
// uppercase for the container/booking-keyed tabs) so this doesn't
// second-guess each tab's existing normalization. Same-key collisions
// WITHIN one batch (e.g. the same container appearing twice on one PDF)
// collapse to the LAST occurrence before writing, so one call never emits
// two conflicting writes for the same key.
//
// normalizeSheetValue: applied to whatever's already written in the sheet's
// key column before comparing against `candidates`' keys — MUST match
// however the caller normalized its own keys (default trim-only, matching
// Pan Metal; container/booking-keyed tabs pass a trim+uppercase version),
// otherwise e.g. a lowercase-typed container already on the sheet would
// never be recognized as the same key and would get double-logged instead
// of updated.
async function upsertRowsByKey(sheets, spreadsheetId, tabName, keyColLetter, candidates, normalizeSheetValue) {
    if (!candidates.length) return { logged: 0, updated: 0 };
    const normalize = normalizeSheetValue || ((v) => (v || '').trim());

    const byKey = new Map();
    for (const c of candidates) byKey.set(c.key, c.row);
    const deduped = [...byKey.entries()].map(([key, row]) => ({ key, row }));

    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!${keyColLetter}2:${keyColLetter}` });
    const values = res.data.values || [];
    const rowNumberByKey = new Map();
    values.forEach((r, i) => {
        const k = normalize(r[0]);
        // First occurrence wins if a key somehow appears twice already on
        // the sheet (shouldn't happen going forward, but a row from before
        // this dedupe existed could) — never guess which of two existing
        // rows is "the real one".
        if (k && !rowNumberByKey.has(k)) rowNumberByKey.set(k, i + 2); // +2: 1-based rows, plus the header row
    });

    const toAppend = [];
    const updateData = [];
    const updatedRowNumbers = [];
    for (const c of deduped) {
        const existingRowNum = rowNumberByKey.get(c.key);
        if (existingRowNum) {
            const lastCol = columnLetter(c.row.length);
            updateData.push({ range: `${tabName}!A${existingRowNum}:${lastCol}${existingRowNum}`, values: [c.row] });
            updatedRowNumbers.push(existingRowNum);
        } else {
            toAppend.push(c.row);
        }
    }

    if (updateData.length) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: 'USER_ENTERED', data: updateData },
        });
    }

    const clearRanges = updatedRowNumbers.map((n) => [n, n]);
    if (toAppend.length) {
        const appendRes = await sheets.spreadsheets.values.append({
            spreadsheetId, range: `${tabName}!A:A`,
            valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
            requestBody: { values: toAppend },
        });
        // updatedRange looks like "'AJ Transport'!A7:L11" — pull the row
        // span so ONLY the rows actually just written get their formatting
        // reset, nothing above or below.
        const updatedRange = appendRes.data.updates && appendRes.data.updates.updatedRange;
        const m = updatedRange && updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)/);
        if (m) clearRanges.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
    }
    // See clearRowFormatting's comment above: Sheets bleeds the header's
    // bold+shaded look onto newly-inserted adjacent rows on its own — reset
    // every row this call just touched back to plain, every time.
    await clearRowFormatting(sheets, spreadsheetId, tabName, clearRanges);

    // rowRanges: every row number this call actually wrote to (both
    // overwritten-in-place and freshly appended), as [start,end] pairs —
    // handed back so a caller that needs to do its own row-specific
    // follow-up (e.g. AJ Transport writing a live SUM formula into a cell
    // whose row number wasn't known until the append actually happened)
    // doesn't have to re-derive it.
    return { logged: toAppend.length, updated: updateData.length, rowRanges: clearRanges };
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

    const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${TAB_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
    // Same header-bleed fix as upsertRowsByKey (see clearRowFormatting's
    // comment) — Proforma's own append path doesn't go through that shared
    // function, so it needs this call too, or its new rows would pick up
    // the header's bold+shaded look exactly the way AJ Transport's did.
    const updatedRange = appendRes.data.updates && appendRes.data.updates.updatedRange;
    const m = updatedRange && updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)/);
    if (m) await clearRowFormatting(sheets, spreadsheetId, TAB_NAME, [[parseInt(m[1], 10), parseInt(m[2], 10)]]);

    return { logged: rows.length, spreadsheetId, duplicates_bumped: duplicatesBumped };
}

module.exports = {
    logProformaToSheet, HEADER_ROW, SHEET_FILE_NAME, TAB_NAME,
    getOrCreateSpreadsheetId, getSheets, ensureTab, upsertRowsByKey, renameHeaderCellIfMatches, clearRowFormatting,
    reorderColumnToPosition,
};
