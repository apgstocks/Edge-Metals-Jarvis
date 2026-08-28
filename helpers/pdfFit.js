// ── helpers/pdfFit.js — keep a generated document on one page ──────────────
//
// Per Apsara 2026-08-29, after generating 260811_AP_26TM03 from the mobile
// app: "pdf should be one page only always."
//
// What actually happened in that PDF: page 1 held the entire invoice — header,
// buyer, all four item rows, the total, the whole packing list — and page 2
// held nothing but the declaration and the signature block. It overflowed A4
// by roughly 100px, about 8%, and paid for it with a second sheet that is
// blank apart from two boxes. That is the worst possible way to be two pages:
// it looks like a mistake to whoever receives it, and the signature ends up
// on a page with no invoice on it.
//
// ── why SCALE rather than tightening the layout ───────────────────────────
// The obvious alternative is to reclaim whitespace — the Buyer cell is tall
// and mostly empty, Vessel and Payment Terms are empty rows with fixed mm
// heights. But invoicePdf.js exists specifically to reproduce her old
// PythonAnywhere invoice "layout exactly", and those fixed heights ARE the
// layout. Shrinking them changes the look of every invoice she has ever sent,
// to fix a document that is only 8% too tall.
//
// Scaling changes nothing about the design. Everything keeps its proportions
// and relative position; the whole sheet is simply rendered slightly smaller,
// the way a photocopier fits an oversized original.
//
// ── why MEASURE rather than pick a number ─────────────────────────────────
// A fixed scale like 0.92 would fix this invoice and break the next one. The
// height depends on the item count — every extra line adds a row to the item
// table AND a row to the packing list. So the height is measured in the real
// browser after layout, and the scale is derived from it. Four items or
// fourteen, it fits.
//
// ── the floor, and why it is not "always" ─────────────────────────────────
// There is a limit past which "one page" stops being a service. A twenty-item
// invoice scaled to fit A4 would be about 5pt type — legally a document,
// practically unreadable, and worse for her than two clean pages. So the
// scale has a floor. Below it, the document is allowed to run to a second page
// and a warning is logged naming the invoice, so it is visible rather than
// silent. In the normal case — the case in her actual PDF — this never
// triggers.
//
// Deliberately NOT using puppeteer's `pageRanges: '1'` to force the issue:
// that does not make a document fit, it truncates it. On a commercial invoice
// the thing hanging off the bottom edge is the authorised signature, and
// silently cutting that off is far worse than a second page.

// CSS pixels per millimetre at the 96dpi CSS reference resolution that
// Chrome's print pipeline uses.
const PX_PER_MM = 96 / 25.4;

// Below this the type stops being readable at A4. Chosen so a typical
// 4-6 item invoice (which needs ~0.90) has plenty of headroom, while a
// 20-item one is not silently rendered at 5pt.
const MIN_SCALE = 0.62;

// Shave a hair off the computed scale. Chrome's layout height and its print
// pagination do not agree to the last fraction of a pixel, and a document
// measured at exactly one page high can still spill a 1px second page —
// which is precisely the failure being fixed here.
const SAFETY = 0.995;

// Reads the laid-out height of the document, in CSS px. Uses the same set of
// properties in the same order as every "get document height" implementation,
// because no single one of them is reliable across box-model edge cases:
// scrollHeight misses some absolutely-positioned overflow, offsetHeight
// misses margin collapse.
async function measureContentPx(page) {
    return page.evaluate(() => {
        const b = document.body;
        const d = document.documentElement;
        return Math.max(
            b.scrollHeight, b.offsetHeight,
            d.clientHeight, d.scrollHeight, d.offsetHeight,
        );
    });
}

// Works out the scale for a page of `pageHeightMm`. Pure arithmetic, exported
// separately so it can be tested without a browser — this sandbox is aarch64
// and cannot launch Chrome, and a rule about money documents should not go
// untested just because the renderer will not run here.
function scaleToFit(contentPx, pageHeightMm) {
    const targetPx = pageHeightMm * PX_PER_MM;
    if (!Number.isFinite(contentPx) || contentPx <= 0) return { scale: 1, fits: true, targetPx };
    if (contentPx <= targetPx) return { scale: 1, fits: true, targetPx };
    const ideal = (targetPx / contentPx) * SAFETY;
    if (ideal < MIN_SCALE) {
        // Too tall to fit legibly. Render at the floor and let it paginate —
        // the caller warns.
        return { scale: MIN_SCALE, fits: false, targetPx, ideal };
    }
    return { scale: ideal, fits: true, targetPx, ideal };
}

