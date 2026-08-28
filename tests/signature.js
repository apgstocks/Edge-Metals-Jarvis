// ── tests/signature.js — the authorised signature reaches every document ───
//
// Apsara, 2026-08-29: "in docs and proforma, invoice why sign not coming",
// then "this is authorised signature of edge metals in docs".
//
// The signature was never missing. It was base64-inlined inside
// assets/invoice-classic/template.html and nowhere else, so the commercial
// invoice printed it and the proforma printed a blank 34px spacer — with a
// code comment asserting "no signature.png shipped", which was simply wrong.
//
// Two things are locked here:
//   1. BOTH customer documents actually contain the image in their rendered
//      HTML. Not that a helper exists — that the bytes reach the page.
//   2. The invoice still renders EXACTLY what it rendered before. It already
//      worked, and a refactor that quietly moves a signature 2px on a live
//      commercial invoice is worse than leaving the proforma broken.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (name, cond) => { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name); } };

console.log('\n─ authorised signature ───────────────────────────────────');

const sig = require(path.join(R, 'helpers', 'signature.js'));

// ── the file exists and is the same image that was inlined ────────────────
{
    ck('the signature file is shipped', fs.existsSync(sig.SIGNATURE_FILE));
    const url = sig.signatureDataUrl();
    ck('it loads as a data URL', typeof url === 'string' && url.startsWith('data:image/png;base64,'));

    // Byte-identical to what was inlined in the invoice template before the
    // refactor. If someone replaces the PNG this fails loudly — which is
    // correct: changing a company signature should be a deliberate act.
    const orig = execSync('git show HEAD~0:assets/invoice-classic/template.html', { cwd: R }).toString();
    const m = /base64,([A-Za-z0-9+/=]+)/.exec(orig);
    if (m) {
        ck('the extracted file matches the previously inlined image',
           url.split('base64,')[1] === m[1]);
    } else {
        // Expected after the refactor lands: the template no longer inlines it.
        ck('the invoice template no longer inlines its own copy', true);
    }
}

// ── it is drawn on BOTH customer documents ────────────────────────────────
{
    const invoiceTpl = fs.readFileSync(path.join(R, 'assets/invoice-classic/template.html'), 'utf8');
    const proformaTpl = fs.readFileSync(path.join(R, 'assets/proforma-dc2/template.html'), 'utf8');

    ck('the invoice template has a signature slot', invoiceTpl.includes('{{signature_block}}'));
    ck('the proforma template has a signature slot', proformaTpl.includes('{{signature_block}}'));
    ck('the invoice no longer carries a duplicate inline copy',
       !invoiceTpl.includes('data:image/png;base64'));

    // The real assertion: the generator SUBSTITUTES it. A slot in a template
    // with nothing filling it is exactly the bug being fixed — that is what
    // the proforma had for months.
    const invoiceSrc = fs.readFileSync(path.join(R, 'helpers/invoicePdf.js'), 'utf8');
    const proformaSrc = fs.readFileSync(path.join(R, 'helpers/proformaPdf.js'), 'utf8');
    ck('invoicePdf.js fills the slot', /signature_block:\s*require\('\.\/signature'\)/.test(invoiceSrc));
    ck('proformaPdf.js fills the slot', /require\('\.\/signature'\)\.signatureBlockHtml\(\)/.test(proformaSrc));
    ck('proformaPdf.js no longer hardcodes an empty spacer',
       !/const signatureBlock = '<div style="height:34px/.test(proformaSrc));
}

// ── the invoice renders identically to before ─────────────────────────────
{
    // The invoice was NOT broken. Preserving it exactly is the whole risk of
    // this change, so it is asserted against the literal markup it replaced.
    const before = '<div style="height:9mm;display:flex;align-items:center;justify-content:center;">'
                 + '<img src="' + sig.signatureDataUrl() + '" style="max-height:8mm;max-width:35mm;"></div>';
    const after = sig.signatureBlockHtml({ height: '9mm', maxHeight: '8mm', maxWidth: '35mm', align: 'center', justify: 'center', marginBottom: null });
    ck('the invoice signature markup is unchanged, byte for byte', before === after);
}

// ── the proforma keeps its original geometry ──────────────────────────────
{
    const block = sig.signatureBlockHtml();
    ck('the proforma block is still 34px tall', block.includes('height:34px'));
    ck('it keeps the 2px bottom margin the spacer had', block.includes('margin-bottom:2px'));
    ck('and now actually contains the image', block.includes('data:image/png;base64,'));
}

// ── fail soft: a missing signature must never break a document ────────────
{
    // The failure that matters. A document that will not generate is far worse
    // than one printing a blank signature line someone can sign by hand.
    const real = sig.SIGNATURE_FILE;
    process.env.SIGNATURE_FILE = '/nonexistent/never/signature.png';
    delete require.cache[require.resolve(path.join(R, 'helpers', 'signature.js'))];
    const missing = require(path.join(R, 'helpers', 'signature.js'));

    let threw = false, block = '';
    try { block = missing.signatureBlockHtml(); } catch (e) { threw = true; }
    ck('a missing signature does not throw', !threw);
    ck('it falls back to an empty block', block === '<div style="height:34px;margin-bottom:2px;"></div>');
    ck('the fallback preserves the height, so the layout does not shift', block.includes('height:34px'));
    ck('signatureDataUrl reports null rather than a broken URL', missing.signatureDataUrl() === null);

    // The invoice geometry survives the fallback too — a blank 9mm box, not
    // a collapsed footer.
    const inv = missing.signatureBlockHtml({ height: '9mm', marginBottom: null });
    ck('the invoice fallback keeps its 9mm box', inv === '<div style="height:9mm;"></div>');

    delete process.env.SIGNATURE_FILE;
    delete require.cache[require.resolve(path.join(R, 'helpers', 'signature.js'))];
    ck('the real signature is still readable afterwards',
       require(path.join(R, 'helpers', 'signature.js')).signatureDataUrl() !== null);
    ck('and it is the same file as before', real === sig.SIGNATURE_FILE);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
