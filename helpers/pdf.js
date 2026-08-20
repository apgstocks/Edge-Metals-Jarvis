const PDFDocument = require('pdfkit');

// ── Shared visual language for both load PDFs ─────────────────────────────
// Redesigned per Apsara ("visual redesign" + "restructure layout") — was
// plain stacked Helvetica text with no branding or table borders. Now: a
// letterhead, shaded field boxes, a properly bordered/zebra-striped item
// table, and a boxed summary — built by hand with rect/line primitives since
// the installed pdfkit (0.15.2) predates its built-in .table() API.
const NAVY       = '#1a3a5c';
const NAVY_LIGHT = '#eaf0f5';
const RULE       = '#d7dce1';
const ZEBRA      = '#f6f8fa';
const MUTED      = '#6b7280';
const INK        = '#1a1a1a';
const PAGE_L = 50, PAGE_R = 562, PAGE_TOP = 50, PAGE_BOTTOM = 700; // leaves room above the footer rule at y=722

// Guards a block of a KNOWN height against straddling a page boundary — for
// anything drawn as one rect() + several explicit-position text() calls
// (field boxes, summary boxes), where a page break landing mid-block used to
// draw a rect that just visually clips off the bottom of the page while the
// text() calls inside independently trigger pdfkit's own auto-pagination
// one at a time (each thinking IT'S the one that needs a new page), scattering
// a single box across 2-3 broken pages instead of moving the whole thing
// to a clean new page as one unit. drawItemTable and the weights-PDF item
// cards already had page-break handling; this is the same idea for the
// other two block-shaped drawers.
function ensureSpace(doc, height) {
    if (doc.y + height > PAGE_BOTTOM) doc.addPage();
}

// Money formatting, per Apsara 2026-08-19 ("if its 0.60 it should be 0.60
// only not 0.6" and "if its 23,768.789 it should be rounded off like
// 23,768.79").
//
// Two DIFFERENT rules, because these are two different kinds of number:
//
//   rate(n)   — a per-unit price (e.g. $0.175/lb). Padded to a MINIMUM of
//               2 decimals but never rounded: 0.6 -> "0.60", but 0.175
//               stays "0.175". Rounding a rate to 2dp would change what
//               the seller is actually paid per pound.
//
//   amount(n) — a money TOTAL (e.g. $23,768.789). Rounded to EXACTLY 2
//               decimals and grouped with thousands separators, because
//               that's what a currency figure on an invoice is:
//               23768.789 -> "23,768.79".
//
// Conflating the two was the earlier mistake — a single formatter can't
// both preserve 0.175 and round 23,768.789.
function fmtRate(n) {
    if (n == null || n === '' || !isFinite(Number(n))) return null;
    const s = String(n);
    const decimals = s.includes('.') ? s.split('.')[1].length : 0;
    return decimals >= 2 ? s : Number(n).toFixed(2);
}
function fmtAmount(n) {
    if (n == null || n === '' || !isFinite(Number(n))) return null;
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Kept so any caller still saying money() keeps working; rates are the
// stricter of the two, so this is the safe alias.
const money = fmtRate;

// The issuing party is not a variable on these documents — every load runs
// through Edge Trading, so it's part of the letterhead rather than a field
// that could be left blank or typo'd per load. Per Apsara 2026-08-12: this
// business's name/address engraved at the top of every document.
//
// Renamed SELLER -> EDGE_TRADING 2026-08-15: per Apsara, Edge Trading is
// actually the BUYER in these transactions (the counterparty supplies
// material TO Edge Trading, not the other way round) — the old name was
// backwards and only ever caused confusion in this file's own comments. This
// constant was never exported, so the rename is contained entirely to this
// file; nothing outside pdf.js references it.
const EDGE_TRADING = {
    name: 'EDGE TRADING',
    address1: '2453 E 25th Street',
    address2: 'Los Angeles, CA 90058',
    phone: '(310) 938-2525',
    email: 'bose@edgemetals.com',
};

function drawLetterhead(doc, subtitle, load) {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text(EDGE_TRADING.name, PAGE_L, 44);

    // Address block sits directly under the name, tight leading so the four
    // lines read as one unit rather than a list.
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    doc.text(EDGE_TRADING.address1, PAGE_L, 70, { lineBreak: false });
    doc.text(EDGE_TRADING.address2, PAGE_L, 81, { lineBreak: false });
    doc.text(EDGE_TRADING.phone, PAGE_L, 92, { lineBreak: false });
    doc.text(EDGE_TRADING.email, PAGE_L, 103, { lineBreak: false });

    // Document type + load id stay right-aligned, opposite the address, so
    // neither block has to compete for the same horizontal space.
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(load.id, PAGE_L, 44, { width: PAGE_R - PAGE_L, align: 'right' });
    // Date+time, not just date, per Apsara 2026-08-15 — reuses
    // formatCreatedAt (defined below) so "Generated" on the letterhead and
    // "Created:" in the field box render in the exact same style.
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(subtitle.toUpperCase(), PAGE_L, 62, { width: PAGE_R - PAGE_L, align: 'right', characterSpacing: 1.2 })
        .text(`Generated ${formatCreatedAt(new Date().toISOString())}`, PAGE_L, 76, { width: PAGE_R - PAGE_L, align: 'right' });

    // Rule moved down from 92 to clear the taller address block — the old
    // value would have struck straight through the phone/email lines.
    doc.moveTo(PAGE_L, 122).lineTo(PAGE_R, 122).lineWidth(1.5).strokeColor(NAVY).stroke();
    doc.lineWidth(1);
    doc.y = 136;
}

// twoColFields render as "Label value" pairs, 2 per row, inside a shaded box.
// fullFields (optional — a single {label,value} OR an array of them) each
// get their own full-width row below the 2-col grid, stacked top to bottom —
// used for Description/Seller Address/Buyer Address, which can run long
// enough that squeezing them into a half column would wrap awkwardly. Each
// one's height is MEASURED with doc.heightOfString() (same font/size/width
// used to actually draw it) rather than assumed to be one line — a long
// value that wraps to 2-3 lines used to overflow past the box border and
// collide with whatever heading was drawn right after it, since the old
// fixed-height guess only ever reserved room for one line.
function drawFieldBox(doc, twoColFields, fullFields) {
    const rowH = 18;
    const rows2 = Math.ceil(twoColFields.length / 2);
    const fields = Array.isArray(fullFields) ? fullFields : (fullFields ? [fullFields] : []);

    doc.font('Helvetica').fontSize(9.5);
    let fullBlockH = 0;
    const measured = fields.map(f => {
        const valH = doc.heightOfString(f.value || '—', { width: 484 });
        const h = 14 + valH + 4;
        fullBlockH += h;
        return { ...f, h };
    });

    // Gap before the full-width block tightened 16->8 per Apsara 2026-08-15
    // ("reduce spacing between seller and seller address" — Seller sits in
    // the last two-col row, Seller Address is the first full-width row right
    // after it). Bottom margin below the box's last field kept at the same
    // 4pt it was before (20 - 16 = 4, now 12 - 8 = 4) so only the gap that
    // was actually flagged shrinks, not the box's own bottom padding.
    const boxH = rows2 * rowH + fullBlockH + 12;
    // Height is fully known BEFORE anything is drawn (measured above), so
    // the page-break check runs first and doc.y is only read AFTER that —
    // boxTop is then guaranteed to be the top of wherever this box actually
    // ends up (same page or a fresh one), never split across the two.
    ensureSpace(doc, boxH);
    const boxTop = doc.y;

    doc.rect(PAGE_L, boxTop, PAGE_R - PAGE_L, boxH).fillAndStroke(NAVY_LIGHT, RULE);

    twoColFields.forEach((f, i) => {
        const col = i % 2;
        const x = col === 0 ? PAGE_L + 14 : PAGE_L + 262;
        const y = boxTop + 12 + Math.floor(i / 2) * rowH;
        doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text(f.label, x, y, { continued: true });
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(' ' + (f.value || '—'));
    });

    let fy = boxTop + 8 + rows2 * rowH;
    measured.forEach(f => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text(f.label, PAGE_L + 14, fy, { characterSpacing: 0.3 });
        doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(f.value || '—', PAGE_L + 14, fy + 12, { width: 484 });
        fy += f.h;
    });
    doc.y = boxTop + boxH + 18;
}

