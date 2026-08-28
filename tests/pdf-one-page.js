// ── tests/pdf-one-page.js — generated documents stay on one page ───────────
//
// Apsara, 2026-08-29, after generating 260811_AP_26TM03 in the mobile app:
// "pdf should be one page only always."
//
// That invoice put the whole document on page 1 and the declaration plus the
// authorised signature alone on page 2 — about 100px of overflow paid for
// with a second, almost blank sheet, with the signature stranded on it.
//
// Chrome cannot launch in this sandbox (aarch64, no root, and the cached
// puppeteer binary is x86-64), so the RENDER cannot be exercised here. The
// arithmetic that decides the scale can be, and that is where the actual
// judgement lives — so it is tested directly rather than left unverified
// because the renderer will not start.

const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (name, cond) => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name); } };

const { scaleToFit, pdfFittedToOnePage, centringOffsetPx, MIN_SCALE, PX_PER_MM } = require(path.join(R, 'helpers', 'pdfFit.js'));

console.log('\n─ one-page documents ─────────────────────────────────────');

const A4 = 297;                       // mm, the invoice's @page
const A4_PX = A4 * PX_PER_MM;         // ~1122.5

// ── a document that already fits is left completely alone ─────────────────
{
    // The important half. Most invoices presumably already fit, and scaling
    // one that does would shrink a document that was correct — changing the
    // look of every short invoice to fix the long ones.
    for (const h of [400, 900, 1100, Math.floor(A4_PX)]) {
        const r = scaleToFit(h, A4);
        ck(`${h}px of content is not scaled at all`, r.scale === 1 && r.fits);
    }
}

// ── her actual invoice now fits ───────────────────────────────────────────
{
    // Page 1 held everything; page 2 held only the declaration + signature
    // block, which is roughly 95-130px tall in this template.
    for (const h of [1190, 1218, 1250]) {
        const r = scaleToFit(h, A4);
        ck(`${h}px (her invoice) fits after scaling`, r.fits && r.scale < 1);
        ck(`  and ${h}px scaled lands inside the page`, h * r.scale <= A4_PX);
        ck(`  and ${h}px stays readable (>0.85)`, r.scale > 0.85);
    }
}

// ── it scales with the item count, which is the whole point ───────────────
{
    // A fixed factor would fix one invoice and break the next. Every extra
    // line adds a row to the item table AND to the packing list.
    const four = scaleToFit(1218, A4).scale;
    const eight = scaleToFit(1440, A4).scale;
    const twelve = scaleToFit(1650, A4).scale;
    ck('a taller document gets a smaller scale', four > eight && eight > twelve);
    for (const h of [1150, 1300, 1500, 1700, 1800]) {
        const r = scaleToFit(h, A4);
        ck(`${h}px still lands inside one page`, h * r.scale <= A4_PX);
    }
}

