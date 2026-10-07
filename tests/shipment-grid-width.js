// tests/shipment-grid-width.js — the Shipment tab must be as wide as its header.
// 2026-10-07: "Range (Shipment!AA1) exceeds grid limits. Max columns: 26" on every bill save,
// because the header is now 28 columns and a tab is created 26 wide.
const path = require('path');
process.env.JARVIS_TEST = '1';
const S = require(path.join(__dirname, '../helpers/shipmentSheetLog'));
let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); if (x) console.log('        ' + x); } };
const fake = (cols, title = 'Shipment') => { const calls = []; return { calls, spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title, gridProperties: { columnCount: cols, rowCount: 1042 } } }] } }),
    batchUpdate: async (a) => { calls.push(a.requestBody.requests[0].updateSheetProperties); return {}; } } }; };
(async () => {
    const n = S.headerRow().length;
    ck('the header really is wider than a default 26-column tab (the bug)', n > 26, String(n));
    const a = fake(26);
    const r = await S.ensureGridColumns(a, 'id', 'Shipment', n);
    ck('a 26-wide tab is widened to the header width', r.widened && r.from === 26 && r.to === n && a.calls.length === 1);
    ck('only the column count is touched (never rows, never data)', a.calls[0].fields === 'gridProperties.columnCount' && a.calls[0].properties.sheetId === 7 && Object.keys(a.calls[0].properties.gridProperties).join() === 'columnCount');
    const b = fake(n + 5);
    ck('a tab already wide enough is left alone — never shrunk', !(await S.ensureGridColumns(b, 'id', 'Shipment', n)).widened && b.calls.length === 0);
    const c = fake(26, 'Jio');
    ck('a different tab is never touched', !(await S.ensureGridColumns(c, 'id', 'Shipment', n)).widened && c.calls.length === 0);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