// Sums gross/tare/net/amount per ITEM DESCRIPTION (e.g. "Sealed units",
// "Auto cast") — per Apsara, the item table lists every individual weigh-in
// but nothing rolled them up by type, so a load with a dozen "Auto cast"
// pulls had no single "here's the Auto cast total" line anywhere. Order
// preserved as first-seen (Map insertion order), not alphabetized — matches
// the order items were entered in, which is usually already grouped since
// yard staff tend to weigh the same item type back-to-back.
function round2(n) {
    return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : n;
}
// Groups on a NORMALIZED key (trimmed + lowercased), not the raw description
// text — per Apsara 2026-08-16 ("Battery" showing as two separate lines,
// 4075 lb and 557 lb, instead of one combined 4632 lb line in the yard
// report). Root cause: one of the two was typed with a trailing space or
// different casing (e.g. "Battery " or "battery"), and the old exact-string
// key treated that as a wholly different item type. The DISPLAYED label
// still uses whichever original spelling/casing was typed FIRST (via
// `raw`, kept alongside the normalized key) — this only affects grouping,
// never rewrites the text stored on the load itself.
function groupItemsByDescription(items) {
    const groups = new Map();
    for (const it of items) {
        const raw = it.description ? String(it.description).trim() : 'Other';
        const key = raw.toLowerCase();
        if (!groups.has(key)) groups.set(key, { description: raw, count: 0, gross: 0, tare: 0, net: 0, amount: 0 });
        const g = groups.get(key);
        g.count += 1;
        g.gross  += it.gross_weight  || 0;
        g.tare   += it.tare_weight   || 0;
        g.net    += it.net_weight    || 0;
        g.amount += it.amount        || 0;
    }
    return Array.from(groups.values()).map(g => ({
        description: g.description, count: g.count,
        gross: round2(g.gross), tare: round2(g.tare), net: round2(g.net), amount: round2(g.amount),
    }));
}

