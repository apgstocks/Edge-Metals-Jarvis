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

// ── Monthly per-day workbook ────────────────────────────────────────────────
// Per Apsara 2026-08-19: "for daily basis, i want a new excel to track the
// daily loads. keep on adding daily loads. that excel should be used for
// monthly basis - august month 31 days - 31 tabs if loaded today."
//
// So: ONE workbook per calendar month, one tab per DAY OF THAT MONTH, and
// each tab holds one row per LINE ITEM (her choice over one-row-per-load).
// Distinct from buildInventoryWorkbook above, which is the rolling
// "last 5 days + Overall" inventory rollup — this one is a chronological
// record of the loads themselves, not an item-type rollup.
//
// Tabs are created only for days that actually have loads. A pre-created
// tab for every one of the 31 days would mean opening a workbook that is
// mostly empty sheets, and would also mean the file changes shape on the
// 1st of a month for no reason; "31 tabs if loaded today" is satisfied by
// a month in which all 31 days have loads. Days are ordered oldest-first
// so the tab strip reads left-to-right as the month progresses.
const MONTH_ITEM_COLUMNS = [
  { header: 'Load #',      width: 14, key: 'loadId' },
  { header: 'Seller',      width: 26, key: 'seller' },
  { header: 'Item',        width: 26, key: 'description' },
  { header: 'Gross',       width: 12, key: 'gross_weight' },
  { header: 'Tare',        width: 12, key: 'tare_weight' },
  { header: 'Net',         width: 12, key: 'net_weight' },
  { header: 'Price',       width: 12, key: 'price' },
  { header: 'Amount',      width: 14, key: 'amount' },
];

function writeMonthDaySheet(sheet, date, loadsForDay, unit) {
  sheet.columns = MONTH_ITEM_COLUMNS.map(c => ({ width: c.width }));

  const loadCount = loadsForDay.length;
  const title = sheet.getCell('A1');
  title.value = `${date} — ${loadCount} load${loadCount === 1 ? '' : 's'} (weights in ${unit})`;
  title.font = { bold: true, size: 12 };
  sheet.mergeCells(1, 1, 1, MONTH_ITEM_COLUMNS.length);

  const headerRow = sheet.getRow(3);
  MONTH_ITEM_COLUMNS.forEach((c, i) => { headerRow.getCell(i + 1).value = c.header; });
  headerRow.font = { bold: true };
  headerRow.commit();

  let r = 4;
  let totGross = 0, totTare = 0, totNet = 0, totAmount = 0;
  for (const load of loadsForDay) {
    const items = Array.isArray(load.items) ? load.items : [];
    if (!items.length) continue;
    for (const it of items) {
      const row = sheet.getRow(r);
      row.getCell(1).value = load.id || '';
      row.getCell(2).value = load.seller || '';
      row.getCell(3).value = it.description || '';
      row.getCell(4).value = it.gross_weight ?? null;
      row.getCell(5).value = it.tare_weight ?? null;
      row.getCell(6).value = it.net_weight ?? null;
      row.getCell(7).value = it.price ?? null;
      row.getCell(8).value = it.amount ?? null;
      row.getCell(7).numFmt = '"$"#,##0.00';
      row.getCell(8).numFmt = '"$"#,##0.00';
      row.commit();
      totGross += it.gross_weight || 0;
      totTare += it.tare_weight || 0;
      totNet += it.net_weight || 0;
      totAmount += it.amount || 0;
      r += 1;
    }
  }

  const totals = sheet.getRow(r);
  totals.getCell(1).value = 'TOTAL';
  totals.getCell(4).value = round2(totGross);
  totals.getCell(5).value = round2(totTare);
  totals.getCell(6).value = round2(totNet);
  totals.getCell(8).value = round2(totAmount);
  totals.getCell(8).numFmt = '"$"#,##0.00';
  totals.font = { bold: true };
  totals.commit();
}

// Float noise guard — the same reason helpers/loads.js rounds its own
// sums; adding several amounts can yield 350.00000000000006.
function round2(n) {
  return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : n;
}

// monthKey: 'YYYY-MM'. Returns an ExcelJS workbook covering only that month.
function buildMonthlyLoadsWorkbook(allLoads, monthKey) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jarvis — Edge Yard';
  wb.created = new Date();

  const inMonth = (allLoads || []).filter(l => l.date && String(l.date).startsWith(monthKey));
  const unit = inMonth.find(l => l.weight_unit)?.weight_unit || 'lb';

  const byDate = new Map();
  for (const l of inMonth) {
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date).push(l);
  }
  // Oldest-first so the tab strip reads chronologically left to right.
  const dates = Array.from(byDate.keys()).sort();

  if (!dates.length) {
    const empty = wb.addWorksheet(safeSheetName(monthKey));
    empty.getCell('A1').value = `No loads recorded for ${monthKey} yet.`;
    empty.getCell('A1').font = { bold: true };
    return wb;
  }

  for (const date of dates) {
    // Tab named by day-of-month ("01".."31") rather than the full date:
    // the workbook is already scoped to one month by its filename, so
    // repeating the year/month in all 31 tab names just makes the strip
    // harder to scan.
    const dayLabel = String(date).slice(8, 10) || date;
    writeMonthDaySheet(wb.addWorksheet(safeSheetName(dayLabel)), date, byDate.get(date), unit);
  }
  return wb;
}

async function monthlyLoadsWorkbookBuffer(allLoads, monthKey) {
  const wb = buildMonthlyLoadsWorkbook(allLoads, monthKey);
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

module.exports = { buildInventoryWorkbook, inventoryWorkbookBuffer, buildFilteredInventoryWorkbook, filteredInventoryWorkbookBuffer, buildMonthlyLoadsWorkbook, monthlyLoadsWorkbookBuffer };
