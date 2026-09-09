// ── tests/invoice-header.js ────────────────────────────────────────────────
// run: node tests/invoice-header.js
//
// Apsara, 2026-09-09, with two real PDFs attached:
//   "Invoice number is not wrapping"
//   "Invoice description should be Aluminium combo, regular combo as both are there"
//
// BOTH came from one multi-container invoice whose containers carry DIFFERENT
// item codes. That case cannot use the short comma form (260901_RC_26JY100,101
// only works when the prefix is shared), so the number renders as two full
// numbers joined by an underscore: 260901_AL_26JY96_260901_RC_26JY97.
//
// 1. WRAPPING. Measured in headless Chromium against the real template: 230px
//    of text in a 218px cell. It ran through the border and printed over the
//    DATE column. Underscores are not line-break opportunities in CSS, which
//    is why a 33-character "word" never wrapped on its own. Fixed with <wbr>
//    hints per underscore (a break opportunity that adds NO character, so the
//    number still copies out of the PDF as plain text) plus overflow-wrap as
//    the safety net.
//
// 2. DESCRIPTION. The header label was built from lineItems[0] alone, so an
//    invoice half regular combo announced itself as "AL-ALUMINIUM COMBO".
//    On a customs document that is not cosmetic.
//
//    The nastier half: when a description did not match ITEM_CODE_MAP exactly,
//    getItemCode fell back to scanning the Inv No and returning the FIRST code
//    it found — so on this number every unmatched item resolved to AL,
//    silently relabelling the regular combo as aluminium.
const fs = require('fs'), path = require('path');
const R = (p) => path.join(__dirname, '..', p);
const src = fs.readFileSync(R('helpers/invoicePdf.js'), 'utf8');
const grab = (n) => { const i = src.indexOf('function ' + n + '('); let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
// getItemCode's second pass calls deriveItemCodeFromDesc (the keyword rules
// shared with the dashboard), so the sandboxed harness has to be handed it as
// well — otherwise every test in this file dies with a ReferenceError inside
// the eval'd function rather than telling you anything about the labels.
const { ITEM_CODE_MAP, deriveItemCodeFromDesc } = require(R('helpers/invoiceSheet'));
const M = new Function('ITEM_CODE_MAP', 'deriveItemCodeFromDesc',
  grab('getItemCode') + grab('itemLabel') + grab('itemLabels') + '; return {itemLabels};')(ITEM_CODE_MAP, deriveItemCodeFromDesc);

let pass = 0, fail = 0;
const ck = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w);
  ok ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log(`  FAIL  ${l}\n    got:  ${JSON.stringify(g)}\n    want: ${JSON.stringify(w)}`)); };

const INV = '260901_AL_26JY96_260901_RC_26JY97';   // her actual invoice

console.log('\n=== the header lists EVERY material, not just the first ===');
ck('both materials appear, in order',
   M.itemLabels([{ item_desc: 'Aluminium combo' }, { item_desc: 'Regular combo' }], INV),
   'AL-ALUMINIUM COMBO, RC-REGULAR COMBO');
ck('reversed line items follow the invoice, not a fixed order',
   M.itemLabels([{ item_desc: 'Regular combo' }, { item_desc: 'Aluminium combo' }], INV),
   'RC-REGULAR COMBO, AL-ALUMINIUM COMBO');
ck('one material across five containers stays ONE label',
   M.itemLabels([{ item_desc: 'Regular combo' }, { item_desc: 'Regular combo' },
                 { item_desc: 'Regular combo' }, { item_desc: 'Regular combo' }], '260901_RC_26JY95'),
   'RC-REGULAR COMBO');

console.log('\n=== the mislabel trap ===');
// Descriptions that do not match the map must NOT all collapse onto whichever
// code happens to appear first in the Inv No.
ck('unmatched descriptions read ALL codes from the Inv No, not just the first',
   M.itemLabels([{ item_desc: 'misc scrap' }, { item_desc: 'other' }], INV),
   'AL-ALUMINIUM COMBO, RC-REGULAR COMBO');
ck('a matched description is never overridden by the Inv No',
   M.itemLabels([{ item_desc: 'Regular combo' }], INV),
   'RC-REGULAR COMBO');
