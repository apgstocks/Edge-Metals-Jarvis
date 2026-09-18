// ── helpers/sheetImport.js — her shipment workbook, read into Jarvis ─────────
//
// Apsara, 2026-09-18, with "Shipments 2026.xlsx": "i want to upload this —
// whatever in shipments tab to Bill and Order Details to Invoice tab .. to
// match the field whatever is there in jarvis website".
//
//   SHIPMENTS 2026     -> Bills   (Edge Metals > Bills)   money OUT to suppliers
//   Order Details 2026 -> Sales   (Edge Metals > Invoice) money IN from customers
//
// The tab labelled "Invoice" on the website has id `sales` — her words for the
// outgoing side, confirmed 2026-09-19: "Upload from order details to match
// invoices tab outgoing".
//
// ── THIS FILE WRITES NOTHING ────────────────────────────────────────────────
// It reads a workbook and returns what WOULD be created, with every row it
// could not read listed beside it. She asked to see it first, and 524 bills
// appearing in live data unannounced is not something to discover afterwards.
// The route that writes is a separate, later step and calls this to build its
// preview from the same code — so what she approves is what gets written.
//
// ── MATCHED BY HEADER NAME, NOT COLUMN POSITION ─────────────────────────────
// The two sheets are 115 columns wide and she edits them daily. A mapping by
// position is one inserted column away from filing a seal number as a gross
// weight. helpers/invoiceSheet.js already reads her Google copy by header, and
// this follows it, including tolerating the double spaces her headers carry
// ("HBL  No.", "Booking  No.").
//
// ── DERIVED FIGURES ARE NOT IMPORTED ────────────────────────────────────────
// Total, NET, MT, INVOICE AMT, COMM Amount, RECEIVED AMT all exist in the
// workbook and all are recomputed by Jarvis from the parts. Importing them
// would store a typed total beside the arithmetic that produces it, and the
// first time the two disagree there is no way to tell which is right. The
// parts are imported; the totals are left to be derived. Where a stored total
// disagrees with the computed one this file REPORTS it rather than picking a
// winner — that disagreement is worth her eyes, not a silent overwrite.

const HEADER_ROW = 1;

// ── WHAT A CELL ACTUALLY CONTAINS ───────────────────────────────────────────
// exceljs does NOT hand back a plain value for every cell. A formula arrives
// as { formula, result }, a shared formula as { sharedFormula, result }, a
// styled string as { richText: [...] }, a link as { text, hyperlink }, and a
// broken cell as { error: '#N/A' }. String() on any of those is the literal
// "[object Object]".
//
// This was found by Apsara, 2026-09-19, looking at rows I had reported as
// skipped: "Everything was there properly". It was. The reader was wrong.
// 6,940 cells in her workbook are formulas, and among the columns this file
// maps they included 664 SUPPLIER INVOICE AMOUNTS — the money owed on most
// bills — every one of which was being imported as null. Worse, 69 container
// numbers were formulas too, so those rows then failed the "has a key" test
// and were dropped entirely, which is how a reading bug disguised itself as
// a data problem in her sheet.
function cellValue(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v !== 'object') return v;
    // A formula's computed value. Recursive because a result can itself be a
    // rich-text or hyperlink object.
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => (t && t.text) || '').join('');
    if ('hyperlink' in v && 'text' in v) return cellValue(v.text);
    if ('text' in v) return cellValue(v.text);
    // #REF!, #N/A, #DIV/0! — a cell Excel itself cannot evaluate. Null, and
    // the row still imports; inventing a number here would be worse.
    if ('error' in v) return null;
    return null;
}

// Lowercased, collapsed whitespace. "HBL  No." and "hbl no." are one header.
function normHeader(h) {
    return String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, ' ');
}

