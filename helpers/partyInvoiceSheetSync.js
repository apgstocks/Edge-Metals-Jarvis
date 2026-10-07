// ── helpers/partyInvoiceSheetSync.js — "sync from sheet" for the invoice register ──
// Apsara, 2026-10-07: "Give an option like sync from sheet, edit, delete, pay."
//
// Reads the Google "Edge Metals" tabs the Verify tabs log to (Jio, Sher, AJ Transport,
// Pan Metal) and brings into the register any line Jarvis does not have yet. Zimex and
// Garduno's have no tab, so they cannot be synced from the sheet.
//
// ── JARVIS IS THE RECORD, SO THE SHEET NEVER OVERWRITES IT ─────────────────
// A line already in the register is left exactly as it is. If the sheet's amount differs
// the difference is REPORTED, not applied: she chose Jarvis as the record, and a sync that
// quietly replaced a figure she had edited would make the sheet the record again.
// New lines are ADDED. Nothing is deleted from either side.
//
// plan() is pure (tab rows + existing rows in, what-to-add out) so the rules run in the suite;
// sync() is the thin part that reads the sheet and writes.
const PI = require('./partyInvoices');

const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const txt = (v) => String(v == null ? '' : v).trim();
const col = (head, ...names) => { const h = head.map((x) => txt(x).toLowerCase()); for (const n of names) { const i = h.indexOf(n.toLowerCase()); if (i !== -1) return i; } return -1; };

// Tab -> party and the check_status a row on that tab implies (they only ever hold passed rows).
const TABS = [
    { party: 'jio', tab: 'Jio', status: 'verified' },
    { party: 'sher', tab: 'Sher', status: 'verified' },
    { party: 'ajtransport', tab: 'AJ Transport', status: 'verified' },
    { party: 'panmetal', tab: 'Pan metal', status: 'match' },
];

// header + rows -> export-style records, run through the same normalize() the importer uses.
function recordsFromTab(party, values) {
    const [head = [], ...rows] = values || [];
    const c = (...n) => col(head, ...n);
    const out = [];
    for (const r of rows) {
        const g = (i) => (i === -1 ? '' : r[i]);
        let rec;
        if (party === 'jio') rec = { invoice_date: g(c('Date')), invoice_no: g(c('Invoice No.')), container_no: g(c('Container')), net_amount: g(c('Net Amount')) };
        else if (party === 'sher') rec = { invoice_date: g(c('Date')), booking_no: g(c('Booking No.')), quantity: g(c('Quantity')), amount: g(c('Amount')) };
        else if (party === 'ajtransport') rec = { invoice_date: g(c('Invoice Date')), invoice_no: g(c('Invoice No.')), container_no: g(c('Container No.')), booking_no: g(c('Booking No.')), total_amount: g(c('Total amount')), amount: g(c('Line Haul')) };
        else if (party === 'panmetal') rec = { invoice_no: g(c('Inv No.')), commission: g(c('Commission')), invoice_date: g(c('Verified On')) };
        else continue;
        out.push({ party, ...rec, status: TABS.find((t) => t.party === party).status, source_file: `sheet:${TABS.find((t) => t.party === party).tab}` });
    }
    return out;
}

// tabs: { jio: values[][], ... }; existing: current register rows.
function plan(tabs, existing) {
    const out = { to_add: [], already_there: 0, differs: [], skipped: {} };
    const byKey = new Map(existing.map((r) => [r.key, r]));
    // A sheet line may have no invoice number (Sher) or a different one than the email gave:
    // fall back to party + the container/booking/hbl, but only when that is unambiguous.
    const byLine = new Map();
    for (const r of existing) { const l = r.party + '|' + (r.container_no || r.booking_no || r.hbl_no || r.invoice_no || ''); byLine.set(l, (byLine.get(l) || []).concat(r)); }
    const seen = new Set();
    for (const { party } of TABS) {
        if (!tabs || !tabs[party]) continue;
        for (const rec of recordsFromTab(party, tabs[party])) {
            const n = PI.normalize(rec);
            if (n.skip) { const k = `${party}: ${n.skip}`; out.skipped[k] = (out.skipped[k] || 0) + 1; continue; }
            const row = { ...n.row, source: 'sheet' };
            let hit = byKey.get(row.key);
            if (!hit) { const m = byLine.get(party + '|' + (row.container_no || row.booking_no || row.hbl_no || row.invoice_no || '')) || []; if (m.length === 1) hit = m[0]; }
            if (hit) {
                out.already_there += 1;
                if (Math.abs(hit.amount - row.amount) >= 0.005) out.differs.push({ party, invoice_no: hit.invoice_no, line: hit.container_no || hit.booking_no || hit.hbl_no, jarvis: hit.amount, sheet: row.amount });
            } else if (!seen.has(row.key)) { seen.add(row.key); out.to_add.push(row); }
        }
    }
    return out;
}

async function readTabs() {
    const { getSheets, getOrCreateSpreadsheetId } = require('./proformaSheetLog');
    const sheets = getSheets(), id = await getOrCreateSpreadsheetId();
    const tabs = {}, problems = [];
    for (const t of TABS) {
        try { tabs[t.party] = ((await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'${t.tab}'!A1:Z5000` })).data.values) || []; }
        catch (e) { problems.push(`${t.tab}: ${e.message}`); }
    }
    return { tabs, problems };
}

// readTabsFn is injectable so the suite never reaches her live sheet.
async function sync({ readTabsFn = readTabs, dryRun = false } = {}) {
    const { tabs, problems } = await readTabsFn();
    const p = plan(tabs, PI.list());
    let res = { added: 0 };
    if (!dryRun && p.to_add.length) res = await PI.upsertMany(p.to_add);
    return { added: dryRun ? 0 : res.added, would_add: p.to_add.length, already_there: p.already_there, differs: p.differs, skipped: p.skipped, problems, dry_run: dryRun,
        no_tab_for: ['Zimex', "Garduno's"] };
}

module.exports = { sync, plan, recordsFromTab, readTabs, TABS };
