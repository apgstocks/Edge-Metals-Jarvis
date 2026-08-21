// ── helpers/sherSheetLog.js — Log every successful Sher Trucking
// verification into a "Sher" tab on the same "Edge Metals" Google Sheet the
// other verification tabs log into ─────────────────────────────────────────
//
// Added per Apsara: "Create a tab called Sher in that date (from
// uplaoded),booking no,quantity ,chassis,others,Amount should be there.if
// quantity in uplaoded sheet is mentioned as 2,check whether there is two
// occurence of the booking no in my original sheet,else show error and
// dont put the row in sher tab." — note NO "Last Verified" column here,
// unlike Pan Metal/Jio; Apsara's column list for Sher didn't include one,
// so this follows her list exactly rather than assuming consistency with
// the other tabs. Only status === 'verified' rows (booking's sheet row
// count matches the invoice's stated quantity, exactly) ever reach here —
// a quantity mismatch is exactly the error she wants surfaced on-screen,
// never silently written as if it were confirmed correct.
//
// Dedup key: Booking No. — same "don't duplicate a row that's already
// logged" rule already applied to Pan Metal (Inv No.) and Jio (Container).

const { getOrCreateSpreadsheetId, getSheets, ensureTab } = require('./proformaSheetLog');

const TAB_NAME = 'Sher';
const HEADER_ROW = ['Date', 'Booking No.', 'Quantity', 'Chassis', 'Others', 'Amount'];

function safeNum(n) {
    return (n === null || n === undefined || n === '') ? '' : n;
}

// Reads every existing "Booking No." (column B) already in the Sher tab.
async function getExistingBookings(sheets, spreadsheetId) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!B2:B` });
    const values = res.data.values || [];
    return new Set(values.map((r) => (r[0] || '').trim().toUpperCase()).filter(Boolean));
}

// matchedRows: the `matched` array crossCheckSherRecords() returns — only
// status === 'verified' rows get logged.
async function logSherVerification(matchedRows) {
    const candidateRows = (matchedRows || [])
        .filter((r) => r.status === 'verified')
        .map((r) => ({
            booking: (r.booking_no || '').trim().toUpperCase(),
            row: [
                r.invoice_date || '',
                r.booking_no || '',
                safeNum(r.quantity),
                safeNum(r.chassis),
                safeNum(r.others),
                safeNum(r.amount),
            ],
        }))
        .filter((c) => c.booking); // nothing to key a dedupe check on without a booking no. — skip rather than log a blank row

    if (!candidateRows.length) return { logged: 0, skipped_duplicates: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);

    const existing = await getExistingBookings(sheets, spreadsheetId);
    const rows = [];
    let skipped = 0;
    for (const c of candidateRows) {
        if (existing.has(c.booking)) { skipped++; continue; }
        rows.push(c.row);
        existing.add(c.booking); // also guards against duplicates WITHIN this same batch
    }

    if (!rows.length) return { logged: 0, skipped_duplicates: skipped, spreadsheetId };

    await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${TAB_NAME}!A:A`,
        valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
    return { logged: rows.length, skipped_duplicates: skipped, spreadsheetId };
}

module.exports = { logSherVerification, TAB_NAME, HEADER_ROW };