// Bordered, zebra-striped item table — `columns` lets the two PDFs show
// different fields (the priced ticket shows price/unit/amount, the
// weights-only PDF doesn't) while sharing the exact same drawing code.
// `totalsRow` (optional) renders as one extra bold row at the very bottom —
// per Apsara, the item table itself had no running total, only the separate
// Summary box further down the page; this puts a TOTAL line directly under
// the last item so it reads top-to-bottom without jumping around the page.
function drawItemTable(doc, items, columns, totalsRow) {
    // $ prefix on price/amount only — per Apsara 2026-08-17 ("in pdf-price
    // and amount need to have $ symbol at the front"). Scoped to these two
    // column keys specifically so weight columns (gross/tare/net/count)
    // don't pick up a stray $ — those are shared across TICKET_COLUMNS,
    // GROUP_COLUMNS, and SELLER_COLUMNS, all of which use these same key
    // names for their price/amount fields, so this one change covers the
    // priced ticket's item table, the item-type summary table, AND the
    // by-seller table in the daily inventory PDF, with nothing to touch in
    // GROUP_COLUMNS_WEIGHTS (the weights-only PDF has no price/amount
    // columns at all, so it's unaffected).
    const fmt = (n, key) => {
        if (n == null) return '—';
        return key === 'price' ? `$${fmtRate(n)}` : (key === 'amount' ? `$${fmtAmount(n)}` : String(n));
    };
    const tableW = PAGE_R - PAGE_L;
    const headerH = 24, rowH = 22;

    const drawHeaderRow = (top) => {
        doc.rect(PAGE_L, top, tableW, headerH).fill(NAVY);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff');
        columns.forEach(c => {
            doc.text(c.label.toUpperCase(), c.x + 6, top + 9, { width: c.width - 12, align: c.align, characterSpacing: 0.3 });
        });
    };

    // it=null marks the totals row — bold text, shaded background (instead
    // of alternating zebra), and drawn from `totalsRow` instead of an item.
    const drawDataRow = (it, y, opts) => {
        const isTotal = !it;
        const rowData = isTotal ? totalsRow : it;
        if (isTotal) doc.rect(PAGE_L, y, tableW, rowH).fill(NAVY_LIGHT);
        else if (opts.zebra) doc.rect(PAGE_L, y, tableW, rowH).fill(ZEBRA);
        doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(isTotal ? NAVY : INK);
        columns.forEach(c => {
            const raw = c.key === 'description' ? (rowData.description || (isTotal ? '' : '—')) : fmt(rowData[c.key], c.key);
            // ellipsis:true does nothing on its own in this pdfkit version
            // (0.15.2) — confirmed by testing directly against the installed
            // package, NOT assumed from docs. It only truncates when a HEIGHT
            // is also given (one line's worth here); without it, a long
            // description just word-wrapped onto extra lines and visually
            // overlapped the row below it, since row height was fixed.
            doc.text(raw, c.x + 6, y + 6, { width: c.width - 12, height: 10, align: c.align, ellipsis: true });
        });
        doc.moveTo(PAGE_L, y + rowH).lineTo(PAGE_R, y + rowH).lineWidth(isTotal ? 1 : 0.5).strokeColor(isTotal ? NAVY : RULE).stroke();
    };

    // Tracked PER PAGE SEGMENT, not just once at the top — a table long
    // enough to span pages used to draw its outer border as ONE rect from
    // the page-1 header down to wherever the last row landed on page 2,
    // mixing y-coordinates from two different pages (each page has its own
    // y origin) into one nonsense box. Each page's slice of the table now
    // gets its own border AND its own repeated navy header row, closed off
    // right before addPage() rather than only once at the very end.
    let segTop = doc.y;
    drawHeaderRow(segTop);
    let y = segTop + headerH;

    items.forEach((it, i) => {
        if (y + rowH > PAGE_BOTTOM) {
            doc.lineWidth(1).rect(PAGE_L, segTop, tableW, y - segTop).strokeColor(RULE).stroke();
            doc.addPage();
            segTop = PAGE_TOP;
            drawHeaderRow(segTop);
            y = segTop + headerH;
        }
        drawDataRow(it, y, { zebra: i % 2 === 1 });
        y += rowH;
    });

    if (totalsRow) {
        // Keep the TOTAL row on the same page as the header it belongs
        // under if at all possible — pushing just that one row alone is
        // more disruptive to read than moving the whole last page's worth.
        if (y + rowH > PAGE_BOTTOM) {
            doc.lineWidth(1).rect(PAGE_L, segTop, tableW, y - segTop).strokeColor(RULE).stroke();
            doc.addPage();
            segTop = PAGE_TOP;
            drawHeaderRow(segTop);
            y = segTop + headerH;
        }
        drawDataRow(null, y, {});
        y += rowH;
    }

    doc.lineWidth(1).rect(PAGE_L, segTop, tableW, y - segTop).strokeColor(RULE).stroke();
    doc.y = y + 18;
}

// Right-aligned shaded box of totals — `emphasize` rows (net/amount) render
// larger and in navy so the number that matters most doesn't get lost among
// the rest.
function drawSummaryBox(doc, rows) {
    const boxW = 230;
    const boxX = PAGE_R - boxW;
    const rowH = 19;
    const boxH = rows.length * rowH + 20;
    ensureSpace(doc, boxH);
    const boxTop = doc.y;

    doc.rect(boxX, boxTop, boxW, boxH).fillAndStroke(NAVY_LIGHT, RULE);
    rows.forEach((r, i) => {
        const y = boxTop + 12 + i * rowH;
        const size = r.emphasize ? 11 : 9.5;
        const color = r.emphasize ? NAVY : INK;
        doc.font(r.emphasize ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(r.label, boxX + 14, y, { width: 110 });
        doc.font(r.emphasize ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(r.value, boxX + 14, y, { width: boxW - 28, align: 'right' });
    });
    doc.y = boxTop + boxH + 18;
}

// ── Seller signature block ───────────────────────────────────────────────
// Per Apsara 2026-08-17 ("post pdf generation, there should be an option
// called sign... it should open a whiteboard where it allows the user to
// sign. this should get reflected in yard invoice above Seller signature").
// So: a ruled signature line labelled "Seller signature", with the captured
// signature drawn IN THE SPACE ABOVE that line — i.e. exactly where a
// person would sign on paper.
// load.seller_signature is a data URL (image/png, transparent background)
// produced by the mobile app's signature pad. When it's absent the block
// still prints, just empty — the ticket then works as a paper form someone
// can sign by hand, which is strictly better than the block vanishing and
// the document silently changing shape depending on signed/unsigned.
function drawSignatureBlock(doc, load) {
    const SIG_AREA_H = 46;   // drawing space above the rule
    const BLOCK_H = SIG_AREA_H + 26;
    ensureSpace(doc, BLOCK_H + 10);
    const top = doc.y + 10;
    const lineY = top + SIG_AREA_H;
    const lineW = 230;

    if (load.seller_signature) {
        try {
            // Data URL -> Buffer. pdfkit accepts a Buffer directly; passing
            // the data URL string would be treated as a file path and throw.
            const b64 = String(load.seller_signature).replace(/^data:image\/\w+;base64,/, '');
            const buf = Buffer.from(b64, 'base64');
            // fit (not scale) keeps the aspect ratio inside the box and
            // never overflows the rule below it, whatever the pad's
            // canvas dimensions were.
            doc.image(buf, PAGE_L, top, { fit: [lineW, SIG_AREA_H - 4], align: 'left', valign: 'bottom' });
        } catch (err) {
            // A corrupt/oversized signature must never take down the whole
            // ticket — the line still prints, just unsigned.
            console.error('[pdf] could not render seller signature:', err.message);
        }
    }

    doc.moveTo(PAGE_L, lineY).lineTo(PAGE_L + lineW, lineY).lineWidth(0.75).strokeColor(INK).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text('Seller signature', PAGE_L, lineY + 5, { width: lineW, lineBreak: false });
    if (load.seller_signed_at) {
        const when = new Date(load.seller_signed_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
            .text(`Signed ${when} (LA time)`, PAGE_L, lineY + 16, { width: 260, lineBreak: false });
    }
    doc.y = lineY + 30;
}

function drawSectionHeading(doc, text) {
    // Small fixed guard (heading + a little breathing room) so a heading
    // never ends up as the last line on a page with its actual content
    // pushed to the next one.
    ensureSpace(doc, 30);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(text, PAGE_L, doc.y);
    doc.moveDown(0.4);
}

// Stamps every buffered page with a footer rule + "Load <id>" / "Page N of M"
// — requires the doc to have been created with { bufferPages: true }.
// IMPORTANT: the default 50pt margin means the page's writable area ends at
// y=742 (792 page height - 50 bottom margin) — a .text() call placed AT OR
// PAST that y triggers pdfkit's automatic "this needs a new page" logic,
// even though we're placing it with an explicit x/y (that check isn't
// skipped just because the position is explicit). That's exactly what
// happened at y=754 here: every footer stamp silently spawned a new,
// near-blank page (2 extra pages per document). Kept comfortably above 742.
function addFooters(doc, load) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.moveTo(PAGE_L, 722).lineTo(PAGE_R, 722).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
            .text(`${EDGE_TRADING.name.replace(/\b(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase())} — Load ${load.id}`, PAGE_L, 729, { width: 250, lineBreak: false })
            .text(`Page ${i - range.start + 1} of ${range.count}`, PAGE_L, 729, { width: PAGE_R - PAGE_L, align: 'right', lineBreak: false });
    }
}

// load.created_at is an ISO timestamp stamped once, server-side, the moment
// the load record was first saved (helpers/loads.js's addLoad) — distinct
// from load.date, which staff enter by hand on the form and can backdate.
// Per Apsara 2026-08-15: show the real creation time on the document as an
// audit fact, separate from the (possibly backdated) Date field.
function formatCreatedAt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    // Explicit timeZone per Apsara 2026-08-15 ("i want this time in...los
    // angeles local time") — without it, toLocaleString renders in whatever
    // timezone the SERVER PROCESS happens to be running in (confirmed this
    // sandbox is Asia/Calcutta; the production VM is whatever it's set to,
    // almost certainly not Pacific), not the business's own timezone. Edge
    // Trading's letterhead address is Los Angeles, so both this field
    // ("Created:") and drawLetterhead's "Generated" line (which calls this
    // same function) need to read correctly for someone in LA regardless of
    // what timezone the server itself happens to be in.
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZone: 'America/Los_Angeles', timeZoneName: 'short',
    });
}

