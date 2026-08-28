// ── helpers/invoicePdf.js — Commercial Invoice + Packing List PDF ──────────
// Added per Apsara: "build invoice now.similar to proforma ask me who is the
// buyer.then follow python anywhere invoice flow". Data/calculations are
// ported from her old PythonAnywhere Flask tool (invoice_gen.py — see
// helpers/invoiceSheet.js for the sourcing/mapping notes and the important
// caveat about that tool's stale column indices).
//
// VISUAL DESIGN — first version reused Jarvis's modern "leaf/steel" Proforma
// look; Apsara rejected it outright ("this design is not what i wanted.")
// and, asked explicitly via AskUserQuestion, chose "Match the old blue
// layout exactly". This now renders assets/invoice-classic/template.html,
// a close replica of invoice_gen.py's draw_mk_trading_invoice() reportlab
// layout (blue header bars, light-blue label cells, boxed grid) — NOT the
// Proforma style. Still rendered via puppeteer; no custom fonts needed here
// (the classic template uses plain Helvetica/Arial), so FONTS_DIR/font
// substitution from the old template is not used by this one.

const fs = require('fs');
const { round2 } = require('./money');
const path = require('path');
const puppeteer = require('puppeteer');

const TEMPLATE_DIR = path.join(__dirname, '..', 'assets', 'invoice-classic');