// ── centring the scaled sheet ──────────────────────────────────────────────
// Apsara, 2026-08-29, on the first one-page invoice: "this should be center".
//
// She is right, and it is a consequence of how the scaling works. Chrome's
// print scale multiplies every position by the scale factor about the TOP-LEFT
// corner of the paper. So at 0.9 the design keeps its 15mm left margin, the
// sheet shrinks, and every millimetre freed by shrinking piles up on the
// right: ~15mm left against ~26mm right. Nothing is misaligned inside the
// document — the whole document is sitting in the corner of the paper.
//
// The correction is a pure horizontal shift, and it is done with `position:
// relative; left:` for one specific reason: relative positioning moves where a
// box is PAINTED without changing the layout, so it cannot alter where Chrome
// decides to break pages. The one-page behaviour that now works stays exactly
// as it is. A transform or a margin would both feed back into layout.
//
// The arithmetic, with S the scale and W the paper width:
//   the shift is applied before scaling, so it lands at  left x S
//   the freed space is                                   W x (1 - S)
//   half of it on each side means                        left = W(1-S) / 2S
// which puts the rendered left edge at W(1-S)/2 and the right edge at the
// mirror of it. Checked at S=0.9 on a 210mm page: 10.5mm each side.
//
// HORIZONTAL ONLY, deliberately. A vertical shift would push content down into
// the space at the bottom, and vertical overflow is the one kind Chrome
// answers by adding a page — which would undo the entire fix. A document that
// starts at the top of the sheet also simply looks right; a letterhead
// floating in the middle of the page does not.
function centringOffsetPx(pageWidthPx, scale) {
    if (!(scale < 1) || !Number.isFinite(pageWidthPx) || pageWidthPx <= 0) return 0;
    return (pageWidthPx * (1 - scale)) / (2 * scale);
}

// Renders `page` to a one-page PDF where it reasonably can.
//
// `pdfOptions` is passed through to page.pdf() untouched apart from `scale`,
// so every existing option (printBackground, preferCSSPageSize, width) keeps
// working exactly as before.
async function pdfFittedToOnePage(page, pdfOptions = {}, opts = {}) {
    // Two ways to say how tall a page is, because the two documents disagree:
    // the invoice's @page is 210mm x 297mm (real A4), while the proforma's is
    // 816px x 1500px (a custom tall sheet). Converting the proforma's height
    // into millimetres just to convert it back would be a rounding error
    // looking for somewhere to happen.
    const pageHeightMm = opts.pageHeightPx
        ? opts.pageHeightPx / PX_PER_MM
        : (opts.pageHeightMm || 297);
    const label = opts.label || 'document';

    let scale = 1;
    try {
        const contentPx = await measureContentPx(page);
        const r = scaleToFit(contentPx, pageHeightMm);
        scale = r.scale;
        if (!r.fits) {
            console.warn(
                `[PDF] ${label} is too tall to fit one page legibly `
                + `(${Math.round(contentPx)}px of content vs ${Math.round(r.targetPx)}px of page). `
                + `Rendered at the ${MIN_SCALE} floor and allowed to run over rather than shrunk to unreadable or cut off.`,
            );
        } else if (scale < 1) {
            console.log(`[PDF] ${label} scaled to ${scale.toFixed(3)} to fit one page.`);
        }
    } catch (err) {
        // Measuring is an optimisation, not a requirement. If it fails the
        // document still generates, exactly as it did before this existed.
        console.warn(`[PDF] could not measure ${label}, rendering unscaled:`, err.message);
        scale = 1;
    }

    // Chrome rejects a scale outside [0.1, 2] with an exception that would
    // take the whole document down.
    const safe = Math.min(2, Math.max(0.1, scale));

    // Put the shrunken sheet back in the middle of the paper. Only when it was
    // actually scaled — an unscaled document already sits where it was
    // designed to, and nudging it would be a bug, not a fix.
    if (safe < 1) {
        const pageWidthPx = opts.pageWidthPx || (opts.pageWidthMm || 210) * PX_PER_MM;
        const left = centringOffsetPx(pageWidthPx, safe);
        try {
            await page.addStyleTag({ content: `body{position:relative;left:${left.toFixed(2)}px;}` });
        } catch (err) {
            // Centring is cosmetic. A document that is correct but sitting a
            // few millimetres left is still a correct document.
            console.warn(`[PDF] could not centre ${label}:`, err.message);
        }
    }

    return page.pdf({ ...pdfOptions, scale: safe });
}

module.exports = { pdfFittedToOnePage, scaleToFit, centringOffsetPx, measureContentPx, MIN_SCALE, SAFETY, PX_PER_MM };