function num(v) {
    const c = cellValue(v);
    if (c === null || c === undefined || c === '') return null;
    const n = parseFloat(String(c).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
}

const str = (v) => {
    const c = cellValue(v);
    return String(c == null ? '' : c).trim();
};

// ── DATES ───────────────────────────────────────────────────────────────────
// exceljs hands back a JS Date for a real date cell. Her workbook also holds
// cells MARKED as dates whose serial is impossible (6620541 ≈ the year 20,000)
// — openpyxl warns about several. Those are corruption, not dates, and they
// are reported rather than imported as a plausible-looking wrong day.
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
function toIsoDate(raw) {
    const v = cellValue(raw);
    if (v === null || v === undefined) return null;
    // Whitespace-only counts as ABSENT, not as unreadable. A cell holding a
    // single space was being reported as `unreadable date ""`, which is a
    // problem she cannot act on and which buried the one real one.
    if (typeof v === 'string' && v.trim() === '') return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
        const y = v.getUTCFullYear();
        if (y < MIN_YEAR || y > MAX_YEAR) return { bad: `date out of range (${y})` };
        return `${y}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
    }
    const s = str(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        if (y < MIN_YEAR || y > MAX_YEAR) return { bad: `date out of range (${y})` };
        return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return { bad: `unreadable date "${s.slice(0, 20)}"` };
}

// ── THE TWO MAPS ────────────────────────────────────────────────────────────
// Left: the header as it appears in her workbook, normalised. Right: the field
// in Jarvis. A header not listed here is IGNORED — the workbook carries the
// whole selling and settlement side (Pier pass, Loan Deduc, Edge Net, Wire
// Charge …) which a supplier bill has no home for, and inventing columns to
// hold them would be building a spreadsheet inside a database.
const SHIPMENTS_MAP = {
    'g': 'route',
    'carrier': 'carrier',
    'trucking': 'trucking_company',
    'date': 'date',
    'supplier': 'supplier',
    'inv no': 'invoice_no',
    'bkg#': 'booking_no',
    'cont#': 'container_no',
    'seal#': 'seal_no',
    'item description': 'description',
    'gross': 'gross',
    'truck': 'truck',
    'container': 'container',
    'chassis': 'chassis',
    'boxes': 'boxes',
    'supplier price': 'supplier_price',
    'suppl invoice amt': 'supplier_invoice_amount',
    'advance /trucking': 'trucking_amount',
    'photo link': 'photos',
};
const SHIPMENT_DATES = ['date'];
const SHIPMENT_NUMS = ['gross', 'truck', 'container', 'chassis', 'boxes',
                       'supplier_price', 'supplier_invoice_amount', 'trucking_amount'];
// Per-grade on a multi-item container; the rest describe the container itself.
const ITEM_FIELDS = ['description', 'gross', 'truck', 'container', 'chassis', 'boxes'];

const ORDER_MAP = {
    'consignee': 'consignee',
    'inv no.': 'invoice_no',
    'inv date': 'date',
    'hbl no.': 'hbl_no',
    'booking no.': 'booking_no',
    'container no.': 'container_no',
    'seal no.': 'seal_no',
    'supplier': 'supplier',
    'terms': 'terms',
    'customer': 'customer',
    'proforma date': 'proforma_date',
    'reference': 'reference',
    'item description': 'item',
    'weight': 'weight',
    'inv price': 'invoice_price',
    'freight charge': 'freight_charges',
    'commissions': 'commission_per_mt',
};
const ORDER_DATES = ['date', 'proforma_date'];
const ORDER_NUMS = ['weight', 'invoice_price', 'freight_charges', 'commission_per_mt'];

// Stored totals: not imported, but read so a disagreement can be reported.
const SHIPMENT_CHECKS = { 'net': 'net', 'mt': 'mt' };
const ORDER_CHECKS = { 'invoice amt': 'invoice_amount', 'received amt': 'received_amount' };

function indexHeaders(headerCells) {
    const idx = {};
    headerCells.forEach((h, i) => {
        const k = normHeader(h);
        if (!k) return;
        // FIRST occurrence wins. Her sheet repeats "Total" and "Balance", and
        // a later duplicate silently replacing an earlier mapped column is
        // the quiet version of the position bug this file avoids.
        if (!(k in idx)) idx[k] = i;
    });
    return idx;
}

// One sheet -> rows of {field: value}, plus whatever could not be read.
// `rows` is [{ n, cells }] — n is the row's REAL number in the sheet.
//
// It used to be a bare array of cells with the number computed as position+2,
// which assumes the rows are contiguous. exceljs's eachRow SKIPS blank rows,
// so every number drifted by however many blanks came before it: the preview
// told her to look at row 673 when it meant a different row entirely. Found
// 2026-09-19 when row 673 turned out to be a live San Antonio shipment that
// the importer had never actually skipped.
function mapRows({ rows, headerIdx, map, dateFields, numFields, checks, sheet }) {
    const out = [];
    const problems = [];
    rows.forEach(({ n, cells }) => {
        const rowNo = n;
        const rec = {};
        for (const [header, field] of Object.entries(map)) {
            const i = headerIdx[header];
            if (i === undefined) continue;
            rec[field] = cells[i];
        }
        for (const f of dateFields) {
            const rawText = str(rec[f]);
            if (rawText) rec[f === 'date' ? '_rawDate' : '_rawProformaDate'] = rawText;
            const d = toIsoDate(rec[f]);
            if (d && d.bad) { problems.push({ sheet, row: rowNo, field: f, why: d.bad }); rec[f] = null; }
            else rec[f] = d;
        }
        for (const f of numFields) rec[f] = num(rec[f]);
        // ── EVERY REMAINING FIELD GOES THROUGH str(), NOT JUST STRINGS ────
        // This used to be `if (typeof rec[k] === 'string')`, which normalised
        // only the values that were ALREADY strings — so a text field holding
        // a formula or a hyperlink stayed a raw exceljs object and would have
        // been written into her data as one. The photo link on a real bill
        // came out as {"text":"https://…","hyperlink":"https://…"} instead of
        // a URL, and a supplier cell carrying a formula came out as the
        // literal "[object Object]".
        //
        // Third variant of the same mistake in one afternoon: the unwrapping
        // has to happen at every boundary, not at the ones that looked likely.
        for (const k of Object.keys(rec)) {
            if (dateFields.includes(k) || numFields.includes(k)) continue;
            rec[k] = str(rec[k]);
        }
        const stored = {};
        for (const [header, key] of Object.entries(checks || {})) {
            const i = headerIdx[header];
            if (i !== undefined) stored[key] = num(cells[i]);
        }
        // ── A SKIPPED ROW MUST BE ABLE TO SHOW ITS OWN CONTENTS ──────────
        // Apsara asked "why 13 skipped?" and the answer given was "row is
        // empty", which was false — every one of them held a stray value.
        // A count with a label she cannot check is how the previous round of
        // this went wrong. The cells travel with the row so the preview can
        // print them instead of asserting something about them.
        const content = [];
        cells.forEach((v, i) => {
            const val = cellValue(v);
            if (val === null || val === undefined || String(val).trim() === '') return;
            const header = Object.keys(headerIdx).find((h) => headerIdx[h] === i);
            content.push((header || ('col' + (i + 1))) + ' = ' + String(val).slice(0, 40));
        });
        out.push({ _row: rowNo, _stored: stored, _content: content, ...rec });
    });
    return { rows: out, problems };
}

// ── SHIPMENTS -> BILLS ──────────────────────────────────────────────────────
// Grouped by container. Her sheet puts one ROW PER GRADE, so a container
// holding alternators, starters and compressors is three rows with three
// weighbridge tickets — which is exactly the shape bills.js already stores as
// `items`. One bill per row would split every multi-grade container into
// separate bills and lose the container's real total.
// ── A LOAD WITHOUT A CONTAINER IS STILL A LOAD ──────────────────────────────
// Apsara, 2026-09-19, shown the rows this had "skipped": "Everything was there
// properly". It was. They are her DOMESTIC business — "LOCAL DELIEVERY",
// "53 ft Trailer", "Local Transit" — real suppliers, customers, weights and
// prices that never went in a container because they went on a truck.
//
// Requiring a container number quietly excluded that entire side of the
// business. A container is how an EXPORT is identified; it is not what makes
// a row real. So the rule is now "does this row say anything", and the
// container is used only for GROUPING, which is all it was ever good for.
// ── NO CONTAINER MEANS LOCAL DELIVERY ───────────────────────────────────────
// Apsara, 2026-09-19, stating the rule plainly: "if container number not
// there, it just means that it is local delivery."
//
// So a blank container is not missing data to be worked around — it is the
// fact that this load went by truck rather than by sea, and it is worth
// recording as such. The route column on these rows backs it up: Oklahoma/LA,
// houston/Humble, san Antonio/Houston. Domestic movements, every one.
//
// It is written into the bill's note rather than a new column. A `local`
// flag would be a schema change to bills.js for data that is already implied
// by the empty container, and the note is what she actually reads on the row.
const LOCAL_NOTE = 'Local delivery — no container (from the Shipments sheet)';

function billKey(r) {
    const container = str(r.container_no).toUpperCase();
    if (container) return { key: 'C:' + container, groupable: true };
    // No container: each row stands alone. There is nothing to group a local
    // delivery BY — two truckloads from the same supplier on the same day are
    // two loads, and merging them would invent a single larger one.
    return { key: 'R:' + r._row, groupable: false };
}

function toBills(mapped) {
    const byContainer = new Map();
    const skipped = [];
    for (const r of mapped.rows) {
        // Anything at all: a supplier, a description, a weight, a price, a
        // booking, an invoice number. Only a row that says NOTHING is dropped.
        const hasAnything = ['supplier', 'description', 'gross', 'supplier_price',
                             'booking_no', 'invoice_no', 'trucking_company', 'carrier',
                             'supplier_invoice_amount', 'trucking_amount']
            .some((f) => r[f] !== null && r[f] !== undefined && str(r[f]) !== '');
        if (!hasAnything) { skipped.push({ row: r._row, why: 'nothing a bill can be built from', content: r._content }); continue; }
        const { key } = billKey(r);
        if (!byContainer.has(key)) byContainer.set(key, []);
        byContainer.get(key).push(r);
    }

    const bills = [];
    for (const [key, group] of byContainer) {
        const first = group[0];
        const bill = {};
        if (key.startsWith('C:')) bill.container_no = key.slice(2);
        else bill.note = LOCAL_NOTE;
        for (const f of ['route', 'carrier', 'trucking_company', 'date', 'supplier',
                         'invoice_no', 'booking_no', 'seal_no', 'supplier_price',
                         'supplier_invoice_amount', 'trucking_amount', 'photos']) {
            if (first[f] !== null && first[f] !== undefined && str(first[f]) !== '') bill[f] = first[f];
        }
        if (group.length === 1) {
            // One grade: the flat shape, which is most bills and is untouched.
            for (const f of ITEM_FIELDS) {
                if (first[f] !== null && first[f] !== undefined && str(first[f]) !== '') bill[f] = first[f];
            }
        } else {
            bill.items = group.map((r) => {
                const it = {};
                for (const f of ITEM_FIELDS) {
                    if (r[f] !== null && r[f] !== undefined && str(r[f]) !== '') it[f] = r[f];
                }
                if (r.supplier_price !== null && r.supplier_price !== undefined) it.price = r.supplier_price;
                return it;
            }).filter((it) => it.description);
            // The container's supplier_price belongs to a grade once there are
            // several, and each item carries its own.
            delete bill.supplier_price;
        }
        bill._rows = group.map((r) => r._row);
        bill._stored = first._stored;
        bills.push(bill);
    }
    return { bills, skipped };
}

// ── ORDER DETAILS -> SALES ──────────────────────────────────────────────────
// One row per invoice line, which is what the sales table already holds.
// ── A CANCELLED ORDER IS NOT AN INVOICE ─────────────────────────────────────
// The bottom of her Order Details sheet — rows 734 to 754 in this file, all
// contiguous — records orders that never shipped: "ORDER CANCELLED",
// "REPLACED BY 26ST10", "LC EXPIRED", "cancelled". Twenty-one of them, and
// they were being imported as live invoices, which would have put money into
// "who owes me" that nobody owes.
//
// Detected by the MARKER rather than by a row number, deliberately. 733 is
// where the live data happens to stop in today's file; "this row says the
// order was cancelled" is true wherever it appears, including in the middle
// of next year's sheet. Every row it removes is listed in the preview with
// the text that triggered it, so the rule can be checked rather than trusted.
const DEAD_ORDER = /\b(cancel(l?ed)?|replaced\s+by|expired|void)\b/i;

function looksCancelled(r) {
    for (const f of ['booking_no', 'hbl_no', 'invoice_no', 'container_no', 'reference', 'terms']) {
        if (DEAD_ORDER.test(str(r[f]))) return str(r[f]);
    }
    // The date columns hold free text on these rows ("REPLACED BY 26ST10,1").
    for (const f of ['_rawDate', '_rawProformaDate']) {
        if (r[f] && DEAD_ORDER.test(String(r[f]))) return String(r[f]);
    }
    return null;
}

function toSales(mapped) {
    const sales = [];
    const skipped = [];
    const cancelled = [];
    for (const r of mapped.rows) {
        const why = looksCancelled(r);
        if (why) {
            cancelled.push({ row: r._row, invoice_no: str(r.invoice_no),
                             customer: str(r.customer) || str(r.consignee), marker: why.slice(0, 60) });
            continue;
        }
        // Same correction as toBills: her local deliveries to Eccomelt carry a
        // PO reference and "Local Transit" instead of a container and an HBL,
        // and they are invoices like any other. A row is kept if it says
        // anything; only a genuinely empty one is dropped.
        const hasAnything = ['customer', 'consignee', 'item', 'weight', 'invoice_price',
                             'invoice_no', 'container_no', 'booking_no', 'reference', 'hbl_no']
            .some((f) => r[f] !== null && r[f] !== undefined && str(r[f]) !== '');
        if (!hasAnything) { skipped.push({ row: r._row, why: 'nothing an invoice can be built from', content: r._content }); continue; }
        const sale = {};
        for (const [, field] of Object.entries(ORDER_MAP)) {
            if (r[field] !== null && r[field] !== undefined && str(r[field]) !== '') sale[field] = r[field];
        }
        // `consignee` is the address-book tag ("Joey/Taewon"); the sales table
        // keys on customer. Keep the tag in the note rather than losing it —
        // it is how the Edge Metals sheet files the row.
        if (sale.consignee && !sale.customer) sale.customer = sale.consignee;
        if (sale.consignee && sale.customer && sale.consignee !== sale.customer) {
            sale.note = `sheet tag: ${sale.consignee}`;
        }
        delete sale.consignee;
        // Not a sales column. Dropped deliberately rather than invented.
        delete sale.seal_no;
        delete sale.supplier;
        sale._row = r._row;
        sale._stored = r._stored;
        sales.push(sale);
    }
    return { sales, skipped, cancelled };
}

// Where a stored total and the computed one disagree by more than a cent.
// Reported, never corrected — see the header.
function totalMismatches(sales) {
    const out = [];
    for (const s of sales) {
        const stored = s._stored && s._stored.invoice_amount;
        if (stored === null || stored === undefined) continue;
        if (s.weight === null || s.weight === undefined
            || s.invoice_price === null || s.invoice_price === undefined) continue;
        const computed = Math.round(s.weight * s.invoice_price * 100) / 100;
        if (Math.abs(computed - stored) > 0.01) {
            out.push({ row: s._row, invoice_no: s.invoice_no || '',
                       sheet_says: stored, weight_x_price: computed,
                       difference: Math.round((stored - computed) * 100) / 100 });
        }
    }
    return out;
}

// ── THE ONE ENTRY POINT ─────────────────────────────────────────────────────
// Takes a workbook buffer. Returns everything that WOULD be created and
// everything that could not be read. Never writes.
// ── WHERE THE DATA STOPS ────────────────────────────────────────────────────
// Apsara, 2026-09-19: "till 665 rows only to beconsidered."
//
// Below that line her Shipments sheet is working space — loose sums, a customs
// commodity description parked for copying, half-built rows for shipments that
// have not happened. Some of it looks importable (row 673 has a supplier, a
// route and a price) which is exactly why a rule is needed rather than a
// judgement per row: a half-built row is indistinguishable from a real one
// until she says where the data ends.
//
// Passed in rather than hardcoded. 665 is true of this file today and will not
// be true of the next one, and a number frozen into the helper would quietly
// start cutting off real rows the moment she adds any.
function applyLastRow(rows, lastRow) {
    if (!Number.isFinite(lastRow)) return { kept: rows, cut: [] };
    return {
        kept: rows.filter((r) => r.n <= lastRow),
        cut: rows.filter((r) => r.n > lastRow).map((r) => r.n),
    };
}

async function readWorkbook(buffer, opts = {}) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const findSheet = (wanted) => wb.worksheets.find((w) => normHeader(w.name) === normHeader(wanted))
        || wb.worksheets.find((w) => normHeader(w.name).startsWith(normHeader(wanted).split(' ')[0]));

    const result = { bills: [], sales: [], problems: [], skipped: [], mismatches: [], sheets: {} };

    const shipSheet = findSheet(opts.shipmentsSheet || 'SHIPMENTS 2026');
    if (shipSheet) {
        const all = [];
        shipSheet.eachRow({ includeEmpty: false }, (row) => {
            all.push({ n: row.number, cells: row.values.slice(1) });   // exceljs pads index 0
        });
        const headerIdx = indexHeaders((all[0] || {}).cells || []);
        const shipCut = applyLastRow(all.slice(1), opts.shipmentsLastRow);
        const mapped = mapRows({ rows: shipCut.kept, headerIdx, map: SHIPMENTS_MAP,
                                 dateFields: SHIPMENT_DATES, numFields: SHIPMENT_NUMS,
                                 checks: SHIPMENT_CHECKS, sheet: shipSheet.name });
        const { bills, skipped } = toBills(mapped);
        result.bills = bills;
        result.problems.push(...mapped.problems);
        result.skipped.push(...skipped.map((s) => ({ sheet: shipSheet.name, ...s })));
        result.belowLastRow = (result.belowLastRow || 0) + shipCut.cut.length;
        result.sheets.shipments = { name: shipSheet.name, dataRows: all.length - 1,
                                    lastRow: opts.shipmentsLastRow || null,
                                    rowsBelowLastRow: shipCut.cut.length,
                                    headersMatched: Object.keys(SHIPMENTS_MAP).filter((h) => h in headerIdx).length,
                                    headersTotal: Object.keys(SHIPMENTS_MAP).length };
    }

    const orderSheet = findSheet(opts.orderSheet || 'Order Details 2026');
    if (orderSheet) {
        const all = [];
        orderSheet.eachRow({ includeEmpty: false }, (row) => { all.push({ n: row.number, cells: row.values.slice(1) }); });
        const headerIdx = indexHeaders((all[0] || {}).cells || []);
        const orderCut = applyLastRow(all.slice(1), opts.ordersLastRow);
        const mapped = mapRows({ rows: orderCut.kept, headerIdx, map: ORDER_MAP,
                                 dateFields: ORDER_DATES, numFields: ORDER_NUMS,
                                 checks: ORDER_CHECKS, sheet: orderSheet.name });
        const { sales, skipped, cancelled } = toSales(mapped);
        result.sales = sales;
        result.cancelled = cancelled;
        result.problems.push(...mapped.problems);
        result.skipped.push(...skipped.map((s) => ({ sheet: orderSheet.name, ...s })));
        result.mismatches = totalMismatches(sales);
        result.belowLastRow = (result.belowLastRow || 0) + orderCut.cut.length;
        result.sheets.orders = { name: orderSheet.name, dataRows: all.length - 1,
                                 lastRow: opts.ordersLastRow || null,
                                 rowsBelowLastRow: orderCut.cut.length,
                                 headersMatched: Object.keys(ORDER_MAP).filter((h) => h in headerIdx).length,
                                 headersTotal: Object.keys(ORDER_MAP).length };
    }

    result.summary = {
        bills: result.bills.length,
        // Named in its own right rather than counted as an oddity — see
        // LOCAL_NOTE. These are her domestic truck movements.
        bills_local_delivery: result.bills.filter((b) => !b.container_no).length,
        bills_multi_grade: result.bills.filter((b) => Array.isArray(b.items) && b.items.length > 1).length,
        sales: result.sales.length,
        rows_skipped: result.skipped.length,
        unreadable_values: result.problems.length,
        total_mismatches: result.mismatches.length,
        cancelled_orders: (result.cancelled || []).length,
    };
    return result;
}

module.exports = {
    readWorkbook, normHeader, toIsoDate, num,
    SHIPMENTS_MAP, ORDER_MAP, indexHeaders, mapRows, toBills, toSales, totalMismatches,
};
