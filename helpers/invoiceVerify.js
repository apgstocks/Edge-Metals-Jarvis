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
    // forceRefresh: true — see helpers/invoiceSheet.js's fetchRawSheet()
    // comment; a cross-check must never compare against a stale cached copy.
    const { headers, rows } = await invoiceSheet.fetchRawSheet(true);
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

// ── Commission → Pan Metal ────────────────────────────────────────────────
// Added per Apsara's worked example against a real file ("Comm. Debit Note
// Edge_260804.pdf"): Pan Metal's debit note bills commission per ORDER NO.
// (e.g. "26MT10"), which doesn't appear as its own sheet column — it's
// embedded as the LAST underscore-separated segment of Inv No., e.g.
// "260528_AC_26MT10" → "26MT10". Confirmed against the real sheet for all
// four orders on the sample debit note (26MT10-13, consignee "Pan
// Metal/HK"): weight(ours) × commission_rate(ours, col 15 "Commissions")
// reproduces the debit note's stated Commission dollar amount EXACTLY in
// all four cases (e.g. 21.301 × $10 = $213.01) — that's the verification.
//
// "start with 26" is Apsara's own rule, tied to 2026 order numbers being
// live right now — not a hardcoded year, just the actual prefix on today's
// orders. Whenever order numbering rolls to "27..." this rule needs
// updating to match (or generalizing to "2 digits then letters+digits"),
// same kind of drift risk flagged elsewhere in this file for hardcoded
// sheet assumptions.
function extractOrderNoFromInvNo(invNo) {
    const parts = safeStr(invNo).split('_');
    const last = parts[parts.length - 1].trim().toUpperCase();
    return last.startsWith('26') ? last : null;
}

// One entry per distinct order code — same "first row that actually has a
// value wins" pattern as buildSheetFreightIndex, since weight/commission
// are recorded once per order, not repeated on every line.
async function buildSheetOrderIndex() {
    // forceRefresh: true — same reasoning as buildSheetFreightIndex above;
    // this is the fix for Apsara's "i changed the weight...it didn't take
    // that" report — the 3-minute cache was serving a stale weight.
    const { headers, rows } = await invoiceSheet.fetchRawSheet(true);
    const colMap = invoiceSheet.buildColumnMap(headers);
    const byOrder = new Map();
    for (const row of rows) {
        const d = invoiceSheet.rowToDict(row, colMap);
        const orderNo = extractOrderNoFromInvNo(d.inv_no);
        if (!orderNo) continue;
        const weight = safeMoney(d.weight);
        const existing = byOrder.get(orderNo);
        if (existing && existing.weight != null) continue;
        if (weight == null && existing) continue;
        byOrder.set(orderNo, {
            order_no: orderNo,
            inv_no: safeStr(d.inv_no),
            consignee: safeStr(d.consignee),
            container_no: safeStr(d.container_no),
            weight,
            commission_rate: safeMoney(d.commission_rate),
            commission_amt: safeMoney(d.commission_amt),
        });
    }
    return byOrder;
}

// pdfRecords: [{ order_no, customer, item, weight, comm_per_mt, commission, source_file, ... }]
// (the shape helpers/gemini.js's extractCommissionDebitNoteRecords returns,
// one array entry per source_file already attached by the API route).
//
// Calculation, per Apsara: "weight*commission should be calculated and it
// should be same as commission in uploaded sheet" — weight comes from OUR
// sheet (not the debit note's own weight column), multiplied by OUR
// commission RATE (col 15). "if in my excel,if commission is empty,use the
// commission column in uploaded sheet" — when OUR rate is blank for that
// order, fall back to the debit note's own Comm./MT rate instead so a
// blank rate cell doesn't just silently produce no answer. Either way the
// result is compared against the debit note's own stated Commission dollar
// figure for that order — a discrepancy there is what she wants surfaced.
const COMMISSION_TOLERANCE = 0.05; // absorbs cent-level rounding, not a real miss

