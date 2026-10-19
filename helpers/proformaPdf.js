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

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'proforma-dc2');

const FONTS = [
    ['__FONT_POPPINS_BOLD__', 'Poppins-Bold.ttf'],
    ['__FONT_POPPINS_MEDIUM__', 'Poppins-Medium.ttf'],
    ['__FONT_DMSANS_REGULAR__', 'DMSans-Regular.ttf'],
    ['__FONT_DMSANS_SEMIBOLD__', 'DMSans-SemiBold.ttf'],
    ['__FONT_DMSANS_BOLD__', 'DMSans-Bold.ttf'],
    ['__FONT_IBMPLEXMONO_REGULAR__', 'IBMPlexMono-Regular.ttf'],
    ['__FONT_IBMPLEXMONO_BOLD__', 'IBMPlexMono-Bold.ttf'],
];

// ── SUBSTITUTION, AS A FUNCTION TAKING ITS OWN LOADER ────────────────────
// Exported and injectable so the EVERY-OCCURRENCE property can be tested on
// a crafted template rather than on assets/proforma-dc2/template.html.
//
// That matters because the template no longer repeats a token: the two
// duplicated faces were merged into weight ranges on 2026-10-20 to drop
// 276 KB of duplicate base64. With no duplicate left in the real file, a
// test that read the real file could not tell replaceAll from replace — the
// mutation would have survived and the check would have been proving
// nothing, which is the failure this repo's mutation pass exists to catch.
//
// So the defence is kept here, independent of what the template happens to
// look like today. A future template that repeats a token is handled, and
// the test can prove it without anyone editing the template to suit it.
function embedFonts(template, loader) {
    let out = String(template || '');
    for (const [token, file] of FONTS) out = out.replaceAll(token, loader(file));
    return out;
}

// ── THE GUARD, AS A FUNCTION RATHER THAN FOUR LINES INLINE ───────────────
// Exported because a test that greps this file for the word "throw" is not
// testing the guard — it is testing that a comment still exists. The
// mutation harness proved exactly that: disabling the throw with `void 0 &&`
// left the message string in place, tests/proforma-fonts.js kept passing,
// and the mutation SURVIVED.
//
// Same reasoning as pdfQueue's job.timeoutMs and pdfBrowser's injectable
// launcher: a real seam, so the behaviour can be exercised on a crafted
// input instead of inferred from the source text.
function assertFontsEmbedded(html) {
    const left = String(html || '').match(/__FONT_[A-Z0-9_]+__/g);
    if (left && left.length) {
        throw new Error('proforma template has unsubstituted font tokens: '
            + [...new Set(left)].join(', ')
            + ' — add it to FONTS in helpers/proformaPdf.js. Left in, it becomes a '
            + 'font request that never resolves and a 30s networkidle0 timeout.');
    }
    return true;
}

let _templateCache = null;
function loadTemplate() {
    if (_templateCache) return _templateCache;

    const fontFile = (name) => {
        const buf = fs.readFileSync(path.join(ASSETS_DIR, name));
        return `data:font/ttf;base64,${buf.toString('base64')}`;
    };

    let html = fs.readFileSync(path.join(ASSETS_DIR, 'template.html'), 'utf8');

    // ── EVERY OCCURRENCE, NOT THE FIRST (2026-10-20) ─────────────────────
    // Apsara: "TIMEOUT AFTER 30000 SECONDS IN PROFORMA".
    //
    // These were seven `.replace('__FONT_X__', ...)` calls with STRING
    // patterns, and String.prototype.replace with a string replaces ONLY THE
    // FIRST MATCH. template.html uses two of them twice:
    //
    //     __FONT_POPPINS_BOLD__     weight 800 and weight 700
    //     __FONT_DMSANS_REGULAR__   twice
    //
    // so the second of each survived into the finished HTML as a literal
    // src: url('__FONT_POPPINS_BOLD__'). setContent() gives the page no base
    // URL, so Chromium resolved those against about: and issued two font
    // requests that never completed — and this renderer waits on
    // 'networkidle0', which requires ZERO requests in flight for 500ms.
    // Network idle was therefore unreachable and puppeteer threw at its
    // 30-second default. Every proforma, every time.
    //
    // Two things were wrong and only one of them is the timeout: Poppins 700
    // and DM Sans 400 have never actually rendered in this document either.
    // They silently fell back to another face, which is why nobody caught it
    // by looking at a PDF.
    //
    // THE WAIT CONDITION IS LEFT AS 'networkidle0' ON PURPOSE. Switching it
    // to 'load' — as the invoice did on 2026-10-10 — also stops the hang,
    // and that is exactly the problem: it would have hidden a genuinely
    // broken font reference instead of surfacing it. The strict wait is what
    // turned a cosmetic bug into a loud one. Changing it is a separate
    // decision with a real trade-off, and it is Apsara's to make.
    //
    // replaceAll is used rather than a global regex so the base64 payload is
    // treated as a literal: a data: URL contains '+' and '/', and a few of
    // the $-sequences that replace() interprets in a replacement string
    // would corrupt the font silently.
    html = embedFonts(html, fontFile);

    // ── AND REFUSE TO SHIP ONE THAT IS STILL DANGLING ────────────────────
    // The bug above was invisible for as long as it existed because a missing
    // font looks like a slightly different font. A leftover token is now a
    // hard failure at BUILD time, with the token named — a template that
    // grows an eighth font, or renames one, fails here in one second instead
    // of hanging for thirty in front of a customer.
    assertFontsEmbedded(html);

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
// Queued — one Chromium at a time. See helpers/pdfQueue.js.
async function generateProformaDc2Pdf(data, opts = {}) {
    return require('./pdfQueue').run(
        () => generateProformaDc2PdfUnqueued(data, opts),
        `proforma ${(data && data.inv_no) || ''}`.trim());
}

async function generateProformaDc2PdfUnqueued(data, opts = {}) {
    // Timed as well, though Apsara asked about the invoice and the BOL: the
    // three renderers share a shape, and a baseline from the one she has NOT
    // complained about is what says whether the other two are slow for a
    // reason of their own or whether every document costs this.
    const timer = require('./pdfTiming').start(`proforma ${(data && data.inv_no) || ''}`.trim());
    const { html } = buildProformaDc2Html(data);
    timer.mark('build-html');
    // A tab in WhatsApp's Chromium — see helpers/pdfBrowser.js.
    try {
      return await require('./pdfBrowser').withPage(async (page) => {
        timer.mark('launch-chromium');
        await page.setContent(html, { waitUntil: 'networkidle0' });
        timer.mark('load-page');
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
        }, { pageHeightPx: 1500, pageWidthPx: 816, timer,
             label: `proforma ${data && data.inv_no ? data.inv_no : ''}`.trim() });
        // puppeteer resolves page.pdf() with a Uint8Array, not a Node
        // Buffer — Buffer.isBuffer(Uint8Array) is false, so passing it
        // straight to Express's res.send() gets JSON-stringified byte-by-
        // byte ({"0":37,"1":80,...}) instead of sent as binary. Found via a
        // real end-to-end curl test against /api/proforma/generate, not
        // just the direct fs.writeFileSync smoke test (which happened to
        // work because fs.writeFileSync accepts any TypedArray fine).
        return Buffer.from(pdf);
      }, { launchArgs: opts.launchArgs });
    } finally {
        timer.mark('close-chromium');
        timer.done({ html_kb: Math.round(html.length / 1024) });
    }
}

module.exports = { buildProformaDc2Html, generateProformaDc2Pdf, assertFontsEmbedded, embedFonts, FONTS, formatDate, amountInWords, formatRate, formatQty };
