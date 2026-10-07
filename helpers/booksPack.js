// ── helpers/booksPack.js ──────────────────────────────────────────────────
// Apsara chose what the books are FOR, 2026-10-06: "The year-end pack for
// your CPA", and who reads it first: "You, then your CPA."
//
// The portal shows the statements on screen. Nothing could get them out of
// the browser, which means the stated purpose of the whole books stack —
// entities, chartOfAccounts, postings, statements, booksBuild, booksAgent —
// stopped one step short of the thing she asked for.
//
// ── ONE WORKBOOK, ONE COMPANY ────────────────────────────────────────────
// Edge Metals, Edge Trading and AAA Investment file separately (CLAUDE.md
// rule 5), so a pack covers ONE of them. statements.js already refuses to
// combine companies — "there is no combined taxpayer" — and a workbook with a
// tab per company would be read as a group return by the first person who
// opened it.
//
// ── THE FINDINGS SHEET IS NOT OPTIONAL ───────────────────────────────────
// It is the first sheet, before any figure. A journal missing rows produces a
// profit SMALLER than the truth and looks exactly like a correct one, and a
// CPA cannot tell by looking. Sending a clean-looking pack built from an
// incomplete journal is the one genuinely expensive thing this module could
// do, so the pack says so on page one and in the filename.
//
// Follows helpers/ledgerExport.js for the ExcelJS conventions — title block,
// frozen header, number formats on the money columns — rather than inventing
// a second house style for the same workbook library.

const E = require('./entities');
const S = require('./statements');
const A = require('./booksAgent');

const MONEY = '$#,##0.00';
const num = (n) => (n === null || n === undefined || n === '' || isNaN(Number(n)) ? null : Number(n));

const GREY = { font: { size: 10, color: { argb: 'FF666666' } } };

// A filename someone can find in six months, and which says on its face
// whether the figures inside were complete. "DRAFT" is in the name because a
// file gets forwarded without the email that explained it.
function filenameFor({ entity, from, to, complete }) {
    const ent = E.get(entity);
    const who = String((ent && ent.uiName) || entity).replace(/[^A-Za-z0-9]+/g, '-');
    const span = from && to ? `${from}_to_${to}` : (to || from || 'all-dates');
    return `Books-${who}-${span}${complete ? '' : '-DRAFT-INCOMPLETE'}.xlsx`;
}

function titleBlock(ws, lines) {
    lines.forEach((t, i) => {
        const r = ws.addRow([t]);
        if (i === 0) r.font = { bold: true, size: 14 };
        else Object.assign(r, GREY);
    });
    ws.addRow([]);
}

function headerRow(ws, labels) {
    const r = ws.addRow(labels);
    r.font = { bold: true };
    r.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
        c.border = { bottom: { style: 'thin' } };
        c.alignment = { wrapText: true, vertical: 'middle' };
    });
    ws.views = [{ state: 'frozen', ySplit: r.number }];
    return r;
}

const widths = (ws, w) => { w.forEach((n, i) => { ws.getColumn(i + 1).width = n; }); };

function moneyCols(ws, fromRow, cols) {
    for (let i = fromRow; i <= ws.rowCount; i += 1) {
        for (const c of cols) ws.getRow(i).getCell(c).numFmt = MONEY;
    }
}

function totalRow(ws, cells) {
    const r = ws.addRow(cells);
    r.font = { bold: true };
    r.eachCell((c) => { c.border = { top: { style: 'thin' } }; });
    return r;
}

