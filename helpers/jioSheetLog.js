// ── helpers/jioSheetLog.js — Log every successful Jio trucking-invoice
// verification into a "Jio" tab on the same "Edge Metals" Google Sheet
// helpers/proformaSheetLog.js / helpers/panMetalSheetLog.js already log
// into ───────────────────────────────────────────────────────────────────
//
// Added per Apsara: "for jio,i want a new tab to be created in edge
// metals.in that ,date(from uploaded),container,shipper,line haul,port
// fees,chassis rent,others,then net amount,last verified should be
// there... on successful verification,create rows in jio tab of edge
// metals" — "successful verification" means the container number was
// found on the Invoice sheet (helpers/invoiceVerify.js's
// crossCheckJioRecords status === 'verified'). A container that isn't on
// our sheet at all never gets a row here — same "don't write unconfirmed
// data into the sheet" rule already applied to Pan Metal
// (helpers/panMetalSheetLog.js's match-only filter).
//
// Dedup/upsert key: Container No. — same spirit as Pan Metal's "no
// duplicate on invoice no." Per Apsara: "when we rerun verification,why it
// is rows/columns not getting updated?" — a Container already on the
// sheet now gets its row overwritten with the latest figures instead of
// skipped.
//
// Column order — Invoice No. was first added trailing at the end (safest
// append-only move for a tab that may already have rows logged). Apsara's
// very next message pasted the resulting header back and pointed at
// "date,invoice no ,etc..", asking for Invoice No. to actually sit right
// after Date instead. That's a genuine reorder, not just a rename or an
// append, so — unlike everywhere else in this file's siblings that only
// ever appends — this uses proformaSheetLog.js's reorderColumnToPosition,
// which moves the WHOLE column (header + every value already logged
// beneath it) as one unit via the Sheets API's moveDimension, so no
// existing row's Invoice No. gets separated from the rest of that row.
// Self-verifying: if the column doesn't land exactly where expected, it
// throws rather than silently letting this file start writing new rows in
// an order that no longer matches the sheet's real layout — a thrown error
// here fails logJioVerification, which api.js already catches without
// failing the verification response itself (surfaces as a "Sheet log
// failed" chip instead of a silent misalignment).
const {
    getOrCreateSpreadsheetId, getSheets, ensureTab, upsertRowsByKey, reorderColumnToPosition,
} = require('./proformaSheetLog');

const TAB_NAME = 'Jio';
const HEADER_ROW = ['Date', 'Invoice No.', 'Container', 'Shipper', 'Line Haul', 'Port Fees', 'Chassis Rent', 'Others', 'Net Amount', 'Last Verified'];

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeNum(n) {
    return (n === null || n === undefined || n === '') ? '' : n;
}

// matchedRows: the `matched` array crossCheckJioRecords() returns — only
// status === 'verified' rows (container confirmed on our sheet) get logged.
async function logJioVerification(matchedRows) {
    const today = todayStr();
    const candidateRows = (matchedRows || [])
        .filter((r) => r.status === 'verified')
        .map((r) => ({
            container: (r.container_no || '').trim().toUpperCase(),
            row: [
                r.invoice_date || '',
                r.invoice_no || '',
                r.container_no || '',
                r.shipper || '',
                safeNum(r.line_haul),
                safeNum(r.port_fees),
                safeNum(r.chassis_rent),
                safeNum(r.others),
                safeNum(r.net_amount),
                today,
            ],
        }))
        .filter((c) => c.container); // nothing to key a dedupe check on without a container — skip rather than log a blank row

    if (!candidateRows.length) return { logged: 0, updated: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);
    // Runs AFTER ensureTab so the tab/header definitely exists first; a
    // no-op every time after the first successful move since Invoice No.
    // is already at index 1 afterward.
    await reorderColumnToPosition(sheets, spreadsheetId, TAB_NAME, 'Invoice No.', 1);

    // Container is column C now (was B before Invoice No. moved to B).
    const candidates = candidateRows.map((c) => ({ key: c.container, row: c.row }));
    const { logged, updated } = await upsertRowsByKey(
        sheets, spreadsheetId, TAB_NAME, 'C', candidates,
        (v) => (v || '').trim().toUpperCase(), // match the same case-insensitive Container key used above
    );
    return { logged, updated, spreadsheetId };
}

module.exports = { logJioVerification, TAB_NAME, HEADER_ROW };
