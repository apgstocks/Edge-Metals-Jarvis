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

const { getOrCreateSpreadsheetId, getSheets, ensureTab } = require('./proformaSheetLog');

const TAB_NAME = 'Jio';
const HEADER_ROW = ['Date', 'Container', 'Shipper', 'Line Haul', 'Port Fees', 'Chassis Rent', 'Others', 'Net Amount', 'Last Verified'];

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function safeNum(n) {
    return (n === null || n === undefined || n === '') ? '' : n;
}

// Reads every existing "Container" (column B) already in the Jio tab.
async function getExistingContainers(sheets, spreadsheetId) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!B2:B` });
    const values = res.data.values || [];
    return new Set(values.map((r) => (r[0] || '').trim().toUpperCase()).filter(Boolean));
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
            ],
        }))
        .filter((c) => c.container); // nothing to key a dedupe check on without a container — skip rather than log a blank row

    if (!candidateRows.length) return { logged: 0, skipped_duplicates: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);

    const existing = await getExistingContainers(sheets, spreadsheetId);
    const rows = [];
    let skipped = 0;
    for (const c of candidateRows) {
        if (existing.has(c.container)) { skipped++; continue; }
        rows.push(c.row);
        existing.add(c.container); // also guards against duplicates WITHIN this same batch
    }

    if (!rows.length) return { logged: 0, skipped_duplicates: skipped, spreadsheetId };

    await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${TAB_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
    return { logged: rows.length, skipped_duplicates: skipped, spreadsheetId };
}

module.exports = { logJioVerification, TAB_NAME, HEADER_ROW };
