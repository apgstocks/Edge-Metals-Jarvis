// ── helpers/invoiceSheet.js — Commercial Invoice generation, sourced from
// the real Invoice Google Sheet ─────────────────────────────────────────────
// Added per Apsara: "build invoice now.similar to proforma ask me who is the
// buyer.then follow python anywhere invoice flow" — this ports the DATA/
// CALCULATION logic of her old PythonAnywhere Flask tool (invoice_gen.py /
// app.py, both saved in the Jarvis project docs) into Jarvis itself, reading
// the SAME Google Sheet (cfg.INVOICE_SHEET_ID) that tool already read.
//
// One deliberate UX change from the old tool, per Apsara's explicit
// instruction: the old app searched by CONTAINER NUMBER first. This asks
// "who is the buyer" first (matching the Proforma flow's own address-book-
// first UX), then shows every container/shipment on record for that buyer
// so she can pick which one to invoice — more natural when she's starting
// from "I need to invoice Taewon" rather than already knowing a container ID.
//
// IMPORTANT — column mapping is resolved BY HEADER NAME at fetch time, not
// by the old script's hardcoded numeric column indices. Checked directly:
// invoice_gen.py's COLUMNS dict (e.g. port_discharge: 23, efs: 25) does NOT
// line up with the real sheet's current header row fetched live in this
// session — the sheet's columns have shifted since that script was last
// used. Trusting stale hardcoded indices on a real financial document is
// exactly the kind of silent-wrong-data risk worth refusing outright, so
// every field below is located by matching the header text instead — same
// "fail loud on a header rename" contract helpers/nextInvoiceNo.js already
// uses for this same sheet. Fields with no matching real header (that
// script's "port_discharge"/"efs" columns) are left for manual entry in the
// editable preview rather than silently pulled from the wrong column.

const cfg = require('../config');
const { parseCsv } = require('./nextInvoiceNo');

let cache = null; // { at, headers, rows: string[][] }
const CACHE_MS = 3 * 60 * 1000;

// forceRefresh: bypasses the 3-minute cache entirely. Added after Apsara
// edited a weight directly on the live sheet and re-ran Pan Metal
// verification within that 3-minute window — it silently compared against
// the stale cached copy instead of her edit. Every OTHER caller (invoice
// preview/lookup below) keeps the cache as-is; it's fine for those to be up
// to 3 minutes behind. A cross-check that's specifically verifying "does
// this PDF match what's on the sheet RIGHT NOW" can't tolerate that same
// staleness without silently grading against outdated numbers, so
// helpers/invoiceVerify.js's buildSheetFreightIndex (Zimex) and
// buildSheetOrderIndex (Pan Metal) both pass forceRefresh: true.
async function fetchRawSheet(forceRefresh) {
    if (!forceRefresh && cache && (Date.now() - cache.at) < CACHE_MS) return cache;
    if (!cfg.INVOICE_SHEET_ID) throw new Error('INVOICE_SHEET_ID not configured');
    const url = `https://docs.google.com/spreadsheets/d/${cfg.INVOICE_SHEET_ID}/export?format=csv&gid=${cfg.INVOICE_MAIN_GID}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read invoice sheet (${res.status})`);
    const text = await res.text();
    const table = parseCsv(text);
    if (!table.length) throw new Error('Invoice sheet is empty');
    const headers = table[0].map((h) => String(h || '').trim().toLowerCase());
    const rows = table.slice(1).filter((r) => r && r.some((c) => String(c || '').trim()));
    cache = { at: Date.now(), headers, rows };
    return cache;
}

// Finds a column index by exact header match first, then by "startsWith" —
// mirrors nextInvoiceNo.js's own `h.startsWith('inv no')` pattern. Returns
// -1 (not -Infinity/undefined) when nothing matches, same as Array.indexOf,
// so callers can check `=== -1` uniformly.
function findCol(headers, exact, startsWith) {
    let idx = headers.indexOf(exact);
    if (idx !== -1) return idx;
    if (startsWith) {
        idx = headers.findIndex((h) => h.startsWith(startsWith));
        if (idx !== -1) return idx;
    }
    return -1;
}

