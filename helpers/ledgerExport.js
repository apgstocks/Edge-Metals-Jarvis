// ── helpers/ledgerExport.js — Bills and Invoice, as a file ──────────────────
//
// Apsara, 2026-09-19: "Add export option to bill and invoice-export as xls and
// pdf", and, asked what it should contain: exactly what is on screen.
//
// ── SO IT IS BUILT FROM THE SAME PLACE THE SCREEN IS ────────────────────────
// Not from a second list of columns kept in step by hand. helpers/bills.js and
// helpers/sales.js already own the column order (tableColumns), the filtering
// (filterRows) and the totals (summary); the /api/bills route serves the table
// from exactly those three, and so does this. A file whose columns drifted
// from the screen's would be discovered by whoever she sent it to.
//
// ── THE SPREADSHEET GETS NUMBERS, NOT FORMATTED STRINGS ─────────────────────
// "$12,345.67" in a cell is text: it will not sum, sort or chart, and the
// first thing anyone does with an exported ledger is add a column up. So every
// money and weight cell is written as a real number with a display format on
// it. It LOOKS like the screen and BEHAVES like a number, which is the whole
// point of exporting to a spreadsheet rather than to a picture of one.
//
// The price columns carry their unit in the number format — `$#,##0.000" /lb"`
// — because the unit is per ROW (she prices some suppliers by the pound and
// some by the tonne) and a column header cannot say it. A price of 0.32 that
// does not say /lb is the kind of figure someone multiplies by 2204 in good
// faith.
//
// ── THE PDF PAGINATES ───────────────────────────────────────────────────────
// Deliberately NOT through pdfFittedToOnePage. That fitter exists so an
// invoice does not spill a near-empty second page; a ledger of 492 bills
// squeezed onto one sheet would be unreadable. It still goes through
// helpers/pdfQueue, because the reason that queue exists — two people
// generating at once — applies more here than anywhere: this is the largest
// render in the app.

const LB_PER_MT = 2204.62262;

const cfgFor = (kind) => (kind === 'sales'
    ? { store: require('./sales'), listKey: 'sales', title: 'Invoice register', eyebrow: 'Edge Metals' }
    : { store: require('./bills'), listKey: 'bills', title: 'Purchase bills', eyebrow: 'Edge Metals' });

// Which columns hold what. Taken from the same lists the screen's ledgerCell
// consults (LEDGER_KINDS in dashboard/index.html), so a column that reads as
// money there reads as money here.
const MONEY = {
    bills: ['supplier_price', 'amount', 'trucking_amount', 'net_payable', 'balance'],
    sales: ['invoice_price', 'amount', 'commission_per_mt', 'commission_amount', 'received', 'balance'],
};
const WEIGHTS = {
    bills: ['gross', 'truck', 'container', 'chassis', 'boxes', 'total', 'net_lb', 'net_mt'],
    sales: ['weight', 'weight_mt', 'net_lb', 'net_mt'],
};
const PRICE = ['supplier_price', 'invoice_price'];

const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
};

// ── WHAT IS ON SCREEN ───────────────────────────────────────────────────────
// filterRows with the same query the table was drawn with, so "exactly what is
// on screen" is true rather than approximately true. summary() over the
// FILTERED rows, for the reason the /api/bills route gives: a totals row
// adding up rows that are not on the page is worse than no totals row.
function build(kind, query = {}) {
    const { store, title, eyebrow } = cfgFor(kind);
    const all = store.listWithTotals();
    const rows = store.filterRows(all, query || {});
    return {
        kind, title, eyebrow,
        rows,
        columns: store.tableColumns().filter(Boolean),
        summary: store.summary(rows),
        total_unfiltered: all.length,
        filters: Object.entries(query || {})
            .filter(([k, v]) => String(v || '').trim() !== '' && k !== 'format')
            .map(([k, v]) => `${k}: ${v}`),
    };
}

// The cell's value for a SPREADSHEET: a number where it is a number.
function cellValue(row, col, kind) {
    const v = row[col.key];
    if (col.key === 'photos') return Array.isArray(v) ? v.join(' ') : '';
    if ((MONEY[kind] || []).includes(col.key) || (WEIGHTS[kind] || []).includes(col.key)) {
        return num(v);   // null stays null — an empty cell, never a zero
    }
    return v === null || v === undefined ? '' : String(v);
}

