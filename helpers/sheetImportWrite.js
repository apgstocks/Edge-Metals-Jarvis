// ── helpers/sheetImportWrite.js — the half that writes ──────────────────────
//
// helpers/sheetImport.js reads her workbook and writes nothing. This puts the
// result into Bills and Invoices, and it is a separate file because the split
// is the safety property: the preview she approves is produced by the reader,
// and nothing here can change what that preview said.
//
// Apsara, 2026-09-18, on how this should be handed over: preview first, then
// confirm.
//
// ── WHAT THIS IS GUARDING AGAINST ───────────────────────────────────────────
// 568 bills and 647 invoices going into live data at once. The ways that ends
// badly, and what stops each:
//
//   HALF AN IMPORT. 568 sequential addBill() calls are 568 separate file
//   locks and 568 chances to fail in the middle, leaving her with 300 bills
//   and no way to tell which 300. Each store is written in ONE mutateJson
//   instead: every row lands or none does.
//
//   TWO IMPORTS. She presses the button twice, or the request times out and
//   she retries, and there are 1136 bills. Every row is stamped with a BATCH
//   ID derived from the file, and a second import of the same file is refused
//   by default.
//
//   NO WAY BACK. A bad import she cannot undo is worse than no import. The
//   batch id is on every row, and undo() removes exactly that batch and
//   nothing else.
//
//   A ROW THE STORE WOULD REFUSE. bills and sales each have rules about what
//   a valid record is — a sale needs a date and a customer. Finding that out
//   halfway through a write is too late, so EVERY row is built and validated
//   first, through the stores' own prepareBill/prepareSale, and what they
//   refuse is reported rather than dropped.
//
// ── THE VALIDATION IS THEIRS, NOT A COPY ────────────────────────────────────
// prepareBill and prepareSale were extracted from addBill and addSale for
// this, and those two still call them. A second copy of "what makes a valid
// bill" living here would be correct on the day it was written and wrong the
// first time the real rule changed.

const cfg = require('../config');
const { mutateJson, loadJson } = require('./json');

// Stamped on every imported row. `source` is the filename she uploaded, so a
// second import of the same file is recognisable; the timestamp makes two
// deliberate imports of the same file distinguishable when she forces one.
function batchIdFor(source) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return 'imp_' + String(source || 'workbook').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) + '_' + stamp;
}

// ── HAS THIS FILE ALREADY BEEN IMPORTED? ────────────────────────────────────
// Matched on the source NAME, not the batch id, because the point is to catch
// the same spreadsheet arriving twice — which is what a double-click and a
// retry after a timeout both look like.
function previousImports(source) {
    const key = String(source || '').trim().toLowerCase();
    const seen = new Map();
    for (const file of [cfg.BILLS_FILE, cfg.SALES_FILE]) {
        for (const row of (loadJson(file, []) || [])) {
            if (!row || !row.imported_batch) continue;
            if (String(row.imported_source || '').trim().toLowerCase() !== key) continue;
            const b = seen.get(row.imported_batch) || { batch: row.imported_batch, at: row.imported_at, rows: 0 };
            b.rows += 1;
            seen.set(row.imported_batch, b);
        }
    }
    return [...seen.values()];
}

// ── STEP ONE: BUILD EVERY ROW, WRITE NOTHING ────────────────────────────────
// Returns what would be written and what the stores refused, with the row
// number from her spreadsheet on each refusal so she can go and look.
function plan(parsed, opts = {}) {
    const bills = require('./bills');
    const sales = require('./sales');
    const source = opts.source || 'workbook.xlsx';
    const batch = opts.batch || batchIdFor(source);
    const actor = opts.actor || 'import';

    const ready = { bills: [], sales: [] };
    const refused = [];

    for (const b of (parsed.bills || [])) {
        const { _rows, _stored, _content, ...input } = b;
        try {
            ready.bills.push({
                ...bills.prepareBill({ ...input, created_by: actor }),
                imported_batch: batch,
                imported_source: source,
                imported_at: new Date().toISOString(),
                // Which spreadsheet rows this came from. A multi-grade
                // container is several, and being able to get back to them is
                // the difference between "this figure looks wrong" and "this
                // figure looks wrong and here is where it came from".
                source_rows: _rows || [],
            });
        } catch (e) {
            refused.push({ kind: 'bill', rows: _rows || [], why: e.message,
                           container: input.container_no || '', supplier: input.supplier || '' });
        }
    }

    for (const s of (parsed.sales || [])) {
        const { _row, _stored, _content, _rawDate, _rawProformaDate, ...input } = s;
        try {
            ready.sales.push({
                ...sales.prepareSale({ ...input, created_by: actor }),
                imported_batch: batch,
                imported_source: source,
                imported_at: new Date().toISOString(),
                source_rows: _row ? [_row] : [],
            });
        } catch (e) {
            refused.push({ kind: 'invoice', rows: _row ? [_row] : [], why: e.message,
                           invoice_no: input.invoice_no || '', customer: input.customer || '' });
        }
    }

    return {
        batch, source,
        bills: ready.bills, sales: ready.sales, refused,
        summary: { bills: ready.bills.length, sales: ready.sales.length, refused: refused.length },
        alreadyImported: previousImports(source),
    };
}