// Returns EVERY column index whose header matches exactly — the sheet has
// two columns that both read "Commissions" once lowercased (checked live:
// col 15 "Commissions" holds a $/MT RATE, e.g. "10"; col 23 "COMMISSIONS"
// holds the already-computed dollar AMOUNT, e.g. "184.11" = weight × rate,
// confirmed against several real rows). findCol's plain indexOf() would
// silently always resolve to the FIRST one (the rate), which is the wrong
// number for a dollar cross-check — this exists so buildColumnMap below can
// disambiguate them explicitly instead of guessing.
function findAllCol(headers, exact) {
    const out = [];
    headers.forEach((h, i) => { if (h === exact) out.push(i); });
    return out;
}

function buildColumnMap(headers) {
    // See findAllCol's comment above — first occurrence is the commission
    // RATE ($/MT), last occurrence (when a second one exists) is the
    // computed dollar AMOUNT. Sheets with only one "Commissions" column
    // fall back to treating it as the amount, since that's the more useful
    // field for a dollar cross-check and there's nothing to disambiguate.
    const commissionIdxs = findAllCol(headers, 'commissions');
    const commissionRateIdx = commissionIdxs.length > 1 ? commissionIdxs[0] : -1;
    const commissionAmtIdx = commissionIdxs.length > 1 ? commissionIdxs[commissionIdxs.length - 1] : (commissionIdxs[0] ?? -1);

    return {
        consignee: findCol(headers, 'consignee'),
        inv_no: findCol(headers, 'inv no.', 'inv no'),
        inv_date: findCol(headers, 'inv date'),
        hbl_no: findCol(headers, 'hbl  no.', 'hbl'),
        booking_no: findCol(headers, 'booking  no.', 'booking'),
        container_no: findCol(headers, 'container no.', 'container'),
        seal_no: findCol(headers, 'seal no.', 'seal'),
        supplier: findCol(headers, 'supplier'),
        terms: findCol(headers, 'terms'),
        customer: findCol(headers, 'customer'),
        proforma_date: findCol(headers, 'proforma date'),
        reference: findCol(headers, 'reference'),
        item_desc: findCol(headers, 'item description', 'item desc'),
        weight: findCol(headers, 'weight'),
        inv_price: findCol(headers, 'inv price'),
        freight_charge: findCol(headers, 'freight charge'),
        // "Freight" (col 21) — the carrier's actual billed freight dollar
        // amount, distinct from "Freight Charge" (col 20, an eval-able
        // expression like "95+35+50" that sums to the same figure). This is
        // what the Zimex sub-tab cross-checks a carrier PDF's amount against.
        freight_amt: findCol(headers, 'freight'),
        commission_rate: commissionRateIdx,
        commission_amt: commissionAmtIdx,
        eta: findCol(headers, 'eta'),
    };
}

function safeStr(v) { return v == null ? '' : String(v).trim(); }
function safeFloat(v) {
    const n = parseFloat(String(v || '').replace(/,/g, '').replace(/\$/g, ''));
    return Number.isFinite(n) ? n : 0;
}
// Freight Charge cells sometimes hold an arithmetic expression like
// "70+35+50" (confirmed in real rows) rather than a plain number — same
// "eval a restricted +-*/ expression" behavior as invoice_gen.py's
// eval_freight(), but without Python's eval(): a regex whitelist first,
// then a small hand-rolled evaluator (+ and - only, matching every real
// example seen — no * or / has shown up in this column in practice).
function evalFreight(expr) {
    const s = String(expr || '').replace(/,/g, '').replace(/\$/g, '').trim();
    if (!s) return 0;
    if (/^[\d.]+$/.test(s)) return parseFloat(s) || 0;
    if (/^[\d.\s+\-]+$/.test(s)) {
        const parts = s.split(/(?=[+\-])/).map((p) => p.trim()).filter(Boolean);
        let total = 0;
        for (const p of parts) {
            const n = parseFloat(p);
            if (Number.isFinite(n)) total += n;
        }
        return total;
    }
    return parseFloat(s) || 0;
}

