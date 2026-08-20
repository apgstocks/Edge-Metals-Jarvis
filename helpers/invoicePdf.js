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

function buildInvoiceClassicHtml(data) {
    const lineItems = data.line_items || [];
    const subtotal = data.subtotal != null ? Number(data.subtotal) : lineItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const freight = Number(data.freight) || 0;
    const finalAmount = data.final_amount != null ? Number(data.final_amount) : subtotal - freight;

    // Item table — S.No / Booking# / Container# / Seal# / Description /
    // Quantity MT / Rate US$/MT / Amount US$. Booking/Container/Seal are the
    // same for every row on a container's invoice (one shipment can carry
    // several line items), so they're repeated per row rather than merged —
    // simpler and safer than a rowspan that could misrender in some PDF
    // engines.
    const itemRowsHtml = lineItems.map((item, i) => {
        const qty = Number(item.weight) || 0;
        const rate = Number(item.rate) || 0;
        const amount = Number(item.amount != null ? item.amount : qty * rate);
        // Booking#/Container#/Seal# use a smaller 8pt + tighter padding and
        // nowrap+hidden-overflow — real Helvetica (reportlab) renders these
        // ID strings narrower than Chromium's Helvetica-substitute font
        // does, so at the reference's own 9pt they were overflowing the
        // narrow ID columns and visually running into the neighboring cell.
        const idCell = (val) => `<td style="padding:0.5mm;font-size:8pt;text-align:center;white-space:nowrap;overflow:hidden;">${escapeHtml(val)}</td>`;
        return `        <tr style="height:8mm;">
          ${idCell(i + 1)}
          ${idCell(data.booking_no)}
          ${idCell(data.container_no)}
          ${idCell(data.seal_no)}
          <td style="padding:1mm;font-size:9pt;">${escapeHtml(item.item_desc)}</td>
          <td style="padding:1mm;font-size:9pt;text-align:right;">${formatQtyMt(qty)}</td>
          <td style="padding:1mm;font-size:9pt;text-align:right;">${formatRate(rate)}</td>
          <td style="padding:1mm;font-size:9pt;text-align:right;">${formatMoney2(amount)}</td>
        </tr>`;
    });

    // Freight is a DEDUCTION off the buyer's invoice total (matches
    // invoice_gen.py's behavior — freight the buyer already paid/arranged
    // gets subtracted, not added). Only rendered when a freight figure was
    // actually found on the sheet for this container.
    let freightRowHtml = '';
    if (freight > 0) {
        freightRowHtml = `        <tr style="height:8mm;">
          <td colspan="5" style="padding:1mm;font-size:9pt;text-align:right;font-style:italic;">Less: Freight Charges</td>
          <td style="padding:1mm;"></td>
          <td style="padding:1mm;"></td>
          <td style="padding:1mm;font-size:9pt;text-align:right;">-${formatMoney2(freight)}</td>
        </tr>`;
    }
    // No real EFS column exists on the live sheet (checked directly — see
    // helpers/invoiceSheet.js's header comment), so this stays blank rather
    // than guessed. Left as an explicit token so a real EFS source can be
    // wired in later without touching the template again.
    const efsRowHtml = '';

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
          <td style="padding:1mm;font-size:8.5pt;text-align:center;">${escapeHtml(data.container_no)}</td>
          <td style="padding:1mm;font-size:8.5pt;text-align:right;">${escapeHtml(p.gross_weight_lbs || '-')}</td>
          <td style="padding:1mm;font-size:8.5pt;text-align:right;">${escapeHtml(p.truck_lbs || '-')}</td>
          <td style="padding:1mm;font-size:8.5pt;text-align:right;">${escapeHtml(p.container_tare_lbs || '-')}</td>
          <td style="padding:1mm;font-size:8.5pt;text-align:right;">${escapeHtml(p.chassis_lbs || '-')}</td>
          <td style="padding:1mm;font-size:8.5pt;text-align:right;">${escapeHtml(p.boxes_weight_lbs || '-')}</td>
          <td style="padding:1mm;font-size:8.5pt;text-align:right;">${escapeHtml(p.net_weight_lbs || formatInt(netLbs))}</td>
          <td style="padding:1mm;font-size:8.5pt;text-align:right;">${netMt.toFixed(3)}</td>
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
        freight_row: freightRowHtml,
        efs_row: efsRowHtml,
        final_amount_fmt: formatMoney2(finalAmount),
        packing_rows: packingRowsHtml.join('\n'),
        total_net_lbs_fmt: formatInt(totalNetLbs),
        total_net_mt_fmt: totalNetMt.toFixed(3),
    };
    for (const [key, val] of Object.entries(subs)) {
        html = html.split(`{{${key}}}`).join(val);
    }
    return { html, subtotal, freight, finalAmount };
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
        const pdf = await page.pdf({
            width: '816px',
            printBackground: true,
            preferCSSPageSize: true,
        });
        // Same Uint8Array -> Buffer gotcha documented in proformaPdf.js —
        // res.send() needs a real Buffer or it JSON-stringifies byte-by-byte.
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
}

module.exports = { buildInvoiceClassicHtml, generateInvoiceClassicPdf };
