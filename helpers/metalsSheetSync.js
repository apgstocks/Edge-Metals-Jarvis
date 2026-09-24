// ── helpers/metalsSheetSync.js — her live workbook, read into Edge Metals ──
//
// Apsara, 2026-09-24: "at everyday night,a bot should run which need to update
// my bills and invoices in website from live sheet..if anything is missing,
// enter that as well".
//
// Asked what to do when the sheet and Jarvis disagree about a row that already
// exists, she chose: "1 with discrepancy should be notified via email report"
// — option 1 being ADD WHAT IS MISSING, TOUCH NOTHING THAT EXISTS. And for the
// first run: "Dry run first — report only, write nothing".
//
// ── NOT helpers/sheetSync.js ───────────────────────────────────────────────
// That name was already taken, by the EDGE YARD sync that pushes loads and
// expenses OUT to Drive every night (scheduler.js calls its syncNow). This
// reads her Edge Metals workbook IN. Opposite direction, opposite company.
// I overwrote that file once while building this; the nightly yard sync would
// have thrown on a missing export at 11pm. Hence the longer name.
//
// ── SO THIS NEVER EDITS A ROW ──────────────────────────────────────────────
// It inserts rows Jarvis does not have, and for rows it DOES have it compares
// and reports. That asymmetry is the whole safety story:
//
//   - 260831_SU_26EM05 was billed $13.09 and corrected on 2026-09-23. An
//     overwriting sync would have put the wrong figure back that night, from
//     a sheet that still holds it.
//   - Rows 59–61 of her Packing tab have an HS code containing a comma, which
//     shifts every column after it. Those are unreadable, not authoritative.
//   - One price column carries both $/lb and $/MT with nothing marking which.
//
// A person can look at a discrepancy and know which side is right. A cron job
// at 11pm cannot, and there is nobody awake to ask.
//
// ── AND IT RUNS THE SAME CODE HER UPLOAD RUNS ──────────────────────────────
// The live workbook is fetched as XLSX and handed to helpers/sheetImport.js's
// readWorkbook — the identical function behind the Upload screen, not a second
// parser reading the same columns slightly differently.

const cfg = require('../config');

// ── ROW IDENTITY ───────────────────────────────────────────────────────────
// Her rule, 2026-09-16: A CONTAINER IS booking_no + container_no TOGETHER,
// NEVER BOOKING ALONE — "UMXU637049 is a trailer that goes out again next
// week", so keying on the booking would call the second trip the first and
// skip a real bill.
const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');

function billKey(row) {
    const b = norm(row && row.booking_no), c = norm(row && row.container_no);
    if (!b && !c) return null;             // nothing to match on — never "new"
    return `${b}|${c}`;
}
// ── AND A SALE IS KEYED BY ITS GRADE TOO ───────────────────────────────────
// One invoice covers several grades and sheetImport's toSales does NOT group
// them — one row per grade, deliberately (toBills groups by container; toSales
// does not). Keying on invoice + container alone collapsed them, and the first
// dry run showed exactly what that costs:
//
//   260923_MC_26MK80 / KOCU4930737 appeared TWICE in the insert list — it
//   would have been added twice that night and twice again the next;
//
//   and 251203 25DHATU01 compared Alternators, Starters AND Compressors
//   against one stored row, then reported the other two as disagreements.
//   Most of that run's 94 conflicts were this artefact, not real ones.
//
// The grade is what makes the row, so the grade is in the key.
function saleKey(row) {
    const i = norm(row && row.invoice_no), c = norm(row && row.container_no);
    const g = norm(row && (row.item || row.description));
    if (!i && !c) return null;
    return `${i}|${c}|${g}`;
}

// ── IS THIS A SHIPMENT AT ALL? ─────────────────────────────────────────────
// sheetImport keeps any row that says ANYTHING — its own comment: "Only a row
// that says NOTHING is dropped". That is right for the upload screen, where
// she reviews the list before it is written. It is wrong at 11pm with nobody
// watching, and the first dry run proved it: these three were queued as new
// invoices —
//
//   AL-ALUMINIUM COMBO,AP-Scrap Auto Parts,RC-Regular Combo,…   (her legend)
//   QB DONE TILL 5/8                                            (a note)
//   260630_BAT_26NT08 … "Order confirmed on Text with Bose"     (a note in the
//                                                                container cell)
//
// So a row must LOOK like a shipment before anything is inserted from it: a
// date, and something that identifies the container it travelled in. Rows that
// fail are reported, never written — she can see them and decide.
const CONTAINER_RE = /^[A-Z]{4}\d{6,7}$/;

function looksLikeShipment(row) {
    if (!row) return false;
    const c = norm(row.container_no), b = norm(row.booking_no);
    // Prose in the invoice cell: her legend row is one long comma-separated
    // line, and a note is a sentence. Neither is an invoice number.
    const inv = String((row.invoice_no == null ? '' : row.invoice_no)).trim();
    if (inv.length > 40 || /,\s/.test(inv)) return false;
    // A container number has a shape. A sentence in that cell does not.
    if (c && !CONTAINER_RE.test(c) && !b) return false;
    if (!c && !b) return false;                 // nothing to identify it by
    if (!String(row.date || '').trim()) return false;
    return true;
}

// ── WHAT COUNTS AS A DISAGREEMENT ──────────────────────────────────────────
// Only the fields that are hers to type. Derived figures are deliberately not
// compared: sheetImport does not import Total, NET, MT or INVOICE AMT because
// Jarvis recomputes them, so a difference there is arithmetic, not a conflict,
// and reporting it nightly would bury the real ones.
const BILL_WATCH = ['date', 'supplier', 'supplier_price', 'supplier_invoice_amount',
    'trucking_amount', 'seal_no', 'description', 'gross'];
