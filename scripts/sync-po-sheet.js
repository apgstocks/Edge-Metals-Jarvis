const fs=require('fs');
const src=fs.readFileSync('dashboard/documents.html','utf8');
function fn(name){const i=src.indexOf('\nfunction '+name+'(');if(i<0)throw new Error(name);const j=src.indexOf('\n}\n',i);return src.slice(i+1,j+3);}
function cst(name){const i=src.indexOf('\nconst '+name+' =');if(i<0)throw new Error(name);const j=src.indexOf(';\n',i);return src.slice(i+1,j+2);}
const parts=[cst('PO_CONTACT'),cst('PO_LOGO'),fn('poIsEdgeMetals'),fn('poMoney'),fn('poPrice'),fn('poQty'),fn('poVendorAddress'),fn('poShipToHtml'),fn('poSheetCss'),fn('poSheetHtml')];
const head=`// ── helpers/poSheet.js — the Purchase Order sheet, server side ────────────
// GENERATED COPY of the sheet in dashboard/documents.html (poSheetCss /
// poSheetHtml and the small helpers they use), so the phone app and the
// "Print PO" button on a load or sale print the SAME sheet the Documents →
// Purchase order tab shows. tests/po-print.js renders both and fails if they
// ever differ, so a change to the website sheet that is not carried here
// turns red instead of quietly printing two different POs.
// Not edited by hand: change documents.html, then re-run scripts/sync-po-sheet.js.

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

`;
const tail=`
module.exports = { esc, PO_CONTACT, poSheetCss, poSheetHtml, poMoney, poPrice, poQty, poIsEdgeMetals };
`;
fs.writeFileSync('helpers/poSheet.js',head+parts.join('\n')+tail);
