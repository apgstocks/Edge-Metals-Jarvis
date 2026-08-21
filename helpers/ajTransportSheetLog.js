// ── helpers/ajTransportSheetLog.js — Log every successful AJ Transport
// verification into an "AJ Transport" tab on the same "Edge Metals" Google
// Sheet the other verification tabs log into ─────────────────────────────
//
// Added per Apsara: "Similarly for AJ Transport invoice date,invoice
// no,container no,booking no,shipper,pickup date,rate,amount in new tab
// called AJ Transport." Only status === 'verified' rows
// (helpers/invoiceVerify.js's crossCheckAjTransportRecords — container
// found on our sheet AND its booking no. matches what's on file) ever
// reach here; a booking mismatch is exactly the error she wants surfaced
// on-screen, never silently written as if confirmed correct.
//
// Dedup key: Container No. — same "don't duplicate an already-logged row"
// rule as Jio (container) and Pan Metal (Inv No.).

const { getOrCreateSpreadsheetId, getSheets, ensureTab } = require('./proformaSheetLog');

const TAB_NAME = 'AJ Transport';
// "Others" appended AFTER Amount (not inserted before it) — this tab may
// already have rows logged under the original 8-column header on
// Apsara's live sheet, and ensureTab() never rewrites an existing header
// row; inserting a column in the middle would misalign every row already
// there. Appending at the end is additive-only: already-logged rows are
// untouched, new rows just start populating column I too. Added per
// Apsara: "why DRY RUN CHARGE and CHARGE FOR EXTRA SCALE both are not
// there" — these are non-container charges on the invoice, attributed to
// the container line above them (see helpers/gemini.js).
const HEADER_ROW = ['Invoice Date', 'Invoice No.', 'Container No.', 'Booking No.', 'Shipper', 'Pickup Date', 'Rate', 'Amount', 'Others'];

function safeNum(n) {
    return (n === null || n === undefined || n === '') ? '' : n;
}

// Reads every existing "Container No." (column C) already in the AJ
// Transport tab.
async function getExistingContainers(sheets, spreadsheetId) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!C2:C` });
    const values = res.data.values || [];
    return new Set(values.map((r) => (r[0] || '').trim().toUpperCase()).filter(Boolean));
}

// matchedRows: the `matched` array crossCheckAjTransportRecords() returns
// — only status === 'verified' rows get logged.
async function logAjTransportVerification(matchedRows) {
    const candidateRows = (matchedRows || [])
        .filter((r) => r.status === 'verified')
        .map((r) => ({
            container: (r.container_no || '').trim().toUpperCase(),
            row: [
                r.invoice_date || '',
                r.invoice_no || '',
                r.container_no || '',
                r.booking_no || '',
                r.shipper || '',
                r.pickup_date || '',
                safeNum(r.rate),
                safeNum(r.amount),
                safeNum(r.others),
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

module.exports = { logAjTransportVerification, TAB_NAME, HEADER_ROW };
