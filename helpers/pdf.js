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

function drawLetterhead(doc, subtitle, load) {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text('EDGE METALS INC.', PAGE_L, 48);
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(subtitle.toUpperCase(), PAGE_L, 72, { characterSpacing: 1.2 });

    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(load.id, PAGE_L, 48, { width: PAGE_R - PAGE_L, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`Generated ${new Date().toLocaleDateString()}`, PAGE_L, 64, { width: PAGE_R - PAGE_L, align: 'right' });

    doc.moveTo(PAGE_L, 92).lineTo(PAGE_R, 92).lineWidth(1.5).strokeColor(NAVY).stroke();
    doc.lineWidth(1);
    doc.y = 106;
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

    const boxH = rows2 * rowH + fullBlockH + 20;
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

    let fy = boxTop + 16 + rows2 * rowH;
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
function groupItemsByDescription(items) {
    const groups = new Map();
    for (const it of items) {
        const key = it.description || 'Other';
        if (!groups.has(key)) groups.set(key, { description: key, count: 0, gross: 0, tare: 0, net: 0, amount: 0 });
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
    const fmt = (n) => (n != null ? String(n) : '—');
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
            const raw = c.key === 'description' ? (rowData.description || (isTotal ? '' : '—')) : fmt(rowData[c.key]);
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
            .text(`Edge Metals Inc. — Load ${load.id}`, PAGE_L, 729, { width: 250, lineBreak: false })
            .text(`Page ${i - range.start + 1} of ${range.count}`, PAGE_L, 729, { width: PAGE_R - PAGE_L, align: 'right', lineBreak: false });
    }
}

const TICKET_COLUMNS = [
    { key: 'description',  label: 'Description', x: 50,  width: 150, align: 'left'   },
    { key: 'gross_weight', label: 'Gross',        x: 200, width: 60,  align: 'right'  },
    { key: 'tare_weight',  label: 'Tare',         x: 260, width: 60,  align: 'right'  },
    { key: 'net_weight',   label: 'Net',          x: 320, width: 60,  align: 'right'  },
    { key: 'price',        label: 'Price',        x: 380, width: 55,  align: 'right'  },
    { key: 'unit',         label: 'Unit',         x: 435, width: 40,  align: 'center' },
    { key: 'amount',       label: 'Amount',       x: 475, width: 87,  align: 'right'  },
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
const GROUP_COLUMNS_WEIGHTS = [
    { key: 'description', label: 'Item Type', x: 50,  width: 220, align: 'left'  },
    { key: 'count',       label: 'Items',     x: 270, width: 60,  align: 'right' },
    { key: 'gross',       label: 'Gross',     x: 330, width: 78,  align: 'right' },
    { key: 'tare',        label: 'Tare',      x: 408, width: 78,  align: 'right' },
    { key: 'net',         label: 'Net',       x: 486, width: 76,  align: 'right' },
];

function generateLoadPdf(load) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            drawLetterhead(doc, 'Load Ticket', load);
            drawFieldBox(doc, [
                { label: 'Date:',       value: load.date },
                { label: 'Seller:',     value: load.seller },
                { label: 'Buyer:',      value: load.buyer },
                { label: 'Created by:', value: load.created_by },
                { label: 'Status:',     value: load.status },
            ], [
                { label: 'Description:',    value: load.description },
                { label: 'Seller Address:', value: load.seller_address },
                { label: 'Buyer Address:',  value: load.buyer_address },
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
            if (items.length) {
                const groups = groupItemsByDescription(items);
                drawSectionHeading(doc, 'Summary by Item Type');
                drawItemTable(doc, groups, GROUP_COLUMNS);
            }

            drawSectionHeading(doc, 'Summary');
            drawSummaryBox(doc, [
                { label: 'Gross total',  value: load.gross_weight != null ? `${load.gross_weight} ${unit}` : '—' },
                { label: 'Tare total',   value: load.tare_weight  != null ? `${load.tare_weight} ${unit}`  : '—' },
                { label: 'Net total',    value: load.net_weight   != null ? `${load.net_weight} ${unit}`   : '—', emphasize: true },
                { label: 'Amount total', value: load.amount       != null ? String(load.amount)             : '—', emphasize: true },
            ]);

            // Each item's captured scale photos, linked (not re-embedded — the
            // photos already live in Drive by the time this runs).
            const itemsWithPhotos = items.filter(it => it.gross_photo_link || it.tare_photo_link);
            if (itemsWithPhotos.length) {
                drawSectionHeading(doc, 'Captured Scale Photos');
                doc.fontSize(9).font('Helvetica');
                items.forEach((it, i) => {
                    if (!it.gross_photo_link && !it.tare_photo_link) return;
                    doc.fillColor(INK).font('Helvetica-Bold').text(`${i + 1}. ${it.description || 'Item ' + (i + 1)}`);
                    doc.font('Helvetica').fillColor('#1a5fb4');
                    if (it.gross_photo_link) doc.text('   Gross photo: ' + it.gross_photo_link, { link: it.gross_photo_link, underline: true });
                    if (it.tare_photo_link)  doc.text('   Tare photo: '  + it.tare_photo_link,  { link: it.tare_photo_link,  underline: true });
                    doc.fillColor(INK);
                    doc.moveDown(0.3);
                });
            }

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
function generateWeightsPdf(load) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            drawLetterhead(doc, 'Weight Record', load);
            drawFieldBox(doc, [
                { label: 'Date:',   value: load.date },
                { label: 'Seller:', value: load.seller },
                { label: 'Buyer:',  value: load.buyer },
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

            addFooters(doc, load);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateLoadPdf, generateWeightsPdf };