// ── THE PACK ──────────────────────────────────────────────────────────────
// `built` is helpers/booksBuild.js's return, so the workbook and whatever the
// screen is showing come from the SAME journal. Building a second one here
// could hand her CPA figures that differ from the ones she just read.
async function toWorkbook(built, { entity, from = null, to = null, when = null } = {}) {
    const ent = E.get(entity);
    if (!ent) throw new Error(`no company ${entity}`);
    const packed = S.pack(built.lines, { entity, from, to });
    const verdict = A.review(built, { entity, from, to });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Jarvis';
    wb.company = ent.legalName || ent.uiName;
    wb.created = new Date();

    const stamp = when || new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const span = `${from || 'the beginning'} to ${to || 'today'}`;
    // The LEGAL name on every sheet, not the short one. Edge Trading trades
    // as "Edge Yard"; a filing in that name would be wrong.
    const legal = ent.legalName || ent.uiName;
    const head = (extra) => [
        `${legal}${ent.taxId ? ` · EIN ${ent.taxId}` : ''}`,
        extra,
        `${span} · prepared by Jarvis ${stamp} · figures derived from source records, not stored`,
    ];

    // ── 1. READ THIS FIRST ────────────────────────────────────────────────
    {
        const ws = wb.addWorksheet('Read first');
        titleBlock(ws, head(verdict.trustworthy
            ? 'The books balance and nothing is unplaced.'
            : 'THESE FIGURES ARE NOT READY TO FILE — see below.'));
        ws.getRow(2).font = verdict.trustworthy
            ? { size: 11, color: { argb: 'FF2E861F' } }
            : { size: 11, bold: true, color: { argb: 'FFC5402F' } };

        ws.addRow([verdict.summary || A.summary(verdict)]);
        ws.addRow([]);
        if (!ent.taxId) {
            ws.addRow([`NOTE: ${legal} has no tax ID on file in Jarvis, so it is missing from `
                + 'these sheets. Give it to Jarvis and re-export before filing.']);
            ws.lastRow.font = { color: { argb: 'FFD99A2B' } };
            ws.addRow([]);
        }

        headerRow(ws, ['Severity', 'What', 'Why it matters', 'What to do', 'Where']);
        if (!verdict.findings.length) {
            ws.addRow(['—', 'Nothing found', 'The trial balance balances, every account is in the '
                + 'chart, and every row was placed on a company.', '', '']);
        }
        for (const f of verdict.findings) {
            const r = ws.addRow([f.severity, f.what, f.why, f.fix, f.where || '']);
            r.alignment = { wrapText: true, vertical: 'top' };
            if (f.severity === 'blocker') r.getCell(1).font = { bold: true, color: { argb: 'FFC5402F' } };
            else if (f.severity === 'high') r.getCell(1).font = { bold: true, color: { argb: 'FFD99A2B' } };
        }
        widths(ws, [11, 46, 62, 62, 28]);
    }

    // ── 2. PROFIT AND LOSS ────────────────────────────────────────────────
    {
        const p = packed.profitAndLoss;
        const ws = wb.addWorksheet('Profit and Loss');
        titleBlock(ws, head('Profit and Loss'));
        headerRow(ws, ['Account', 'Name', 'Amount']);
        const first = ws.rowCount + 1;
        const block = (label, list, total) => {
            const h = ws.addRow(['', label, null]);
            h.font = { bold: true };
            for (const a of list) ws.addRow([a.code, a.name, num(a.balance)]);
            totalRow(ws, ['', `Total ${label.toLowerCase()}`, num(total)]);
        };
        block('Income', p.income, p.incomeTotal);
        block('Cost of material sold', p.cogs, p.cogsTotal);
        totalRow(ws, ['', 'GROSS PROFIT', num(p.grossProfit)]);
        block('Expenses', p.expense, p.expenseTotal);
        totalRow(ws, ['', 'NET INCOME', num(p.netIncome)]);
        moneyCols(ws, first, [3]);
        widths(ws, [10, 44, 16]);
    }

    // ── 3. BALANCE SHEET ──────────────────────────────────────────────────
    {
        const b = packed.balanceSheet;
        const ws = wb.addWorksheet('Balance Sheet');
        titleBlock(ws, head(`Balance Sheet as at ${to || 'today'}`));
        headerRow(ws, ['Account', 'Name', 'Amount']);
        const first = ws.rowCount + 1;
        const block = (label, list, total) => {
            const h = ws.addRow(['', label, null]);
            h.font = { bold: true };
            for (const a of list) ws.addRow([a.code, a.name, num(a.balance)]);
            totalRow(ws, ['', `Total ${label.toLowerCase()}`, num(total)]);
        };
        block('Assets', b.assets, b.assetTotal);
        block('Liabilities', b.liabilities, b.liabilityTotal);
        block('Equity', b.equity, b.equityTotal);
        ws.addRow(['', 'Net income for the period', num(b.netIncome)]);
        totalRow(ws, ['', 'Liabilities, equity and profit', num(b.rightSide)]);
        if (!b.balances) {
            const r = totalRow(ws, ['', 'OUT OF BALANCE BY', num(b.difference)]);
            r.font = { bold: true, color: { argb: 'FFC5402F' } };
        }
        moneyCols(ws, first, [3]);
        widths(ws, [10, 44, 16]);
    }

    // ── 4. TRIAL BALANCE ──────────────────────────────────────────────────
    {
        const t = packed.trialBalance;
        const ws = wb.addWorksheet('Trial Balance');
        titleBlock(ws, head(t.balanced ? 'Trial Balance — balanced'
                                       : 'Trial Balance — DOES NOT BALANCE'));
        headerRow(ws, ['Account', 'Name', 'Type', 'Debit', 'Credit', 'Balance']);
        const first = ws.rowCount + 1;
        for (const a of t.accounts) {
            ws.addRow([a.code, a.name, a.type, num(a.debit), num(a.credit), num(a.balance)]);
        }
        // Accounts the chart has never heard of are listed here, not dropped.
        // The trial balance still balances with them in it, so leaving them
        // out of the pack is how the money disappears quietly.
        for (const u of (t.unknown || [])) {
            const r = ws.addRow([u.code, 'NOT IN THE CHART OF ACCOUNTS', '',
                num(u.debit), num(u.credit), null]);
            r.font = { color: { argb: 'FFC5402F' } };
        }
        totalRow(ws, ['', 'Total', '', num(t.debit), num(t.credit), null]);
        moneyCols(ws, first, [4, 5, 6]);
        widths(ws, [10, 44, 12, 16, 16, 16]);
    }

    // ── 5. GENERAL LEDGER — every account, every entry ────────────────────
    // The sheet a CPA actually works in: one flat list they can filter, which
    // is why it is not one tab per account.
    {
        const ws = wb.addWorksheet('General Ledger');
        titleBlock(ws, head('General Ledger — every entry, every account'));
        headerRow(ws, ['Account', 'Name', 'Date', 'What', 'Who', 'Memo', 'Debit', 'Credit', 'Running']);
        const first = ws.rowCount + 1;
        for (const a of packed.trialBalance.accounts) {
            const g = S.generalLedger(built.lines, { entity, from, to, account: a.code });
            for (const e of g.entries) {
                ws.addRow([a.code, a.name, e.date || '', e.kind || '', e.party || '',
                    e.memo || '', num(e.debit), num(e.credit), num(e.running)]);
            }
        }
        moneyCols(ws, first, [7, 8, 9]);
        widths(ws, [10, 34, 12, 20, 24, 30, 15, 15, 15]);
        ws.autoFilter = { from: { row: first - 1, column: 1 }, to: { row: ws.rowCount, column: 9 } };
    }

    // ── 6. WHAT COULD NOT BE PLACED ───────────────────────────────────────
    // Only when there is something to say. An empty sheet titled "Unplaced"
    // in a clean pack invites the question it cannot answer.
    if ((built.unplaced || []).length) {
        const ws = wb.addWorksheet('Unplaced rows');
        titleBlock(ws, head(`${built.unplaced.length} rows are on NO company, so they are on no `
            + 'statement in this pack'));
        headerRow(ws, ['Store', 'Row id', 'Why it could not be placed', 'The row']);
        for (const u of built.unplaced) {
            const row = u.row || {};
            ws.addRow([u.store || '', row.id || '', u.why || '',
                JSON.stringify(row).slice(0, 500)]);
        }
        widths(ws, [20, 20, 52, 90]);
    }

    return {
        workbook: wb,
        filename: filenameFor({ entity, from, to, complete: built.complete && verdict.trustworthy }),
        verdict,
        sheets: wb.worksheets.map((w) => w.name),
    };
}

module.exports = { toWorkbook, filenameFor };
