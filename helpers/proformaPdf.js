// ── helpers/proformaPdf.js — dc-2 Proforma Invoice PDF (pixel-exact) ──────────
// Added 2026-08-19 as part of the Documents (Invoice/Proforma/Verification)
// build-out. Per Apsara's explicit choice (asked directly rather than
// decided silently — the two options were "match the pdfkit look of the
// rest of Jarvis's PDFs" vs. "keep the exact pixel design"), this renders
// the SAME HTML/CSS design as the Flask app's dc-2 proforma, via headless
// Chromium (puppeteer) instead of WeasyPrint (Python-only, not available in
// Node). That's a real dependency-weight tradeoff worth restating here:
// puppeteer bundles its own Chromium (~300MB on disk) — a heavier footprint
// than the rest of this "single VM, zero paid services" codebase, which
// otherwise only uses pdfkit (no browser engine at all). Accepted knowingly
// per Apsara's choice; see SETUP.md in the delivered patch for the ops
// implications (extra disk, first-launch download on `npm install`, and
// slower cold-start than pdfkit — a browser has to boot per PDF).
//
// Fonts and the HTML template are embedded from assets/proforma-dc2/ as
// base64 data URIs at render time, so this works regardless of where the
// process's cwd is or how the app is deployed — no relative-path or
// base_url fragility like the WeasyPrint version had.

const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'proforma-dc2');

let _templateCache = null;
function loadTemplate() {
    if (_templateCache) return _templateCache;

    const fontFile = (name) => {
        const buf = fs.readFileSync(path.join(ASSETS_DIR, name));
        return `data:font/ttf;base64,${buf.toString('base64')}`;
    };

    let html = fs.readFileSync(path.join(ASSETS_DIR, 'template.html'), 'utf8');
    html = html
        .replace('__FONT_POPPINS_BOLD__', fontFile('Poppins-Bold.ttf'))
        .replace('__FONT_POPPINS_MEDIUM__', fontFile('Poppins-Medium.ttf'))
        .replace('__FONT_DMSANS_REGULAR__', fontFile('DMSans-Regular.ttf'))
        .replace('__FONT_DMSANS_SEMIBOLD__', fontFile('DMSans-SemiBold.ttf'))
        .replace('__FONT_DMSANS_BOLD__', fontFile('DMSans-Bold.ttf'))
        .replace('__FONT_IBMPLEXMONO_REGULAR__', fontFile('IBMPlexMono-Regular.ttf'))
        .replace('__FONT_IBMPLEXMONO_BOLD__', fontFile('IBMPlexMono-Bold.ttf'));

    _templateCache = html;
    return html;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Formatting helpers — ported 1:1 from proforma_dc2_html_renderer.py ────────

function formatDate(val) {
    if (!val) return '';
    if (val instanceof Date) {
        const mm = String(val.getMonth() + 1).padStart(2, '0');
        const dd = String(val.getDate()).padStart(2, '0');
        return `${mm}/${dd}/${val.getFullYear()}`;
    }
    const s = String(val).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s; // already MM/DD/YYYY
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // DD/MM/YYYY — ambiguous, kept as-is like the Python version's fallback chain
    if (m) return s;
    return s;
}

// US Dollars <words> Only — same integer-only word conversion as the Flask app.
function amountInWords(amount) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
        'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
        'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function b1000(n) {
        if (n === 0) return '';
        if (n < 20) return ones[n];
        if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 === 0 ? '' : ' ' + ones[n % 10]);
        const r = b1000(n % 100);
        return ones[Math.floor(n / 100)] + ' Hundred' + (r ? ' ' + r : '');
    }

    let n = Math.round(amount || 0);
    if (n === 0) return 'Zero';
    const parts = [];
    const bi = Math.floor(n / 1_000_000_000); n %= 1_000_000_000;
    const mi = Math.floor(n / 1_000_000); n %= 1_000_000;
    const th = Math.floor(n / 1_000); n %= 1_000;
    if (bi) parts.push(b1000(bi) + ' Billion');
    if (mi) parts.push(b1000(mi) + ' Million');
    if (th) parts.push(b1000(th) + ' Thousand');
    if (n) parts.push(b1000(n));
    return 'US Dollars ' + parts.join(' ') + ' Only';
}

