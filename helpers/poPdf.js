// ── helpers/poPdf.js — the Purchase Order sheet as a PDF ───────────────────
// Same HTML the website prints (helpers/poSheet.js is a generated copy of the
// Documents → Purchase order tab's sheet), same page rules as its print window
// (body margin 0, first page flush to the top, 14mm bottom margin), rendered
// by the shared headless Chromium and queued behind other PDFs like the BOL.
const S = require('./poSheet');

const PDF_FILL = '@page :first{margin:0;} @media print{.po-sheet{min-height:296.5mm;}}';

function buildPoHtml(d) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>PO ' + S.esc(d.number) + ' - ' + S.esc(d.company) + '</title>'
        + '<style>body{margin:0; background:#fff;} @page{size:A4; margin:14mm 0;} @page :first{margin:0 0 14mm;}'
        + S.poSheetCss()
        // The PDF owns the whole page. The website's print CSS is sized for a browser
        // print dialog (262mm sheet, 14mm bottom margin), which in a PDF leaves the dark
        // footer hanging ~35mm above the bottom edge (Apsara, 2026-11-18: "why there is
        // black footer hanging"). Here the first page has no margin and the sheet is the
        // page's height, so the footer (pinned to the sheet's bottom) sits on the edge.
        // A longer PO still flows onto a second page with its 14mm margins.
        + PDF_FILL + '</style></head><body>' + S.poSheetHtml(d) + '</body></html>';
}

async function generatePoPdf(d, opts = {}) {
    return require('./pdfQueue').run(() => renderUnqueued(d, opts), `po ${d.number || ''}`.trim());
}

async function renderUnqueued(d, opts) {
    const html = buildPoHtml(d);
    return require('./pdfBrowser').withPage(async (page) => {
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
        // puppeteer returns a Uint8Array; Express would JSON-stringify it.
        return Buffer.from(pdf);
    }, { launchArgs: opts.launchArgs });
}

module.exports = { buildPoHtml, generatePoPdf, PDF_FILL };
