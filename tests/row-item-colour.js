// ── tests/row-item-colour.js ──────────────────────────────────────────────
// Apsara, 2026-09-24, with a mock of "Al combo, Regular Combo" rendered three
// ways — first word red, neither red, second word red: "just replicate the
// colour exactly in invoice and packing lsit".
//
// ── AND HOW THE FIRST VERSION OF THIS WAS WRONG ───────────────────────────
// It read every ROW on the document, listed the distinct materials across
// them, and reddened the one matching that row's container. Every check
// passed. It also never fired on a single real document, which she found by
// sending the PDFs: "Description looks ugly".
//
// 260901_AL_26JY99 is ONE container, ONE row, and the description she typed
// is a single string — "Al combo,Regular Combo". Both materials are in the
// one box, in the one field. Her mock was never two containers: it was the AL
// invoice and the RC invoice of the SAME shipment, which is why one word is
// red in each and the middle line is what the document prints today.
//
// So: the split is on the COMMA inside one description, and the invoice
// number's item code decides the red. The fixtures below are her actual
// document, not an invented one — that is the whole lesson.
//
// ── WHAT THIS PINS ────────────────────────────────────────────────────────
//
//   1. THE COLOUR, EXACTLY. #EA3323, sampled from the solid glyph fill of her
//      mock. "Replicate the colour exactly" is the whole request, so a test
//      that accepted any red would be testing nothing she asked for.
//
//   2. THE RIGHT WORD IS RED. Reddening the wrong material on a customer's
//      invoice is worse than reddening none: it states that a container holds
//      goods it does not.
//
//   3. A ONE-MATERIAL DESCRIPTION IS UNTOUCHED. My call, recorded as mine in
//      helpers/invoicePdf.js. No comma, no split, no red, no reflow — which
//      covers every single-material invoice she has ever sent AND the
//      2026-09-16 packing list whose rows are one material each.
//
//   5. THE WRAPPING. "Description looks ugly" was the literal complaint: it
//      printed as "Al / combo,Regular / Combo" over three ragged lines,
//      because she types no space after the comma so "combo,Regular" was one
//      unbreakable token. Each material now gets its own line.
//
//   4. THE TWO DOCUMENTS AGREE. The invoice's Description column and the
//      packing list's Item column go through one helper, because two copies
//      of a rule is how they drift.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const ck = (n, c, extra) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; failures.push(n); console.log('  FAIL  ' + n); if (extra) console.log('        ' + extra); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rowcolour-'));
process.env.JARVIS_TEST = '1';

const ROOT = path.join(__dirname, '..');
const { buildInvoiceClassicHtml: buildRaw } = require(path.join(ROOT, 'helpers/invoicePdf'));
// It returns { html, subtotal, notes, finalAmount }, not a bare string.
// String(obj) is "[object Object]", against which every NEGATIVE check in
// this file passes vacuously — which is exactly what the first run did until
// the "cells.length >= 2" guard caught it.
const buildInvoiceClassicHtml = async (d) => {
    const r = await buildRaw(d);
    const html = (r && typeof r === 'object') ? r.html : r;
    if (typeof html !== 'string' || html.length < 200) {
        throw new Error('buildInvoiceClassicHtml returned no html — every check below would be meaningless');
    }
    return html;
};

// Sampled from her mock: the solid glyph fill, 1,284 px of it. Written as a
// literal rather than imported so that changing the constant in the source
// without meaning to turns this red.
const RED = '#EA3323';

const doc = (invNo, desc) => ({
    inv_no: invNo, inv_date: '2026-09-28', consignee: 'TAEWON AUTOMOTIVE CO., LTD',
    booking_no: 'DALA25048200',
    line_items: [{
        item_desc: desc, container_no: 'GOAU6226932', seal_no: '0009497',
        weight: 22.979, rate: 1015, amount: 23323.68, net_weight_lbs: 50660,
    }],
});

