// ── trim-proforma-columns.js — one-time cleanup of the Proforma tab's
// trailing unused columns on the "Edge Metals" Google Sheet ────────────────
//
// Per Apsara: "in proforma,column names should be Consignee Inv No. Inv
// Date HBL No. Booking No. Container No. Seal No. Supplier Terms Customer
// Proforma Date Reference Item Description Weight Inv price" — that list
// matches the Proforma tab's FIRST 15 columns exactly (helpers/
// proformaSheetLog.js's HEADER_ROW). The tab also currently has 11 more
// trailing columns after "Inv price" (Commissions, two blank spacer
// columns, INVOICE AMT, RECEIVED AMT, Received Date, Freight Charge,
// Freight, another blank spacer, COMMISSIONS, ETA) — leftover from when
// this header was copied wholesale from the existing Invoice sheet's own
// column layout. Confirmed with Apsara she wants those 11 removed.
//
//   node trim-proforma-columns.js            # dry run — reports only, changes nothing
//   node trim-proforma-columns.js --apply    # actually deletes the trailing columns
//
// SAFETY: this is a genuinely destructive, one-time structural change to a
// live production sheet — unlike everywhere else this session (which only
// ever appends new columns or moves a column without touching its data),
// deleting a column deletes whatever's under it too. This script refuses
// to delete anything if ANY of the 11 target columns has so much as one
// non-blank cell below the header, anywhere in the tab — if that happens
// it lists exactly which column(s) and which row(s) blocked it and exits
// without changing anything, rather than guessing that data doesn't
// matter. Re-run is safe: if the columns are already gone (e.g. from a
// prior --apply), it reports nothing to do.

const cfg = require('./config');
const { getOrCreateSpreadsheetId, getSheets, TAB_NAME } = require('./helpers/proformaSheetLog');

// The 15 columns Apsara wants KEPT, in order — everything else on the
// Proforma tab's current header is a candidate for removal.
const KEEP_COLUMNS = [
    'Consignee', 'Inv No.', 'Inv Date', 'HBL  No.', 'Booking  No.', 'Container No.',
    'Seal No.', 'Supplier', 'Terms', 'Customer', 'Proforma Date', 'Reference',
    'Item Description', 'Weight', 'Inv price',
];

const APPLY = process.argv.includes('--apply');

function columnLetter(n) {
    let s = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

async function main() {
    console.log(APPLY ? '=== APPLYING — trailing columns will be deleted from the Proforma tab ===\n' : '=== DRY RUN — reporting only. Pass --apply to actually delete. ===\n');

    if (!cfg.GDRIVE_FOLDER_ID) throw new Error('GDRIVE_FOLDER_ID not configured — same requirement as every other Edge Metals sheet script.');

    const spreadsheetId = await getOrCreateSpreadsheetId();
    const sheets = getSheets();

    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
    const tab = (meta.data.sheets || []).find((s) => s.properties.title === TAB_NAME);
    if (!tab) throw new Error(`"${TAB_NAME}" tab not found on the Edge Metals sheet — nothing to trim.`);
    const sheetId = tab.properties.sheetId;

    const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!A1:Z1` });
    const header = (headerRes.data.values && headerRes.data.values[0]) || [];
    console.log(`Current header (${header.length} columns): [${header.join(', ')}]\n`);

    // Everything past the last KEEP_COLUMNS match, by position — not by
    // name matching alone, since a couple of the trailing columns are
    // blank labels ('', ' ') that could otherwise false-match an
    // already-removed column and confuse the index math.
    const keepCount = KEEP_COLUMNS.length;
    const matchesKeepList = KEEP_COLUMNS.every((label, i) => header[i] === label);
    if (!matchesKeepList) {
        console.error(`Header's first ${keepCount} columns don't match the expected keep-list exactly — stopping rather than guessing which columns are "extra". Expected: [${KEEP_COLUMNS.join(', ')}]`);
        process.exit(1);
    }
    if (header.length <= keepCount) {
        console.log('Nothing to do — the tab already has no columns past "Inv price" (safe to re-run).');
        return;
    }

    const trailingLabels = header.slice(keepCount);
    console.log(`Trailing columns beyond "Inv price" (candidates for removal): [${trailingLabels.join(', ')}]\n`);

    // Empty-check: read every trailing column's full data range (row 2
    // downward) and refuse to proceed if ANY cell in ANY of them has
    // content.
    const startCol = columnLetter(keepCount + 1);
    const endCol = columnLetter(header.length);
    const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!${startCol}2:${endCol}` });
    const dataRows = dataRes.data.values || [];

    const blockers = [];
    dataRows.forEach((row, rowIdx) => {
        row.forEach((cell, colOffset) => {
            if (cell != null && String(cell).trim() !== '') {
                blockers.push({ row: rowIdx + 2, column: trailingLabels[colOffset] || `(col ${keepCount + colOffset + 1})`, value: cell });
            }
        });
    });

    if (blockers.length) {
        console.error(`REFUSING to delete — found ${blockers.length} non-blank cell(s) under the trailing columns:`);
        blockers.slice(0, 20).forEach((b) => console.error(`  row ${b.row}, "${b.column}": "${b.value}"`));
        if (blockers.length > 20) console.error(`  ...and ${blockers.length - 20} more.`);
        console.error('\nMove or record that data elsewhere first if it needs to be kept, then re-run this script.');
        process.exit(1);
    }

    console.log('All trailing columns are empty below the header — safe to remove.\n');

    if (!APPLY) {
        console.log('Re-run with --apply to actually delete these columns.');
        return;
    }

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{
            deleteDimension: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: keepCount, endIndex: header.length },
            },
        }] },
    });

    const verifyRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB_NAME}!A1:Z1` });
    const newHeader = (verifyRes.data.values && verifyRes.data.values[0]) || [];
    if (newHeader.length !== keepCount || !KEEP_COLUMNS.every((label, i) => newHeader[i] === label)) {
        console.error(`Deletion ran but the resulting header doesn't match expectations — got [${newHeader.join(', ')}]. Check the sheet by hand.`);
        process.exit(1);
    }
    console.log(`Done — Proforma tab now has exactly ${newHeader.length} columns: [${newHeader.join(', ')}] (verified by re-reading the sheet).`);
}

main().catch((err) => {
    console.error('Trim failed:', err.message);
    process.exit(1);
});