ck('nothing to go on yields an empty label, not a guess', M.itemLabels([], ''), '');
ck('null-safe', M.itemLabels(null, null), '');

console.log('\n=== the number can wrap ===');
const tpl = fs.readFileSync(R('assets/invoice-classic/template.html'), 'utf8');
const cell = (tpl.match(/<div style="[^"]*">\{\{inv_no\}\}<\/div>/) || [])[0] || '';
ck('the Inv No cell allows a long token to break', /overflow-wrap\s*:\s*anywhere/.test(cell), true);
ck('...and <wbr> hints are inserted per underscore',
   /inv_no:\s*escapeHtml\([^)]*\)\.replace\(\/_\/g,\s*'_<wbr>'\)/.test(src), true);
ck('the hint adds no character to the copied text', '260901_AL_26JY96'.replace(/_/g, '_<wbr>').replace(/<wbr>/g, ''), '260901_AL_26JY96');

console.log('\n=== separate invoice / packing list ===');
// Apsara, 2026-09-09: "Use seprate flag."
// ONE template, three render modes, selected by a body class. A second
// template was rejected deliberately: two copies of this layout is exactly how
// the wrap fix ended up on three files and missing from the fourth.
{
  const t = fs.readFileSync(R('assets/invoice-classic/template.html'), 'utf8');
  ck('the invoice half is wrapped', /class="doc-invoice"/.test(t), true);
  ck('the packing half is wrapped', /class="doc-packing"/.test(t), true);
  ck('the standalone packing list has its own header', /class="pl-header"/.test(t), true);
  ck('only-invoice hides the packing list', /body\.only-invoice \.doc-packing/.test(t), true);
  ck('only-packing hides the invoice', /body\.only-packing \.doc-invoice/.test(t), true);
  ck('the standalone header is hidden by default', /\.pl-header\{display:none;\}/.test(t), true);

  // The mid-document banner carries an INLINE display:flex, so hiding it needs
  // !important or BOTH banners render on the standalone doc. Found by looking
  // at the rendered PDF, not by reading the CSS.
  ck('the duplicate banner is hidden with !important',
     /body\.only-packing \.pl-banner-inline\{display:none !important;\}/.test(t), true);

  // ── the standalone header is a CLONE, not a second hand-written header ──
  // Apsara sent her own separately-created packing list (2026-09-09) as the
  // reference. It carries the FULL invoice header block. My first cut
  // hand-wrote a trimmed version in the template; it dropped Other
  // Reference(s), the buyer address, Terms, Payment Terms and Place of
  // Receipt, and it was a second copy that would drift the first time anyone
  // touched the real header. These assertions run against the ASSEMBLED html,
  // not the raw template, because "the placeholder got substituted in both
  // copies" is the part that actually breaks.
  ck('the template marks the header region for cloning',
     /<!--INV_HEAD_START-->/.test(t) && /<!--INV_HEAD_END-->/.test(t), true);
  ck('the standalone header is a placeholder, not a second copy',
     /\{\{pl_header_rows\}\}/.test(t), true);

  const { buildInvoiceClassicHtml } = require(R('helpers/invoicePdf'));
  const built = buildInvoiceClassicHtml({
    inv_no: INV, inv_date: '2026-09-10',
    consignee_address: ['TAEWON AUTOMOTIVE CO., LTD', '5, YUJEON 2-GIL, GUNBUK-MYEON',
                        'HAMAN-GUN, GYEONGSANGNAMDO', 'KOREA 52062'],
    terms: 'LC', vessel: 'HMM', reference: 'M3928609NU00121',
    place_of_receipt: 'FRISCO', port_loading: 'OAKLAND', port_discharge: 'BUSAN',
    line_items: [
      { item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 23.469, rate: 1000 },
      { item_desc: 'Regular combo', container_no: 'HMMU6904319', weight: 23.678, rate: 1000 },
    ],
  }).html;
  const head = built.slice(built.indexOf('class="pl-header"'),
                           built.indexOf('<div class="doc-packing"'));
  ck('the clone actually rendered (not an empty block)', head.length > 1500, true);
  ck('no placeholder survived into the clone', /\{\{/.test(head), false);

  // Every field her own packing list carries.
  for (const [label, needle] of [
    ['Exporter',                  'EDGE METALS INC'],
    ['the exporter FAX line',     'FAX: (425) 940-9408'],
    ['Invoice No & Items',        'Invoice No &amp; Items'],
    ['the invoice number',        '26JY96'],
    ['the item label',            'ALUMINIUM COMBO'],
    ['DATE',                      '09/10/2026'],
    ['Other Reference(s)',        'Other Reference(s)'],
    ['the booking reference',     'M3928609NU00121'],
    ['the buyer name',            'TAEWON AUTOMOTIVE'],
    ['the buyer address',         'HAMAN-GUN'],
    ['Terms',                     '>Terms<'],
    ['Vessel / Flight No',        'Vessel / Flight No'],
    ['Payment Terms',             'Payment Terms'],
    ['Country of Origin',         'Country of Origin'],
    ['Place of Receipt by Carrier', 'Place of Receipt by Carrier'],
    ['Port of Loading',           'OAKLAND'],
    ['Port of Discharge',         'BUSAN'],
  ]) ck(`the standalone header carries ${label}`, head.includes(needle), true);

  // ...and still no money on it. The item table with Rate/Amount lives in
  // .doc-invoice, which only-packing hides; nothing price-shaped may leak into
  // the header block itself.
  ck('the standalone header carries NO rate column', /US\$\/MT/.test(head), false);
  ck('...no amount column', /Amount/i.test(head), false);
  ck('...no invoice total', /final_amount|TOTAL/.test(head), false);

  // Apsara, 2026-09-09: "packing list separate colour should not contain blue".
  // The header is a clone of the INVOICE header, so it arrives wearing the
  // invoice palette. Standing alone it is the orange document.
  ck('the standalone packing header is repainted orange',
     /\.pl-header \.lbl\{background:var\(--light-orange\);\}/.test(t), true);
  ck('...and the override is scoped so the combined sheet keeps its blue',
     /body\.only-packing \.lbl/.test(t), false);

  // The declaration has to change with the document. "This invoice shows the
  // actual price of the goods" on a page with no prices is wrong, and wrong on
  // a customs document is the kind that gets questioned.
  ck('the invoice declaration is the default', /class="decl-invoice"/.test(t), true);
  ck('the packing list has its own declaration',
     /class="decl-packing">We declare that this packing list is true and correct/.test(t), true);
  ck('...hidden unless the packing list stands alone',
     /\.decl-packing\{display:none;\}/.test(t) && /body\.only-packing \.decl-invoice\{display:none;\}/.test(t), true);

  const pdfSrc = fs.readFileSync(R('helpers/invoicePdf.js'), 'utf8');
  ck('combined stays the DEFAULT — no flag, no change', /if \(!opts\.separate\)/.test(pdfSrc), true);
  ck('separate returns both buffers', /return \{ invoice, packing \}/.test(pdfSrc), true);
  ck('one browser launch for both documents', (pdfSrc.match(/puppeteer\.launch/g) || []).length, 1);

  const apiSrc = fs.readFileSync(R('api.js'), 'utf8');
  ck('the API reads the flag', /body\.separate === true/.test(apiSrc), true);
  ck('...and names the files the way her old tool did',
     /_INVOICE\.pdf/.test(apiSrc) && /_PACKING_LIST\.pdf/.test(apiSrc), true);

  const dash = fs.readFileSync(R('dashboard/documents.html'), 'utf8');
  ck('the dashboard offers the checkbox', /id="inv_separate"/.test(dash), true);
  // Apsara, 2026-09-09: "Separate flag not coming" — she was on the SHIPMENT
  // PICKER (Step 2), where the flag did not exist; it only lived on the Step 3
  // review screen. The batch flow steps through Step 3 once per group, so a
  // per-review-only checkbox would have to be re-ticked for every container.
  ck('...on the batch bar too, not only the review screen',
     /id="inv_separate_bulk"/.test(dash), true);
  ck('...and the two are kept in sync', /function syncInvSeparate\(/.test(dash), true);
  ck('...and generate reads EITHER of them',
     /sepEl && sepEl\.checked\) \|\| \(sepBulkEl && sepBulkEl\.checked/.test(dash), true);
  ck('...and downloads both files', /saved_filenames/.test(dash), true);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
