// ── helpers/spendExport.js — the Spend report as a spreadsheet ────────────
//
// Apsara, 2026-11-07: "export as xls and pdf".
//
// ── THE EXPORT IS THE REPORT, NOT A SECOND REPORT ────────────────────────
// Nothing here queries anything. It is handed the finished report object
// that routes/reports.js already built from her query string — the same
// object the screen draws — and lays it out. That is deliberate: the one way
// an export goes wrong is by being a DIFFERENT report from the page the
// button was pressed on, and it goes wrong silently, in a file she sends to
// an accountant.
//
// ── THE FILTERS ARE ON THE FIRST SHEET, AT THE TOP ──────────────────────
// A spreadsheet with no period and no company on it is a column of numbers
// that cannot be checked against anything a month later. Every filter that
// was on is written out in words before a single figure.
//
// ── AND "NOT RECORDED" IS NEVER DROPPED ─────────────────────────────────
// Same rule as the screen and as helpers/spendReport.js: a breakdown that
// quietly omits the rows it cannot name disagrees with its own total. It is
// exported as a row like any other, because it is money that moved.
const ExcelJS = require('exceljs');

const INK = 'FF1F2937';
const MUTED = 'FF6B7280';
const RULE = 'FFE5E7EB';
const GAP = 'FFB45309';          // the amber the screen uses for a gap
const NOT_RECORDED = 'Not recorded';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const MONEY = '#,##0.00';

function titleRow(ws, text) {
    const r = ws.addRow([text]);
    r.font = { bold: true, size: 11, color: { argb: INK } };
    r.getCell(1).alignment = { vertical: 'middle' };
    return r;
}

function headerRow(ws, cells) {
    const r = ws.addRow(cells);
    r.font = { bold: true, size: 9, color: { argb: MUTED } };
    r.eachCell((c) => {
        c.border = { bottom: { style: 'thin', color: { argb: RULE } } };
    });
    return r;
}

// One breakdown — a name, its money, its share — with the gap row flagged.
function breakdown(ws, title, obj, ofTotal) {
    const keys = Object.keys(obj || {});
    if (!keys.length) return;
    ws.addRow([]);
    titleRow(ws, title);
    headerRow(ws, ['', 'Amount', 'Share']);
    const of = num(ofTotal) || keys.reduce((a, k) => a + num(obj[k]), 0);
    for (const k of keys.sort((a, b) => num(obj[b]) - num(obj[a]))) {
        const r = ws.addRow([k, num(obj[k]), of ? num(obj[k]) / of : 0]);
        r.getCell(2).numFmt = MONEY;
        r.getCell(3).numFmt = '0.0%';
        if (k === NOT_RECORDED) r.font = { color: { argb: GAP }, bold: true };
    }
    // The total, so the sheet proves its own arithmetic rather than asking
    // her to add a column up to check it.
    const t = ws.addRow(['Total', keys.reduce((a, k) => a + num(obj[k]), 0), 1]);
    t.font = { bold: true, color: { argb: INK } };
    t.getCell(2).numFmt = MONEY;
    t.getCell(3).numFmt = '0.0%';
}