// ITEM_CODE_MAP — Apsara's own list, same as dashboard/documents.html's
// client-side copy (kept in sync manually; both are small, static, and
// change together only when she adds a new material code).
const ITEM_CODE_MAP = {
    AL: 'ALUMINIUM COMBO', AP: 'SCRAP AUTO PARTS', RC: 'REGULAR COMBO', BT: 'BATTERY',
    AW: 'ALUMINIUM WHEELS', CW: 'CHROME WHEELS', HW: 'HARNESS WIRE', TT: 'TAINT TABOUR',
    AC: 'AUTO CAST', ML: 'MIXED LOAD', SU: 'SEALED UNITS', MM: 'MIXED MOTORS',
    RD: 'ROTORS AND DRUMS', MC: 'MIXED COMBO',
};
// If a row's own Item Description cell is blank, fall back to extracting
// the 2-letter code from the Inv No. (e.g. "260819_AC_26JY19" -> AC ->
// "AUTO CAST") — same fallback invoice_gen.py's resolve_item_desc() used.
function resolveItemDesc(itemDesc, invNo) {
    const d = safeStr(itemDesc);
    if (d) return d.replace(/^[A-Z]{2}-/, '').trim();
    const tokens = safeStr(invNo).split(/[\s_]+/);
    for (const t of tokens) {
        const code = t.toUpperCase();
        if (ITEM_CODE_MAP[code]) return ITEM_CODE_MAP[code];
    }
    return d || 'SCRAP METALS';
}

function rowToDict(row, colMap) {
    const d = {};
    for (const [key, idx] of Object.entries(colMap)) {
        d[key] = idx === -1 ? '' : safeStr(row[idx]);
    }
    return d;
}

// Loose match — same either-direction substring rule the rest of Jarvis
// uses for consignee search (NOT the agent-prefix grouping
// helpers/nextInvoiceNo.js uses for numbering; that's a different concern
// specific to sequencing invoice numbers, not buyer lookup here).
function looseMatch(cell, query) {
    const c = cell.toLowerCase().trim();
    const q = query.toLowerCase().trim();
    if (!c || !q) return false;
    return c.includes(q) || q.includes(c);
}

// Returns every distinct container on record for a buyer, most recent
// first (by sheet order — the real sheet is appended chronologically),
// each with a short summary so the UI can show a pick-list before loading
// the full editable preview.
async function findContainersForBuyer(buyerQuery) {
    const { headers, rows } = await fetchRawSheet();
    const colMap = buildColumnMap(headers);
    if (colMap.consignee === -1 || colMap.container_no === -1) {
        throw new Error('Invoice sheet header layout changed — expected "Consignee" and "Container No." columns');
    }
    const query = safeStr(buyerQuery);
    if (!query) return [];

    const groups = new Map(); // container_no -> rows[]
    for (const row of rows) {
        const consignee = safeStr(row[colMap.consignee]);
        if (!consignee || !looseMatch(consignee, query)) continue;
        const containerNo = safeStr(row[colMap.container_no]).toUpperCase();
        if (!containerNo) continue;
        if (!groups.has(containerNo)) groups.set(containerNo, []);
        groups.get(containerNo).push(row);
    }

    const out = [];
    for (const [containerNo, containerRows] of groups.entries()) {
        const first = rowToDict(containerRows[0], colMap);
        out.push({
            container_no: containerNo,
            consignee: first.consignee,
            inv_no: first.inv_no,
            inv_date: first.inv_date,
            item_count: containerRows.length,
            // Exposed so the client can group a multi-select batch by
            // shared booking number without a second round trip — see
            // buildMultiContainerInvoiceData() below and Apsara: "if both
            // containers belong to the same booking, it should get
            // generated in same invoice".
            booking_no: first.booking_no,
        });
    }
    // Most recently added rows tend to sort later in the sheet — reverse so
    // the newest shipment shows first, matching "what do I need to invoice
    // right now" more often than the oldest.
    out.reverse();
    return out;
}

