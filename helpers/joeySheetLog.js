// ── helpers/joeySheetLog.js — log verified Joey commission lines ───────────
// Same as helpers/panMetalSheetLog.js (Apsara: "similar to pan metals"), into a
// "Joey" tab of the same Edge Metals sheet: only lines that MATCHED are written,
// so a mismatch is something she looks at, not something filed as reconciled.
// Keyed by Inv No. + container, because a container can have two lines and a
// Joey contract number is not on our sheet's Inv No.
const { getOrCreateSpreadsheetId, getSheets, ensureTab, upsertRowsByKey } = require('./proformaSheetLog');
const TAB_NAME = 'Joey';
const HEADER_ROW = ['Key', 'Inv No.', 'Container', 'Contract', 'Weight', 'Comm/MT', 'Commission', 'Verified On'];
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const n = (v) => (v === null || v === undefined || v === '' ? '' : v);

function rowsFor(matched, day = today()) {
    return (matched || []).filter((r) => r.status === 'match' && r.sheet && r.sheet.inv_no).map((r) => {
        const key = `${r.sheet.inv_no}|${r.sheet.container_no}|${r.mt}`;
        return { key, row: [key, r.sheet.inv_no, r.sheet.container_no, r.contract_no || '', n(r.sheet.weight), n(r.rate_used), n(r.commission), day] };
    });
}

async function logJoeyVerification(matched, deps = {}) {
    const rows = rowsFor(matched);
    if (!rows.length) return { logged: 0, updated: 0 };
    const spreadsheetId = await (deps.getOrCreateSpreadsheetId || getOrCreateSpreadsheetId)();
    const sheets = (deps.getSheets || getSheets)();
    await (deps.ensureTab || ensureTab)(sheets, spreadsheetId, TAB_NAME, HEADER_ROW);
    const { logged, updated } = await (deps.upsertRowsByKey || upsertRowsByKey)(sheets, spreadsheetId, TAB_NAME, 'A', rows);
    return { logged, updated, spreadsheetId };
}
module.exports = { logJoeyVerification, rowsFor, TAB_NAME, HEADER_ROW };
