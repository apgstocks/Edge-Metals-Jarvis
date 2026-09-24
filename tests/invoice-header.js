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
// Behaviour, not source shape — asserted on the ASSEMBLED html, so this does
// not fail again the next time the substitution is rewritten.
// 2026-09-10: commas too. The mixed-material number separates whole numbers
// with one ("260901_AL_26JY96,260901_RC_26JY97"), and a comma is no more a
// break opportunity in CSS than an underscore is, so without a hint there the
// preferred break lands mid-number instead of between the two numbers.
{
  const { buildInvoiceClassicHtml: build } = require(R('helpers/invoicePdf'));
  const cellOf = (n) => (build({ inv_no: n, line_items: [{ item_desc: 'Aluminium combo' }] }).html
    .match(/overflow-wrap:anywhere;word-wrap:break-word;">([\s\S]*?)<\/div>/) || [])[1] || '';
  ck('...and <wbr> hints are inserted per underscore',
     cellOf('260901_AL_26JY96'), '260901_<wbr>AL_<wbr>26JY96');
  ck('...and per comma, between whole numbers',
     cellOf('260901_AL_26JY96,260901_RC_26JY97'),
     '260901_<wbr>AL_<wbr>26JY96,<wbr>260901_<wbr>RC_<wbr>26JY97');
  ck('the hint adds no character to the copied text',
     cellOf('260901_AL_26JY96,260901_RC_26JY97').replace(/<wbr>/g, ''),
     '260901_AL_26JY96,260901_RC_26JY97');
}

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
  ck('the template still marks the invoice header region',
     /<!--INV_HEAD_START-->/.test(t) && /<!--INV_HEAD_END-->/.test(t), true);

  const { buildInvoiceClassicHtml } = require(R('helpers/invoicePdf'));
  // ── packing_compact: THIS IS THE PACKING LIST TAB'S DOCUMENT ──────────
  // Apsara, 2026-09-17: "my separate packing list tab needs to have only that
  // while my invoice tab's packing list need to have gross,tare,container,
  // boxes like last time". Two documents now, and this section is about the
  // compact one — the checks below were written when there was only one and
  // would otherwise be asserting the compact shape against the invoice's.
  const built = buildInvoiceClassicHtml({
    packing_compact: true,
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

  // ── WHAT THE COMPACT HEADER CARRIES ─────────────────────────────────
  // Apsara, 2026-09-16, on the document as it stood: "I dont want this much
  // big packing list", then "I dont want terms,vessel,payment terms..", then
  // "Build B".
  //
  // This block used to assert the CLONE — every field of the invoice header,
  // because on 2026-09-09 she sent her own separately-made packing list as the
  // reference and it carried them all. Ten of those assertions now fail, and
  // every one of them is a rule she has since overruled rather than a
  // regression. The clone was about half an A4 page; eight bundle weights
  // needed a second sheet under it.
  //
  // WHAT IT MUST STILL CARRY is everything that says which shipment this is.
  // A packing list that has lost the buyer or the container is a grid of
  // numbers a broker cannot file, and that failure looks tidy.
  for (const [label, needle] of [
    ['the exporter',        'EDGE METALS INC'],
    ['the exporter address','14750 DEVONSHIRE LN'],
    ['the invoice number',  '26JY96'],
    ['the date',            '09/10/2026'],
    ['the buyer name',      'TAEWON AUTOMOTIVE'],
    ['the buyer address',   'HAMAN-GUN'],
  ]) ck(`the standalone header carries ${label}`, head.includes(needle), true);

  // ── THE COLOUR ───────────────────────────────────────────────────────
  // Apsara, 2026-09-16: "Fill the packing list colour."
  //
  // The first compact header printed orange TYPE on white with a rule under
  // it. Every other document this company sends opens with a solid bar — the
  // invoice's, and this one's own before the rebuild — so beside them it read
  // as an unfinished draft rather than as the same company's paperwork.
  //
  // Checked because a fill is exactly the kind of thing a later layout change
  // drops without anything failing, which is how it went missing this time.
  ck('the banner is FILLED, not just coloured type',
     /background:var\(--orange\)/.test(head), true);
  ck('  with the invoice number inside it, costing no extra height',
     head.indexOf('background:var(--orange)') < head.indexOf('26JY96'), true);
  ck('  and the exporter and buyer strips are tinted to match',
     (head.match(/background:var\(--light-orange\)/g) || []).length, 2);
  // Orange, never blue: the invoice header is the blue document and this is a
  // clone of its VALUES, not of its palette (2026-09-09, "packing list
  // separate colour should not contain blue").
  ck('  and nothing in it is blue', /light-blue/.test(head), false);

  // ── AND WHAT IT MUST NOT ────────────────────────────────────────────
  // Her three, by name. Two of them printed EMPTY on her own documents,
  // which is how a header grows without anyone deciding it should.
  for (const gone of ['Terms', 'Vessel', 'Payment Terms'])
    ck(`  and not ${gone}`, new RegExp(gone, 'i').test(head), false);

  // The shipment's own references survive, on one line instead of in five
  // boxes — a packing list with no container or booking on it cannot be
  // matched to the shipment it describes.
  {
    const { html: h4 } = require(R('helpers/invoicePdf')).buildInvoiceClassicHtml({
      packing_compact: true,
      inv_no: INV, inv_date: '2026-09-10', container_no: 'KOCU5139886',
      booking_no: 'M3928609NU00121', seal_no: '40217',
      port_loading: 'OAKLAND', port_discharge: 'BUSAN', country_of_origin: 'USA',
      terms: 'LC', vessel: 'HMM',
      line_items: [{ item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 23.469, rate: 1000 }],
    });
    const head4 = h4.slice(h4.indexOf('class="pl-header"'), h4.indexOf('<div class="doc-packing"'));
    for (const [label, needle] of [['the booking', 'M3928609NU00121'], ['the seal', '40217'],
                                   ['the load port', 'OAKLAND'], ['the discharge port', 'BUSAN'],
                                   ['the origin', 'USA']])
      ck(`  the reference line carries ${label}`, head4.includes(needle), true);
    ck('  and still refuses Terms and Vessel', /Terms|Vessel/i.test(head4), false);

    // A blank field prints NOTHING, not a label with nothing after it.
    const { html: h5 } = require(R('helpers/invoicePdf')).buildInvoiceClassicHtml({
      packing_compact: true,
      inv_no: INV, container_no: 'KOCU5139886',
      line_items: [{ item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 1, rate: 1 }],
    });
    const head5 = h5.slice(h5.indexOf('class="pl-header"'), h5.indexOf('<div class="doc-packing"'));
    ck('  a shipment with no booking or seal prints no empty labels',
       /Booking|Seal|Origin/.test(head5), false);
    ck('  and no placeholder survives either', /\{\{/.test(head5), false);
  }

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

// Everything below needs `await`, and this file is a plain CommonJS script —
// top-level await is a SyntaxError here, not a slow test. One async wrapper
// around the asynchronous sections, with the summary inside it so the exit
// code cannot be printed before the checks have run.
(async () => {

console.log('\n=== the packing list names what is in the container ===');
// Apsara, 2026-09-16: "why item description missing in packing list of invoice
// tab in docs?"
//
// Because the Item column was built for the packing-list screen and waited on
// ITS checkbox, which the invoice path never sets — while her invoice line
// items have carried item_desc since this template was written. The packing
// list beside a commercial invoice printed a container number and four weights
// and did not say what was in the box.
{
  const { buildInvoiceClassicHtml: build2 } = require(R('helpers/invoicePdf'));
  const { html: h } = build2({
    inv_no: INV, container_no: 'KOCU5139886',
    line_items: [
      { item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 23.469, rate: 1000,
        packing: { gross_weight_lbs: '56,000', tare_lbs: '4,265', net_weight_lbs: '51,735', net_weight_mt: '23.469' } },
      { item_desc: 'Regular combo', container_no: 'HMMU6904319', weight: 23.678, rate: 1000,
        packing: { gross_weight_lbs: '56,500', tare_lbs: '4,300', net_weight_lbs: '52,200', net_weight_mt: '23.678' } },
    ],
  });
  const d = h.slice(h.indexOf('<div class="doc-packing">'));
  const tbl = d.slice(d.indexOf('<table'), d.indexOf('</table>'));
  const rows = [...tbl.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map((m) =>
      [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
          .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));

  ck('the packing table has an Item column', /Item/.test(rows[0][1]), true);
  // ── THIS ASSERTION WAS RIGHT ALL ALONG ───────────────────────────────
  // On 2026-09-24 I rewrote it to expect "Aluminium combo, Regular combo" in
  // BOTH rows with one reddened, on the theory that her red-highlight request
  // listed every material on every row of a multi-container invoice. It did
  // not. Her real document (260901_AL_26JY99) is ONE container whose single
  // description field reads "Al combo,Regular Combo" — the split is on the
  // COMMA inside one description, and the invoice number's code picks the
  // red. See helpers/invoicePdf.js rowItemsHtml and tests/row-item-colour.js.
  //
  // This fixture's two rows each carry ONE material, so nothing splits and
  // nothing reddens: the Item column says what is in each container, exactly
  // as it did before. Restored to its original form, with the detour recorded
  // so nobody re-derives the same wrong rule from the same mock.
  ck('...naming each container', [rows[1][1], rows[2][1]], ['Aluminium combo', 'Regular combo']);
  // ── AND THE INVOICE'S OWN SHAPE IS BACK ──────────────────────────────
  // Apsara, 2026-09-17: "my invoice tab's packing list need to have
  // gross,tare,container,boxes like last time". The tare is BROKEN OUT here
  // — truck, container tare, chassis, boxes — which is the working that
  // justifies the net and what her broker has always received. Collapsing it
  // to one Tare column was my over-reach on 2026-09-16, applied from a
  // message about a different screen.
  ck('...and the tare broken into its four columns',
     rows[0].slice(3, 7).map((h) => h.replace(/\s*\(lbs\)/, '')),
     ['Truck', 'Container Tare', 'Chassis', 'Boxes']);
  // COUNTED. A TOTAL row with the wrong number of cells does not error, it
  // SHEARS — the figures slide one column left and print under the wrong
  // headings, on the document a customer checks with a calculator.
  ck('...and every row still has the same cell count',
     new Set(rows.map((r) => r.length)).size, 1);
  ck('...nine of them', rows[0].length, 9);
  // COUNTED, not eyeballed: a TOTAL row with the wrong cell count does not
  // error, it SHEARS — every figure slides one column left and prints under
  // the wrong heading, and this table just grew four columns.
  const col = (name) => rows[0].findIndex((h) => h.replace(/\s+/g, ' ').startsWith(name));
  ck('the TOTAL row carries gross and net',
     [rows[3][0], rows[3][col('Gross')], rows[3][col('Net Weight (lbs)')]],
     ['TOTAL', '112,500', '103,935']);
  // The fixture above carries a COMBINED tare and no components, which is the
  // honest edge case: the four working columns print dashes and the NET is
  // still right, because tareOf falls back to the single figure. A blank
  // working column is visible; a wrong net would not be.
  ck('  a line with only a combined tare shows dashes, not wrong figures',
     [rows[1][col('Truck')], rows[1][col('Chassis')]], ['-', '-']);

  // And with the four components — which is what both invoice grids actually
  // collect, four boxes on the website and four on the phone — each totals in
  // its own column.
  {
    const { html: h6 } = build2({ inv_no: INV, container_no: 'KOCU5139886',
      line_items: [
        { item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 12.02, rate: 1000,
          packing: { gross_weight_lbs: '56,000', truck_lbs: '15,000', container_tare_lbs: '8,000',
                     chassis_lbs: '6,000', boxes_weight_lbs: '500', net_weight_lbs: '26,500' } },
        { item_desc: 'Regular combo', container_no: 'HMMU6904319', weight: 12.24, rate: 900,
          packing: { gross_weight_lbs: '56,500', truck_lbs: '15,000', container_tare_lbs: '8,000',
                     chassis_lbs: '6,000', boxes_weight_lbs: '500', net_weight_lbs: '27,000' } },
      ] });
    const d6 = h6.slice(h6.indexOf('<div class="doc-packing">'));
    const t6 = d6.slice(d6.indexOf('<table'), d6.indexOf('</table>'));
    const r6 = [...t6.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map((m) =>
        [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
            .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
    const c6 = (name) => r6[0].findIndex((h) => h.replace(/\s+/g, ' ').startsWith(name));
    const last6 = r6[r6.length - 1];
    ck('  each tare component adds up in its own column',
       [last6[c6('Truck')], last6[c6('Container Tare')], last6[c6('Chassis')], last6[c6('Boxes')]],
       ['30,000', '16,000', '12,000', '1,000']);
    ck('    and the net total is still gross minus all four',
       [last6[c6('Gross')], last6[c6('Net Weight (lbs)')]], ['112,500', '53,500']);
    ck('    with every row the same width', new Set(r6.map((r) => r.length)).size, 1);
  }

  // ── A NET OF ZERO IS A CLAIM ──────────────────────────────────────────
  // An invoice line carrying a gross and a tare but no stored net printed
  // "0" in the Net column, beside a gross of 56,000 on the same line. Gross
  // minus tare is the rule the rest of the system runs on; it was not
  // reaching this table, which invoice line items feed as well as the
  // packing-list screen does.
  {
    const { html: h3 } = build2({ inv_no: INV, container_no: 'KOCU5139886',
      line_items: [
        { item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 0, rate: 1000,
          packing: { gross_weight_lbs: '56,000', truck_lbs: '15,000', container_tare_lbs: '8,000' } },
        { item_desc: 'Regular combo', container_no: 'HMMU6904319', weight: 0, rate: 900,
          packing: { gross_weight_lbs: '50,000', container_tare_lbs: '8,000' } },
      ] });
    const d3 = h3.slice(h3.indexOf('<div class="doc-packing">'));
    const tbl3 = d3.slice(d3.indexOf('<table'), d3.indexOf('</table>'));
    const rows3 = [...tbl3.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map((m) =>
        [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
            .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
    const netCol = rows3[0].findIndex((hh) => hh.replace(/\s+/g, ' ').startsWith('Net Weight (lbs)'));
    ck('a line with weights but no stored net is not printed as 0',
       [rows3[1][netCol], rows3[2][netCol]], ['33,000', '42,000']);
    ck('  and the MT follows from it', rows3[1][netCol + 1], '14.969');
  }

  // Nothing named, nothing added: the column follows the data, so a document
  // with no descriptions is the five-column one it has always been.
  const { html: h2 } = build2({ inv_no: INV, container_no: 'KOCU5139886',
    line_items: [{ container_no: 'KOCU5139886', weight: 23.469, rate: 1000,
                   packing: { gross_weight_lbs: '56,000', net_weight_lbs: '51,735' } }] });
  const d2 = h2.slice(h2.indexOf('<div class="doc-packing">'));
  const tbl2 = d2.slice(d2.indexOf('<table'), d2.indexOf('</table>'));
  const head2 = [...tbl2.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').trim());
  ck('a line item with no description keeps the invoice\'s eight columns', head2.length, 8);
}

console.log('\n=== the invoice tab keeps the header it always had ===');
// Apsara, 2026-09-17, asked whether "like last time" covered the header as
// well as the columns: yes.
//
// Two documents, two headers. The compact block above is the PACKING LIST
// TAB's; a packing list split off an INVOICE still carries the clone —
// exporter, buyer, Terms, Vessel, Payment Terms, four ports — so it says
// everything the invoice it came from said.
//
// This section exists because without it, making both documents compact broke
// nothing: every header check in this file had moved to the compact fixture.
{
  const { html: hi } = require(R('helpers/invoicePdf')).buildInvoiceClassicHtml({
    inv_no: INV, inv_date: '2026-09-10', container_no: 'KOCU5139886',
    terms: 'LC', vessel: 'HMM', reference: 'M3928609NU00121',
    consignee_address: ['TAEWON AUTOMOTIVE CO., LTD', 'HAMAN-GUN, KOREA 52062'],
    place_of_receipt: 'FRISCO', port_loading: 'OAKLAND', port_discharge: 'BUSAN',
    line_items: [{ item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 23.469, rate: 1000,
                   packing: { gross_weight_lbs: '56,000', truck_lbs: '15,000' } }],
  });
  const head = hi.slice(hi.indexOf('class="pl-header"'), hi.indexOf('<div class="doc-packing"'));

  ck('the invoice\'s packing list keeps Terms', /&gt;Terms|>Terms</.test(head), true);
  ck('  and Vessel / Flight No', /Vessel \/ Flight No/.test(head), true);
  ck('  and Payment Terms', /Payment Terms/.test(head), true);
  ck('  and the four ports', /Port of Loading/.test(head) && /Port of Discharge/.test(head)
     && /Place of Receipt/.test(head) && /Country of Origin/.test(head), true);
  ck('  and Other Reference(s)', /Other Reference/.test(head), true);
  ck('  with its own banner above it', /PACKING LIST/.test(head), true);
  ck('  and nothing left unfilled', /\{\{/.test(head), false);

  // The compact block's own marker must NOT appear here: the reference line is
  // the packing list tab's, and seeing it would mean the wrong header landed.
  ck('  and it is NOT the compact block', /EXPORTER<\/div>/.test(head), false);
}

console.log('\n=== invoice only ===');
// Apsara, 2026-09-16: "add a checkbox called invoice only in invoice of
// documents". The invoice on its own — no packing list in the PDF, no second
// file.
//
// ── WHY THE RISK HERE IS THE OPPOSITE ONE ───────────────────────────────────
// Every other check in this section guards against the packing list going
// MISSING. This one guards against it going OUT: the point of the flag is that
// a customer receives the invoice and nothing else, and a mode that quietly
// rendered 'both' would look identical in the filename and the status message.
// So the assertion is on WHICH MODES are requested, driven through the real
// function with the renderer injected — Chromium cannot launch in this sandbox
// and the mode list is the entire decision.
{
  const { generateInvoiceClassicPdf } = require(R('helpers/invoicePdf'));
  const data = { inv_no: INV, container_no: 'KOCU5139886',
                 line_items: [{ item_desc: 'Aluminium combo', container_no: 'KOCU5139886', weight: 23.469, rate: 1000 }] };
  const spy = () => { const seen = []; return { seen, render: async (html, modes) => {
      seen.push(modes.join('+'));
      return { both: Buffer.from('B'), invoice: Buffer.from('I'), packing: Buffer.from('P') };
  } }; };

  const a = spy();
  const onlyOut = await generateInvoiceClassicPdf(data, { invoiceOnly: true, render: a.render });
  ck('invoice only renders the invoice half ALONE', a.seen, ['invoice']);
  ck('...and hands back one buffer, not a pair', Buffer.isBuffer(onlyOut) && onlyOut.toString(), 'I');

  const b = spy();
  await generateInvoiceClassicPdf(data, { render: b.render });
  ck('no flag still means the combined sheet', b.seen, ['both']);

  const c = spy();
  await generateInvoiceClassicPdf(data, { separate: true, render: c.render });
  ck('separate still renders both halves', c.seen, ['invoice+packing']);

  // A contradiction has to resolve the SAFE way: fewer documents than she
  // expected, never a packing list she asked not to send.
  const d2 = spy();
  await generateInvoiceClassicPdf(data, { separate: true, invoiceOnly: true, render: d2.render });
  ck('invoice only BEATS separate if both arrive', d2.seen, ['invoice']);

  const apiSrc2 = fs.readFileSync(R('api.js'), 'utf8');
  ck('the API reads the flag', /body\.invoice_only === true/.test(apiSrc2), true);
  ck('...and stops separate from overriding it',
     /const separate = !invoiceOnly &&/.test(apiSrc2), true);
  ck('...and files it under its own name', /_INVOICE\.pdf` : `\$\{safeInv\}\.pdf`/.test(apiSrc2), true);
}

console.log('\n=== the two checkboxes cannot contradict each other ===');
// Driven in jsdom, not grepped: the exclusion is four elements and two
// handlers, and "the function exists" is not the property that matters.
{
  const { JSDOM } = require('jsdom');
  const dash2 = fs.readFileSync(R('dashboard/documents.html'), 'utf8');
  const dom = new JSDOM(dash2, { runScripts: 'dangerously', url: 'http://localhost/documents',
    beforeParse(w) {
      w.fetch = () => new Promise(() => {});   // boot() must never reach the DOM after close()
      w.alert = () => {};
    } });
  await new Promise((r) => setTimeout(r, 250));
  const w = dom.window, d = w.document;
  const ids = ['inv_separate', 'inv_separate_bulk', 'inv_only', 'inv_only_bulk'];
  ck('all four boxes exist', ids.every((i) => !!d.getElementById(i)), true);
  const state = () => ids.map((i) => (d.getElementById(i).checked ? 1 : 0));
  const tick = (id) => { const el = d.getElementById(id); el.checked = true;
                         el.dispatchEvent(new w.Event('change', { bubbles: true })); };

  tick('inv_separate');
  ck('ticking Separate ticks both Separate boxes', state(), [1, 1, 0, 0]);
  tick('inv_only');
  ck('...and ticking Invoice only clears them', state(), [0, 0, 1, 1]);
  tick('inv_separate_bulk');
  ck('...it works from the batch bar too', state(), [1, 1, 0, 0]);
  tick('inv_only_bulk');
  ck('...both ways', state(), [0, 0, 1, 1]);

  ck('generate sends invoice_only', /payload\.invoice_only = /.test(dash2), true);
  ck('...and will not send separate alongside it',
     /payload\.separate = !payload\.invoice_only/.test(dash2), true);
  dom.window.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