// Returns every distinct container whose Container No. loosely matches a
// query, regardless of buyer — the "search by container number" path
// Apsara's old PythonAnywhere tool used as its ONLY lookup (--container
// flag, see invoice_gen.py's main()) before Jarvis added the buyer-first
// flow above. Same summary shape as findContainersForBuyer so the UI can
// reuse one render function for either search path.
//
// containerQuery may hold SEVERAL container numbers/fragments separated by
// commas, spaces, or newlines — per Apsara: "add multi container search",
// so she can pull two specific containers from the same booking straight
// into one search result and check them both, rather than re-searching and
// losing the first result each time. Each term is matched independently
// (substring match, same as before) and results are unioned/deduped by
// container_no — a single term behaves exactly as it always did.
async function findContainersByNumber(containerQuery) {
    const { headers, rows } = await fetchRawSheet();
    const colMap = buildColumnMap(headers);
    if (colMap.consignee === -1 || colMap.container_no === -1) {
        throw new Error('Invoice sheet header layout changed — expected "Consignee" and "Container No." columns');
    }
    const terms = safeStr(containerQuery).toUpperCase().split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    if (!terms.length) return [];

    const groups = new Map(); // container_no -> rows[]
    for (const row of rows) {
        const containerNo = safeStr(row[colMap.container_no]).toUpperCase();
        if (!containerNo || !terms.some((t) => containerNo.includes(t))) continue;
        if (!groups.has(containerNo)) groups.set(containerNo, []);
        groups.get(containerNo).push(row);
    }

    const out = [];
    for (const [containerNo, containerRows] of groups.entries()) {
        const first = rowToDict(containerRows[0], colMap);
        out.push({
            container_no: containerNo,
            consignee: first.consignee,
            inv_no: first.inv_no,
            inv_date: first.inv_date,
            item_count: containerRows.length,
            booking_no: first.booking_no,
        });
    }
    out.reverse(); // newest shipment first, same rationale as findContainersForBuyer
    return out;
}

// The searchable tail of an Inv No.
//
// Apsara, 2026-08-22: "SEARCH BY INV NO. MULTI ENTRY SUPPORT. IT SHOULD BE
// LAST PART AFTER _. EG;[DATE]_[CODE]_[WHAT WE NEED]"
//
// "260819_AC_26JY96" -> ["26JY96"]. The date and item code are shared by
// every invoice generated that day for that material, so searching on them
// would return the whole day rather than the one document she wants — the
// trailing segment is the part that actually identifies it.
//
// Returns an ARRAY because a multi-container proforma now puts several codes
// in that segment: "260819_AC_26JY96,26JY97" -> ["26JY96", "26JY97"]. Typing
// either one has to find that invoice, or a merged invoice would be
// reachable only by whichever container happened to be listed first.
function invNoTailCodes(invNo) {
    const s = safeStr(invNo).toUpperCase().trim();
    if (!s) return [];
    const idx = s.lastIndexOf('_');
    const tail = idx === -1 ? s : s.slice(idx + 1);
    return tail.split(',').map((x) => x.trim()).filter(Boolean);
}