// Unit column removed per Apsara (the per-item Unit field is gone from the
// dashboard entirely — see renderItemRows in dashboard/index.html). Its 40pt
// went to Gross/Tare/Net/Amount rather than Price, matching the same
// "shrink description, grow the weight/amount columns" request applied to
// the on-screen item rows.
const TICKET_COLUMNS = [
    { key: 'description',  label: 'Description', x: 50,  width: 140, align: 'left'  },
    { key: 'gross_weight', label: 'Gross',        x: 190, width: 68,  align: 'right' },
    { key: 'tare_weight',  label: 'Tare',         x: 258, width: 68,  align: 'right' },
    { key: 'net_weight',   label: 'Net',          x: 326, width: 68,  align: 'right' },
    { key: 'price',        label: 'Price',        x: 394, width: 58,  align: 'right' },
    { key: 'amount',       label: 'Amount',       x: 452, width: 110, align: 'right' },
];

// "Summary by Item Type" table columns — priced version (ticket) includes
// Amount, the weights-only PDF's version below doesn't.
const GROUP_COLUMNS = [
    { key: 'description', label: 'Item Type', x: 50,  width: 180, align: 'left'  },
    { key: 'count',       label: 'Items',     x: 230, width: 50,  align: 'right' },
    { key: 'gross',       label: 'Gross',     x: 280, width: 70,  align: 'right' },
    { key: 'tare',        label: 'Tare',      x: 350, width: 70,  align: 'right' },
    { key: 'net',         label: 'Net',       x: 420, width: 70,  align: 'right' },
    { key: 'amount',      label: 'Amount',    x: 490, width: 72,  align: 'right' },
];
// Same shape as GROUP_COLUMNS, relabeled for the daily inventory report's
// "By seller" table (generateInventoryReportPdf below) — same drawItemTable
// renderer, just a different first-column header.
const SELLER_COLUMNS = [
    { key: 'description', label: 'Seller',   x: 50,  width: 180, align: 'left'  },
    { key: 'count',       label: 'Loads',    x: 230, width: 50,  align: 'right' },
    { key: 'gross',       label: 'Gross',    x: 280, width: 70,  align: 'right' },
    { key: 'tare',        label: 'Tare',     x: 350, width: 70,  align: 'right' },
    { key: 'net',         label: 'Net',      x: 420, width: 70,  align: 'right' },
    { key: 'amount',      label: 'Amount',   x: 490, width: 72,  align: 'right' },
];
const GROUP_COLUMNS_WEIGHTS = [
    { key: 'description', label: 'Item Type', x: 50,  width: 220, align: 'left'  },
    { key: 'count',       label: 'Items',     x: 270, width: 60,  align: 'right' },
    { key: 'gross',       label: 'Gross',     x: 330, width: 78,  align: 'right' },
    { key: 'tare',        label: 'Tare',      x: 408, width: 78,  align: 'right' },
    { key: 'net',         label: 'Net',       x: 486, width: 76,  align: 'right' },
];