// Preserves exactly the precision entered — 1.47 stays $1.47, 0.4256 stays
// $0.4256 — never rounded to a fixed 0 or 2 decimals. Floor: 2 decimals
// minimum, so whole numbers still read as $1.00, not $1.
function formatRate(value) {
    const n = Number(value) || 0;
    const s = String(n);
    const decIdx = s.indexOf('.');
    const decimals = decIdx === -1 ? 0 : s.length - decIdx - 1;
    const useDecimals = Math.max(2, decimals);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: useDecimals, maximumFractionDigits: useDecimals });
}

// Comma-separated, 2 decimals, always.
function formatQty(value) {
    return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const { round2 } = require('./money');

function formatMoney2(value) {
    return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── HTML builder ────────────────────────────────────────────────────────────

function buildProformaDc2Html(data) {
    const containers = data.containers || [];
    let totalQty = 0, totalDue = 0;
    const renderContainers = containers.map((cont) => {
        const items = (cont.items || []).map((item) => {
            const qty = Number(item.qty) || 0;
            const rate = Number(item.rate) || 0;
            // Rounded ONCE, per line, and the total built from the rounded
            // lines — per Apsara 2026-08-28. qty * rate is raw floating point
            // (13.5 x 1.15 = 15.524999999999999), and accumulating the raw
            // values drifts: ten such lines total 155.25000000000003 while the
            // printed lines add to 155.20. On a document a customer checks by
            // hand, the total has to equal the rows above it — so the same
            // rounded figure is both printed and summed.
            const lineAmount = round2(qty * rate);
            totalQty += qty;
            totalDue += lineAmount;
            return {
                desc: item.desc || '',
                qtyFmt: formatQty(qty),
                rateFmt: formatRate(rate),
                amountFmt: '$' + formatMoney2(lineAmount),
            };
        });
        return { container_no: cont.container_no || '', items };
    });
    if (data.total_due) totalDue = Number(data.total_due);

    const addr = data.consignee_address || [];
    const consigneeName = addr.length ? addr[0] : (data.consignee || '');
    const rest = addr.length > 1 ? addr.slice(1) : [];
    const addressLines = rest.filter((l) => !/^\s*(TEL|FAX|PHONE)/i.test(l));
    const contactLines = rest.filter((l) => /^\s*(TEL|FAX|PHONE)/i.test(l));
    const consigneeAddressLine = addressLines.map(escapeHtml).join('<br>');
    const consigneeContactLine = contactLines.map(escapeHtml).join('<br>');

    const tradeTerms = data.trade_terms || '';
    const tradeTermsShort = tradeTerms ? tradeTerms.split(/\s+/)[0] : 'CIF';

    const freightLabel = data.freight_label || 'CIF (freight included)';
    const freightStatus = /included/i.test(freightLabel) || /^CIF/i.test(freightLabel.trim())
        ? 'INCLUDED' : (freightLabel ? 'EXCLUDED' : 'NOT STATED');

    const buyerPo = data.buyer_po || '';
    const buyerPoDate = data.buyer_po_date ? formatDate(data.buyer_po_date) : '';
    const termsCells = [
        ['Buyer\'s Order No & Date', (buyerPo + (buyerPoDate ? ' · ' + buyerPoDate : '')) || '-'],
        ['Payment Terms', data.payment_term || 'T/T 100% Against Shipping Documents'],
        ['Trade Terms', tradeTerms],
        ['Origin', data.country_of_origin || 'USA'],
        ['Pre-Carriage', 'By Sea'],
        ['Port of Loading', 'USA Ports'],
        ['Port of Discharge', data.port_discharge || ''],
        ['Shipment Allowance', data.shipment_allowance || '+/- 10% on weights'],
    ];

    function termsRow(cells) {
        return cells.map((c, i) => {
            const isLast = i === cells.length - 1;
            const border = isLast ? '' : 'border-right:1px solid var(--steel-100);';
            return `        <div style="flex:1;padding:11px 15px;${border}">
          <div style="font-family:var(--font-mono);font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--steel-400);margin-bottom:3px;">${escapeHtml(c[0])}</div>
          <div style="font-size:12px;font-weight:600;color:var(--steel-900);">${escapeHtml(c[1])}</div>
        </div>`;
        }).join('\n');
    }
    const termsRow1 = termsRow(termsCells.slice(0, 4));
    const termsRow2 = termsRow(termsCells.slice(4));

    const itemRowsHtml = [];
    renderContainers.forEach((cont, ci) => {
        const isLastContainer = ci === renderContainers.length - 1;
        cont.items.forEach((item, ii) => {
            const isLastRowOfLastContainer = isLastContainer && ii === cont.items.length - 1;
            const bottomBorder = isLastRowOfLastContainer ? '2px solid var(--leaf-600)' : '1px solid var(--steel-100)';
            const containerCell = ii === 0
                ? `<td rowspan="${cont.items.length}" style="padding:11px 14px;border-bottom:${isLastContainer ? '2px solid var(--leaf-600)' : '1px solid var(--steel-200)'};border-right:1px solid var(--steel-100);vertical-align:top;background:var(--leaf-50);font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--leaf-700);">${escapeHtml(cont.container_no)}</td>`
                : '';
            itemRowsHtml.push(`        <tr>
          ${containerCell}
          <td style="padding:11px 14px;border-bottom:${bottomBorder};color:var(--steel-800);">${escapeHtml(item.desc)}</td>
          <td style="padding:11px 14px;border-bottom:${bottomBorder};text-align:right;font-family:var(--font-mono);color:var(--steel-700);">${item.qtyFmt}</td>
          <td style="padding:11px 14px;border-bottom:${bottomBorder};text-align:right;font-family:var(--font-mono);color:var(--steel-700);">${item.rateFmt}</td>
          <td style="padding:11px 14px;border-bottom:${bottomBorder};text-align:right;font-family:var(--font-mono);font-weight:500;color:var(--steel-950);">${item.amountFmt}</td>
        </tr>`);
        });
    });

    // Was a hardcoded empty spacer, with a comment claiming no signature image
    // was shipped. It was — inlined as base64 inside the INVOICE template,
    // which is why the invoice had a signature and the proforma never did.
    // Now both draw the same file via helpers/signature.js, which still falls
    // back to exactly this empty 34px block if the image cannot be read.
    const signatureBlock = require('./signature').signatureBlockHtml();

    let html = loadTemplate();
    const subs = {
        inv_no: escapeHtml(data.inv_no || ''),
        inv_date: escapeHtml(formatDate(data.inv_date)),
        reference: escapeHtml(data.reference || 'Proforma & Email Conf.'),
        consignee_name: escapeHtml(consigneeName),
        consignee_address_line: consigneeAddressLine,
        consignee_contact_line: consigneeContactLine,
        terms_row_1: termsRow1,
        terms_row_2: termsRow2,
        qty_unit: escapeHtml(data.qty_unit || 'MT'),
        item_rows: itemRowsHtml.join('\n'),
        total_qty_fmt: formatQty(totalQty),
        amount_in_words: escapeHtml(amountInWords(totalDue)),
        trade_terms_short: escapeHtml(tradeTermsShort),
        total_due_fmt: formatMoney2(totalDue),
        freight_status: escapeHtml(freightStatus),
        signature_block: signatureBlock,
    };
    for (const [key, val] of Object.entries(subs)) {
        html = html.split(`{{${key}}}`).join(val);
    }
    return { html, totalQty, totalDue };
}

// Renders the dc-2 proforma to a PDF Buffer. `opts.launchArgs` lets callers
// pass `['--no-sandbox']` etc. if the deploy VM needs it (common on some
// Linux hosts running as root) without hardcoding that here.
async function generateProformaDc2Pdf(data, opts = {}) {
    const { html } = buildProformaDc2Html(data);
    const browser = await puppeteer.launch({
        headless: true,
        args: opts.launchArgs || ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        // One page, same rule as the invoice (Apsara 2026-08-29). This
        // template's @page is 816x1500px rather than A4, and 1500px is
        // generous, so in practice this never scales — it is here so a
        // proforma with an unusually long container list cannot start
        // spilling a near-empty second page the way the invoice did.
        const { pdfFittedToOnePage } = require('./pdfFit');
        const pdf = await pdfFittedToOnePage(page, {
            width: '816px',
            printBackground: true,
            preferCSSPageSize: true,
        }, { pageHeightPx: 1500, label: `proforma ${data && data.inv_no ? data.inv_no : ''}`.trim() });
        // puppeteer resolves page.pdf() with a Uint8Array, not a Node
        // Buffer — Buffer.isBuffer(Uint8Array) is false, so passing it
        // straight to Express's res.send() gets JSON-stringified byte-by-
        // byte ({"0":37,"1":80,...}) instead of sent as binary. Found via a
        // real end-to-end curl test against /api/proforma/generate, not
        // just the direct fs.writeFileSync smoke test (which happened to
        // work because fs.writeFileSync accepts any TypedArray fine).
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
}

module.exports = { buildProformaDc2Html, generateProformaDc2Pdf, formatDate, amountInWords, formatRate, formatQty };