// Mirror of findContainersByNumber, keyed on the Inv No. tail instead of the
// container number. Returns the IDENTICAL shape on purpose — the dashboard
// renders both results through the same list and the same downstream
// select/preview/generate flow, so nothing after the search needs to know
// which box the query came from.
async function findContainersByInvNo(invNoQuery) {
    const { headers, rows } = await fetchRawSheet();
    const colMap = buildColumnMap(headers);
    if (colMap.consignee === -1 || colMap.container_no === -1) {
        throw new Error('Invoice sheet header layout changed — expected "Consignee" and "Container No." columns');
    }
    if (colMap.inv_no === -1) throw new Error('Invoice sheet has no "Inv No." column to search');

    // Same comma/space splitting as the container search, so both boxes
    // accept a pasted list in whatever form it arrives.
    const terms = safeStr(invNoQuery).toUpperCase().split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    if (!terms.length) return [];

    const groups = new Map(); // container_no -> rows[]
    for (const row of rows) {
        const codes = invNoTailCodes(row[colMap.inv_no]);
        if (!codes.length) continue;
        // PREFIX match, not substring. A partial "26JY9" should still pull
        // up the run of related invoices, but plain `includes` matches
        // mid-string and produced a real false positive in testing: the term
        // "AC" matched the unrelated invoice "LEGACYINV" (leg-AC-yinv). On a
        // financial lookup, surfacing someone else's invoice because two
        // letters happened to appear inside it is worse than being slightly
        // stricter — and these codes are read left-to-right anyway, so a
        // prefix is how a person actually shortens one.
        if (!terms.some((t) => codes.some((c) => c.startsWith(t)))) continue;
        // Grouped by CONTAINER, not by invoice: the result list feeds a
        // container multi-select, and a merged invoice must appear as its
        // individual containers there so she can pick a subset.
        const containerNo = safeStr(row[colMap.container_no]).toUpperCase();
        if (!containerNo) continue;
        if (!groups.has(containerNo)) groups.set(containerNo, []);
        groups.get(containerNo).push(row);
    }

    const out = [];
    for (const [containerNo, containerRows] of groups.entries()) {
        const first = rowToDict(containerRows[0], colMap);
        out.push({
            container_no: containerNo,
            consignee: first.consignee,
            inv_no: first.inv_no,
            inv_date: first.inv_date,
            item_count: containerRows.length,
            booking_no: first.booking_no,
        });
    }
    out.reverse(); // newest shipment first, same rationale as the sibling searches
    return out;
}

// Builds the full computed invoice/packing data for one container — mirrors
// invoice_gen.py's rows_to_invoice_data() + resolve_item_desc() +
// eval_freight(), minus the fields that don't have a matching real column
// (port_discharge, efs, place_of_receipt, port_loading, hbl/booking/seal —
// present as columns but often blank in practice) — those stay blank here
// for manual entry in the editable preview, never guessed.
async function buildContainerInvoiceData(containerNo) {
    const { headers, rows } = await fetchRawSheet();
    const colMap = buildColumnMap(headers);
    if (colMap.container_no === -1) {
        throw new Error('Invoice sheet header layout changed — expected a "Container No." column');
    }
    const target = safeStr(containerNo).toUpperCase();
    const containerRows = rows.filter((r) => safeStr(r[colMap.container_no]).toUpperCase() === target);
    if (!containerRows.length) return null;

    const first = rowToDict(containerRows[0], colMap);
    const packingLookup = await fetchPackingLookup();
    const packing = packingLookup.get(target) || null;

    let freight = 0;
    const lineItems = containerRows.map((row) => {
        const d = rowToDict(row, colMap);
        const weight = safeFloat(d.weight);
        const rate = safeFloat(d.inv_price);
        const amount = weight * rate;
        if (!freight) {
            const fv = evalFreight(d.freight_charge);
            if (fv > 0) freight = fv;
        }
        const itemDesc = resolveItemDesc(d.item_desc, first.inv_no);
        const weightLbs = Math.round(weight * 2204.62);
        const pr = packing ? findPackingRow(packing.rows, itemDesc) : null;
        return {
            item_desc: itemDesc,
            weight,
            rate,
            amount,
            packing: {
                gross_weight_lbs: (pr && pr.gross_weight_lbs) || '',
                truck_lbs: (pr && pr.truck_lbs) || '',
                container_tare_lbs: (pr && pr.container_tare_lbs) || '',
                chassis_lbs: (pr && pr.chassis_lbs) || '',
                boxes_weight_lbs: (pr && pr.boxes_weight_lbs) || '',
                net_weight_lbs: (pr && pr.net_weight_lbs) || String(weightLbs),
                net_weight_mt: (pr && pr.net_weight_mt) || weight.toFixed(3),
            },
        };
    });

    const subtotal = lineItems.reduce((s, it) => s + it.amount, 0);

    return {
        container_no: target,
        consignee: first.consignee,
        inv_no: first.inv_no,
        inv_date: first.inv_date,
        hbl_no: first.hbl_no,
        booking_no: first.booking_no,
        seal_no: first.seal_no,
        terms: first.terms,
        reference: first.reference,
        proforma_date: first.proforma_date,
        eta: first.eta,
        port_loading: packing ? packing.port_loading : 'LOS ANGELES',
        port_discharge: packing ? packing.port_discharge : 'TO BE ADVISED',
        place_of_receipt: packing ? packing.place_of_receipt : '',
        freight,
        subtotal,
        final_amount: subtotal - freight,
        line_items: lineItems,
    };
}