async function crossCheckPanMetalRecords(pdfRecords) {
    const orderIndex = await buildSheetOrderIndex();
    const seenOrders = new Set();

    const matched = (pdfRecords || []).map((rec) => {
        const orderNo = safeStr(rec.order_no).toUpperCase();
        const stated = safeMoney(rec.commission);
        if (!orderNo) {
            return { ...rec, status: 'no_order_no_on_pdf', sheet: null, rate_used: null, rate_source: null, calculated: null, delta: null };
        }
        const sheetRow = orderIndex.get(orderNo);
        if (!sheetRow) {
            return { ...rec, status: 'not_in_sheet', sheet: null, rate_used: null, rate_source: null, calculated: null, delta: null };
        }
        seenOrders.add(orderNo);
        if (sheetRow.weight == null) {
            return { ...rec, status: 'sheet_weight_blank', sheet: sheetRow, rate_used: null, rate_source: null, calculated: null, delta: null };
        }
        // Fallback: our rate blank → use the debit note's own Comm./MT.
        const pdfRate = safeMoney(rec.comm_per_mt);
        const rateUsed = sheetRow.commission_rate != null ? sheetRow.commission_rate : pdfRate;
        const rateSource = sheetRow.commission_rate != null ? 'sheet' : (pdfRate != null ? 'pdf_fallback' : null);
        if (rateUsed == null) {
            return { ...rec, status: 'no_rate_available', sheet: sheetRow, rate_used: null, rate_source: null, calculated: null, delta: null };
        }
        if (stated == null) {
            return { ...rec, status: 'pdf_commission_unreadable', sheet: sheetRow, rate_used: rateUsed, rate_source: rateSource, calculated: null, delta: null };
        }
        const calculated = Math.round(sheetRow.weight * rateUsed * 100) / 100;
        const delta = Math.round((stated - calculated) * 100) / 100;
        return {
            ...rec,
            status: Math.abs(delta) <= COMMISSION_TOLERANCE ? 'match' : 'mismatch',
            sheet: sheetRow,
            rate_used: rateUsed,
            rate_source: rateSource,
            calculated,
            delta,
        };
    });

    // Reverse direction — per Apsara: "if a invoice no there in uploaded
    // sheet but not in my original excel sheet and vice versa how does tis
    // work?" The forward pass above only ever looks at what's ON the
    // uploaded debit note; an order that's on OUR sheet but that Pan Metal
    // never billed (omitted from the PDF, whether by mistake or not) was
    // previously invisible. This lists every sheet order with a real
    // weight — i.e. an actual shipment, not a blank row — that this run's
    // PDF(s) never claimed. No year/month scoping here (Apsara: "month/year
    // field i dont want" — unlike Zimex's equivalent sheet_only list),
    // so this is EVERY unmatched weighed order on the whole sheet, not a
    // recent window — expect this list to be long unless the upload covers
    // every outstanding order.
    const sheetOnly = [];
    for (const [orderNo, row] of orderIndex.entries()) {
        if (row.weight == null) continue;
        if (seenOrders.has(orderNo)) continue;
        sheetOnly.push(row);
    }

    return { matched, sheet_only: sheetOnly };
}

// ── Transport → Jio ─────────────────────────────────────────────────────────
// Added per Apsara: "for jio,i want a new tab to be created in edge
// metals.in that ,date(from uploaded),container,shipper,line haul,port
// fees,chassis rent,others,then net amount,last verified should be
// there.Your job is to find whether container number is there in my
// original sheet against the column Container No. on successful
// verification,create rows in jio tab of edge metals" — grounded against
// two real Jio Transport invoices (Invoice_8559.pdf, Invoice_8635.pdf):
// one load per PDF, "W/O (Ref):" holds the container number, charges
// itemized under "RATES AND CHARGES" (Line Haul / PORT FEE(S) / chassis
// rent line / occasionally something else), summing to "Total Rate:".
//
// Unlike Zimex (freight $ cross-checked) or Pan Metal (a calculation
// cross-checked), Jio has no dollar figure already on the Invoice sheet to
// compare against — "verification" here just means the container number
// on the invoice is a real container Edge Metals actually shipped. That's
// intentionally the whole check: existence, not a money match.
function normContainer(v) { return safeStr(v).toUpperCase().replace(/\s+/g, ''); }

// One entry per distinct container — same "first row wins" pattern as the
// other indexes in this file.
async function buildSheetContainerIndex() {
    const { headers, rows } = await invoiceSheet.fetchRawSheet(true); // always fresh — same reasoning as the other verification indexes above
    const colMap = invoiceSheet.buildColumnMap(headers);
    const byContainer = new Map();
    for (const row of rows) {
        const d = invoiceSheet.rowToDict(row, colMap);
        const containerNo = normContainer(d.container_no);
        if (!containerNo) continue;
        if (byContainer.has(containerNo)) continue; // already recorded — same container can legitimately repeat across rows (multi-item shipments)
        byContainer.set(containerNo, {
            container_no: containerNo,
            inv_no: safeStr(d.inv_no),
            consignee: safeStr(d.consignee),
            // booking_no added for crossCheckAjTransportRecords below (a
            // container-existence check alone, like Jio's, plus AJ
            // Transport's own booking no. cross-checked against this same
            // sheet row) — harmless for Jio's own use, which never reads it.
            booking_no: normBooking(d.booking_no),
        });
    }
    return byContainer;
}