function generateLoadPdf(load, opts = {}) {
    // Per Apsara 2026-08-15: instead of the document silently deciding
    // whether to print the Summary section, the dashboard now asks before
    // generating. Default stays TRUE (old behavior) for any caller that
    // doesn't pass opts at all — e.g. scheduler.js's end-of-day yard report,
    // which runs unattended with nobody to ask.
    const includeSummary = opts.includeSummary !== false;
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Reduced to exactly what Apsara asked for: date, created time,
            // seller, seller address, description. Edge Trading's own info
            // lives in the letterhead; Created by / Status dropped — both are
            // internal workflow state, not part of the document the
            // counterparty receives.
            //
            // load.seller/load.seller_address hold the counterparty (the
            // company Edge Trading is buying scrap FROM) — per Apsara
            // 2026-08-15 ("no. buyer should be edge trading"), correcting an
            // earlier backwards mapping where this data lived under
            // load.buyer and just got RELABELED "Seller:" on the printed
            // page. Field names and printed labels now agree, so no
            // relabeling trick is needed here anymore. Order matters:
            // drawFieldBox lays two-col fields out left-to-right, top-to-
            // bottom (index 0/1 = row 1, index 2 = row 2 col 1) — so [Date,
            // Created, Seller] puts Created directly beside Date on row 1,
            // and Seller directly beneath Date on row 2, per Apsara
            // 2026-08-15's earlier layout request.
            drawLetterhead(doc, 'Load Ticket', load);
            drawFieldBox(doc, [
                { label: 'Date:',    value: load.date },
                { label: 'Created:', value: formatCreatedAt(load.created_at) },
                { label: 'Seller:',  value: load.seller },
            ], [
                { label: 'Seller Address:', value: load.seller_address },
                { label: 'Description:',    value: load.description },
            ]);

            const unit = load.weight_unit || 'lb';
            const items = Array.isArray(load.items) ? load.items : [];
            if (items.length) {
                drawSectionHeading(doc, 'Item Detail');
                // TOTAL row uses the load-level sums already computed
                // server-side (helpers/loads.js's sumItems) rather than
                // re-adding the items here, so it's always consistent with
                // whatever the Summary box further down shows.
                drawItemTable(doc, items, TICKET_COLUMNS, {
                    description: 'TOTAL',
                    gross_weight: load.gross_weight, tare_weight: load.tare_weight,
                    net_weight: load.net_weight, amount: load.amount,
                });
            }

            // Rolled up by item TYPE (e.g. every "Sealed units" weigh-in
            // combined into one line) — sits between the raw item table and
            // the grand totals so a load with many pulls of the same item
            // doesn't require manually adding up scattered rows to see "how
            // much Auto cast did we actually move today."
            // Only worth printing when grouping actually COLLAPSES something.
            // Per Apsara 2026-08-12: with a single item, or with every item a
            // different type, this table is a line-for-line restatement of
            // Item Detail directly above it — pure noise on the page. It
            // earns its place only when at least one item type appears more
            // than once, which is exactly when groups.length < items.length.
            // Whole Summary section (grouped table + totals box) is now
            // opt-in per document, per Apsara 2026-08-15 — previously this
            // decided automatically off item count; now the dashboard asks
            // before generating and includeSummary carries that answer here.
            if (includeSummary) {
                const groups = items.length ? groupItemsByDescription(items) : [];
                if (groups.length && groups.length < items.length) {
                    drawSectionHeading(doc, 'Summary by Item Type');
                    drawItemTable(doc, groups, GROUP_COLUMNS);
                }

                drawSectionHeading(doc, 'Summary');
                drawSummaryBox(doc, [
                    { label: 'Gross total',  value: load.gross_weight != null ? `${load.gross_weight} ${unit}` : '—' },
                    { label: 'Tare total',   value: load.tare_weight  != null ? `${load.tare_weight} ${unit}`  : '—' },
                    { label: 'Net total',    value: load.net_weight   != null ? `${load.net_weight} ${unit}`   : '—', emphasize: true },
                    { label: 'Amount total', value: load.amount       != null ? `$${fmtAmount(load.amount)}`        : '—', emphasize: true },
                ]);
            }

            // The "Captured Scale Photos" list that used to be appended here
            // was removed 2026-08-12 per Apsara: weight evidence belongs on
            // the separate weights PDF only, so the ticket ends on the
            // Summary rather than trailing a page of photo links. The weights
            // PDF still carries each item's gross/tare photo links inline on
            // its per-item cards, so nothing is lost — it just isn't
            // duplicated on the document the buyer receives.

            // Scale photo links — per Apsara 2026-08-19 ("i want weight
            // photo link in generated invoice pdf").
            //
            // This partially reverses the 2026-08-12 decision to keep weight
            // evidence on the separate weights PDF only. The difference is
            // what's being added: that removal was of a full page of photo
            // links appended to the ticket, whereas this is a compact list
            // of clickable links, so the ticket still ends on the Summary
            // and signature rather than trailing off into evidence.
            // The weights PDF is unchanged and still carries the same links
            // inline on its per-item cards — this doesn't replace it, it
            // just means the invoice alone is enough to reach the photos.
            //
            // Skipped entirely when no photos were captured, so a load
            // weighed without photos doesn't get an empty heading.
            const photoItems = items
                .map((it, i) => ({ it, i }))
                .filter(({ it }) => it.gross_photo_link || it.tare_photo_link);
            // Diagnostic, added 2026-08-20: Apsara reported photos present in
            // Drive and on the weights PDF but absent from the invoice, on
            // confirmed-latest code. This section is unconditional, so the
            // only way it can be skipped is an empty photoItems — i.e. the
            // LOAD RECORD carries no *_photo_link, whatever exists in Drive.
            // Printing the per-item link state turns that from a guess into
            // a fact visible in pm2 logs on the very next PDF generated.
            console.log(`[pdf] ${load.id} scale-photo links: ${items.length ? items.map((it, i) => `${i + 1}:${it.gross_photo_link ? 'G' : '-'}${it.tare_photo_link ? 'T' : '-'}`).join(' ') : '(no items)'} -> ${photoItems.length} item(s) with photos`);
            if (photoItems.length) {
                drawSectionHeading(doc, 'Scale Photos');
                doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
                    .text('Tap a link to open the scale photo backing each weight.', PAGE_L, doc.y);
                doc.moveDown(0.5);
                for (const { it, i } of photoItems) {
                    // Guard each row against straddling a page break — the
                    // label and its links must not end up on separate pages.
                    ensureSpace(doc, 28);
                    const y = doc.y;
                    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
                        .text(`${i + 1}. ${it.description || 'Item ' + (i + 1)}`, PAGE_L, y, { width: 200, lineBreak: false });
                    // Links are placed at explicit x positions on the same
                    // line rather than flowed, so a long description can't
                    // push them onto the next line and split the row.
                    let lx = PAGE_L + 210;
                    if (it.gross_photo_link) {
                        doc.font('Helvetica').fontSize(9).fillColor('#1a5fb4')
                            .text('Gross photo', lx, y, { link: it.gross_photo_link, underline: true, width: 90, lineBreak: false });
                        lx += 100;
                    }
                    if (it.tare_photo_link) {
                        doc.font('Helvetica').fontSize(9).fillColor('#1a5fb4')
                            .text('Tare photo', lx, y, { link: it.tare_photo_link, underline: true, width: 90, lineBreak: false });
                    }
                    doc.y = y + 15;
                }
                doc.moveDown(0.6);
            }

            // Signature block last, per Apsara 2026-08-17 — a signature
            // belongs at the end of the document, under the numbers it's
            // attesting to.
            drawSignatureBlock(doc, load);

            addFooters(doc, load);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ── Separate, smaller PDF: just gross/tare weights + their photo links ───────
// Generated alongside the main priced ticket (same /generate-pdf action in
// api.js) but uploaded as its own file, weights_<load id>.pdf, per Apsara —
// some downstream use (handing proof-of-weight to the scale operator, a
// quick audit) doesn't need the priced item table, just the weights and the
// photos backing them up. Shares the same letterhead/field-box/summary-box
// styling as the main ticket for a consistent look across both documents.
function generateWeightsPdf(load, opts = {}) {
    const includeSummary = opts.includeSummary !== false;
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Same field reduction as the main ticket — Edge Trading's own
            // info lives in the letterhead now, so repeating it here would be
            // redundant. Labels/Created field match generateLoadPdf — see
            // its comments for where load.seller/Created: come from.
            // Same [Date, Created, Seller] ordering as generateLoadPdf — see
            // its comment for why that puts Created beside Date and Seller
            // beneath Date.
            drawLetterhead(doc, 'Weight Record', load);
            drawFieldBox(doc, [
                { label: 'Date:',    value: load.date },
                { label: 'Created:', value: formatCreatedAt(load.created_at) },
                { label: 'Seller:',  value: load.seller },
            ], [
                { label: 'Seller Address:', value: load.seller_address },
                { label: 'Description:',    value: load.description },
            ]);

            const unit = load.weight_unit || 'lb';
            const items = Array.isArray(load.items) ? load.items : [];
            drawSectionHeading(doc, 'Item Weights');

            if (!items.length) {
                doc.font('Helvetica').fontSize(10).fillColor(INK).text('No items on this load.');
                doc.moveDown(0.5);
            }
            items.forEach((it, i) => {
                const lines = [];
                lines.push({ text: `Gross weight: ${it.gross_weight != null ? it.gross_weight + ' ' + unit : '—'}` });
                if (it.gross_photo_link) lines.push({ text: 'View gross photo >', link: it.gross_photo_link });
                lines.push({ text: `Tare weight: ${it.tare_weight != null ? it.tare_weight + ' ' + unit : '—'}` });
                if (it.tare_photo_link) lines.push({ text: 'View tare photo >', link: it.tare_photo_link });
                lines.push({ text: `Net weight: ${it.net_weight != null ? it.net_weight + ' ' + unit : '—'}`, bold: true });

                const headerH = 22, lineH = 14;
                const cardH = headerH + lines.length * lineH + 10;
                if (doc.y + cardH > PAGE_BOTTOM) doc.addPage();
                const cardTop = doc.y;

                doc.lineWidth(1).rect(PAGE_L, cardTop, PAGE_R - PAGE_L, cardH).strokeColor(RULE).stroke();
                doc.rect(PAGE_L, cardTop, PAGE_R - PAGE_L, headerH).fill(NAVY_LIGHT);
                doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(`${i + 1}. ${it.description || 'Item ' + (i + 1)}`, PAGE_L + 10, cardTop + 6);

                let ly = cardTop + headerH + 6;
                lines.forEach(l => {
                    if (l.link) {
                        doc.font('Helvetica').fontSize(9).fillColor('#1a5fb4').text('   ' + l.text, PAGE_L + 10, ly, { link: l.link, underline: true });
                    } else {
                        doc.font(l.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(l.bold ? NAVY : INK).text('   ' + l.text, PAGE_L + 10, ly);
                    }
                    ly += lineH;
                });
                doc.y = cardTop + cardH + 10;
            });

            doc.moveDown(0.3);
            if (includeSummary) {
                if (items.length) {
                    const groups = groupItemsByDescription(items);
                    drawSectionHeading(doc, 'Summary by Item Type');
                    drawItemTable(doc, groups, GROUP_COLUMNS_WEIGHTS);
                }

                drawSectionHeading(doc, 'Summary');
                drawSummaryBox(doc, [
                    { label: 'Gross total', value: load.gross_weight != null ? `${load.gross_weight} ${unit}` : '—' },
                    { label: 'Tare total',  value: load.tare_weight  != null ? `${load.tare_weight} ${unit}`  : '—' },
                    { label: 'Net total',   value: load.net_weight   != null ? `${load.net_weight} ${unit}`   : '—', emphasize: true },
                ]);
            }

            addFooters(doc, load);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ── Daily inventory report PDF ─────────────────────────────────────────────
// Per Apsara 2026-08-15: "everyday a pdf should be created for inventory for
// that day and it should stored in drive as report folder." Same letterhead/
// table styling as the load tickets above, but the content is a report, not
// a per-load document — `dateKey` stands in for a load id in the top-right
// corner and the footer. `todayReport`/`overallReport` are both
// helpers/loads.js's getInventoryReport() output (today's date-filtered and
// unfiltered respectively) — called by scheduler.js's nightly job, which
// already has both on hand for the email/WhatsApp version of this same
// report (buildYardReportText above), so nothing here is a third source of
// truth for what "today's inventory" means.
function generateInventoryReportPdf(dateKey, todayReport, overallReport) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const pseudoLoad = { id: dateKey };
            drawLetterhead(doc, 'Daily Inventory Report', pseudoLoad);

            const todayNet = round2(todayReport.byType.reduce((s, g) => s + (g.net || 0), 0));
            const todayAmount = round2(todayReport.byType.reduce((s, g) => s + (g.amount || 0), 0));

            drawSectionHeading(doc, `Today — ${dateKey} (${todayReport.loadCount} load${todayReport.loadCount === 1 ? '' : 's'})`);
            if (todayReport.byType.length) {
                drawItemTable(doc, todayReport.byType, GROUP_COLUMNS);
            } else {
                doc.font('Helvetica').fontSize(10).fillColor(INK).text('No loads recorded today.');
                doc.moveDown(0.6);
            }
            drawSummaryBox(doc, [
                { label: 'Loads today',  value: String(todayReport.loadCount) },
                { label: 'Net total',    value: `${todayNet} ${todayReport.unit}`, emphasize: true },
                { label: 'Amount total', value: `$${fmtAmount(todayAmount)}`, emphasize: true },
            ]);

            drawSectionHeading(doc, `By seller — today`);
            if (todayReport.bySeller.length) {
                drawItemTable(doc, todayReport.bySeller.map(s => ({ description: s.seller, count: s.loadCount, gross: '—', tare: '—', net: s.net, amount: s.amount })), SELLER_COLUMNS);
            } else {
                doc.font('Helvetica').fontSize(10).fillColor(INK).text('No loads recorded today.');
                doc.moveDown(0.6);
            }

            drawSectionHeading(doc, `All-time (${overallReport.loadCount} load${overallReport.loadCount === 1 ? '' : 's'} recorded total)`);
            if (overallReport.byType.length) {
                drawItemTable(doc, overallReport.byType, GROUP_COLUMNS);
            } else {
                doc.font('Helvetica').fontSize(10).fillColor(INK).text('No loads recorded yet.');
                doc.moveDown(0.6);
            }

            addFooters(doc, pseudoLoad);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ── On-demand inventory export PDF — Inventory tab's "⋮" export menu ──────
// Per Apsara 2026-08-15 ("export as excel/pdf"). Unlike
// generateInventoryReportPdf above (a fixed "today + all-time" nightly
// report), this reflects exactly whatever date range is currently applied
// on screen — `rangeLabel` is a human-readable description of that range
// (e.g. "All time" or "2026-08-01 to 2026-08-15"), `report` is a single
// getInventoryReport() result for that range.
function generateInventoryExportPdf(rangeLabel, report) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const pseudoLoad = { id: rangeLabel };
            drawLetterhead(doc, 'Inventory Export', pseudoLoad);

            const net = round2(report.byType.reduce((s, g) => s + (g.net || 0), 0));
            const amount = round2(report.byType.reduce((s, g) => s + (g.amount || 0), 0));

            drawSectionHeading(doc, `${rangeLabel} — ${report.loadCount} load${report.loadCount === 1 ? '' : 's'}`);
            if (report.byType.length) {
                drawItemTable(doc, report.byType, GROUP_COLUMNS);
            } else {
                doc.font('Helvetica').fontSize(10).fillColor(INK).text('No loads in this range.');
                doc.moveDown(0.6);
            }
            drawSummaryBox(doc, [
                { label: 'Loads',        value: String(report.loadCount) },
                { label: 'Net total',    value: `${net} ${report.unit}`, emphasize: true },
                { label: 'Amount total', value: `$${fmtAmount(amount)}`, emphasize: true },
            ]);

            drawSectionHeading(doc, 'By seller');
            if (report.bySeller.length) {
                drawItemTable(doc, report.bySeller.map(s => ({ description: s.seller, count: s.loadCount, gross: '—', tare: '—', net: s.net, amount: s.amount })), SELLER_COLUMNS);
            } else {
                doc.font('Helvetica').fontSize(10).fillColor(INK).text('No sellers in this range.');
                doc.moveDown(0.6);
            }

            drawSectionHeading(doc, 'Per day');
            if (report.byDay.length) {
                drawItemTable(doc, report.byDay.map(d => ({ description: d.date, count: d.loadCount, gross: '—', tare: '—', net: d.net, amount: d.amount })), SELLER_COLUMNS.map(c => c.key === 'description' ? { ...c, label: 'Date' } : (c.key === 'count' ? { ...c, label: 'Loads' } : c)));
            } else {
                doc.font('Helvetica').fontSize(10).fillColor(INK).text('No loads in this range.');
                doc.moveDown(0.6);
            }

            addFooters(doc, pseudoLoad);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ── POS/receipt-format PDF — per Apsara 2026-08-17 ("I want print option
// once pdf generated... I want it to be pos dimension for printing") ────────
// A completely separate renderer from generateLoadPdf/generateWeightsPdf
// above, not a variant of them — those two are hand-built around LETTER's
// ~512pt content width (fixed-x-position multi-column tables, side-by-side
// field boxes), none of which fits an 80mm thermal receipt (~227pt total
// page width, ~207pt after margins). This draws everything as simple
// sequential single-column text instead, the way an actual POS receipt
// reads top to bottom.
//
// Page height problem: pdfkit needs the page size fixed at document
// creation, but we don't know how tall this load's receipt needs to be
// until we've laid out every item (a load can have 1 item or 20). Rather
// than guess a big height and print several inches of wasted blank paper
// past the last line (or guess too short and truncate), this runs the
// exact same draw function TWICE: once against a throwaway tall scratch
// document just to measure how far doc.y travels, then again against a
// real document sized to fit that measured height exactly — a real
// continuous-receipt page, not a multi-page LETTER-style document.
const RECEIPT_WIDTH_MM = { '58': 58, '80': 80 };
// Fixed page height, per Apsara 2026-08-19 ("make the pos receipt standard
// size for printing"). The first version sized every page to its own
// content, which meant no two receipts had the same page size. That's fine
// for a raw continuous roll but bad for everything that expects a real
// page: Android's print dialog and most print drivers map the PDF page onto
// a selected paper size, and a page whose dimensions change per load gets
// scaled inconsistently — the same receipt coming out a different size each
// time. 80x150mm is a conventional receipt page and comfortably fits a
// typical load; content that genuinely exceeds it flows onto a SECOND PAGE
// OF THE SAME SIZE rather than stretching the page (see generateLoadReceiptPdf).
const RECEIPT_HEIGHT_MM = 150;
function mmToPt(mm) { return (mm / 25.4) * 72; }

function drawReceiptContent(doc, load, contentWidth) {
    // Page-break guard for the primitives that DON'T paginate themselves.
    // doc.text() checks the bottom margin and adds a page on its own, but
    // moveTo/lineTo/image draw at raw coordinates — past the page bottom
    // they'd render off the page and silently vanish. Now that the page
    // height is fixed (2026-08-19) that's a reachable case on a long load,
    // where before the page simply grew to fit.
    const room = (needed) => {
        const bottom = doc.page.height - doc.page.margins.bottom;
        if (doc.y + needed > bottom) doc.addPage();
    };
    const line = (text, { size = 9, bold = false, align = 'left', gap = 2, color = '#000' } = {}) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color)
            .text(text, doc.page.margins.left, doc.y, { width: contentWidth, align });
        doc.moveDown(gap / size);
    };
    const divider = () => {
        room(4);
        doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + contentWidth, doc.y)
            .lineWidth(0.75).strokeColor('#000').dash(2, { space: 2 }).stroke().undash();
        doc.moveDown(0.6);
    };

    line(EDGE_TRADING.name, { size: 13, bold: true, align: 'center', gap: 1 });
    line(EDGE_TRADING.address1, { size: 7.5, align: 'center', color: MUTED, gap: 0.5 });
    line(EDGE_TRADING.address2, { size: 7.5, align: 'center', color: MUTED, gap: 0.5 });
    line(EDGE_TRADING.phone, { size: 7.5, align: 'center', color: MUTED, gap: 2 });
    divider();

    line(`Load: ${load.id || '—'}`, { size: 9, bold: true, gap: 1 });
    line(`Date: ${load.date || '—'}`, { size: 8.5, gap: 1 });
    line(`Seller: ${load.seller || '—'}`, { size: 8.5, gap: load.seller_address ? 0.5 : 1 });
    if (load.seller_address) line(load.seller_address, { size: 7.5, color: MUTED, gap: 1 });
    divider();

    const unit = load.weight_unit || 'lb';
    const items = Array.isArray(load.items) ? load.items : [];
    items.forEach((it, i) => {
        line(it.description || `Item ${i + 1}`, { size: 8.5, bold: true, gap: 0.5 });
        line(`Gross ${it.gross_weight ?? '—'} ${unit}  ·  Tare ${it.tare_weight ?? '—'} ${unit}`, { size: 7.5, color: MUTED, gap: 0.5 });
        line(`Net ${it.net_weight ?? '—'} ${unit}  ·  Price $${fmtRate(it.price) ?? '—'}  ·  Amount $${fmtAmount(it.amount) ?? '—'}`, { size: 7.5, gap: 1.5 });
    });
    divider();

    line(`Net total: ${load.net_weight != null ? `${load.net_weight} ${unit}` : '—'}`, { size: 9.5, bold: true, gap: 1 });
    line(`Amount total: ${load.amount != null ? `$${fmtAmount(load.amount)}` : '—'}`, { size: 11, bold: true, gap: 3 });
    divider();

    // Signature — same idea as the full ticket's block (see
    // drawSignatureBlock), scaled to receipt width. This is the copy the
    // seller physically takes away, so it's arguably the one that most
    // needs their signature on it. Prints the ruled line either way so an
    // unsigned receipt can still be signed by hand on paper.
    room(52); // keep the signature image, its rule and its label together
    if (load.seller_signature) {
        try {
            const b64 = String(load.seller_signature).replace(/^data:image\/\w+;base64,/, '');
            doc.image(Buffer.from(b64, 'base64'), doc.page.margins.left, doc.y, { fit: [contentWidth, 34], align: 'left', valign: 'bottom' });
            doc.y += 36;
        } catch (err) {
            console.error('[pdf] could not render seller signature on receipt:', err.message);
        }
    } else {
        doc.y += 30; // blank space to sign by hand
    }
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + contentWidth, doc.y).lineWidth(0.75).strokeColor('#000').stroke();
    doc.moveDown(0.35);
    line('Seller signature', { size: 7.5, color: MUTED, gap: 2 });

    line(`Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} (LA time)`, { size: 6.5, align: 'center', color: MUTED });
}