// Builds ONE invoice covering several containers that share a booking —
// per Apsara: "if both containers belong to the same booking, it should
// get generated in same invoice". Header fields (consignee, inv_no, dates,
// booking_no, terms…) come from the FIRST matched row same as
// buildContainerInvoiceData, since Booking # is the one field genuinely
// shared across every container in the group. Container # and Seal #
// differ PER CONTAINER though, so — unlike the single-container path —
// each line item carries its OWN container_no/seal_no rather than
// inheriting one top-level value. helpers/invoicePdf.js's item/packing
// rows read `item.container_no || data.container_no` so this same
// template renders both shapes without a second code path.
async function buildMultiContainerInvoiceData(containerNos) {
    const { headers, rows } = await fetchRawSheet();
    const colMap = buildColumnMap(headers);
    if (colMap.container_no === -1) {
        throw new Error('Invoice sheet header layout changed — expected a "Container No." column');
    }
    const targets = new Set((containerNos || []).map((c) => safeStr(c).toUpperCase()).filter(Boolean));
    if (!targets.size) return null;
    const matchedRows = rows.filter((r) => targets.has(safeStr(r[colMap.container_no]).toUpperCase()));
    if (!matchedRows.length) return null;

    const first = rowToDict(matchedRows[0], colMap);
    const packingLookup = await fetchPackingLookup();

    let freight = 0;
    const lineItems = matchedRows.map((row) => {
        const d = rowToDict(row, colMap);
        const containerNo = safeStr(d.container_no).toUpperCase();
        const weight = safeFloat(d.weight);
        const rate = safeFloat(d.inv_price);
        const amount = weight * rate;
        if (!freight) {
            const fv = evalFreight(d.freight_charge);
            if (fv > 0) freight = fv;
        }
        const itemDesc = resolveItemDesc(d.item_desc, first.inv_no);
        const weightLbs = Math.round(weight * 2204.62);
        const packing = packingLookup.get(containerNo) || null;
        const pr = packing ? findPackingRow(packing.rows, itemDesc) : null;
        return {
            item_desc: itemDesc,
            weight,
            rate,
            amount,
            container_no: containerNo,
            seal_no: d.seal_no,
            packing: {
                gross_weight_lbs: (pr && pr.gross_weight_lbs) || '',
                truck_lbs: (pr && pr.truck_lbs) || '',
                container_tare_lbs: (pr && pr.container_tare_lbs) || '',
                chassis_lbs: (pr && pr.chassis_lbs) || '',
                boxes_weight_lbs: (pr && pr.boxes_weight_lbs) || '',
                net_weight_lbs: (pr && pr.net_weight_lbs) || String(weightLbs),
                net_weight_mt: (pr && pr.net_weight_mt) || weight.toFixed(3),
            },
        };
    });

    const subtotal = lineItems.reduce((s, it) => s + it.amount, 0);
    const firstContainerNo = safeStr(first.container_no).toUpperCase();
    const firstPacking = packingLookup.get(firstContainerNo) || null;

    // Distinct container list, sheet order — used both as a display fallback
    // (any item missing its own container_no falls back to this) and as the
    // identifier documentsSaved.js/invoiceVersions.js file this invoice
    // under, since there's no single container number to key off of here.
    const distinctContainers = Array.from(new Set(lineItems.map((li) => li.container_no)));

    return {
        container_no: distinctContainers.join('+'),
        consignee: first.consignee,
        inv_no: first.inv_no,
        inv_date: first.inv_date,
        hbl_no: first.hbl_no,
        booking_no: first.booking_no,
        seal_no: first.seal_no,
        terms: first.terms,
        reference: first.reference,
        proforma_date: first.proforma_date,
        eta: first.eta,
        port_loading: firstPacking ? firstPacking.port_loading : 'LOS ANGELES',
        port_discharge: firstPacking ? firstPacking.port_discharge : 'TO BE ADVISED',
        place_of_receipt: firstPacking ? firstPacking.place_of_receipt : '',
        freight,
        subtotal,
        final_amount: subtotal - freight,
        line_items: lineItems,
        multi_container: true,
        containers: distinctContainers,
    };
}

