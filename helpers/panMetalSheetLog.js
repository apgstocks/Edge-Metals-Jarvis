// ── helpers/panMetalSheetLog.js — Log every Pan Metal commission
// verification run into a "Pan metal" tab on the same "Edge Metals"
// Google Sheet helpers/proformaSheetLog.js already logs Proformas into ────
//
// Added per Apsara: "post comparison,create a tab called Pan metal in my
// Edge Metal sheet with a column called inv no,weight,coom/MT,commission,
// verified on with that day's date" — then, mid-build: "no duplicate on
// invoice no." That second line means: if the same Inv No. is already a
// row in this tab (e.g. she re-runs verification on the same debit note,
// or two debit notes happen to cover the same order), do NOT append a
// second row for it — skip it, same spirit as the dedupe rule already
// enforced on the Proforma tab (helpers/proformaSheetLog.js's
// bumpInvNoUntilUnique), just simpler here: this is an audit log of
// verification runs, not something that needs a bumped/renumbered ID, so
// a duplicate Inv No. is just skipped rather than renamed.
//
// Reuses the SAME "Edge Metals" spreadsheet (found/created by
// proformaSheetLog.js's getOrCreateSpreadsheetId — same Shared Drive,
// same service account) rather than creating a second spreadsheet, since
// Apsara said "in my Edge Metal sheet", singular, referring to the one
// that already exists.
//
// COLUMN MAPPING — exactly the columns Apsara named, filled from the
// actual comparison in helpers/invoiceVerify.js's crossCheckPanMetalRecords():
//   Inv No.     <- the matched sheet row's Inv No. (e.g. "260528_AC_26MT10")
//                  if this order was found on our sheet; else the raw
//                  Order No. read off the debit note (so an unmatched
//                  order still leaves a traceable row instead of a blank
//                  one), else '' if neither is available.
//   Weight      <- OUR sheet's weight for that order (the number actually
//                  used in the calculation), blank if no sheet match.
//   Comm/MT     <- the rate actually used (rate_used — OUR sheet's rate,
//                  or the debit note's own rate if OUR rate was blank).
//   Commission  <- the debit note's own stated commission dollar amount
//                  (the figure being verified).
//   Verified On <- today's server date, when this verification ran.

const { getOrCreateSpreadsheetId, getSheets, ensureTab, upsertRowsByKey } = require('./proformaSheetLog');

const TAB_NAME = 'Pan metal';
const HEADER_ROW = ['Inv No.', 'Weight', 'Comm/MT', 'Commission', 'Verified On'];

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeNum(n) {
    return (n === null || n === undefined || n === '') ? '' : n;
}

// matchedRows: the `matched` array crossCheckPanMetalRecords() returns —
// one entry per order read off the uploaded debit note, each already
// carrying its matched `sheet` row (or null) and computed rate_used.
//
// Per Apsara: "on every geerate my edge metal sheet should be updated but
// only matched rows should go.inv no is the key" — narrowed from logging
// every row (including mismatches/not-on-sheet) to ONLY status === 'match'.
// A mismatch or an unmatched order is exactly the thing she wants surfaced
// on-screen to investigate, not silently written into her sheet as if it
// were confirmed reconciled — so those never reach this tab now. Inv No.
// (from OUR sheet, since only real sheet matches get here at all) stays
// the dedupe key, same as before.
async function logPanMetalVerification(matchedRows) {
    const today = todayStr();
    const candidateRows = (matchedRows || [])
        .filter((r) => r.status === 'match')
        .map((r) => {
            const invNo = (r.sheet && r.sheet.inv_no) ? r.sheet.inv_no : '';
            return {
                invNo: (invNo || '').trim(),
                row: [
                    invNo,
                    r.sheet && r.sheet.weight != null ? r.sheet.weight : safeNum(r.weight),
                    safeNum(r.rate_used),
                    safeNum(r.commission),
                    today,
                ],
            };
        }).filter((c) => c.invNo); // nothing to key a dedupe check on without an Inv No. — skip rather than log a blank row

    if (!candidateRows.length) return { logged: 0, updated: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);

    // Per Apsara: "when we rerun verification,why it is rows/columns not
    // getting updated?" — an Inv No. already on the sheet now gets that
    // row overwritten with the latest figures, instead of silently
    // skipped forever. Inv No. is column A here.
    const candidates = candidateRows.map((c) => ({ key: c.invNo, row: c.row }));
    const { logged, updated } = await upsertRowsByKey(sheets, spreadsheetId, TAB_NAME, 'A', candidates);
    return { logged, updated, spreadsheetId };
}

module.exports = { logPanMetalVerification, TAB_NAME, HEADER_ROW };