// The Description / Item cells, in document order. Anchored on the real cell
// style so the header's own label (which also names the material) cannot be
// mistaken for a row.
const cells = (html) => (html.match(/<td style="padding:1mm;font-size:(?:10|9\.5)pt[^"]*">(?:(?!<\/td>)[\s\S])*?[Cc]ombo(?:(?!<\/td>)[\s\S])*?<\/td>/g) || [])
    .map((c) => c.replace(/<td[^>]*>/, '').replace(/<\/td>/, '').trim());

(async () => {

// Exactly what she typed into 260901_AL_26JY99: no space after the comma.
const DESC = 'Al combo,Regular Combo';

// ══════════════════════════════════════════════════════════════════════════
section('A — her actual invoice, 260901_AL_26JY99');
// ══════════════════════════════════════════════════════════════════════════
{
    const html = await buildInvoiceClassicHtml(doc('260901_AL_26JY99', DESC));
    const c = cells(html);
    ck('the document has Description cells', c.length >= 1, String(c.length));

    // The AL invoice reddens Al combo. Her mock, line one.
    ck('the AL invoice reddens Al combo',
       c[0] === `<span style="color:${RED};">Al combo</span>,<br>Regular Combo`, c[0]);
    ck('  and leaves Regular Combo black', !/color:[^"]*">Regular Combo/.test(c[0]), c[0]);
    ck('the colour is exactly #EA3323', html.includes(RED));

    // Both documents: the invoice's Description column and the packing list's
    // Item column run through one helper.
    ck('the packing list carries it too', c.length >= 2 && c[1] === c[0], c.join(' || '));
}

// ══════════════════════════════════════════════════════════════════════════
section('B — the RC invoice of the same shipment');
// ══════════════════════════════════════════════════════════════════════════
// Her mock, line three. Same container, same description, different number.
{
    const html = await buildInvoiceClassicHtml(doc('260901_RC_26JY99', DESC));
    const c = cells(html);
    ck('the RC invoice reddens Regular Combo',
       c[0] === `Al combo,<br><span style="color:${RED};">Regular Combo</span>`, c[0]);
    ck('  and leaves Al combo black', !/color:[^"]*">Al combo/.test(c[0]), c[0]);
}

// ══════════════════════════════════════════════════════════════════════════
section('C — "Description looks ugly": the wrapping');
// ══════════════════════════════════════════════════════════════════════════
// It printed "Al / combo,Regular / Combo" — three ragged lines, because she
// types no space after the comma so "combo,Regular" was one token the browser
// could not break, forcing the break back onto "Al".
{
    const html = await buildInvoiceClassicHtml(doc('260901_AL_26JY99', DESC));
    const c = cells(html)[0];
    ck('each material gets its own line', c.includes(',<br>'), c);
    ck('  so "combo,Regular" never appears as one token', !/combo,Regular/.test(c), c);
    ck('  and the break is AFTER the comma, not before it', !/<br>,/.test(c), c);
}

// ══════════════════════════════════════════════════════════════════════════
section('D — one material: nothing changes at all');
// ══════════════════════════════════════════════════════════════════════════
// No comma, no split, no red, no reflow. This is every single-material
// invoice she has ever sent, and the 2026-09-16 packing list whose rows are
// one material each.
{
    const html = await buildInvoiceClassicHtml(doc('260901_AL_26JY99', 'Al combo'));
    const c = cells(html);
    ck('no red', !html.includes(RED));
    ck('  no line break inserted', !c[0].includes('<br>'), c[0]);
    ck('  the cell is just the name', c[0] === 'Al combo', c[0]);
}

// ══════════════════════════════════════════════════════════════════════════
section('E — the edges');
// ══════════════════════════════════════════════════════════════════════════
{
    // A number whose code matches NEITHER part: no red rather than a guess.
    // Reddening the wrong material states that a box holds goods it does not.
    const h1 = await buildInvoiceClassicHtml(doc('PLAIN-1234', DESC));
    ck('an invoice number with no item code reddens nothing', !h1.includes(RED),
       (cells(h1)[0] || ''));
    ck('  but still puts each material on its own line', cells(h1)[0].includes(',<br>'),
       cells(h1)[0]);

    // Spacing she may or may not type — both forms behave identically.
    const h2 = await buildInvoiceClassicHtml(doc('260901_AL_26JY99', 'Al combo, Regular Combo'));
    ck('a space after the comma changes nothing',
       cells(h2)[0] === `<span style="color:${RED};">Al combo</span>,<br>Regular Combo`, cells(h2)[0]);

    // Three materials in the one description.
    const h3 = await buildInvoiceClassicHtml(doc('260901_AL_26JY99', 'Al combo,Regular Combo,Zorba'));
    const c3 = cells(h3)[0];
    ck('three materials each get a line', (c3.match(/<br>/g) || []).length === 2, c3);
    ck('  and exactly one is red', (c3.match(new RegExp(RED, 'g')) || []).length === 1, c3);

    // A trailing comma must not produce an empty line.
    const h4 = await buildInvoiceClassicHtml(doc('260901_AL_26JY99', 'Al combo,'));
    ck('a trailing comma is not a second material', !h4.includes('<br>')
       || !cells(h4)[0].endsWith('<br>'), cells(h4)[0]);

    // Escaped — the helper returns HTML.
    const h5 = await buildInvoiceClassicHtml(doc('260901_AL_26JY99', '<b>Al combo</b>,Regular Combo'));
    ck('the red part is escaped',
       h5.includes(`<span style="color:${RED};">&lt;b&gt;Al combo&lt;/b&gt;</span>`)
       || h5.includes('&lt;b&gt;Al combo&lt;/b&gt;'), 'an unescaped tag would render as markup');
    ck('  and no raw tag reaches the document', !h5.includes('<b>Al combo</b>'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  FAILED:\n' + failures.map((f) => '    - ' + f).join('\n')); process.exit(1); }

})().catch((e) => { console.error(e); process.exit(1); });
