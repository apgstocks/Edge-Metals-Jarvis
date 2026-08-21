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
// Dedup key: Container No. — same spirit as Pan Metal's "no duplicate on
// invoice no" (Apsara hasn't said this explicitly for Jio, but a container
// is the natural unique key here, and re-running verification on an
// invoice already logged shouldn't create a second row for it).

const { getOrCreateSpreadsheetId, getSheets, ensureTab, upsertRowsByKey } = require('./proformaSheetLog');

const TAB_NAME = 'Jio';
// "Invoice No." appended AFTER Last Verified (not inserted near Date),
// same "never insert/reorder an already-logged tab's columns" rule used
// for AJ Transport's Others/Dry Run/Extra Scale — this tab may already
// have rows logged under the original 9-column header on Apsara's live
// sheet. The invoice number was already being extracted off every Jio PDF
// (see gemini.js's extractJioInvoiceRecords — "invoice_no") and passed
// through crossCheckJioRecords, it just wasn't logged to the sheet yet;
// added per Apsara's follow-up after the AJ Transport work: "in jio,add
// date,invoice no,... etc" — clarified to just add Invoice No., since Date
// and the rest already exist.
const HEADER_ROW = ['Date', 'Container', 'Shipper', 'Line Haul', 'Port Fees', 'Chassis Rent', 'Others', 'Net Amount', 'Last Verified', 'Invoice No.'];

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
                r.container_no || '',
                r.shipper || '',
                safeNum(r.line_haul),
                safeNum(r.port_fees),
                safeNum(r.chassis_rent),
                safeNum(r.others),
                safeNum(r.net_amount),
                today,
                r.invoice_no || '',
            ],
        }))
        .filter((c) => c.container); // nothing to key a dedupe check on without a container — skip rather than log a blank row

    if (!candidateRows.length) return { logged: 0, updated: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);

    // Per Apsara: "when we rerun verification,why it is rows/columns not
    // getting updated?" — a Container already on the sheet now gets its
    // row overwritten with the latest figures instead of skipped. Container
    // is column B here.
    const candidates = candidateRows.map((c) => ({ key: c.container, row: c.row }));
    const { logged, updated } = await upsertRowsByKey(
        sheets, spreadsheetId, TAB_NAME, 'B', candidates,
        (v) => (v || '').trim().toUpperCase(), // match the same case-insensitive Container key used above
    );
    return { logged, updated, spreadsheetId };
}

module.exports = { logJioVerification, TAB_NAME, HEADER_ROW };