// ── the floor: unreadable is worse than two pages ─────────────────────────
{
    const r = scaleToFit(2400, A4);
    ck('an enormous document stops at the floor', r.scale === MIN_SCALE);
    ck('and is honestly reported as NOT fitting', r.fits === false);
    ck('the floor is high enough to stay legible', MIN_SCALE >= 0.6);
    // It must NOT be truncated. The thing at the bottom of a commercial
    // invoice is the authorised signature.
    const src = fs.readFileSync(path.join(R, 'helpers/pdfFit.js'), 'utf8');
    ck('nothing truncates the document to one page', !/pageRanges/.test(src) || /NOT using puppeteer's `pageRanges/.test(src));
}

// ── nonsense measurements never make things worse ─────────────────────────
{
    for (const bad of [0, -100, NaN, null, undefined, Infinity]) {
        const r = scaleToFit(bad, A4);
        ck(`a ${JSON.stringify(bad)} measurement renders unscaled`, r.scale === 1);
    }
}

// ── the proforma's taller custom page ─────────────────────────────────────
{
    // Its @page is 816x1500px, not A4. Expressed in px so the height is not
    // round-tripped through millimetres.
    const asMm = 1500 / PX_PER_MM;
    ck('a 1400px proforma is untouched', scaleToFit(1400, asMm).scale === 1);
    ck('a 1600px proforma is scaled to fit', scaleToFit(1600, asMm).scale < 1);
    ck('  and lands inside its page', 1600 * scaleToFit(1600, asMm).scale <= 1500);
}


// ── the scaled sheet sits in the middle of the paper ──────────────────────
// Apsara, on the first one-page invoice: "this should be center". Chrome
// scales about the paper's top-left, so every millimetre freed by shrinking
// piled up on the right — ~15mm left against ~26mm right.
{
    const W = 210 * PX_PER_MM;
    // The margins are computed in the RENDERED document, which is the only
    // place the answer matters: shift is applied pre-scale, so it lands at
    // offset x scale.
    for (const contentPx of [1190, 1218, 1250, 1440, 1650]) {
        const s = scaleToFit(contentPx, 297).scale;
        const off = centringOffsetPx(W, s);
        const left = off * s;
        const right = W - (off + W) * s;
        ck(`${contentPx}px: left and right margins are equal`, Math.abs(left - right) < 0.01);
        ck(`  ${contentPx}px: the sheet stays on the paper`, off * s >= 0 && (off + W) * s <= W + 0.01);
    }

    // A document that already fits must not be nudged at all — it is sitting
    // exactly where it was designed to sit.
    ck('an unscaled document is not shifted', centringOffsetPx(W, 1) === 0);
    ck('a scale above 1 is not shifted either', centringOffsetPx(W, 1.2) === 0);
    ck('a nonsense page width does not shift anything', centringOffsetPx(0, 0.9) === 0);
    ck('a NaN page width does not shift anything', centringOffsetPx(NaN, 0.9) === 0);

    // The proforma's page is 816px wide, not A4.
    const s2 = 0.9;
    const off2 = centringOffsetPx(816, s2);
    ck('the proforma centres on its own 816px page',
       Math.abs((off2 * s2) - (816 - (off2 + 816) * s2)) < 0.01);
}

// ── it degrades safely, and passes options through ────────────────────────
(async () => {
    // A fake puppeteer page. Measuring is an optimisation; if it throws, the
    // document must still generate exactly as it did before this existed.
    {
        let got = null;
        const page = {
            evaluate: async () => { throw new Error('detached frame'); },
            pdf: async (o) => { got = o; return Buffer.from('PDF'); },
        };
        const out = await pdfFittedToOnePage(page, { printBackground: true, preferCSSPageSize: true, width: '816px' }, { label: 'x' });
        ck('a failed measurement does not throw', Buffer.isBuffer(out));
        ck('it falls back to scale 1', got.scale === 1);
        ck('and every existing pdf option survives',
           got.printBackground === true && got.preferCSSPageSize === true && got.width === '816px');
    }

    // A real overflow measurement produces a real scale.
    {
        let got = null, css = null;
        const page = {
            evaluate: async () => 1250,
            addStyleTag: async (o) => { css = o.content; },
            pdf: async (o) => { got = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(page, { printBackground: true }, { pageHeightMm: 297, pageWidthMm: 210, label: 'invoice TEST' });
        ck('an overflowing page is scaled down', got.scale < 1 && got.scale > 0.85);
        ck('the scaled height fits A4', 1250 * got.scale <= A4_PX);

        // The centring really is injected, and it really does centre.
        ck('a centring style is injected', typeof css === 'string' && css.length > 0);
        ck('it moves paint, not layout', /position:relative/.test(css));
        const px = parseFloat(/left:([\d.]+)px/.exec(css)[1]);
        const W = 210 * PX_PER_MM;
        ck('the shift is a real positive offset', px > 0);
        ck('the rendered left and right margins match',
           Math.abs((px * got.scale) - (W - (px + W) * got.scale)) < 0.05);
        ck('the sheet does not run off the right edge', (px + W) * got.scale <= W + 0.05);
    }

    // A document that already fits must be left exactly where it is.
    {
        let css = null, got = null;
        const page = {
            evaluate: async () => 800,
            addStyleTag: async (o) => { css = o.content; },
            pdf: async (o) => { got = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(page, {}, { pageHeightMm: 297, pageWidthMm: 210, label: 'short invoice' });
        ck('a short invoice is not scaled', got.scale === 1);
        ck('and no centring style is injected at all', css === null);
    }

    // Chrome throws if scale leaves [0.1, 2], which would take the whole
    // document down rather than produce a slightly wrong one.
    {
        let got = null;
        const page = {
            evaluate: async () => 999999,
            pdf: async (o) => { got = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(page, {}, { label: 'absurd' });
        ck('the scale is always within the range Chrome accepts', got.scale >= 0.1 && got.scale <= 2);
    }

    // ── both generators actually use it ───────────────────────────────────
    {
        const inv = fs.readFileSync(path.join(R, 'helpers/invoicePdf.js'), 'utf8');
        const pro = fs.readFileSync(path.join(R, 'helpers/proformaPdf.js'), 'utf8');
        ck('the invoice generator fits to one page', /pdfFittedToOnePage\(/.test(inv));
        ck('the proforma generator fits to one page', /pdfFittedToOnePage\(/.test(pro));
        ck('the invoice fits to A4, matching its @page', /pageHeightMm:\s*297/.test(inv));
        ck('the proforma fits to its own 1500px page', /pageHeightPx:\s*1500/.test(pro));
        ck('neither still calls page.pdf directly', !/await page\.pdf\(/.test(inv) && !/await page\.pdf\(/.test(pro));
        ck('the invoice tells the fitter how wide its page is', /pageWidthMm:\s*210/.test(inv));
        ck('the proforma tells it too', /pageWidthPx:\s*816/.test(pro));
        const fit = fs.readFileSync(path.join(R, 'helpers/pdfFit.js'), 'utf8');
        // position:relative moves paint, not layout — so centring cannot undo
        // the pagination fix by nudging content onto a second page.
        ck('centring uses relative positioning, not a margin or transform',
           /position:relative;left:/.test(fit) && !/transform:\s*translate/.test(fit));
        ck('centring is horizontal only', !/\btop:\$\{/.test(fit));
    }

    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