// ── Packing List sheet (cfg.INVOICE_PACKING_GID) ────────────────────────────
// Unlike the main Invoice sheet, this one's numeric column positions were
// checked directly against 5 real live rows and DO still match
// invoice_gen.py's hardcoded PACKING_COLUMNS (carrier:0, container_no:8,
// gross:11, truck:12, tare:13, chassis:14, boxes:15, net_lbs:17, net_mt:18)
// — this sheet hasn't drifted the way the main one had, so those indices
// are used as-is rather than resolved by header name (its header row is
// itself malformed — column A is literally labeled "g").
let packingCache = null;
const PACKING_CACHE_MS = 3 * 60 * 1000;

const PORT_ALIASES = {
    LA: 'LOS ANGELES', LAX: 'LOS ANGELES', LB: 'LONG BEACH',
    NY: 'NEW YORK', CHI: 'CHICAGO', HOU: 'HOUSTON', SAV: 'SAVANNAH', OAK: 'OAKLAND',
};
function expandPort(v) {
    const s = safeStr(v).toUpperCase();
    return PORT_ALIASES[s] || safeStr(v);
}

async function fetchPackingLookup() {
    if (packingCache && (Date.now() - packingCache.at) < PACKING_CACHE_MS) return packingCache.lookup;
    if (!cfg.INVOICE_PACKING_GID) return new Map();
    const url = `https://docs.google.com/spreadsheets/d/${cfg.INVOICE_SHEET_ID}/export?format=csv&gid=${cfg.INVOICE_PACKING_GID}`;
    const res = await fetch(url);
    if (!res.ok) return new Map();
    const text = await res.text();
    const table = parseCsv(text);
    const lookup = new Map(); // container_no -> { port_loading, port_discharge, place_of_receipt, rows: [...] }

    for (const row of table.slice(1)) {
        const containerNo = safeStr(row[8]).toUpperCase();
        if (!containerNo) continue;
        if (!lookup.has(containerNo)) {
            const carrierRaw = safeStr(row[0]);
            let placeOfReceipt = '', portLoading = '', portDischarge = '';
            if (carrierRaw.includes('/')) {
                const parts = carrierRaw.split('/').map((p) => p.trim());
                if (parts.length >= 3) { [placeOfReceipt, portLoading, portDischarge] = parts; }
                else { portLoading = parts[0] || ''; portDischarge = parts[1] || ''; }
            } else {
                portLoading = carrierRaw;
            }
            lookup.set(containerNo, {
                port_loading: expandPort(portLoading) || 'LOS ANGELES',
                port_discharge: expandPort(portDischarge) || 'TO BE ADVISED',
                place_of_receipt: expandPort(placeOfReceipt),
                rows: [],
            });
        }
        lookup.get(containerNo).rows.push({
            item_desc: safeStr(row[10]),
            gross_weight_lbs: safeStr(row[11]),
            truck_lbs: safeStr(row[12]),
            container_tare_lbs: safeStr(row[13]),
            chassis_lbs: safeStr(row[14]),
            boxes_weight_lbs: safeStr(row[15]),
            net_weight_lbs: safeStr(row[17]),
            net_weight_mt: safeStr(row[18]),
        });
    }
    packingCache = { at: Date.now(), lookup };
    return lookup;
}

// Matches a packing row to a line item by description (either-direction
// substring, same as invoice_gen.py's find_packing_row) — falls back to the
// first packing row for the container if nothing matches by description.
function findPackingRow(packingRows, itemDesc) {
    if (!packingRows || !packingRows.length) return null;
    const key = itemDesc.trim().toUpperCase();
    for (const row of packingRows) {
        const rowDesc = row.item_desc.trim().toUpperCase();
        if (rowDesc && (rowDesc.includes(key) || key.includes(rowDesc))) return row;
    }
    return packingRows[0];
}