function cellFormat(row, col, kind) {
    if (PRICE.includes(col.key)) {
        // Per row, because she prices some suppliers by the pound and some by
        // the tonne, and a number without its unit is the wrong number.
        const u = row.price_unit === 'lb' ? ' "/lb"' : row.price_unit === 'mt' ? ' "/MT"' : '';
        return `$#,##0.000${u}`;
    }
    if ((MONEY[kind] || []).includes(col.key)) return '$#,##0.00';
    if ((WEIGHTS[kind] || []).includes(col.key)) {
        return (col.key === 'net_mt' || col.key === 'weight_mt') ? '#,##0.000' : '#,##0';
    }
    return null;
}

async function toWorkbook(built, opts = {}) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Jarvis — Edge Metals';
    wb.created = new Date();
    const ws = wb.addWorksheet(built.title.slice(0, 31));

    const cols = built.columns;
    // A title block above the table, so a file found in six months says what
    // it is and what was filtered when it was made. Three rows, then the
    // header row — freeze below it so the headers stay put on a 492-row sheet.
    ws.addRow([built.title]);
    ws.addRow([`${built.rows.length} of ${built.total_unfiltered} rows`
        + (built.filters.length ? ` · filtered by ${built.filters.join(' · ')}` : ' · no filters')]);
    ws.addRow([`Exported ${opts.when || new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`]);
    ws.addRow([]);
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.getRow(2).font = { size: 10, color: { argb: 'FF666666' } };
    ws.getRow(3).font = { size: 10, color: { argb: 'FF666666' } };

    const headRow = ws.addRow(cols.map((c) => c.label));
    headRow.font = { bold: true };
    headRow.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
        c.border = { bottom: { style: 'thin' } };
        c.alignment = { wrapText: true, vertical: 'middle' };
    });
    ws.views = [{ state: 'frozen', ySplit: headRow.number }];

    for (const row of built.rows) {
        const r = ws.addRow(cols.map((c) => cellValue(row, c, built.kind)));
        cols.forEach((c, i) => {
            const fmt = cellFormat(row, c, built.kind);
            if (fmt) r.getCell(i + 1).numFmt = fmt;
        });
    }

    // ── AND THE TOTALS ROW THE SCREEN SHOWS ─────────────────────────────
    // Only the columns summary() actually reports. A total under a column it
    // knows nothing about would be a figure with no meaning, and on a
    // spreadsheet someone will use it.
    const s = built.summary || {};
    const totals = cols.map((c) => (Object.prototype.hasOwnProperty.call(s, c.key) ? num(s[c.key]) : null));
    if (totals.some((t) => t !== null)) {
        const tr = ws.addRow(totals);
        tr.font = { bold: true };
        tr.eachCell((c) => { c.border = { top: { style: 'thin' } }; });
        cols.forEach((c, i) => {
            const fmt = cellFormat({}, c, built.kind);
            if (fmt) tr.getCell(i + 1).numFmt = fmt.replace(/ "\/(lb|MT)"$/, '');
        });
        // The label goes in the first column that has no total under it, so
        // "TOTAL" never lands on top of a figure.
        const free = cols.findIndex((c, i) => totals[i] === null);
        if (free >= 0) tr.getCell(free + 1).value = 'TOTAL';
    }

    cols.forEach((c, i) => {
        const wid = Math.max(String(c.label || '').length + 2,
            ...built.rows.slice(0, 200).map((r) => String(cellValue(r, c, built.kind) ?? '').length + 2));
        ws.getColumn(i + 1).width = Math.min(Math.max(wid, 9), 34);
    });

    return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── THE PDF ─────────────────────────────────────────────────────────────────
