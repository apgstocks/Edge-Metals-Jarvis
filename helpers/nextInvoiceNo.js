// ── helpers/nextInvoiceNo.js — Next-invoice-number suggestion ──────────────
// Added per Apsara: derive the next invoice number for a selected consignee
// by reading her REAL historical numbers from the Invoice Google Sheet
// (cfg.INVOICE_SHEET_ID / INVOICE_MAIN_GID — the SAME sheet invoice_gen.py
// already reads, via the same public CSV export URL invoice_gen.py uses —
// confirmed reachable without any service-account sharing step, unlike
// helpers/sheets.js's PRICE_SHEET_ID which needs the sheet shared with a
// service account first).
//
// Number format below was confirmed against LIVE rows in that sheet, not
// guessed: the LAST whitespace-separated token of the "Inv No." cell is a
// code like "25JY104" / "25RMT116" / "25AQ02" — two-digit year + a letter
// code + a running number, sometimes followed by a trailing container-
// suffix letter (e.g. "25JY67A", "25JY68A"). That trailing letter is left
// alone — never auto-generated, still typed by hand — since its meaning
// (which container within a shipment) isn't something this can infer.
//
// Matching a selected consignee to past sheet rows is LOOSE (substring,
// either direction) per Apsara's explicit choice — the sheet has spelling
// drift for the same real customer (e.g. "MK Trading" vs "MK Metal
// Trading"), and loose matching catches both under one running sequence.
//
// New suggestions use the CURRENT 2-digit year as the prefix (e.g. "26"
// as of 2026) per Apsara's explicit choice, even though every row in the
// sheet today is still "25" — this only changes the YEAR PREFIX text, not
// the running number itself, which keeps incrementing from whatever the
// highest matched number was regardless of which year it was logged under.

const cfg = require('../config');

let cache = null; // { at: <ms>, rows: [{ consignee, invNo }, ...] }
const CACHE_MS = 3 * 60 * 1000; // avoid hammering Google Sheets on every keystroke

// Minimal RFC4180-ish CSV parser (quoted fields, embedded commas, escaped
// "" inside quotes) — no new npm dependency added just for this; the sheet
// export is well-formed enough that a small hand-rolled parser is plenty.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip — \n handles the row break */ }
        else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

async function fetchInvoiceSheetRows() {
    if (cache && (Date.now() - cache.at) < CACHE_MS) return cache.rows;
    if (!cfg.INVOICE_SHEET_ID) throw new Error('INVOICE_SHEET_ID not configured');
    const url = `https://docs.google.com/spreadsheets/d/${cfg.INVOICE_SHEET_ID}/export?format=csv&gid=${cfg.INVOICE_MAIN_GID}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read invoice sheet (${res.status})`);
    const text = await res.text();
    const table = parseCsv(text);
    if (!table.length) return [];

    const headers = table[0].map((h) => String(h || '').trim().toLowerCase());
    const consigneeCol = headers.indexOf('consignee');
    const invNoCol = headers.findIndex((h) => h.startsWith('inv no'));
    if (consigneeCol === -1 || invNoCol === -1) {
        // Fail loud, not silent — a header rename in the sheet should surface
        // as an error here, not quietly suggest wrong/blank numbers.
        throw new Error('Invoice sheet header layout changed — expected "Consignee" and "Inv No." columns');
    }

    const rows = table.slice(1)
        .filter((r) => r && r[consigneeCol] && String(r[consigneeCol]).trim())
        .map((r) => ({
            consignee: String(r[consigneeCol] || '').trim(),
            invNo: String(r[invNoCol] || '').trim(),
        }));
    cache = { at: Date.now(), rows };
    return rows;
}

// Parses the trailing code token of an "Inv No." cell, e.g.
// "250930 25JY67A" -> { yearPrefix:'25', code:'JY', number:67,
// numberDigits:2, numberHadLeadingZero:false, suffix:'A' }.
// Returns null for cells that don't match the expected shape (blank,
// malformed, or a one-off format) — skipped rather than guessed at.
function parseInvNoToken(invNoRaw) {
    const tokens = (invNoRaw || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    const token = tokens[tokens.length - 1];
    const m = /^(\d{2})([A-Za-z]+)(\d+)([A-Za-z]*)$/.exec(token);
    if (!m) return null;
    return {
        yearPrefix: m[1],
        code: m[2].toUpperCase(),
        number: parseInt(m[3], 10),
        numberDigits: m[3].length,
        numberHadLeadingZero: m[3].length > 1 && m[3][0] === '0',
        suffix: m[4] || '',
    };
}

function looseMatch(consigneeCell, query) {
    const a = consigneeCell.toLowerCase();
    const b = query.toLowerCase();
    return a.includes(b) || b.includes(a);
}

// Main entry point: given a consignee name (as typed/selected on the
// Proforma page), returns a suggested next inv_no, or null if there's no
// usable history to derive one from (brand-new consignee — falls back to
// manual entry, same as before this feature existed).
async function suggestNextInvNo(consigneeQuery) {
    const query = (consigneeQuery || '').trim();
    if (!query) return null;

    const rows = await fetchInvoiceSheetRows();
    const matches = rows.filter((r) => looseMatch(r.consignee, query));

    let best = null; // the parsed token with the highest running number among matches
    for (const r of matches) {
        const parsed = parseInvNoToken(r.invNo);
        if (!parsed) continue;
        if (!best || parsed.number > best.number) best = parsed;
    }
    if (!best) return null;

    const today = new Date();
    const yy = String(today.getFullYear()).slice(-2);
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;

    const nextNumber = best.number + 1;
    const numberStr = best.numberHadLeadingZero
        ? String(nextNumber).padStart(best.numberDigits, '0')
        : String(nextNumber);

    const codeOnly = `${yy}${best.code}${numberStr}`;
    return {
        inv_no: `${dateStr} ${codeOnly}`,
        code_only: codeOnly,
        matched_rows: matches.length,
        highest_existing: `${best.yearPrefix}${best.code}${String(best.number).padStart(best.numberDigits, '0')}${best.suffix}`,
        letter_code: best.code,
        // Raw pieces so the client can keep generating FURTHER sequential
        // codes without another round trip — per Apsara: "update this in
        // container incrementally in proforma". The real sheet shows exactly
        // this pattern already: multiple containers under one shipment each
        // get their own consecutive number (e.g. 25JY84, 85, 86, 87, 88 as
        // separate rows on the same date) — so each container block in a
        // proforma with more than one container should get the next number
        // up, not all of them repeating the same one.
        year_prefix: yy,
        next_number: nextNumber,
        number_digits: best.numberDigits,
        number_had_leading_zero: best.numberHadLeadingZero,
    };
}

module.exports = { suggestNextInvNo, parseInvNoToken, looseMatch, fetchInvoiceSheetRows };
