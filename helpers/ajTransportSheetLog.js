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
// Dedup/upsert key: Container No. — same key Jio uses. Per Apsara: "when
// we rerun verification,why it is rows/columns not getting updated?" — a
// Container No. already logged now gets that row OVERWRITTEN with the
// latest verification result (see proformaSheetLog.js's upsertRowsByKey),
// not silently skipped forever.
//
// Columns "Others" -> "Dry Run" -> "Extra Scale", all appended AFTER
// Amount, never inserted before it or in place of an existing column —
// this tab may already have rows logged under an earlier, shorter header
// on Apsara's live sheet, and ensureTab() only ever backfills missing
// TRAILING header cells, never rewrites one that's already there;
// inserting/renaming a column in the middle would misalign every row
// already logged under it. "Others" was this session's first fix for "why
// DRY RUN CHARGE and CHARGE FOR EXTRA SCALE both are not there" (both
// summed into one number); the follow-up ("instead of others,add new
// columns for that booking,keep the column name in two words") splits
// those two known charge types into their own named columns. "Others"
// itself is NOT dropped — it's repurposed as the catch-all for any
// non-container charge that's neither of those two named types (see
// gemini.js's extractAjTransportInvoiceRecords / invoiceVerify.js's
// crossCheckAjTransportRecords for other_charge), so a charge type that
// hasn't been seen on a real invoice yet still lands somewhere instead of
// silently vanishing the way DRY RUN CHARGE/EXTRA SCALE did before.

const { getOrCreateSpreadsheetId, getSheets, ensureTab, upsertRowsByKey, renameHeaderCellIfMatches } = require('./proformaSheetLog');

const TAB_NAME = 'AJ Transport';
// Per Apsara's column list ("...Rate, Line Haul, Others, Dry Run, Extra
// Scale, Total amount. others should come before total amount"): column H
// ("Amount") is relabeled "Line Haul" in place (same figures, see
// renameHeaderCellIfMatches call below — never touches a header cell that
// doesn't already say exactly "Amount"), and "Total amount" is appended as
// a brand new trailing column — Line Haul + Others + Dry Run + Extra
// Scale, computed in invoiceVerify.js's crossCheckAjTransportRecords since
// no single field on the invoice states this sum outright.
const HEADER_ROW = [
    'Invoice Date', 'Invoice No.', 'Container No.', 'Booking No.', 'Shipper', 'Pickup Date', 'Rate', 'Line Haul',
    'Others', 'Dry Run', 'Extra Scale', 'Total amount',
];

// Per Apsara: "make changes in excel that if i change some number,total
// should be modified" — "Total amount" (column L) is written as a LIVE
// FORMULA (=H+I+J+K for that row), not a static number, so hand-editing
// Line Haul/Others/Dry Run/Extra Scale directly in the sheet recalculates
// it automatically, the same as any formula she'd typed in herself. See
// the formula-patch step at the end of logAjTransportVerification below.

function safeNum(n) {
    return (n === null || n === undefined || n === '') ? '' : n;
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
                safeNum(r.other_charge),
                safeNum(r.dry_run_charge),
                safeNum(r.extra_scale_charge),
                safeNum(r.total_amount),
            ],
        }))
        .filter((c) => c.container); // nothing to key a dedupe check on without a container — skip rather than log a blank row

    if (!candidateRows.length) return { logged: 0, updated: 0 };

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();
    await ensureTab(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);
    // Runs AFTER ensureTab so the tab/header definitely exists first; a
    // no-op every time after the first successful rename since the cell no
    // longer says "Amount" afterward.
    await renameHeaderCellIfMatches(sheets, spreadsheetId, TAB_NAME, 'H', 'Amount', 'Line Haul');

    const candidates = candidateRows.map((c) => ({ key: c.container, row: c.row }));
    const { logged, updated, rowRanges } = await upsertRowsByKey(
        sheets, spreadsheetId, TAB_NAME, 'C', candidates,
        (v) => (v || '').trim().toUpperCase(),
    );

    // Per Apsara: "make changes in excel that if i change some number,
    // total should be modified" — a plain number in "Total amount" would
    // go stale the moment she hand-edits Line Haul/Others/Dry Run/Extra
    // Scale directly in the sheet. Replace it with a real formula
    // (=H+I+J+K for that row) so Sheets itself recalculates it on any edit,
    // the same as it would for a formula she'd typed in herself. This has
    // to run as a follow-up AFTER upsertRowsByKey, not baked into the row
    // array up front, because a freshly appended row's actual row number
    // isn't known until the append itself has happened.
    if (rowRanges && rowRanges.length) {
        const formulaData = [];
        for (const [start, end] of rowRanges) {
            for (let row = start; row <= end; row++) {
                formulaData.push({ range: `${TAB_NAME}!L${row}`, values: [[`=H${row}+I${row}+J${row}+K${row}`]] });
            }
        }
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: 'USER_ENTERED', data: formulaData },
        });
    }

    return { logged, updated, spreadsheetId };
}

module.exports = { logAjTransportVerification, TAB_NAME, HEADER_ROW };