// Buckets a record's charges into the four columns Apsara asked for. Gemini
// already sorts Line Haul / Port Fees / Chassis Rent into their own fields;
// "others" is OUR sum of whatever it put in other_charges, computed here in
// code rather than trusted from the model, same "money math happens in
// code, not the LLM" rule the rest of this file follows.
function sumOtherCharges(otherCharges) {
    return (otherCharges || []).reduce((sum, c) => sum + (safeMoney(c && c.amount) || 0), 0);
}

// pdfRecords: [{ invoice_no, invoice_date, container_no, shipper, line_haul,
// port_fees, chassis_rent, other_charges, net_amount, source_file }] — the
// shape helpers/gemini.js's extractJioInvoiceRecords() returns.
async function crossCheckJioRecords(pdfRecords) {
    const containerIndex = await buildSheetContainerIndex();
    const seenContainers = new Set();

    const matched = (pdfRecords || []).map((rec) => {
        const containerNo = normContainer(rec.container_no);
        const others = sumOtherCharges(rec.other_charges);
        const base = { ...rec, container_no: containerNo, others };
        if (!containerNo) {
            return { ...base, status: 'no_container_on_pdf', sheet: null };
        }
        const sheetRow = containerIndex.get(containerNo);
        if (!sheetRow) {
            return { ...base, status: 'not_in_sheet', sheet: null };
        }
        seenContainers.add(containerNo);
        return { ...base, status: 'verified', sheet: sheetRow };
    });

    // Reverse direction — per Apsara: "Always ensure to check the same
    // where if container number not in sheet and vice versa case", same
    // symmetric check already built for Pan Metal. IMPORTANT CAVEAT, worth
    // reading before trusting this list: Zimex/Pan Metal's reverse checks
    // are meaningful because every sheet order genuinely SHOULD have a
    // matching freight/commission entry. There's no equivalent signal here
    // — the sheet has no column saying "this container was trucked by
    // Jio" specifically (vs. AJ Transport, Sher Trucking, or anyone else).
    // So this lists EVERY container on the whole sheet this run's PDFs
    // didn't claim, which will include plenty of containers that were
    // never Jio's to begin with — it's a much noisier signal than the
    // Pan Metal/Zimex version, not a real "missing invoice" alarm.
    const sheetOnly = [];
    for (const [containerNo, row] of containerIndex.entries()) {
        if (seenContainers.has(containerNo)) continue;
        sheetOnly.push(row);
    }

    return { matched, sheet_only: sheetOnly };
}

// ── Transport → Sher Trucking ────────────────────────────────────────────
// Added per Apsara: "instead of container,booking number shoudl be
// compared from uplaoded sheet vs Booking No. in my original sheet.Create
// a tab called Sher in that date (from uplaoded),booking no,quantity
// ,chassis,others,Amount should be there.if quantity in uplaoded sheet is
// mentioned as 2,check whether there is two occurence of the booking no in
// my original sheet,else show error and dont put the row in sher tab."
//
// Verification here is DIFFERENT from Jio's plain existence check: a
// booking number can legitimately appear on multiple sheet rows (multiple
// containers under one booking), and Sher's invoice states how many
// containers/loads it's billing under that booking (quantity). The check
// is that the sheet's row-count for that booking matches the invoice's
// stated quantity EXACTLY — not just "booking exists somewhere."
function normBooking(v) { return safeStr(v).toUpperCase().replace(/\s+/g, ''); }

// booking_no -> { count, inv_no, consignee } — count is how many sheet rows
// carry this booking (NOT deduped the way container/order indexes above
// are — the row COUNT is the actual thing being verified here, so every
// occurrence has to be counted, not collapsed to one).
async function buildSheetBookingIndex() {
    const { headers, rows } = await invoiceSheet.fetchRawSheet(true); // always fresh — same reasoning as the other verification indexes above
    const colMap = invoiceSheet.buildColumnMap(headers);
    const byBooking = new Map();
    for (const row of rows) {
        const d = invoiceSheet.rowToDict(row, colMap);
        const bookingNo = normBooking(d.booking_no);
        if (!bookingNo) continue;
        const existing = byBooking.get(bookingNo);
        if (existing) { existing.count += 1; continue; }
        byBooking.set(bookingNo, { count: 1, inv_no: safeStr(d.inv_no), consignee: safeStr(d.consignee) });
    }
    return byBooking;
}

