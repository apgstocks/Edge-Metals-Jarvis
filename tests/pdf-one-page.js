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

const { scaleToFit, pdfFittedToOnePage, centringOffsetPx, trimToFit, RELIEFS, MIN_SCALE, PX_PER_MM } = require(path.join(R, 'helpers', 'pdfFit.js'));

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
    // ── BELOW THE FLOOR, IT STOPS SHRINKING ALTOGETHER ───────────────────
    // Apsara, 2026-09-16: "in packing list tab,what if my packing list keep on
    // going to 3 page?"
    //
    // This check used to assert r.scale === MIN_SCALE, which encoded the
    // behaviour her question exposed: a document too tall to fit was shrunk to
    // 62% AND STILL RAN TO THREE PAGES. The shrinking bought nothing — it does
    // not remove the second page, it only makes the type on all three harder
    // to read. The header of pdfFit.js already said the document should be
    // "allowed to run to a second page"; the code scaled it anyway.
    const r = scaleToFit(2400, A4);
    ck('a document that cannot fit is NOT shrunk', r.scale === 1,
       `${r.scale} — 62% type across three pages is the worst of both answers`);
    ck('and is honestly reported as NOT fitting', r.fits === false);
    ck('  and flagged as something to paginate properly', r.paginate === true);
    ck('the floor is still high enough to stay legible', MIN_SCALE >= 0.6);
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
        // Apsara: "what happened to original size? i asked you to put it in
        // one page. didnt tell about reducing right/left border."
        //
        // THE central assertion of this file now: an invoice that is over by
        // an amount the empty space can absorb must come out at FULL SIZE.
        let got = null; const styles = []; let reliefs = 0;
        const page = {
            // 1250px first, then shrinking as reliefs are applied — a stand-in
            // for what the real browser reports after each style is injected.
            evaluate: async (fn) => {
                if (typeof fn === 'function' && fn.length === 0 && reliefs > 0) { /* adaptive relief */ }
                return [1250, 1215, 1180, 1118][Math.min(reliefs, 3)];
            },
            addStyleTag: async (o) => { styles.push(o.content); reliefs += 1; },
            pdf: async (o) => { got = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(page, { printBackground: true }, { pageHeightMm: 297, pageWidthMm: 210, label: 'invoice TEST' });
        ck('an invoice that empty space can absorb stays at FULL SIZE', got.scale === 1);
        ck('and it is NOT shifted, so the margins stay as designed',
           !styles.some((c) => /position:relative/.test(c)));
        ck('space was reclaimed from the page margin first',
           /padding-top/.test(styles[0] || ''));
        ck('the left and right margins are never touched',
           !styles.some((c) => /padding-left|padding-right|padding:\s*\d/.test(c)));
    }

    // A document that already fits must be left completely untouched.
    {
        let css = null, got = null;
        const page = {
            evaluate: async () => 800,
            addStyleTag: async (o) => { css = o.content; },
            pdf: async (o) => { got = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(page, {}, { pageHeightMm: 297, pageWidthMm: 210, label: 'short invoice' });
        ck('a short invoice is not scaled', got.scale === 1);
        ck('no space is reclaimed from it either', css === null);

        // ── scaling is the LAST resort, not the first move ────────────────
        // A document so tall that no amount of empty space can save it. Only
        // then may it shrink, and only then is it centred.
        let got2 = null; const styles2 = [];
        const tall = {
            evaluate: async () => 1500,          // never shrinks, whatever is applied
            addStyleTag: async (o) => { styles2.push(o.content); },
            pdf: async (o) => { got2 = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(tall, {}, { pageHeightMm: 297, pageWidthMm: 210, label: 'huge invoice' });
        ck('a document empty space cannot save DOES scale', got2.scale < 1);
        ck('every relief was tried before scaling', styles2.length >= RELIEFS.length - 1);
        ck('and only then is it centred', styles2.some((c) => /position:relative/.test(c)));
        ck('the scaled version still fits the page', 1500 * got2.scale <= A4_PX + 0.5);
    }

    // ── AND THE ONE THAT CANNOT BE SAVED AT ALL ──────────────────────────
    // Apsara, 2026-09-16: "in packing list tab,what if my packing list keep on
    // going to 3 page?" Forty bundles is forty bundles — three pages is the
    // right answer. What matters is that they read as one document.
    //
    // THE RENDERER CANNOT RUN HERE (this sandbox is aarch64 and Chromium will
    // not launch), so what is asserted is the CSS and the options handed to
    // Chrome. That is an honest limit and it is the same one every other check
    // in this file works within — but it means the footer's appearance itself
    // is unverified, and that is written down rather than implied.
    {
        let got3 = null; const styles3 = [];
        const enormous = {
            evaluate: async () => 4200,          // ~4 pages, nothing can save it
            addStyleTag: async (o) => { styles3.push(o.content); },
            pdf: async (o) => { got3 = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(enormous, { printBackground: true, preferCSSPageSize: true },
                                 { pageHeightMm: 297, pageWidthMm: 210, label: 'forty-bundle packing list' });
        ck('a genuinely multi-page document prints at FULL size', got3.scale === 1,
           `${got3.scale} — shrinking it would not have removed a single page`);
        ck('  so it is not centred either', !styles3.some((c) => /position:relative/.test(c)),
           'centring exists to put a SHRUNKEN sheet back in the middle of the paper');

        const css = styles3.join('\n');
        ck('  the column headings repeat on every page', /thead \{ display: table-header-group/.test(css),
           'page 2 of a weight table with no headings is four columns of numbers');
        ck('  no row is split down the middle', /page-break-inside: avoid/.test(css),
           'a break through a row puts a gross on one page and its net on the next');
        ck('  and the TOTAL is kept with the rows above it',
           /tr\.total[^}]*break-before:\s*avoid/.test(css),
           'a final page carrying only TOTAL and a signature is the shape she objected to in August');

        ck('  the pages are numbered', got3.displayHeaderFooter === true
           && /pageNumber/.test(got3.footerTemplate || '') && /totalPages/.test(got3.footerTemplate || ''),
           'three loose sheets with no numbers give a broker no way to know they have all of them');
        ck('    with a font size, or Chrome renders the footer at zero',
           /font-size:\s*\d/.test(got3.footerTemplate || ''), got3.footerTemplate);
        ck('    and room to sit in, since the template sets @page margin 0',
           (got3.margin || {}).bottom === '10mm', JSON.stringify(got3.margin));
        ck('  and the caller\'s own options survive',
           got3.printBackground === true && got3.preferCSSPageSize === true,
           'the sheet must stay the size the template asks for');
    }

    // A document that FITS gets none of this — no footer, no page numbers, no
    // pagination CSS. "Page 1 of 1" on a commercial invoice is noise, and this
    // template has never carried a footer of its own.
    {
        let got4 = null; const styles4 = [];
        const fine = {
            evaluate: async () => 900,
            addStyleTag: async (o) => { styles4.push(o.content); },
            pdf: async (o) => { got4 = o; return Buffer.from('PDF'); },
        };
        await pdfFittedToOnePage(fine, { printBackground: true }, { pageHeightMm: 297, label: 'ordinary invoice' });
        ck('a one-page document gets no page-number footer', !got4.displayHeaderFooter,
           '"Page 1 of 1" is noise on an invoice');
        ck('  and no pagination rules', !styles4.some((c) => /table-header-group/.test(c)),
           'nothing about a document that fits should change');
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
