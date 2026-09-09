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

// ── Standalone packing-list header ────────────────────────────────────────
// Apsara, 2026-09-09: "What if i want to have separate invoice and packing
// list" -> "Use seprate flag.." -> then sent her own separately-created
// packing list as the reference. Hers carries the FULL invoice header block:
// Exporter (with FAX), Invoice No & Items, DATE, Other Reference(s), the full
// Buyer address, Terms, Vessel / Flight No, Payment Terms, and all four port
// cells including Place of Receipt by Carrier.
//
// My first cut hand-wrote a trimmed-down second header in the template. That
// was wrong twice over: it dropped fields her document has, and it created a
// second copy of the header that would silently drift the first time anyone
// edited the real one (this template gets edited often — see the border and
// wrapping history in it). So instead the region between INV_HEAD_START and
// INV_HEAD_END is LIFTED from the invoice header and dropped into
// {{pl_header_rows}}. One source of truth.
//
// The lifted markup still contains {{...}} placeholders; it is injected
// BEFORE the substitution loop runs, so both copies get filled from the same
// values and cannot disagree about the buyer, the vessel or the ports.
const INV_HEAD_START = '<!--INV_HEAD_START-->';
const INV_HEAD_END = '<!--INV_HEAD_END-->';

function extractInvoiceHeader(tpl) {
    const a = tpl.indexOf(INV_HEAD_START);
    const b = tpl.indexOf(INV_HEAD_END);
    if (a === -1 || b === -1 || b < a) {
        // Fail loudly. Silently rendering a packing list with a blank header
        // would produce a document that looks fine and is useless to a broker.
        throw new Error(
            'invoicePdf: INV_HEAD markers missing from assets/invoice-classic/template.html — '
            + 'the standalone packing list cannot be built without them.'
        );
    }
    return tpl.slice(a + INV_HEAD_START.length, b);
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
const { ITEM_CODE_MAP, deriveItemCodeFromDesc } = require('./invoiceSheet');

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
    // KEYWORD match, second pass. Exact equality above only catches a
    // description already written exactly like the canonical name. Her real
    // line items say "Al combo", which is not "ALUMINIUM COMBO", so a
    // two-material invoice resolved only the regular combo and printed one
    // material in the header. Same rules the dashboard and mobile app use.
    const byKeyword = deriveItemCodeFromDesc(itemDesc);
    if (byKeyword && ITEM_CODE_MAP[byKeyword]) return byKeyword;

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

// EVERY material on the invoice, not just the first one.
//
// Apsara, 2026-09-09: "Invoice description should be Aluminium combo, regular
// combo as both are there."
//
// The header label was built from lineItems[0] alone, so an invoice covering
// two containers of different materials announced itself as whichever one
// happened to be first — "AL-ALUMINIUM COMBO" on a document that is half
// regular combo. On a customs document that is not a cosmetic problem.
//
// TWO SOURCES, in order of how much they can be trusted:
//
//   1. Each line item's own description, matched against ITEM_CODE_MAP.
//      De-duplicated and kept in the order they appear, so a five-container
//      invoice of one material still reads as one label.
//
//   2. Only if NOT ONE description matched: the codes carried in the Inv No.
//      itself. getItemCode already does this per item, but it returns the
//      FIRST code it finds in the number — so on "260901_AL_26JY96_260901_RC_
//      26JY97" every unmatched item resolved to AL, quietly relabelling the
//      regular combo as aluminium. Reading ALL of them instead is both more
//      honest and exactly what she asked for.
function itemLabels(lineItems, invNo) {
    const out = [];
    const seen = new Set();
    const push = (label) => {
        if (!label || seen.has(label)) return;
        seen.add(label);
        out.push(label);
    };

    for (const it of lineItems || []) {
        // Deliberately NOT passing invNo here. The per-item pass must answer
        // "what did THIS line say"; letting it fall back to the number is what
        // produced the mislabel above.
        push(itemLabel(it && it.item_desc, null));
    }
    if (out.length) return out.join(', ');

    for (const t of String(invNo || '').split(/[\s_]+/)) {
        const code = t.toUpperCase();
        if (ITEM_CODE_MAP[code]) push(`${code}-${ITEM_CODE_MAP[code]}`);
    }
    return out.join(', ');
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
        const amount = Number(item.amount != null ? item.amount : qty * rate);
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

    // (firstItemDesc removed 2026-09-09 — the header label now reads EVERY
    //  line item via itemLabels(), not just the first one.)
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
    // Clone the invoice header into the standalone packing-list slot before
    // any substitution happens, so the copy's placeholders are filled by the
    // same pass that fills the original's.
    html = html.split('{{pl_header_rows}}').join(extractInvoiceHeader(html));
    const subs = {
        // <wbr> after each underscore: a real break OPPORTUNITY that
        // contributes no character, so the wrapped number still copies out of
        // the PDF as plain text. Without it, overflow-wrap breaks at the box
        // edge wherever that lands — splitting "26JY96" into "26JY9" and "6"
        // on a financial document. With it, a combined number breaks between
        // whole invoice numbers. Escape FIRST, then insert the tag, or the
        // angle brackets get escaped too.
        inv_no: escapeHtml(data.inv_no || '').replace(/_/g, '_<wbr>'),
        item_label: escapeHtml(itemLabels(lineItems, data.inv_no)),
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
    };
    for (const [key, val] of Object.entries(subs)) {
        html = html.split(`{{${key}}}`).join(val);
    }
    return { html, subtotal, notes, finalAmount };
}

// ONE browser, N renders. Chromium launch is by far the most expensive part
// of this (~1s), so producing two documents must not pay it twice.
async function renderModes(html, modes, opts) {
    const browser = await puppeteer.launch({
        headless: true,
        args: opts.launchArgs || ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const out = {};
        for (const mode of modes) {
            // The mode is a BODY CLASS, and the CSS in the template hides the
            // other document. One DOM, re-labelled — no second setContent, and
            // no possibility of the two PDFs disagreeing about the data.
            await page.evaluate((m) => {
                document.body.classList.remove('only-invoice', 'only-packing');
                if (m) document.body.classList.add(m);
            }, mode === 'both' ? null : `only-${mode}`);
            const pdf = await page.pdf({
                width: '816px',
                printBackground: true,
                preferCSSPageSize: true,
            });
            // Same Uint8Array -> Buffer gotcha documented in proformaPdf.js —
            // res.send() needs a real Buffer or it JSON-stringifies byte-by-byte.
            out[mode] = Buffer.from(pdf);
        }
        return out;
    } finally {
        await browser.close();
    }
}

// ── separate ──────────────────────────────────────────────────────────────
// Apsara, 2026-09-09: "What if i want to have separate invoice and packing
// list" -> "Use seprate flag."
//
// opts.separate falsy (DEFAULT, unchanged)  -> Buffer, both documents in one
//                                              PDF, exactly as before.
// opts.separate true                        -> { invoice: Buffer, packing: Buffer }
//
// The return type changes with the flag rather than always being an object,
// so every existing caller keeps working untouched. api.js opts in explicitly.
async function generateInvoiceClassicPdf(data, opts = {}) {
    const { html } = buildInvoiceClassicHtml(data);
    if (!opts.separate) {
        const { both } = await renderModes(html, ['both'], opts);
        return both;
    }
    const { invoice, packing } = await renderModes(html, ['invoice', 'packing'], opts);
    return { invoice, packing };
}

module.exports = { buildInvoiceClassicHtml, generateInvoiceClassicPdf, renderModes, extractInvoiceHeader };
