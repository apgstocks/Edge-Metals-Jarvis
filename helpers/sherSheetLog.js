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

const { getOrCreateSpreadsheetId, getSheets, ensureTab, upsertRowsByKey } = require('./proformaSheetLog');

const TAB_NAME = 'Sher';
const HEADER_ROW = ['Date', 'Booking No.', 'Quantity', 'Chassis', 'Others', 'Amount'];

function safeNum(n) {
    return (n === null || n === undefined || n === '') ? '' : n;
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

    if (!candidateRows.length) return { logged: 0, updated: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);

    // Per Apsara: "when we rerun verification,why it is rows/columns not
    // getting updated?" — a Booking No. already on the sheet now gets its
    // row overwritten with the latest quantity/amount instead of skipped.
    // Booking No. is column B here.
    const candidates = candidateRows.map((c) => ({ key: c.booking, row: c.row }));
    const { logged, updated } = await upsertRowsByKey(
        sheets, spreadsheetId, TAB_NAME, 'B', candidates,
        (v) => (v || '').trim().toUpperCase(),
    );
    return { logged, updated, spreadsheetId };
}

module.exports = { logSherVerification, TAB_NAME, HEADER_ROW };
