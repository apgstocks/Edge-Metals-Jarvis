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
const { round2 } = require('./money');

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
        // ── ROUNDED, LIKE ITS TWO SISTER FILES ───────────────────────
        // helpers/invoiceSheet.js and helpers/proformaPdf.js both wrap this
        // in round2; this one lost it in 7f16c64 "invoice change". 29,000 lb
        // at $0.41 is 11889.999999999998 in floating point, and this figure
        // goes on a document a customer pays against. Her own figure, when
        // she has typed one, still wins untouched.
        const amount = item.amount != null
            ? Number(item.amount)
            : round2(qty * rate);
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
    // ── THE PACKING TABLE'S COLUMNS, DECLARED ONCE ───────────────────────
    // Apsara, 2026-09-16: "sometimes i will have 3 different items in a
    // container..for eg:alternator,starter,ac compressor.each with separate
    // gross,net,tare overall total gross,net,tare and adding those
    // gross,net,tare --->overall for the container", and on whether the
    // customer's copy shows the breakdown: "Item column on the PDF too".
    //
    // The table is therefore FIVE columns or SIX, and the heading, the rows
    // and the TOTAL row must all agree about which. Three hand-written copies
    // of a changing count is how that row SHEARS: no error, the net figures
    // slide one column left and print under the wrong headings on the paper a
    // customer is checking with a calculator. tests/packing-list.js counts
    // cells for exactly this reason.
    //
    // So: one list, three renderers. The count cannot disagree with itself.
    //
    // ── OFF BY DEFAULT ───────────────────────────────────────────────────
    // showItem is false unless a packing list says otherwise, so an INVOICE
    // generated through the "Separate invoice & packing list" flag prints the
    // same five columns it has printed since 2026-09-09. Nothing on file
    // changes shape because a different screen grew a checkbox.
    // ── WHY AN INVOICE'S PACKING LIST SHOWS IT TOO ───────────────────────
    // Apsara, 2026-09-16: "why item description missing in packing list of
    // invoice tab in docs?"
    //
    // Because the column was built for the packing-list screen and switched on
    // by ITS checkbox, and the invoice path never sets that flag. Her invoice
    // line items have carried item_desc all along — "Aluminium combo",
    // "Regular combo" — and the packing list beside them printed a container
    // number and four weights with no word about what was in the box. On a
    // customs document that is the column that matters most.
    //
    // So the column also appears when the DATA has descriptions, which for an
    // invoice is always. This DOES change a document her customers already
    // receive, from five columns to six. Deliberate, and the smaller change of
    // the two available: the alternative is a packing list that names nothing.
    const lineItemsNameSomething = lineItems.some((it) =>
        String((it && (it.item || it.item_desc)) || '').trim());
    const showItem = data.packing_show_item === true || data.packing_show_item === 'true'
        || lineItemsNameSomething;
    const num = (v) => {
        const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim());
        return isFinite(n) ? n : null;
    };

    let totalNetLbs = 0, totalNetMt = 0, totalGrossLbs = null, totalTareLbs = null;
    const addUp = (acc, v) => (v == null ? acc : (acc == null ? v : acc + v));

    const PACKING_COLUMNS = [
        { head: 'Container', width: showItem ? '18%' : '22%',
          cell: (item) => escapeHtml(item.container_no || data.container_no),
          total: 'TOTAL' },
        // `item` is what the packing-list screen sends; `item_desc` is what an
        // invoice line item has always been called. One column, either source
        // — reading only one of them is how this went missing in the first
        // place.
        ...(showItem ? [{ head: 'Item', width: '16%',
          cell: (item) => escapeHtml(item.item || item.item_desc || ''), total: '' }] : []),
        { head: 'Gross Weight<br>(lbs)', width: showItem ? '17%' : '20%',
          cell: (item, p) => escapeHtml(p.gross_weight_lbs || '-'),
          total: () => (totalGrossLbs == null ? '' : formatInt(totalGrossLbs)) },
        { head: 'Tare<br>(lbs)', width: showItem ? '16%' : '20%',
          cell: (item, p) => { const t = require('./packingList').tareOf(p);
                               return escapeHtml(t == null ? '-' : t.toLocaleString('en-US')); },
          total: () => (totalTareLbs == null ? '' : formatInt(totalTareLbs)) },
        { head: 'Net Weight<br>(lbs)', width: showItem ? '17%' : '20%',
          cell: (item, p, netLbs) => escapeHtml(p.net_weight_lbs || formatInt(netLbs)),
          total: () => formatInt(totalNetLbs) },
        { head: 'Net Weight<br>(MT)', width: showItem ? '16%' : '18%',
          cell: (item, p, netLbs, netMt) => netMt.toFixed(3),
          total: () => totalNetMt.toFixed(3) },
    ];

    const packingHeadCellsHtml = PACKING_COLUMNS.map((c) =>
        `          <th style="width:${c.width};padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;border:1pt solid black;">${c.head}</th>`
    ).join('\n');

    // Packing List rows — one per line item, using whatever weights were
    // resolved server-side (real packing-sheet data where matched, else a
    // calculated fallback — see helpers/invoiceSheet.js).
    //
    // ── ONE TARE COLUMN ──────────────────────────────────────────────────
    // Apsara, 2026-09-16: "in packing list,i juxt want gross,tare ,net" — and,
    // on whether the printed document follows, "Yes".
    //
    // helpers/packingList.js's tareOf is the ONE place that decides what a
    // tare is: her own figure when she typed one, otherwise the four
    // components added up. Reused rather than re-implemented here, because two
    // answers to "what is the tare" would eventually differ, and they would
    // differ on a document a customer is holding.
    //
    // An INVOICE SAVED BEFORE TODAY still carries truck/container/chassis/
    // boxes broken out. It regenerates with the same total it always had, in
    // one column instead of four — nothing on file needs migrating.
    const packingRowsHtml = lineItems.map((item) => {
        const p = item.packing || {};
        const netMt = parseFloat(String(p.net_weight_mt || '').replace(/,/g, '')) || Number(item.weight) || 0;
        const netLbs = parseFloat(String(p.net_weight_lbs || '').replace(/,/g, '')) || Math.round(netMt * 2204.62);
        totalNetMt += netMt;
        totalNetLbs += netLbs;
        // The overall gross and tare for the container — her words, "overall
        // total gross,net,tare". Null rather than 0 when no row carried one:
        // a printed 0 claims a container that weighed nothing, and a blank is
        // an absence. Same rule tareOf follows.
        totalGrossLbs = addUp(totalGrossLbs, num(p.gross_weight_lbs));
        totalTareLbs = addUp(totalTareLbs, require('./packingList').tareOf(p));
        const cells = PACKING_COLUMNS.map((c) =>
            `          <td style="padding:1mm;font-size:9.5pt;text-align:center;vertical-align:middle;">${c.cell(item, p, netLbs, netMt)}</td>`
        ).join('\n');
        return `        <tr style="height:10mm;">\n${cells}\n        </tr>`;
    });

    // Built AFTER the rows, because the totals are accumulated while they
    // render. Hence the thunks in `total` above — reading the variables at
    // declaration time would print zeroes.
    const packingTotalCellsHtml = PACKING_COLUMNS.map((c, i) => {
        const v = typeof c.total === 'function' ? c.total() : c.total;
        const style = v
            ? 'padding:2mm 1mm;font-weight:700;font-size:10pt;text-align:center;vertical-align:middle;border:1pt solid black;'
            : 'padding:2mm 1mm;border:1pt solid black;';
        return `          <td style="${style}">${v}</td>`;
    }).join('\n');

    // One line naming what is in the container when it is all one thing.
    // Apsara, 2026-09-16, on where the header description goes: "Printed above
    // the packing table". Empty when she has not named one — a stray "Item:"
    // with nothing after it looks like a field that failed to fill.
    const itemDesc = String(data.packing_item_description || '').trim();
    const packingItemLineHtml = itemDesc
        ? `    <div class="seam" style="padding:1.5mm 2mm;font-size:10pt;font-weight:700;border-left:0.8pt solid var(--black);border-right:0.8pt solid var(--black);">Item: ${escapeHtml(itemDesc)}</div>`
        : '';

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
        // Also after a COMMA (2026-09-10): the mixed-material number separates
        // whole numbers with one — "260901_AL_26JY96,260901_RC_26JY97" — and
        // a comma is no more a break opportunity in CSS than an underscore is.
        // Without this the preferred break is mid-number at an underscore
        // instead of at the boundary between the two numbers.
        inv_no: escapeHtml(data.inv_no || '').replace(/([_,])/g, '$1<wbr>'),
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
        // ── ONE SIGNATURE FILE, TWO PRESENTATIONS ────────────────────────
        // 7f16c64 replaced the shared {{signature_block}} with the image
        // pasted inline as base64. Understandable: the shared block is
        // left-aligned at 34px and her new layout needs it centred at 8mm in
        // a table cell, so the block did not fit and the image did.
        //
        // Her MARKUP is kept exactly — the wrapper, the sizing, the centring
        // are hers. Only the src comes from helpers/signature.js now, so the
        // invoice and the proforma cannot end up showing different
        // signatures the day the file is replaced. That drift is the whole
        // reason ab3cf26 unified them in the first place.
        signature_src: require('./signature').signatureDataUrl() || '',
        signature_block: require('./signature').signatureBlockHtml(),
        packing_rows: packingRowsHtml.join('\n'),
        packing_head_cells: packingHeadCellsHtml,
        packing_total_cells: packingTotalCellsHtml,
        packing_item_line: packingItemLineHtml,
        // Kept as substitutions even though the TOTAL row now builds its own
        // cells: an older saved template or another caller may still reference
        // them, and leaving a live {{placeholder}} on a customer's document is
        // the worst possible failure mode for a rename.
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
            // ── ONE PAGE, PER MODE ───────────────────────────────────
            // Restored 2026-09-10. e20d8a1 "separate inv and packing list"
            // rewrote this into a loop over modes and the fitter did not come
            // with it — the invoice went back to spilling a near-empty second
            // page, which is what pdfFittedToOnePage was written for on
            // 2026-08-29. Read as an accidental drop rather than a decision:
            // that commit is about SEPARATING two documents, and the proforma
            // path a few files away still fits to one page.
            //
            // Inside the loop deliberately. Each mode is a different amount of
            // content — the invoice alone, the packing list alone, or both —
            // so each needs measuring on its own. Fitting once outside would
            // scale all three by whatever the longest one needed.
            const { pdfFittedToOnePage } = require('./pdfFit');
            const pdf = await pdfFittedToOnePage(page, {
                width: '816px',
                printBackground: true,
                preferCSSPageSize: true,
                // Its @page is 210mm x 297mm — real A4 — and the fitter
                // measures against that, not against the 816px width above.
                // Saying only the width let it default to 297 by luck rather
                // than by statement.
            }, { pageHeightMm: 297, pageWidthMm: 210, label: `invoice ${mode}` });
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
// ── invoice only ──────────────────────────────────────────────────────────
// Apsara, 2026-09-16: "add a checkbox called invoice only in invoice of
// documents".
//
// opts.invoiceOnly true -> Buffer, the invoice ALONE. No packing list, not in
//                          the same PDF and not as a second file.
//
// The machinery was already there: the template has hidden the packing half
// under body.only-invoice since 2026-09-09, and separate mode has been
// rendering exactly this document as its first output ever since. What was
// missing was a way to ask for it and keep only that half.
//
// It BEATS separate, and deliberately so: "invoice only" and "and also give me
// the packing list" are a contradiction, and the safe reading of a
// contradiction on a document going to a customer is the narrower one — she
// gets fewer papers than she expected, not a packing list she asked not to
// send. The screen keeps the two boxes from being ticked together; this is
// what happens if anything else ever posts both.
//
// `opts.render` is injectable for the same reason helpers/packingList.js's
// generatePdf takes a renderer: Chromium cannot launch in the test sandbox, and
// WHICH MODES are asked for is the whole of this decision. A test that cannot
// see the mode list can only re-read the source.
async function generateInvoiceClassicPdf(data, opts = {}) {
    const { html } = buildInvoiceClassicHtml(data);
    const render = opts.render || renderModes;
    if (opts.invoiceOnly) {
        const { invoice } = await render(html, ['invoice'], opts);
        return invoice;
    }
    if (!opts.separate) {
        const { both } = await render(html, ['both'], opts);
        return both;
    }
    const { invoice, packing } = await render(html, ['invoice', 'packing'], opts);
    return { invoice, packing };
}

module.exports = { buildInvoiceClassicHtml, generateInvoiceClassicPdf, renderModes, extractInvoiceHeader };
