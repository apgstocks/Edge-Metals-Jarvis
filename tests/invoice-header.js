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
const { ITEM_CODE_MAP } = require(R('helpers/invoiceSheet'));
const M = new Function('ITEM_CODE_MAP', grab('getItemCode') + grab('itemLabel') + grab('itemLabels') + '; return {itemLabels};')(ITEM_CODE_MAP);

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

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