const SALE_WATCH = ['date', 'customer', 'consignee', 'invoice_price', 'freight_charges',
    'commission_per_mt', 'seal_no', 'item'];

const same = (a, b) => {
    // Whitespace collapsed, not just trimmed. The first dry run reported
    // supplier: sheet "Edge Yard" vs Jarvis "EdgeYard" as a disagreement —
    // one spacing difference is not a change of supplier.
    const flat = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
    const x = flat(a);
    const y = flat(b);
    // A blank on EITHER side is not a disagreement — a field she has not
    // filled in yet on one side is the normal state of a live sheet.
    if (!x || !y) return true;
    if (x === y) return true;
    // ── BOTH SIDES MUST ACTUALLY BE NUMBERS ────────────────────────────────
    // Stripping non-numerics from "Gomez" leaves an empty string, and
    // Number('') is 0 — so without this guard "Gomez" and "Freddy" both became
    // 0 and compared EQUAL. A supplier changing on a bill would have gone
    // unreported, which is exactly what this job exists to catch. Found by
    // tests/metals-sheet-sync.js section E.
    const digits = (s) => /[0-9]/.test(String(s));
    const nx = digits(x) ? Number(String(x).replace(/[^0-9.-]/g, '')) : NaN;
    const ny = digits(y) ? Number(String(y).replace(/[^0-9.-]/g, '')) : NaN;
    // Money and weights: equal to the cent. "1,250.00" and "1250" are the same
    // number typed two ways, and flagging that is noise.
    if (Number.isFinite(nx) && Number.isFinite(ny)) return Math.abs(nx - ny) < 0.005;
    return x.replace(/\s/g, '').toLowerCase() === y.replace(/\s/g, '').toLowerCase();
};

function differences(sheetRow, jarvisRow, watch) {
    const out = [];
    for (const f of watch) {
        if (!same(sheetRow[f], jarvisRow[f])) {
            out.push({ field: f, sheet: sheetRow[f], jarvis: jarvisRow[f] });
        }
    }
    return out;
}

// ── THE DIFF ───────────────────────────────────────────────────────────────
// Pure: hand it what the sheet says and what Jarvis holds, get back what would
// happen. No fetching, no writing, no clock — which is what makes the night
// job's decision testable without a network or a live ledger.
function diff({ sheetBills = [], sheetSales = [], bills = [], sales = [] }) {
    const haveBills = new Map();
    for (const b of bills) { const k = billKey(b); if (k) haveBills.set(k, b); }
    const haveSales = new Map();
    for (const s of sales) { const k = saleKey(s); if (k) haveSales.set(k, s); }

    const report = { newBills: [], newSales: [], changedBills: [], changedSales: [],
                     unkeyed: [], notShipments: [] };

    for (const row of sheetBills) {
        // A legend line or a note to herself is not a bill. Reported, never
        // written — see looksLikeShipment.
        if (!looksLikeShipment(row)) { report.notShipments.push({ kind: 'bill', row }); continue; }
        const k = billKey(row);
        // No booking AND no container: it cannot be matched next time, so it
        // must not be inserted either — an unkeyable row added tonight is a
        // duplicate added every night after.
        if (!k) { report.unkeyed.push({ kind: 'bill', row }); continue; }
        const mine = haveBills.get(k);
        if (!mine) { report.newBills.push(row); continue; }
        const d = differences(row, mine, BILL_WATCH);
        if (d.length) report.changedBills.push({ key: k, container_no: row.container_no, differences: d });
    }
    for (const row of sheetSales) {
        if (!looksLikeShipment(row)) { report.notShipments.push({ kind: 'sale', row }); continue; }
        const k = saleKey(row);
        if (!k) { report.unkeyed.push({ kind: 'sale', row }); continue; }
        const mine = haveSales.get(k);
        if (!mine) { report.newSales.push(row); continue; }
        const d = differences(row, mine, SALE_WATCH);
        if (d.length) report.changedSales.push({ key: k, invoice_no: row.invoice_no, container_no: row.container_no, differences: d });
    }
    return report;
}

// ── THE LIVE WORKBOOK ──────────────────────────────────────────────────────
// Exported as XLSX so readWorkbook gets exactly what an upload gives it. Kept
// separate from diff() on purpose: the decision is testable offline, and this
// is the only part that can fail for reasons that have nothing to do with her
// data — a redirect, an expired share, a network down at 11pm.
function fetchWorkbook(sheetId) {
    const id = sheetId || cfg.INVOICE_SHEET_ID;
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
    return new Promise((resolve, reject) => {
        const get = (u, hops) => {
            if (hops > 5) return reject(new Error('too many redirects fetching the workbook'));
            require('https').get(u, { headers: { 'User-Agent': 'jarvis-metals-sheet-sync' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(res.headers.location, hops + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`the workbook came back HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
        };
        get(url, 0);
    });
}

// One line she can read at a glance. Written here rather than in the mailer so
// the same words go to email, to the log and to WhatsApp.
function summarise(report) {
    const n = report.newBills.length + report.newSales.length;
    const c = report.changedBills.length + report.changedSales.length;
    const head = n
        ? `${n} row${n === 1 ? '' : 's'} to add (${report.newBills.length} bills, ${report.newSales.length} invoices)`
        : 'Nothing new';
    const tail = c ? `, ${c} disagree with the sheet` : '';
    const bad = report.unkeyed.length ? `, ${report.unkeyed.length} unreadable` : '';
    const nots = (report.notShipments || []).length
        ? `, ${report.notShipments.length} not shipment rows` : '';
    return head + tail + bad + nots + '.';
}

module.exports = { diff, differences, billKey, saleKey, same, fetchWorkbook, summarise,
    looksLikeShipment, BILL_WATCH, SALE_WATCH };