// RESTORED 2026-08-22. Removed by commit 8dc3495 ("INV BY INV NO"), which
// added findContainersByInvNo/invNoTailCodes and, in writing this file back,
// dropped this one. helpers/receivables.js's buildLedger() calls it, so every
// receivables question answered "Couldn't read the invoice sheet:
// invoiceSheet.listAllInvoices is not a function" — the second regression of
// this exact shape today; see the restored block in workflow/actions.js for
// the first.
// ── Every invoice on the sheet, with its total ──────────────────────────────
// Built 2026-08-22 for the receivables ledger (helpers/receivables.js). Lives
// HERE, not there, on purpose: the invoice total is real money, and the rule
// for it — sum(weight × inv price), then subtract freight ONCE per invoice —
// already exists twice in this file (buildContainerInvoiceData and
// buildMultiContainerInvoiceData, which agree exactly). A third copy in
// another file would be a place for the three to silently drift apart, and
// the symptom would be an AR balance that disagrees with the invoice PDF the
// customer is holding.
//
// Grouped by INV NO. rather than by container, because that's the unit a
// customer actually owes against: one invoice can cover several containers
// (see buildMultiContainerInvoiceData), and freight applies once to the
// invoice, not once per container.
//
// Rows with no invoice number are skipped rather than lumped together — an
// unnumbered row is a draft or a spacer, not a debt.
async function listAllInvoices(forceRefresh) {
    const { headers, rows } = await fetchRawSheet(forceRefresh);
    const colMap = buildColumnMap(headers);
    if (colMap.inv_no === -1) {
        throw new Error('Invoice sheet header layout changed — expected an "Inv No." column');
    }
    const byInvNo = new Map();
    for (const row of rows) {
        const d = rowToDict(row, colMap);
        const invNo = safeStr(d.inv_no);
        if (!invNo) continue;
        if (!byInvNo.has(invNo)) {
            byInvNo.set(invNo, {
                inv_no: invNo,
                consignee: safeStr(d.consignee),
                customer: safeStr(d.customer),
                inv_date: safeStr(d.inv_date),
                terms: safeStr(d.terms),
                containers: [],
                subtotal: 0,
                freight: 0,
                line_count: 0,
            });
        }
        const inv = byInvNo.get(invNo);
        inv.subtotal += safeFloat(d.weight) * safeFloat(d.inv_price);
        inv.line_count += 1;
        const c = safeStr(d.container_no).toUpperCase();
        if (c && !inv.containers.includes(c)) inv.containers.push(c);
        // First non-zero freight wins, exactly as the two builders above do.
        if (!inv.freight) {
            const fv = evalFreight(d.freight_charge);
            if (fv > 0) inv.freight = fv;
        }
        // Keep the first non-empty header value seen for the invoice — later
        // rows of a multi-container invoice often leave these blank and carry
        // only line-item data.
        if (!inv.consignee) inv.consignee = safeStr(d.consignee);
        if (!inv.customer) inv.customer = safeStr(d.customer);
        if (!inv.inv_date) inv.inv_date = safeStr(d.inv_date);
        if (!inv.terms) inv.terms = safeStr(d.terms);
    }
    return Array.from(byInvNo.values()).map((inv) => ({
        ...inv,
        subtotal: Math.round(inv.subtotal * 100) / 100,
        final_amount: Math.round((inv.subtotal - inv.freight) * 100) / 100,
    }));
}

module.exports = {
    listAllInvoices, // restored 2026-08-22, see above
    findContainersByInvNo, invNoTailCodes,
    findContainersForBuyer,
    findContainersByNumber,
    buildContainerInvoiceData,
    buildMultiContainerInvoiceData,
    fetchPackingLookup,
    findPackingRow,
    resolveItemDesc,
    evalFreight,
    // Exposed for helpers/invoiceVerify.js (Verification tab's Zimex
    // sub-tab) to build its own HBL-keyed freight/commission index without
    // duplicating the column-resolution/CSV-fetch logic above.
    fetchRawSheet,
    buildColumnMap,
    rowToDict,
    ITEM_CODE_MAP,
};