// pdfRecords: [{ invoice_date, booking_no, quantity, chassis, other_charges,
// amount, source_file }] — the shape helpers/gemini.js's
// extractSherTruckingInvoiceRecords() returns.
async function crossCheckSherRecords(pdfRecords) {
    const bookingIndex = await buildSheetBookingIndex();
    const seenBookings = new Set();

    const matched = (pdfRecords || []).map((rec) => {
        const bookingNo = normBooking(rec.booking_no);
        const others = sumOtherCharges(rec.other_charges);
        const qty = (rec.quantity === null || rec.quantity === undefined || rec.quantity === '') ? null : Number(rec.quantity);
        const base = { ...rec, booking_no: bookingNo, others, quantity: qty };
        if (!bookingNo) {
            return { ...base, status: 'no_booking_on_pdf', sheet: null, sheet_count: null };
        }
        const sheetRow = bookingIndex.get(bookingNo);
        if (!sheetRow) {
            return { ...base, status: 'not_in_sheet', sheet: null, sheet_count: null };
        }
        seenBookings.add(bookingNo);
        if (qty == null || !Number.isFinite(qty)) {
            return { ...base, status: 'quantity_unreadable', sheet: sheetRow, sheet_count: sheetRow.count };
        }
        if (qty !== sheetRow.count) {
            return { ...base, status: 'quantity_mismatch', sheet: sheetRow, sheet_count: sheetRow.count };
        }
        return { ...base, status: 'verified', sheet: sheetRow, sheet_count: sheetRow.count };
    });

    // Reverse direction — same symmetric check Apsara asked to always
    // include (see Jio/Pan Metal above). Same noise caveat as Jio's: the
    // sheet has no "this booking is Sher's" marker, so this lists every
    // booking not claimed by this run's uploads, Sher's or not.
    const sheetOnly = [];
    for (const [bookingNo, row] of bookingIndex.entries()) {
        if (seenBookings.has(bookingNo)) continue;
        sheetOnly.push({ booking_no: bookingNo, ...row });
    }

    return { matched, sheet_only: sheetOnly };
}

// ── Transport → AJ Transport ─────────────────────────────────────────────
// Added per Apsara: "Similarly for AJ Transport invoice date,invoice
// no,container no,booking no,shipper,pickup date,rate,amount in new tab
// called AJ Transport.About the logic,you know hwat to do" — grounded
// against a real file (Invoice_6405_from_AJ_Transport_Inc.pdf).
//
// Unlike Jio (container existence only) or Sher (booking row-COUNT), AJ
// Transport's invoice states BOTH a container no. AND a booking no. per
// line — the extra field is put to use, not just displayed: this verifies
// the container is on our sheet (like Jio) AND that OUR sheet's Booking
// No. for that same container matches what AJ Transport billed against.
// A container whose booking doesn't match what we have on file is exactly
// the kind of thing worth a hard stop, not a silent pass — "you know what
// to do" is read here as "hold this to the same standard as Sher's
// quantity check": a real mismatch is an error, not a warning, and never
// gets logged.
async function crossCheckAjTransportRecords(pdfRecords) {
    const containerIndex = await buildSheetContainerIndex();
    const seenContainers = new Set();

    const matched = (pdfRecords || []).map((rec) => {
        const containerNo = normContainer(rec.container_no);
        const bookingNo = normBooking(rec.booking_no);
        // "others" = DRY RUN CHARGE / CHARGE FOR EXTRA SCALE / etc. attributed
        // to this container by the Gemini extraction prompt (see gemini.js's
        // extractAjTransportInvoiceRecords) — normalized the same way as any
        // other sheet-bound dollar figure so a missing/blank value logs as 0,
        // not a stray empty string.
        const others = safeMoney(rec.others) || 0;
        const base = { ...rec, container_no: containerNo, booking_no: bookingNo, others };
        if (!containerNo) {
            return { ...base, status: 'no_container_on_pdf', sheet: null };
        }
        const sheetRow = containerIndex.get(containerNo);
        if (!sheetRow) {
            return { ...base, status: 'not_in_sheet', sheet: null };
        }
        seenContainers.add(containerNo);
        if (!sheetRow.booking_no) {
            return { ...base, status: 'sheet_booking_blank', sheet: sheetRow };
        }
        if (bookingNo && bookingNo !== sheetRow.booking_no) {
            return { ...base, status: 'booking_mismatch', sheet: sheetRow };
        }
        return { ...base, status: 'verified', sheet: sheetRow };
    });

    // Reverse direction — same symmetric check applied to every other
    // trucker tab, same noise caveat as Jio/Sher: no "this container is
    // AJ Transport's" marker on the sheet, so this is every container this
    // run's uploads didn't claim, not a clean "AJ Transport missed this"
    // signal.
    const sheetOnly = [];
    for (const [containerNo, row] of containerIndex.entries()) {
        if (seenContainers.has(containerNo)) continue;
        sheetOnly.push(row);
    }

    return { matched, sheet_only: sheetOnly };
}

module.exports = {
    buildSheetFreightIndex, crossCheckZimexRecords, AMOUNT_TOLERANCE,
    buildSheetOrderIndex, crossCheckPanMetalRecords, extractOrderNoFromInvNo, COMMISSION_TOLERANCE,
    buildSheetContainerIndex, crossCheckJioRecords,
    buildSheetBookingIndex, crossCheckSherRecords,
    crossCheckAjTransportRecords,
};