let _templateCache = null;
function loadTemplate() {
    if (_templateCache) return _templateCache;
    _templateCache = fs.readFileSync(path.join(TEMPLATE_DIR, 'template.html'), 'utf8');
    return _templateCache;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Formatting — reuses the exact same date/rate/qty helpers already proven
// correct in helpers/proformaPdf.js, required directly rather than
// re-implemented, so a fix made there doesn't silently drift out of sync
// between the two document types. amountInWords is not used by this classic
// layout (the old reportlab tool didn't print it either), so it's not
// imported here.
const { formatDate, formatRate } = require('./proformaPdf');
const { ITEM_CODE_MAP } = require('./invoiceSheet');

function formatMoney2(value) {
    return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatInt(value) {
    return Math.round(Number(value) || 0).toLocaleString('en-US');
}
// invoice_gen.py's qty_display used f"{weight:.3f}" for MT quantities (3
// decimals — confirmed against the real reference PDF: "22.680", not
// "22.68"). Proforma's own formatQty() is fixed at 2 decimals for its own
// document, so it's not reused here — a local 3-decimal formatter matches
// this specific document's real historical output instead.
function formatQtyMt(value) {
    return Number(value || 0).toFixed(3);
}

// "AC-AUTO CAST" style label — mirrors invoice_gen.py's get_item_label().
// Tries to find the code by matching the resolved description back against
// ITEM_CODE_MAP first (cheap, no ambiguity when the description is exactly
// one of the known material names); falls back to pulling the 2-letter code
// out of the Inv No. token, same fallback helpers/invoiceSheet.js's own
// resolveItemDesc() already uses for the description itself.
function getItemCode(itemDesc, invNo) {
    const descUpper = String(itemDesc || '').toUpperCase().trim();
    for (const [code, desc] of Object.entries(ITEM_CODE_MAP)) {
        if (desc === descUpper) return code;
    }
    const tokens = String(invNo || '').split(/[\s_]+/);
    for (const t of tokens) {
        const code = t.toUpperCase();
        if (ITEM_CODE_MAP[code]) return code;
    }
    return '';
}
// Matches invoice_gen.py's get_item_label() exactly: the label is
// CODE-CANONICAL_NAME (e.g. "AL-ALUMINIUM COMBO"), always from
// ITEM_CODE_MAP's own value — NOT the sheet row's raw item_desc text (which
// can be lowercase/abbreviated, like "Al combo" in a real sample invoice).
function itemLabel(itemDesc, invNo) {
    const code = getItemCode(itemDesc, invNo);
    if (code && ITEM_CODE_MAP[code]) return `${code}-${ITEM_CODE_MAP[code]}`;
    return '';
}

// Normalizes whatever the client sent into a flat [{label, amount}, ...]
// list. Apsara's redesign ("Invoice Notes" — replaces the old dedicated
// Freight Deduction field) lets her add arbitrary labeled adjustment rows,
// each signed: negative deducts from the total, positive adds to it (her
// own words on the mockup). Freight and EFS are no longer special-cased
// fields — they're just the first couple of notes, still shown as friendly
// labeled inputs in the UI, but structurally identical to any other note.
//
// Backward compatible with the OLD single-freight payload shape
// (data.freight, a positive number meaning "deduct this much") for any
// already-saved version-history entries or in-flight requests from a
// not-yet-updated client — synthesized into one negative-amount note so old
// and new payloads render identically.
function normalizeNotes(data) {
    if (Array.isArray(data.notes)) {
        return data.notes
            .map((n) => ({ label: String((n && n.label) || '').trim(), amount: Number(n && n.amount) || 0 }))
            .filter((n) => n.label && n.amount !== 0);
    }
    const legacyFreight = Number(data.freight) || 0;
    return legacyFreight > 0 ? [{ label: 'Less: Freight Charges', amount: -legacyFreight }] : [];
}

function buildInvoiceClassicHtml(data) {
    const lineItems = data.line_items || [];
    const subtotal = data.subtotal != null ? Number(data.subtotal) : lineItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const notes = normalizeNotes(data);
    const notesTotal = notes.reduce((s, n) => s + n.amount, 0);
    const finalAmount = data.final_amount != null ? Number(data.final_amount) : subtotal + notesTotal;

    // Item table — S.No / Booking# / Container# / Seal# / Description /
    // Quantity MT / Rate US$/MT / Amount US$. Booking/Container/Seal are the
    // same for every row on a container's invoice (one shipment can carry
    // several line items), so they're repeated per row rather than merged —
    // simpler and safer than a rowspan that could misrender in some PDF
    // engines.
    const itemRowsHtml = lineItems.map((item, i) => {
        const qty = Number(item.weight) || 0;
        const rate = Number(item.rate) || 0;
        // round2 on the fallback: when the sheet supplied no amount this
        // computes one, and qty * rate is raw floating point. An invoice line
        // reading 15.524999999999999 is not a thing to send a customer.
        const amount = round2(Number(item.amount != null ? item.amount : qty * rate));
        // Booking#/Container#/Seal# use a smaller 8.5pt (was 8pt, bumped
        // one step less than the other columns' +1pt) + tighter padding
        // and nowrap+hidden-overflow — real Helvetica (reportlab) renders
        // these ID strings narrower than Chromium's Helvetica-substitute
        // font does, so pushing this column all the way to 9pt like the
        // rest reintroduced the overflow into the neighboring cell that
        // was fixed earlier this session (re-tested against the real
        // "DALA27808800"/"KOCU4877967" values before settling here).
        const idCell = (val) => `<td style="padding:0.5mm;font-size:8.5pt;text-align:center;vertical-align:middle;white-space:nowrap;overflow:hidden;">${escapeHtml(val)}</td>`;
        // Description always wraps (word-wrap/overflow-wrap:break-word,
        // white-space:normal) regardless of length — a long unbroken item
        // description no longer overflows into the Quantity column now
        // that table-layout:fixed enforces the column width, it just wraps
        // and the row grows taller instead. Every cell is both
        // horizontally (text-align:center) AND vertically
        // (vertical-align:middle) centered — global td{vertical-align:top}
        // in the template's CSS would otherwise pin short cells (S.No,
        // Quantity) to the top of a row that a wrapped Description has
        // made much taller. Apsara: "make the text in center aligned. also
        // wrap description always." / "mid center alignment."
        // item.container_no/item.seal_no exist when several containers are
        // merged into one invoice (buildMultiContainerInvoiceData — each
        // container keeps its own seal); falls back to the shared
        // top-level value for the ordinary single-container case, so this
        // one code path renders both shapes correctly.
        return `        <tr style="height:8mm;">
          ${idCell(i + 1)}
          ${idCell(data.booking_no)}
          ${idCell(item.container_no || data.container_no)}
          ${idCell(item.seal_no || data.seal_no)}
          <td style="padding:1mm;font-size:10pt;text-align:center;vertical-align:middle;word-wrap:break-word;overflow-wrap:break-word;white-space:normal;">${escapeHtml(item.item_desc)}</td>
          <td style="padding:1mm;font-size:10pt;text-align:center;vertical-align:middle;">${formatQtyMt(qty)}</td>
          <td style="padding:1mm;font-size:10pt;text-align:center;vertical-align:middle;">${formatRate(rate)}</td>
          <td style="padding:1mm;font-size:10pt;text-align:center;vertical-align:middle;">${formatMoney2(amount)}</td>
        </tr>`;
    });

    // One merged-through-Rate italic row per note (same visual pattern the
    // old single hardcoded freight row used — label cell's own colspan
    // extends through Rate, 7 columns: S.No/Booking/Container/Seal/
    // Description/Quantity/Rate, only Amount stays a separate column.
    // Apsara: "no till rate only merge" — merge through Rate only, not a
    // second blank cell after the label). A negative amount prints with its
    // sign and reads as a deduction; a positive amount prints with a "+"
    // so it's visually obvious it's adding to the total, not a stray
    // positive line item.
    const notesRowsHtml = notes.map((n) => {
        const sign = n.amount < 0 ? '-' : '+';
        return `        <tr style="height:8mm;">
          <td colspan="7" style="padding:1mm;font-size:10pt;text-align:center;vertical-align:middle;font-style:italic;">${escapeHtml(n.label)}</td>
          <td style="padding:1mm;font-size:10pt;text-align:center;vertical-align:middle;">${sign}${formatMoney2(Math.abs(n.amount))}</td>
        </tr>`;
    }).join('\n');

    const addr = data.consignee_address || [];
    const buyerName = addr.length ? addr[0] : (data.consignee || '');
    const rest = addr.length > 1 ? addr.slice(1) : [];
    const buyerAddressLines = rest.map(escapeHtml).join('<br>');

    const firstItemDesc = lineItems.length ? lineItems[0].item_desc : '';
    const otherRefParts = [];
    if (data.reference) otherRefParts.push(escapeHtml(data.reference));
    if (data.proforma_date) otherRefParts.push(`Proforma Date: ${escapeHtml(formatDate(data.proforma_date))}`);
    const otherRef = otherRefParts.join(' &nbsp;|&nbsp; ');

    // Packing List rows — one per line item, using whatever weights were
    // resolved server-side (real packing-sheet data where matched, else a
    // calculated fallback — see helpers/invoiceSheet.js).
    let totalNetLbs = 0, totalNetMt = 0;
    const packingRowsHtml = lineItems.map((item) => {
        const p = item.packing || {};
        const netMt = parseFloat(String(p.net_weight_mt || '').replace(/,/g, '')) || Number(item.weight) || 0;
        const netLbs = parseFloat(String(p.net_weight_lbs || '').replace(/,/g, '')) || Math.round(netMt * 2204.62);
        totalNetMt += netMt;
        totalNetLbs += netLbs;
        return `        <tr style="height:10mm;">
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${escapeHtml(item.container_no || data.container_no)}</td>
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${escapeHtml(p.gross_weight_lbs || '-')}</td>
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${escapeHtml(p.truck_lbs || '-')}</td>
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${escapeHtml(p.container_tare_lbs || '-')}</td>
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${escapeHtml(p.chassis_lbs || '-')}</td>
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${escapeHtml(p.boxes_weight_lbs || '-')}</td>
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${escapeHtml(p.net_weight_lbs || formatInt(netLbs))}</td>
          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${netMt.toFixed(3)}</td>
        </tr>`;
    });

    let html = loadTemplate();
    const subs = {
        inv_no: escapeHtml(data.inv_no || ''),
        item_label: escapeHtml(itemLabel(firstItemDesc, data.inv_no)),
        inv_date: escapeHtml(formatDate(data.inv_date)),
        other_ref: otherRef,
        buyer_name: escapeHtml(buyerName),
        buyer_address_lines: buyerAddressLines,
        terms: escapeHtml(data.terms || ''),
        vessel: escapeHtml(data.vessel || ''),
        country_of_origin: escapeHtml(data.country_of_origin || 'USA'),
        place_of_receipt: escapeHtml(data.place_of_receipt || ''),
        port_loading: escapeHtml(data.port_loading || ''),
        port_discharge: escapeHtml(data.port_discharge || ''),
        item_rows: itemRowsHtml.join('\n'),
        notes_rows: notesRowsHtml,
        final_amount_fmt: formatMoney2(finalAmount),
        packing_rows: packingRowsHtml.join('\n'),
        total_net_lbs_fmt: formatInt(totalNetLbs),
        total_net_mt_fmt: totalNetMt.toFixed(3),
        // The signature used to be base64-inlined directly in the template.
        // Pulled out to assets/shared/signature.png so the proforma can draw
        // the SAME image — one file, not two copies that can drift apart.
        // Dimensions preserved exactly (9mm block, 8mm x 35mm image) so this
        // renders pixel-identically to what it replaced.
        signature_block: require('./signature').signatureBlockHtml({ height: '9mm', maxHeight: '8mm', maxWidth: '35mm', align: 'center', justify: 'center', marginBottom: null }),
    };
    for (const [key, val] of Object.entries(subs)) {
        html = html.split(`{{${key}}}`).join(val);
    }
    return { html, subtotal, notes, finalAmount };
}

async function generateInvoiceClassicPdf(data, opts = {}) {
    const { html } = buildInvoiceClassicHtml(data);
    const browser = await puppeteer.launch({
        headless: true,
        args: opts.launchArgs || ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        // One page, per Apsara 2026-08-29 ("pdf should be one page only
        // always") after an invoice put its entire body on page 1 and only
        // the declaration and signature on page 2.
        //
        // The height is measured in the browser and the scale derived from
        // it, rather than a fixed factor: every extra item adds a row to the
        // item table AND to the packing list, so the right scale is different
        // for a 4-line invoice and a 12-line one. See helpers/pdfFit.js for
        // why this scales rather than tightening the layout — the fixed mm
        // heights in this template ARE the layout she asked to be reproduced
        // exactly.
        //
        // @page here is 210mm x 297mm and preferCSSPageSize honours it, so
        // A4 is the height to fit to.
        const { pdfFittedToOnePage } = require('./pdfFit');
        const pdf = await pdfFittedToOnePage(page, {
            width: '816px',
            printBackground: true,
            preferCSSPageSize: true,
        }, { pageHeightMm: 297, label: `invoice ${data && data.inv_no ? data.inv_no : ''}`.trim() });
        // Same Uint8Array -> Buffer gotcha documented in proformaPdf.js —
        // res.send() needs a real Buffer or it JSON-stringifies byte-by-byte.
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
}

module.exports = { buildInvoiceClassicHtml, generateInvoiceClassicPdf };
