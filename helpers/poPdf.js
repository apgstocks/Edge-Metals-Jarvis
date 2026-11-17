// ── helpers/poPdf.js — the Purchase Order sheet as a PDF ───────────────────
// Same HTML the website prints (helpers/poSheet.js is a generated copy of the
// Documents → Purchase order tab's sheet), same page rules as its print window
// (body margin 0, first page flush to the top, 14mm bottom margin), rendered
// by the shared headless Chromium and queued behind other PDFs like the BOL.
const S = require('./poSheet');

function buildPoHtml(d) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>PO ' + S.esc(d.number) + ' - ' + S.esc(d.company) + '</title>'
        + '<style>body{margin:0; background:#fff;} @page{size:A4; margin:14mm 0;} @page :first{margin:0 0 14mm;}'
        + S.poSheetCss() + '</style></head><body>' + S.poSheetHtml(d) + '</body></html>';
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

module.exports = { buildPoHtml, generatePoPdf };
