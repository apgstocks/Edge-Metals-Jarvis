// ── helpers/invoiceVerify.js — Verification tab / Zimex sub-tab ────────────
// Added per Apsara: "build verification .in that create sub tab as zimex".
// Ports the carrier-freight-invoice cross-check tool that already existed as
// a separate PDF-upload page (verify.html + a Node api-server, found in the
// Edge-Metals-Inc project docs — a DIFFERENT repo than this one) into Jarvis
// itself, self-contained: its own Gemini extraction call
// (helpers/gemini.js's extractFreightInvoiceRecords) and its own read of the
// SAME Invoice Google Sheet helpers/invoiceSheet.js already reads, rather
// than depending on that other server being deployed/reachable.
//
// What it checks: Zimex (or any carrier) bills freight per HBL on a PDF
// invoice. This sheet already has a "Freight" dollar amount recorded per
// HBL (helpers/invoiceSheet.js's buildColumnMap → freight_amt, col 21 on the
// real sheet). This cross-checks the two, both directions:
//   - a PDF line item whose HBL isn't on the sheet at all, or whose amount
//     doesn't match what's recorded → something to chase down
//   - a sheet row WITH a freight amount whose HBL never showed up in any
//     uploaded PDF this run → billed on our side but no carrier invoice to
//     back it up (or it just hasn't been uploaded yet)
//
// Commission (helpers/invoiceSheet.js's commission_rate/commission_amt) is
// surfaced alongside each match for her own visibility, but is NOT
// currently part of the pass/fail verdict — per Apsara, commission's exact
// role here wasn't nailed down yet ("not ready to define" was one of the
// options offered; she picked "it's a column I haven't mapped" and this
// maps it), and Zimex bills FREIGHT, not commission (commission is Edge
// Metals' own internal figure, never something a carrier invoice would
// state) — so a mismatch there would never reflect anything Zimex actually
// billed. Structured as its own field specifically so a real commission
// check can be added later without reworking this.

const invoiceSheet = require('./invoiceSheet');

function safeStr(v) { return v == null ? '' : String(v).trim(); }
function normHbl(v) { return safeStr(v).toUpperCase().replace(/\s+/g, ''); }
function safeMoney(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').replace(/\$/g, ''));
    return Number.isFinite(n) ? n : null;
}

// M/D/YYYY (confirmed live format, e.g. "12/1/2025") — same loose parse as
// every other date field in this codebase, no external date library.
function parseSheetDate(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return { month: Number(m[1]), year: Number(m[3]) };
}

// One entry per distinct HBL on the sheet — freight/commission are
// container-level (recorded once, usually on that container's first sheet
// row, blank on the rest) same convention buildContainerInvoiceData already
// relies on ("Only take freight/efs from first non-zero row"), so the first
// row seen per HBL that actually carries a freight amount wins.
//
// period ({year, month}, both optional) scopes which rows count toward the
// index by Invoice Date — mirrors the year/month filter the original
// verify.html tool had. Only affects the REVERSE "sheet_only" (missing
// invoice) list in crossCheckZimexRecords below, so that list reflects just
// the period she's actually checking instead of every HBL on record; a
// forward match/mismatch always looks the HBL up regardless of period,
// since an uploaded PDF is itself already scoped to whatever she uploaded.
async function buildSheetFreightIndex(period) {
    const { headers, rows } = await invoiceSheet.fetchRawSheet();
    const colMap = invoiceSheet.buildColumnMap(headers);
    const byHbl = new Map();
    for (const row of rows) {
        const d = invoiceSheet.rowToDict(row, colMap);
        const hbl = normHbl(d.hbl_no);
        if (!hbl) continue;
        if (period && (period.year || period.month)) {
            const parsed = parseSheetDate(d.inv_date);
            if (!parsed) continue;
            if (period.year && parsed.year !== Number(period.year)) continue;
            if (period.month && parsed.month !== Number(period.month)) continue;
        }
        const freightAmt = safeMoney(d.freight_amt);
        const existing = byHbl.get(hbl);
        if (existing && existing.freight_amt != null) continue; // already have a real value for this HBL
        if (freightAmt == null && existing) continue; // don't overwrite a partial entry with an even emptier one
        byHbl.set(hbl, {
            hbl_no: safeStr(d.hbl_no),
            container_no: safeStr(d.container_no),
            booking_no: safeStr(d.booking_no),
            consignee: safeStr(d.consignee),
            inv_no: safeStr(d.inv_no),
            inv_date: safeStr(d.inv_date),
            freight_amt: freightAmt,
            commission_rate: safeMoney(d.commission_rate),
            commission_amt: safeMoney(d.commission_amt),
        });
    }
    return byHbl;
}

// pdfRecords: [{ hbl_no, container_no, booking_no, description, amount, source_file }]
// Returns { matched: [...], sheet_only: [...] } — see status meanings below.
// $1 tolerance absorbs rounding, not a real discrepancy worth flagging.
const AMOUNT_TOLERANCE = 1.0;

// period ({year, month}) scopes ONLY the reverse "sheet_only" list — see
// buildSheetFreightIndex's comment. Forward match/mismatch/not_in_sheet
// always checks a PDF's HBL against the FULL sheet, unscoped, since an
// uploaded PDF might legitimately reference an HBL invoiced in an earlier
// period and that's still worth catching, not hiding.
async function crossCheckZimexRecords(pdfRecords, period) {
    const sheetIndex = await buildSheetFreightIndex();
    const scopedIndex = period && (period.year || period.month) ? await buildSheetFreightIndex(period) : sheetIndex;
    const seenHbls = new Set();

    const matched = (pdfRecords || []).map((rec) => {
        const hbl = normHbl(rec.hbl_no);
        const pdfAmount = safeMoney(rec.amount);
        if (!hbl) {
            return { ...rec, status: 'no_hbl_on_pdf', sheet: null, delta: null };
        }
        const sheetRow = sheetIndex.get(hbl);
        if (!sheetRow) {
            return { ...rec, status: 'not_in_sheet', sheet: null, delta: null };
        }
        seenHbls.add(hbl);
        if (sheetRow.freight_amt == null) {
            return { ...rec, status: 'sheet_freight_blank', sheet: sheetRow, delta: null };
        }
        if (pdfAmount == null) {
            return { ...rec, status: 'pdf_amount_unreadable', sheet: sheetRow, delta: null };
        }
        const delta = Math.round((pdfAmount - sheetRow.freight_amt) * 100) / 100;
        return {
            ...rec,
            status: Math.abs(delta) <= AMOUNT_TOLERANCE ? 'match' : 'mismatch',
            sheet: sheetRow,
            delta,
        };
    });

    // Reverse direction — sheet HBLs with a real freight amount that no
    // uploaded PDF this run ever claimed. Only meaningful if she uploaded
    // ALL of Zimex's invoices for the period she's checking; a partial
    // upload will show plenty of these, so this is a hint, not an alarm.
    const sheetOnly = [];
    for (const [hbl, row] of scopedIndex.entries()) {
        if (row.freight_amt == null) continue;
        if (seenHbls.has(hbl)) continue;
        sheetOnly.push(row);
    }

    return { matched, sheet_only: sheetOnly };
}

module.exports = { buildSheetFreightIndex, crossCheckZimexRecords, AMOUNT_TOLERANCE };