// widthMm: '58' or '80' (the two standard thermal roll widths) — defaults
// to 80mm, the more common size for a business receipt printer.
// heightMm: defaults to RECEIPT_HEIGHT_MM (150mm). Every page is this exact
// size, per Apsara 2026-08-19 ("make the pos receipt standard size for
// printing") — a receipt longer than one page continues onto another page
// of identical dimensions rather than the page itself growing, so a printer
// or print dialog always sees one consistent paper size.
function generateLoadReceiptPdf(load, opts = {}) {
    const widthMm = RECEIPT_WIDTH_MM[String(opts.widthMm)] || 80;
    const heightMm = Number(opts.heightMm) > 0 ? Number(opts.heightMm) : RECEIPT_HEIGHT_MM;
    const pageWidth = mmToPt(widthMm);
    const pageHeight = mmToPt(heightMm);
    const margin = 10;
    const contentWidth = pageWidth - margin * 2;

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            drawReceiptContent(doc, load, contentWidth);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// Exported 2026-08-15 so scheduler.js's eodYardReport can reuse the exact
// same item-type grouping logic for its new inventory sections instead of
// duplicating this reduce elsewhere — one definition of "how items roll up
// by type" for both the PDF and the report.
module.exports = {
    generateLoadPdf, generateWeightsPdf, generateLoadReceiptPdf, groupItemsByDescription, generateInventoryReportPdf, generateInventoryExportPdf,
    // Additive exports — added 2026-08-19 for the Documents (Invoice/Proforma/
    // Verification) build-out. These drawing primitives already existed as
    // private module-level functions used internally by generateLoadPdf and
    // friends; nothing about their implementation changed, they're just now
    // reachable from other files (helpers/proformaPdf.js, helpers/invoicePdf.js)
    // instead of being reimplemented from scratch. Zero risk to existing
    // Load/Weights/Receipt/Inventory PDF generation above.
    ensureSpace, drawLetterhead, drawFieldBox, drawItemTable, drawSummaryBox, drawSignatureBlock, drawSectionHeading,
    NAVY, NAVY_LIGHT, RULE, MUTED, INK, PAGE_L, PAGE_R, PAGE_TOP, PAGE_BOTTOM,
};