function buildSpendWorkbook(rep, label) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Jarvis';
    wb.created = new Date();

    // ── 1. SUMMARY ───────────────────────────────────────────────────────
    const s = wb.addWorksheet('Summary');
    s.columns = [{ width: 34 }, { width: 16 }, { width: 10 }];
    titleRow(s, 'Spend report');
    const sub = s.addRow([label || '']);
    sub.font = { size: 9, color: { argb: MUTED } };
    s.addRow([]);

    const out = s.addRow(['Money out', num(rep.total)]);
    out.font = { bold: true };
    out.getCell(2).numFmt = MONEY;
    s.addRow(['Entries', num(rep.count)]);
    if (rep.received && num(rep.received.total)) {
        const inR = s.addRow(['Money received (kept apart)', num(rep.received.total)]);
        inR.getCell(2).numFmt = MONEY;
        s.addRow(['Sale payments', num(rep.received.count)]);
    }

    // WHERE IT WENT — every part, and they add to the total. The screen's
    // own rule: the heading used to show two of six and leave 55% unnamed.
    const PARTS = [
        ['Paid to sellers', rep.loadTotal], ['Trucking', rep.truckerTotal],
        ['Suppliers', rep.supplierTotal], ['Cost of sales', rep.saleCostTotal],
        ['Edge Metals haulage', rep.metalsTruckingTotal], ['Expenses', rep.expenseTotal],
    ].filter(([, v]) => Math.abs(num(v)) > 0.005);
    if (PARTS.length) {
        s.addRow([]);
        titleRow(s, 'Where it went');
        headerRow(s, ['', 'Amount', 'Share']);
        for (const [k, v] of PARTS) {
            const r = s.addRow([k, num(v), num(rep.total) ? num(v) / num(rep.total) : 0]);
            r.getCell(2).numFmt = MONEY;
            r.getCell(3).numFmt = '0.0%';
        }
        const sum = PARTS.reduce((a, [, v]) => a + num(v), 0);
        const t = s.addRow(['Total', sum, 1]);
        t.font = { bold: true };
        t.getCell(2).numFmt = MONEY;
        t.getCell(3).numFmt = '0.0%';
        // If the parts ever stop reconciling, SAY SO in the file. A tidy
        // column that is quietly short is the fault this card exists to
        // have stopped.
        if (Math.abs(sum - num(rep.total)) > 0.01) {
            const w = s.addRow([`These parts come to ${sum.toFixed(2)}, not ${num(rep.total).toFixed(2)} — do not file from this sheet until it is found.`]);
            w.font = { bold: true, color: { argb: 'FFC53030' } };
        }
    }

    breakdown(s, 'Out of each account', rep.byBank, rep.total);
    breakdown(s, 'Whose money it was', rep.byPaidVia, rep.total);
    breakdown(s, 'Whom we buy from', rep.byBoughtFrom, rep.total);
    if (rep.received && num(rep.received.total)) {
        breakdown(s, 'Whom we sell to (of money received)', rep.bySoldTo, rep.received.total);
    }

    if (rep.cash) {
        s.addRow([]);
        titleRow(s, 'Petty cash over this period');
        for (const [k, v] of [['Opened', rep.cash.opening], ['Cash in', rep.cash.in],
                              ['Cash out', rep.cash.out], ['Should hold', rep.cash.closing]]) {
            const r = s.addRow([k, num(v)]);
            r.getCell(2).numFmt = MONEY;
        }
    }

    // ── 2. BY MONTH ──────────────────────────────────────────────────────
    const cols = rep.columns || [];
    if ((rep.months || []).length) {
        const m = wb.addWorksheet('By month');
        m.columns = [{ width: 12 }, ...cols.map(() => ({ width: 14 })), { width: 16 }];
        headerRow(m, ['Month', ...cols, 'Total']);
        for (const row of rep.months) {
            const r = m.addRow([row.month, ...cols.map((c) => num(row[c])), num(row.total)]);
            for (let i = 2; i <= cols.length + 2; i++) r.getCell(i).numFmt = MONEY;
        }
        const t = m.addRow(['All months', ...cols.map((c) => num((rep.byMethod || {})[c])), num(rep.total)]);
        t.font = { bold: true };
        for (let i = 2; i <= cols.length + 2; i++) t.getCell(i).numFmt = MONEY;
    }

    // ── 3. EVERY ENTRY ───────────────────────────────────────────────────
    // The rows behind every figure above, so a number she doubts can be
    // taken apart without opening Jarvis.
    const e = wb.addWorksheet('Entries');
    e.columns = [{ width: 12 }, { width: 14 }, { width: 28 }, { width: 24 },
                 { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
    headerRow(e, ['Date', 'Kind', 'Counterparty', 'Reference',
                  'Paid by', 'Out of', 'Paid via', 'Amount']);
    for (const r of (rep.rows || [])) {
        const row = e.addRow([r.date || '', r.kind || '', r.party || NOT_RECORDED,
            r.label || '', r.method || '', r.bank || NOT_RECORDED,
            r.paid_via || NOT_RECORDED, num(r.amount)]);
        row.getCell(8).numFmt = MONEY;
    }
    if (rep.received && (rep.received.rows || []).length) {
        e.addRow([]);
        titleRow(e, 'Received from buyers — money IN, never added to the figures above');
        headerRow(e, ['Date', 'Kind', 'Counterparty', 'Reference',
                      'Paid by', 'Out of', 'Paid via', 'Amount']);
        for (const r of rep.received.rows) {
            const row = e.addRow([r.date || '', 'sale', r.party || NOT_RECORDED,
                r.label || '', r.method || '', '', '', num(r.amount)]);
            row.getCell(8).numFmt = MONEY;
        }
    }

    return wb;
}

async function spendWorkbookBuffer(rep, label) {
    const wb = buildSpendWorkbook(rep || {}, label);
    return wb.xlsx.writeBuffer();
}

module.exports = { buildSpendWorkbook, spendWorkbookBuffer, NOT_RECORDED };
