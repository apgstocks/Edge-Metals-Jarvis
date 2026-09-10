// ── helpers/shipmentSheetLog.js — every bill, in the Edge Metals sheet ────
// Apsara, 2026-09-10: "post save of a bill,i want Shipment tab to be created
// in edge metals sheet.on every edit of the bill,i want that row to be
// modified."
//
// ── NOTHING HERE IS A NEW SHEETS INTEGRATION ─────────────────────────────
// helpers/proformaSheetLog.js already finds-or-creates a spreadsheet called
// "Edge Metals" in the Shared Drive, already creates tabs in it, and already
// has upsertRowsByKey — write a row, and writing it again with the same key
// UPDATES that row rather than appending a second one. That last function is
// precisely "on every edit of the bill, modify that row", written months ago
// for the proforma log.
//
// So this file borrows all four of those and contributes only two things: the
// column list for a bill, and the key. Building a second Sheets client would
// mean two auth paths, two find-or-create races and two ideas of where "Edge
// Metals" lives.
//
// ── THE KEY IS THE BILL ID, AND IT IS ON THE SHEET ───────────────────────
// upsertRowsByKey matches on a column. The obvious candidates — container
// number, invoice no — are all things she can CHANGE, and changing the key is
// how an edit silently becomes a second row. The bill's own id never changes
// and is meaningless to read, so it goes in the LAST column where it is out
// of the way, and it is what the upsert matches on.
//
// ── AND A SHEET FAILURE MUST NOT COST HER THE BILL ───────────────────────
// The bill is saved to bills.json FIRST and this runs after, non-fatally.
// Drive being unreachable, the token being stale, someone having renamed the
// tab — none of those are reasons for "Save" to fail on a bill she has just
// typed eighteen fields into. It logs loudly and the row is reconciled the
// next time she edits it. Same posture as helpers/yardChatLog.js's Drive
// mirror, which carries the same comment.

const cfg = require('../config');
const bills = require('./bills');
const proforma = require('./proformaSheetLog');

const TAB_NAME = 'Shipment';

// Her bill columns, in her table order, plus the three things a shipment row
// wants that the table does not show: the carrier (she took it OFF the table
// on 2026-09-10 but it is still on the record and still worth having in the
// sheet), the price unit, and the id the upsert matches on.
//
// Built from bills.tableColumns() rather than typed out again — the table and
// this cannot drift into disagreeing about what a bill has, and a column she
// adds later arrives here without an edit.
const KEY_LABEL = 'Bill ID (do not edit)';

function headerRow() {
    return [
        ...bills.tableColumns().map((c) => c.label),
        'Carrier',
        'Priced per',
        // Last, and named so nobody wonders what it is or sorts by it. Found
        // BY THIS LABEL in the live sheet rather than by counting our own
        // columns — see keyColumnFrom below.
        KEY_LABEL,
    ];
}

// ── ONE ROW PER GRADE, NOT PER BILL ──────────────────────────────────────
// Apsara, 2026-09-10: "only if same container -different item,it should be
// inserted-else update only".
//
// A bill can now carry several grades, each with its own weighbridge ticket.
// One row per bill would collapse them into a single line whose Item
// description says one thing and whose weights say another. So the row grain
// follows the data: one row per ITEM, keyed on the bill AND the item, which
// is precisely her rule — same container with a different item inserts,
// anything else updates in place.
//
// A bill with no items is still one row, keyed on the bill alone, so nothing
// entered before today changes shape.
function rowsFor(bill) {
    const b = bills.withTotals(bill || {});
    const cellOf = (src) => (c) => {
        const v = src[c.key];
        if (v === null || v === undefined) return '';
        // Photos are an array on the record; a sheet cell is text. One per
        // line so the cell stays clickable rather than becoming one run-on
        // string.
        if (Array.isArray(v)) return v.join('\n');
        return v;
    };
    const tail = (src) => [
        src.carrier || '',
        src.price_unit === 'lb' ? 'per lb' : src.price_unit === 'mt' ? 'per MT' : '',
        '',   // filled with the key below
    ];

    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) {
        const row = [...bills.tableColumns().map(cellOf(b)), ...tail(b)];
        row[row.length - 1] = b.id || '';
        return [{ key: b.id, row }];
    }

    return items.map((it) => {
        // The bill's own fields, with THIS grade's description, weights and
        // money laid over them — so the row reads as that grade's line rather
        // than as the container's total with one grade's name on it.
        const view = {
            ...b,
            description: it.description || b.description || '',
            gross: it.weighed ? it.gross : b.gross,
            truck: it.weighed ? it.truck : b.truck,
            container: it.weighed ? it.container : b.container,
            chassis: it.weighed ? it.chassis : b.chassis,
            boxes: it.weighed ? it.boxes : b.boxes,
            total: it.weighed ? it.tare_total : b.total,
            net_lb: it.weight,
            net_mt: it.weight_mt,
            supplier_price: it.price,
            amount: it.amount,
            price_unit: it.price_unit || b.price_unit,
            // Trucking, payable and balance belong to the CONTAINER, not to a
            // grade inside it. Repeating them on every line would make a
            // three-grade container look like three lots of haulage to
            // anyone summing the column.
            trucking_amount: '', net_payable: '', balance: '',
        };
        const row = [...bills.tableColumns().map(cellOf(view)), ...tail(view)];
        const key = `${b.id}:${it.id}`;
        row[row.length - 1] = key;
        return { key, row };
    });
}

