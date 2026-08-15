// ── helpers/inventoryExcel.js — daily inventory backup workbook ─────────────
// Per Apsara 2026-08-15: "as a backup, an excel should be created to track
// this inventory. in tabs, per day inventory should be updated. summing the
// per day inventory, overall inventory should be calculated." Follow-up
// clarification, verbatim: "last 5 day tab loads and one overall sheet" —
// a literal one-tab-per-calendar-day workbook would grow forever (300+ tabs
// after a year, unusable to navigate/open); a rolling window of the 5 most
// recent days' tabs plus one "Overall" tab (which covers EVERY day, not just
// the 5 shown as tabs) was the agreed middle ground.
//
// Every number in here comes from helpers/loads.js's getInventoryReport() —
// the SAME function the dashboard/mobile Inventory tab calls — so this
// workbook can never disagree with what's on screen. Nothing is stored or
// accumulated separately; the whole file is rebuilt from loads.json fresh
// every time buildInventoryWorkbook() runs (see scheduler.js's nightly job).

const ExcelJS = require('exceljs');
const { getInventoryReport } = require('./loads');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

function writeItemTypeTable(sheet, startRow, title, byType, unit) {
  sheet.getCell(`A${startRow}`).value = title;
  sheet.getCell(`A${startRow}`).font = { bold: true, size: 12 };
  const headerRow = startRow + 1;
  const headers = ['Item type', 'Items', `Gross (${unit})`, `Tare (${unit})`, `Net (${unit})`, 'Amount ($)'];
  headers.forEach((h, i) => {
    const cell = sheet.getRow(headerRow).getCell(i + 1);
    cell.value = h;
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
  let r = headerRow + 1;
  if (!byType.length) {
    sheet.getCell(`A${r}`).value = 'No items.';
    r += 1;
  } else {
    for (const g of byType) {
      const row = sheet.getRow(r);
      row.getCell(1).value = g.description;
      row.getCell(2).value = g.count;
      row.getCell(3).value = g.gross;
      row.getCell(4).value = g.tare;
      row.getCell(5).value = g.net;
      row.getCell(6).value = g.amount;
      r += 1;
    }
  }
  return r + 1; // next free row, with one blank row of spacing
}

function writeDailyRollupTable(sheet, startRow, byDay, unit) {
  sheet.getCell(`A${startRow}`).value = 'Daily totals — all-time (every day recorded, not just the last 5 tabs)';
  sheet.getCell(`A${startRow}`).font = { bold: true, size: 12 };
  const headerRow = startRow + 1;
  ['Date', 'Loads', `Net (${unit})`, 'Amount ($)'].forEach((h, i) => {
    const cell = sheet.getRow(headerRow).getCell(i + 1);
    cell.value = h;
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
  let r = headerRow + 1;
  for (const d of byDay) {
    const row = sheet.getRow(r);
    row.getCell(1).value = d.date;
    row.getCell(2).value = d.loadCount;
    row.getCell(3).value = d.net;
    row.getCell(4).value = d.amount;
    r += 1;
  }
  return r;
}

function writeSellerTable(sheet, startRow, bySeller, unit) {
  sheet.getCell(`A${startRow}`).value = 'By seller — all-time';
  sheet.getCell(`A${startRow}`).font = { bold: true, size: 12 };
  const headerRow = startRow + 1;
  ['Seller', 'Loads', `Net (${unit})`, 'Amount ($)'].forEach((h, i) => {
    const cell = sheet.getRow(headerRow).getCell(i + 1);
    cell.value = h;
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
  let r = headerRow + 1;
  for (const s of bySeller) {
    const row = sheet.getRow(r);
    row.getCell(1).value = s.seller;
    row.getCell(2).value = s.loadCount;
    row.getCell(3).value = s.net;
    row.getCell(4).value = s.amount;
    r += 1;
  }
  return r;
}

function setColumnWidths(sheet) {
  sheet.columns = [{ width: 26 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
}

// Excel sheet names can't contain [ ] : * ? / \ and max out at 31 chars —
// dates like "2026-08-15" are always safe, but this guards against any
// future date format change silently corrupting the workbook.
function safeSheetName(name) {
  return String(name).replace(/[\[\]:*?/\\]/g, '-').slice(0, 31) || 'Sheet';
}

function buildInventoryWorkbook(allLoads) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jarvis — Edge Yard';
  wb.created = new Date();

  const overall = getInventoryReport(allLoads, {});
  const recentDates = overall.byDay.map(d => d.date).filter(d => d && d !== 'Unknown date').slice(0, 5);

  for (const date of recentDates) {
    const dayReport = getInventoryReport(allLoads, { from: date, to: date });
    const sheet = wb.addWorksheet(safeSheetName(date));
    setColumnWidths(sheet);
    const next = writeItemTypeTable(sheet, 1, `${date} — ${dayReport.loadCount} load${dayReport.loadCount === 1 ? '' : 's'}`, dayReport.byType, dayReport.unit);
    writeSellerTable(sheet, next, dayReport.bySeller, dayReport.unit);
  }

  const overallSheet = wb.addWorksheet('Overall');
  setColumnWidths(overallSheet);
  let next = writeItemTypeTable(overallSheet, 1, `All-time — ${overall.loadCount} load${overall.loadCount === 1 ? '' : 's'}`, overall.byType, overall.unit);
  next = writeSellerTable(overallSheet, next, overall.bySeller, overall.unit);
  next += 1;
  writeDailyRollupTable(overallSheet, next, overall.byDay, overall.unit);

  return wb;
}

async function inventoryWorkbookBuffer(allLoads) {
  const wb = buildInventoryWorkbook(allLoads);
  return wb.xlsx.writeBuffer();
}

// ── On-demand export — dashboard/mobile Inventory tab's "⋮" export menu ────
// Per Apsara 2026-08-15: "there should be an export option on the top with
// three dotted emoji. when i click that export as excel/pdf." Distinct from
// buildInventoryWorkbook above (the FIXED nightly "last 5 days + Overall"
// backup) — this reflects exactly whatever date range is currently applied
// on screen, computed with the SAME getInventoryReport() call the Inventory
// tab itself uses, so the download can never disagree with what's visible.
// One sheet, three stacked tables (item type / seller / per-day), matching
// the three sub-tabs that have a table shape (the fourth, "Load summary",
// is a handful of totals already implied by the item-type table's own
// column sums, so it isn't a separate section here).
function buildFilteredInventoryWorkbook(report, rangeLabel) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jarvis — Edge Yard';
  wb.created = new Date();
  const sheet = wb.addWorksheet(safeSheetName(rangeLabel));
  setColumnWidths(sheet);
  let next = writeItemTypeTable(sheet, 1, `${rangeLabel} — ${report.loadCount} load${report.loadCount === 1 ? '' : 's'}`, report.byType, report.unit);
  next = writeSellerTable(sheet, next, report.bySeller, report.unit);
  next += 1;
  writeDailyRollupTable(sheet, next, report.byDay, report.unit);
  return wb;
}

async function filteredInventoryWorkbookBuffer(report, rangeLabel) {
  const wb = buildFilteredInventoryWorkbook(report, rangeLabel);
  return wb.xlsx.writeBuffer();
}

module.exports = { buildInventoryWorkbook, inventoryWorkbookBuffer, buildFilteredInventoryWorkbook, filteredInventoryWorkbookBuffer };