const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (v) => (num(v) === null ? '' : '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (v, dp) => (num(v) === null ? '' : num(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));

function printedCell(row, col, kind) {
    const v = row[col.key];
    if (col.key === 'photos') return Array.isArray(v) && v.length ? `${v.length} link${v.length === 1 ? '' : 's'}` : '';
    if (PRICE.includes(col.key)) {
        if (num(v) === null) return '';
        const u = row.price_unit === 'lb' ? '/lb' : row.price_unit === 'mt' ? '/MT' : '';
        return esc('$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + (u ? ' ' + u : ''));
    }
    if ((MONEY[kind] || []).includes(col.key)) return esc(money(v));
    if ((WEIGHTS[kind] || []).includes(col.key)) {
        return esc(qty(v, (col.key === 'net_mt' || col.key === 'weight_mt') ? 3 : 0));
    }
    return esc(v === null || v === undefined ? '' : v);
}

function toHtml(built, opts = {}) {
    const cols = built.columns;
    const rightish = (c) => (MONEY[built.kind] || []).includes(c.key)
        || (WEIGHTS[built.kind] || []).includes(c.key) || PRICE.includes(c.key);
    const s = built.summary || {};
    const totalCells = cols.map((c) => (Object.prototype.hasOwnProperty.call(s, c.key)
        ? printedCell(s, c, built.kind) : ''));
    const free = totalCells.findIndex((t) => !t);
    if (free >= 0) totalCells[free] = 'TOTAL';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 10mm 8mm; }
  body { font-family: Helvetica, Arial, sans-serif; color:#111; margin:0; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  .sub { font-size: 8.5pt; color:#555; margin-bottom: 4mm; }
  table { width:100%; border-collapse: collapse; font-size: 7.5pt; }
  /* thead repeats on every page — a 492-row ledger whose columns are named
     only on page one is a table nobody can read past page one. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background:#EFEFEF; border-bottom:0.6pt solid #333; padding:1.6mm 1.2mm;
       text-align:left; font-size:7pt; text-transform:uppercase; letter-spacing:.04em; }
  td { border-bottom:0.3pt solid #DDD; padding:1.4mm 1.2mm; white-space:nowrap; }
  .r { text-align:right; }
  tfoot td { border-top:0.8pt solid #333; border-bottom:none; font-weight:700; font-size:8pt; padding:2mm 1.2mm; }
  tfoot { display: table-footer-group; }
</style></head><body>
  <h1>${esc(built.title)}</h1>
  <div class="sub">${esc(built.eyebrow)} &middot; ${built.rows.length} of ${built.total_unfiltered} rows`
   + `${built.filters.length ? ' &middot; ' + esc(built.filters.join(' · ')) : ' &middot; no filters'}`
   + ` &middot; exported ${esc(opts.when || new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))}</div>
  <table>
    <thead><tr>${cols.map((c) => `<th class="${rightish(c) ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${built.rows.map((row) => `<tr>${cols.map((c) =>
        `<td class="${rightish(c) ? 'r' : ''}">${printedCell(row, c, built.kind)}</td>`).join('')}</tr>`).join('')}
      ${built.rows.length ? '' : `<tr><td colspan="${cols.length}" style="padding:8mm;text-align:center;color:#888;">Nothing matches these filters.</td></tr>`}
    </tbody>
    ${totalCells.some(Boolean) ? `<tfoot><tr>${cols.map((c, i) =>
        `<td class="${rightish(c) ? 'r' : ''}">${totalCells[i]}</td>`).join('')}</tr></tfoot>` : ''}
  </table>
</body></html>`;
}

// Renderer injected for the same reason every other PDF path in this codebase
// injects it: Chromium cannot launch in the test sandbox (x86 binaries, ARM
// host), and a document helper that can only be tested by launching a browser
// is a document helper that does not get tested.
async function toPdf(built, opts = {}) {
    const html = toHtml(built, opts);
    if (opts.renderer) return opts.renderer(html);
    return require('./pdfQueue').run(async () => {
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({ headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        try {
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'networkidle0' });
            // NOT pdfFittedToOnePage. See the note at the top of this file.
            const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
            return Buffer.from(pdf);
        } finally { await browser.close(); }
    }, `ledger ${built.kind}`);
}

// One place that names the file, so the xlsx and the pdf of the same view are
// obviously the same view.
function filenameFor(built, ext) {
    const when = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const base = built.kind === 'sales' ? 'Invoices' : 'Bills';
    const filtered = built.filters.length ? '_filtered' : '';
    return `${base}_${when}${filtered}.${ext}`;
}

module.exports = { build, toWorkbook, toHtml, toPdf, filenameFor, cellValue, cellFormat, printedCell, LB_PER_MT };