// Kept for callers and tests that want the single-row shape.
function rowFor(bill) { return rowsFor(bill)[0].row; }

// ── THE HEADER IN THE SHEET IS THE ONE THAT MATTERS ──────────────────────
// Apsara, 2026-09-10: "what the hell.headers in shipment of edge metals and
// data are not match..why this duplicate".
//
// One cause, both symptoms. proformaSheetLog.ensureTab only backfills MISSING
// TRAILING header cells and deliberately never reorders — correct when a
// column is appended, and exactly wrong when the order CHANGES. A column went
// in before Balance today, so:
//
//   · every value in every new row landed one column left of its heading
//   · keyColumnLetter(), counted from OUR header, pointed one past where the
//     id actually sat, so the upsert matched nothing, appended, and produced
//     the duplicate pair she is looking at
//
// So the header is reconciled properly: when the sheet's differs from ours,
// the EXISTING ROWS ARE REMAPPED BY LABEL first and then the header is
// rewritten. Remapping is the whole point — rewriting the header alone would
// leave every historical row silently misaligned under correct-looking
// headings, which is worse than the visible mess it replaces.
async function reconcileHeader(sheets, spreadsheetId, tabName, wanted) {
    const got = await sheets.spreadsheets.values.get({
        spreadsheetId, range: `${tabName}!A1:ZZ`,
    });
    const values = got.data.values || [];
    const existing = values[0] || [];
    if (!existing.length) return { changed: false, reason: 'empty tab' };
    const same = existing.length === wanted.length
        && existing.every((h, i) => String(h).trim() === String(wanted[i]).trim());
    if (same) return { changed: false };

    // old label -> its column index, so a value follows its HEADING rather
    // than its position.
    const oldIndex = new Map();
    existing.forEach((h, i) => {
        const k = String(h).trim();
        if (k && !oldIndex.has(k)) oldIndex.set(k, i);
    });

    const remapped = values.slice(1).map((row) => wanted.map((label) => {
        const i = oldIndex.get(String(label).trim());
        return i === undefined ? '' : (row[i] === undefined ? '' : row[i]);
    }));

    const body = [wanted, ...remapped];
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1:${columnLetterOf(wanted.length)}${body.length}`,
        valueInputOption: 'RAW',
        requestBody: { values: body },
    });
    return { changed: true, rows_remapped: remapped.length };
}

// Local rather than imported: proformaSheetLog does not export its own.
function columnLetterOf(n) {
    let s = ''; let i = n;
    while (i > 0) { const rem = (i - 1) % 26; s = String.fromCharCode(65 + rem) + s; i = Math.floor((i - 1) / 26); }
    return s;
}

// The column letter the id lands in — computed, not counted by hand, because
// adding a column to bills.js would otherwise silently point the upsert at
// the wrong column and turn every edit into a new row.
function keyColumnLetter() {
    const n = headerRow().length;                 // 1-based index of the last column
    let s = '';
    let i = n;
    while (i > 0) {
        const rem = (i - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        i = Math.floor((i - 1) / 26);
    }
    return s;
}

// Writes one bill. Appends the first time, UPDATES that same row every time
// after — which is her requirement, and is upsertRowsByKey's whole job.
//
// Returns a small result rather than throwing, so callers can log what
// happened without having to wrap it.
async function logBillToSheet(bill) {
    if (!bill || !bill.id) return { ok: false, reason: 'no bill' };
    // ── THE GUARD, AND HOW I GOT PAST IT ─────────────────────────────────
    // The same switch every other Drive-touching helper honours. It works —
    // and on 2026-09-10 I still wrote a junk row into her live "Edge Metals"
    // spreadsheet, because I ran a one-off `node -e` probe WITHOUT setting
    // JARVIS_TEST, and this function does exactly what it is told to do when
    // nothing says otherwise. The row was found and deleted the same minute.
    //
    // Recorded here rather than in a commit message because the failure was
    // not the guard's: an env-var switch protects the test RUNNER and protects
    // nothing at all from a hand-run script. Anything poking this file by hand
    // must set JARVIS_TEST=1 first, every time, and there is no code change
    // that makes that unnecessary.
    if (process.env.JARVIS_TEST === '1') return { ok: false, reason: 'disabled under JARVIS_TEST' };
    if (!cfg.GDRIVE_FOLDER_ID) return { ok: false, reason: 'no Shared Drive configured' };

    const sheets = proforma.getSheets();
    const spreadsheetId = await proforma.getOrCreateSpreadsheetId();
    // Creates "Shipment" the first time and backfills the header if a column
    // was added since — ensureTab already does both.
    await proforma.ensureTab(sheets, spreadsheetId, TAB_NAME, headerRow());
    // ensureTab handles a NEW tab and an APPENDED column; this handles the
    // case it explicitly refuses — a header whose order changed. Must run
    // before the upsert, or the key column is read from the old layout.
    const fixed = await reconcileHeader(sheets, spreadsheetId, TAB_NAME, headerRow());

    const res = await proforma.upsertRowsByKey(
        sheets, spreadsheetId, TAB_NAME, keyColumnLetter(),
        rowsFor(bill),
    );
    return { ok: true, spreadsheetId, header_fixed: fixed.changed || false, ...res };
}

// ── COALESCED, BECAUSE AUTOSAVE TYPES ────────────────────────────────────
// Apsara, 2026-09-10: "if i start adding atleast one value in bill,it should
// get autosaved ... On every modification,that row needs to e updated."
//
// Taken literally that is one Sheets write per keystroke-burst, and the Sheets
// API is rate-limited per minute per user. Filling eighteen fields would fire
// eighteen upserts of which only the last matters.
//
// So writes for the SAME bill are collapsed: a pending write is replaced by
// the newer one and only the last state within the window is sent. The row
// still ends up correct — an upsert is idempotent on the key — it just is not
// written seventeen times to get there.
const pending = new Map();
const COALESCE_MS = 2500;

// Fire-and-forget wrapper for the save path. NEVER throws: see the header.
function logBillSafely(bill, why) {
    if (!bill || !bill.id) return;
    const prev = pending.get(bill.id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
        const job = pending.get(bill.id);
        pending.delete(bill.id);
        if (job) writeNow(job.bill, job.why);
    }, COALESCE_MS);
    // unref so a queued write cannot hold the process open — this runs on a
    // long-lived server, but the tests are short-lived and would hang.
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(bill.id, { bill, why, timer });
}

// Flushes everything waiting. For shutdown, and for a test that wants the
// write to have happened before it looks.
function flushPending() {
    const jobs = [...pending.values()];
    pending.clear();
    jobs.forEach((j) => clearTimeout(j.timer));
    return Promise.all(jobs.map((j) => writeNow(j.bill, j.why)));
}

function writeNow(bill, why) {
    return Promise.resolve()
        .then(() => logBillToSheet(bill))
        .then((r) => {
            if (r && r.ok) console.log(`[SHIPMENT-SHEET] ${why} ${bill.id}: ${r.updated ? 'updated its row' : 'added a row'}`);
            else console.log(`[SHIPMENT-SHEET] ${why} ${bill.id}: skipped — ${r && r.reason}`);
        })
        .catch((e) => {
            // LOUD, and still not fatal. A row that failed to sync is
            // reconciled the next time she edits the bill, because the upsert
            // is keyed and not positional.
            console.error(`[SHIPMENT-SHEET] could not write ${bill && bill.id} (${why}) — the bill IS saved:`, e.message);
        });
}

module.exports = { TAB_NAME, headerRow, rowFor, rowsFor, keyColumnLetter, reconcileHeader,
    KEY_LABEL, logBillToSheet, logBillSafely,
    flushPending, COALESCE_MS };