// ── STEP TWO: WRITE IT ──────────────────────────────────────────────────────
// One mutateJson per store, STRICT and retried. mutateJson is non-strict by
// default: on a lock failure it logs, returns stale data and NEVER RUNS THE
// MUTATOR — which for a bulk import means reporting success having written
// nothing. That trade is right for a cache and catastrophic here.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appendAll(file, rows, attempt = 0) {
    if (!rows.length) return 0;
    try {
        await mutateJson(file, [], (all) => {
            const list = Array.isArray(all) ? all : [];
            // push, not concat-and-return-new: mutateJson writes what the
            // mutator returns, and either works, but appending in place keeps
            // the existing rows' order untouched, which matters because the
            // screens sort on it.
            for (const r of rows) list.push(r);
            return list;
        }, { strict: true });
    } catch (e) {
        if (attempt >= 5) throw e;
        await sleep(50 * (attempt + 1));
        return appendAll(file, rows, attempt + 1);
    }
    return rows.length;
}

async function commit(planned, opts = {}) {
    if (!planned || !planned.batch) throw new Error('nothing planned to commit');

    // The same file twice. Refused unless she says otherwise, because a
    // duplicate import is silent — the totals simply double, and by the time
    // anyone notices there is no way to tell the two copies apart.
    if (!opts.force && (planned.alreadyImported || []).length) {
        const prev = planned.alreadyImported
            .map((p) => `${p.rows} rows on ${String(p.at || '').slice(0, 10)}`).join('; ');
        const e = new Error(`"${planned.source}" has already been imported (${prev}). `
            + 'Importing it again would double every row. Undo the previous import first, or force this one.');
        e.code = 'ALREADY_IMPORTED';
        throw e;
    }

    const wroteBills = await appendAll(cfg.BILLS_FILE, planned.bills);
    let wroteSales = 0;
    try {
        wroteSales = await appendAll(cfg.SALES_FILE, planned.sales);
    } catch (e) {
        // The bills landed and the invoices did not. Said plainly, with the
        // batch id, because the undo below is the way out and she cannot use
        // it without knowing the id.
        const err = new Error(`The bills were imported but the invoices failed: ${e.message}. `
            + `Undo batch ${planned.batch} and try again.`);
        err.code = 'PARTIAL_IMPORT';
        err.batch = planned.batch;
        err.wroteBills = wroteBills;
        throw err;
    }

    return { batch: planned.batch, source: planned.source, bills: wroteBills, sales: wroteSales,
             refused: planned.refused.length };
}

// ── AND THE WAY BACK ────────────────────────────────────────────────────────
// Removes exactly the rows carrying this batch id. Nothing she typed herself
// can carry one, so this cannot take a hand-entered bill with it.
async function undo(batch) {
    if (!batch) throw new Error('which import? a batch id is required');
    let removed = 0;
    for (const file of [cfg.BILLS_FILE, cfg.SALES_FILE]) {
        await mutateJson(file, [], (all) => {
            const list = Array.isArray(all) ? all : [];
            const keep = list.filter((r) => !(r && r.imported_batch === batch));
            removed += list.length - keep.length;
            return keep;
        }, { strict: true });
    }
    return removed;
}

// Every import that has ever run, newest first — so an undo has something to
// name.
function listBatches() {
    const seen = new Map();
    for (const file of [cfg.BILLS_FILE, cfg.SALES_FILE]) {
        for (const row of (loadJson(file, []) || [])) {
            if (!row || !row.imported_batch) continue;
            const b = seen.get(row.imported_batch)
                || { batch: row.imported_batch, source: row.imported_source, at: row.imported_at, bills: 0, sales: 0 };
            if (file === cfg.BILLS_FILE) b.bills += 1; else b.sales += 1;
            seen.set(row.imported_batch, b);
        }
    }
    return [...seen.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

module.exports = { plan, commit, undo, listBatches, previousImports, batchIdFor };
