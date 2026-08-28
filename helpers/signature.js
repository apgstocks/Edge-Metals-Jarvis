// ── helpers/signature.js — the Edge Metals authorised signature ────────────
//
// Per Apsara 2026-08-29: "in docs and proforma, invoice why sign not coming",
// then "this is authorised signature of edge metals in docs".
//
// It was not missing. It was in ONE place and only one: base64-inlined in the
// middle of assets/invoice-classic/template.html. So the commercial invoice
// had it and the proforma did not, because proformaPdf.js had this line:
//
//     const signatureBlock = '<div style="height:34px..."></div>';
//         // no signature.png shipped
//
// The comment was written when nobody had looked inside the invoice template.
// The image had been sitting in the repo the whole time, 280x89, in a data
// URL so long it never showed up in a grep for "signature".
//
// That is the actual bug, and it is a structural one rather than a missing
// asset: an image pasted inline into one template cannot be reused by a
// second one. This module makes it a real file (assets/shared/signature.png,
// byte-identical to what was inlined) with a single loader, so every document
// draws the same signature and adding it to a new document is one call.
//
// FAIL SOFT. A missing or unreadable file returns an empty block of the same
// height, which is exactly what the proforma rendered before. A document that
// fails to generate because a signature could not be read would be a far worse
// outcome than one that prints with a blank signature line — the operator can
// see a blank line and sign it by hand; they cannot rescue a PDF that never
// rendered.

const fs = require('fs');
const path = require('path');

const SIGNATURE_FILE = process.env.SIGNATURE_FILE
    || path.join(__dirname, '..', 'assets', 'shared', 'signature.png');

// Read once. These documents are generated in a loop over containers, and
// re-reading and re-base64ing a 22KB PNG per page is pure waste. `undefined`
// means "not yet looked"; `null` means "looked, and it is not there" — the
// distinction matters or a missing file gets re-stat'd on every render.
let _cache;

// The signature as a data URL, or null. Data URL rather than a file:// path
// because these templates are rendered by puppeteer from an HTML string with
// no base directory — a relative <img src> would silently resolve to nothing
// and print a broken-image icon on a customer's invoice.
function signatureDataUrl() {
    if (_cache !== undefined) return _cache;
    try {
        _cache = `data:image/png;base64,${fs.readFileSync(SIGNATURE_FILE).toString('base64')}`;
    } catch (err) {
        console.warn(`[SIGNATURE] not available (${SIGNATURE_FILE}): ${err.message} — documents will print an empty signature line`);
        _cache = null;
    }
    return _cache;
}

// The HTML block that sits directly above a printed "Authorised Signature"
// rule. Height is fixed whether or not the image loads, so the signature line
// never moves up the page and the layout of a document is identical either
// way — a shifting footer between two invoices of the same batch looks like a
// forgery risk, not a rendering quirk.
//
// `height` is the block; `maxHeight`/`maxWidth` constrain the image inside it.
// Defaults match the proforma's existing 34px spacer.
//
// `align`/`justify`/`marginBottom` exist so the COMMERCIAL INVOICE renders
// byte-for-byte what it rendered before this refactor. Its signature was
// centred in a 9mm box with no bottom margin; the proforma's placeholder was
// bottom-aligned with a 2px margin. Collapsing the two into one "sensible
// default" would have silently nudged the signature on a document that
// already goes to customers — the kind of change nobody notices until an
// invoice looks subtly different from last month's.
function signatureBlockHtml(opts = {}) {
    const height = opts.height || '34px';
    const maxHeight = opts.maxHeight || '30px';
    const maxWidth = opts.maxWidth || '150px';
    const align = opts.align || 'flex-end';
    const justify = opts.justify || 'flex-start';
    const mb = opts.marginBottom === undefined ? 'margin-bottom:2px;' : (opts.marginBottom ? `margin-bottom:${opts.marginBottom};` : '');
    const url = signatureDataUrl();
    if (!url) return `<div style="height:${height};${mb}"></div>`;
    return `<div style="height:${height};${mb}display:flex;align-items:${align};justify-content:${justify};">`
         + `<img src="${url}" style="max-height:${maxHeight};max-width:${maxWidth};"></div>`;
}

// Tests only — lets a suite prove the fail-soft path without deleting the file.
function _resetCache() { _cache = undefined; }

module.exports = { signatureDataUrl, signatureBlockHtml, SIGNATURE_FILE, _resetCache };
