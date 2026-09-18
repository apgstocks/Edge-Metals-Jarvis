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

// Lowercased, collapsed whitespace. "HBL  No." and "hbl no." are one header.
function normHeader(h) {
    return String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, ' ');
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
}

const str = (v) => String(v == null ? '' : v).trim();

// ── DATES ───────────────────────────────────────────────────────────────────
// exceljs hands back a JS Date for a real date cell. Her workbook also holds
// cells MARKED as dates whose serial is impossible (6620541 ≈ the year 20,000)
// — openpyxl warns about several. Those are corruption, not dates, and they
// are reported rather than imported as a plausible-looking wrong day.
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
function toIsoDate(v) {
    if (v === null || v === undefined || v === '') return null;
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
function mapRows({ rows, headerIdx, map, dateFields, numFields, checks, sheet }) {
    const out = [];
    const problems = [];
    rows.forEach((cells, n) => {
        const rowNo = n + HEADER_ROW + 1;
        const rec = {};
        for (const [header, field] of Object.entries(map)) {
            const i = headerIdx[header];
            if (i === undefined) continue;
            rec[field] = cells[i];
        }
        for (const f of dateFields) {
            const d = toIsoDate(rec[f]);
            if (d && d.bad) { problems.push({ sheet, row: rowNo, field: f, why: d.bad }); rec[f] = null; }
            else rec[f] = d;
        }
        for (const f of numFields) rec[f] = num(rec[f]);
        for (const k of Object.keys(rec)) if (typeof rec[k] === 'string' || rec[k] instanceof String) rec[k] = str(rec[k]);
        const stored = {};
        for (const [header, key] of Object.entries(checks || {})) {
            const i = headerIdx[header];
            if (i !== undefined) stored[key] = num(cells[i]);
        }
        out.push({ _row: rowNo, _stored: stored, ...rec });
    });
    return { rows: out, problems };
}

// ── SHIPMENTS -> BILLS ──────────────────────────────────────────────────────
// Grouped by container. Her sheet puts one ROW PER GRADE, so a container
// holding alternators, starters and compressors is three rows with three
// weighbridge tickets — which is exactly the shape bills.js already stores as
// `items`. One bill per row would split every multi-grade container into
// separate bills and lose the container's real total.
function toBills(mapped) {
    const byContainer = new Map();
    const skipped = [];
    for (const r of mapped.rows) {
        const key = str(r.container_no).toUpperCase();
        if (!key) {
            // A row with no container is a spacer, a subtotal or a note. Named,
            // not silently dropped: "620 of 2262 rows" needs an explanation.
            const hasAnything = ['supplier', 'description', 'gross', 'supplier_price']
                .some((f) => r[f] !== null && r[f] !== undefined && str(r[f]) !== '');
            if (hasAnything) skipped.push({ row: r._row, why: 'no container number' });
            continue;
        }
        if (!byContainer.has(key)) byContainer.set(key, []);
        byContainer.get(key).push(r);
    }

    const bills = [];
    for (const [container, group] of byContainer) {
        const first = group[0];
        const bill = { container_no: container };
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
function toSales(mapped) {
    const sales = [];
    const skipped = [];
    for (const r of mapped.rows) {
        const hasKey = str(r.container_no) || str(r.invoice_no);
        if (!hasKey) {
            const hasAnything = ['customer', 'consignee', 'item', 'weight', 'invoice_price']
                .some((f) => r[f] !== null && r[f] !== undefined && str(r[f]) !== '');
            if (hasAnything) skipped.push({ row: r._row, why: 'no container number and no invoice number' });
            continue;
        }
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
    return { sales, skipped };
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
            all.push(row.values.slice(1));   // exceljs pads index 0
        });
        const headerIdx = indexHeaders(all[0] || []);
        const mapped = mapRows({ rows: all.slice(1), headerIdx, map: SHIPMENTS_MAP,
                                 dateFields: SHIPMENT_DATES, numFields: SHIPMENT_NUMS,
                                 checks: SHIPMENT_CHECKS, sheet: shipSheet.name });
        const { bills, skipped } = toBills(mapped);
        result.bills = bills;
        result.problems.push(...mapped.problems);
        result.skipped.push(...skipped.map((s) => ({ sheet: shipSheet.name, ...s })));
        result.sheets.shipments = { name: shipSheet.name, dataRows: all.length - 1,
                                    headersMatched: Object.keys(SHIPMENTS_MAP).filter((h) => h in headerIdx).length,
                                    headersTotal: Object.keys(SHIPMENTS_MAP).length };
    }

    const orderSheet = findSheet(opts.orderSheet || 'Order Details 2026');
    if (orderSheet) {
        const all = [];
        orderSheet.eachRow({ includeEmpty: false }, (row) => { all.push(row.values.slice(1)); });
        const headerIdx = indexHeaders(all[0] || []);
        const mapped = mapRows({ rows: all.slice(1), headerIdx, map: ORDER_MAP,
                                 dateFields: ORDER_DATES, numFields: ORDER_NUMS,
                                 checks: ORDER_CHECKS, sheet: orderSheet.name });
        const { sales, skipped } = toSales(mapped);
        result.sales = sales;
        result.problems.push(...mapped.problems);
        result.skipped.push(...skipped.map((s) => ({ sheet: orderSheet.name, ...s })));
        result.mismatches = totalMismatches(sales);
        result.sheets.orders = { name: orderSheet.name, dataRows: all.length - 1,
                                 headersMatched: Object.keys(ORDER_MAP).filter((h) => h in headerIdx).length,
                                 headersTotal: Object.keys(ORDER_MAP).length };
    }

    result.summary = {
        bills: result.bills.length,
        bills_multi_grade: result.bills.filter((b) => Array.isArray(b.items) && b.items.length > 1).length,
        sales: result.sales.length,
        rows_skipped: result.skipped.length,
        unreadable_values: result.problems.length,
        total_mismatches: result.mismatches.length,
    };
    return result;
}

module.exports = {
    readWorkbook, normHeader, toIsoDate, num,
    SHIPMENTS_MAP, ORDER_MAP, indexHeaders, mapRows, toBills, toSales, totalMismatches,
};
