// ── tests/form-parity.js ────────────────────────────────────────────────────
// The load form exists TWICE — dashboard/index.html and mobile-app/www/index.html
// — with its own copy of the same logic in each. Apsara works from both, and
// asked for the website changes to be mirrored to the app, so the two have to
// agree.
//
// Two copies of the same arithmetic is precisely how they drift: someone fixes
// rounding on one screen, and a load typed on the other quietly totals
// differently. These tests execute BOTH copies against identical rows and
// require identical output, rather than reading them and hoping.
//
// Also asserts the structural changes of 2026-08-28 landed on both: no Buyer
// box, Date beside Seller, address beside phone, and no load-level description.
// Runs BOTH copies of updateItemTotals against the same rows. Two files with
// their own copy of the same arithmetic is exactly how they silently drift.
const fs=require('fs'),path=require('path');
const R=path.join(__dirname,'..')+path.sep;
function grabFrom(file,name){
  const src=fs.readFileSync(R+file,'utf8');
  const i=src.indexOf('function '+name+'('); if(i<0) throw new Error(name+' not in '+file);
  let d=0,j=src.indexOf('{',i);
  for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1);}}
}
const mkRow=(g,t,n,a)=>{const v={'.ld-item-gross':g,'.ld-item-tare':t,'.ld-item-net':n,'.ld-item-amount':a};
  return {querySelector:s=>(s in v)?{value:v[s]==null?'':String(v[s])}:null};};
function run(file,rows){
  let el={innerHTML:''};
  const ctx={document:{getElementById:()=>el,querySelectorAll:()=>rows},
             fmtAmount:n=>n==null?'':Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
  const fn=new Function('document','fmtAmount', grabFrom(file,'updateItemTotals')+'; return updateItemTotals;');
  fn(ctx.document,ctx.fmtAmount)();
  return el.innerHTML.replace(/\s+/g,' ').trim();
}
let pass=0,fail=0; const ck=(n,c)=>{c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n));};
const cases=[
  ['a normal two-item load', [mkRow(4210,200,4010,'8,823.00'), mkRow(3475,180,3295,'7,249.00')]],
  ['a single item',          [mkRow(1000,100,900,'1,980.00')]],
  ['all blank',              [mkRow('','','',''), mkRow('','','','')]],
  ['half filled',            [mkRow(4210,'','',''), mkRow('',180,'','')]],
  ['floating point',         [mkRow(1.005,0.005,1,''), mkRow(1.005,0.005,1,'')]],
  ['no prices yet',          [mkRow(4210,200,4010,''), mkRow(3475,180,3295,'')]],
];
for (const [label,rows] of cases) {
  const web = run('dashboard/index.html', rows);
  const app = run('mobile-app/www/index.html', rows);
  ck(`website and app agree — ${label}`, web===app);
  if (web!==app) { console.log('    web:', web); console.log('    app:', app); }
}
const web=run('dashboard/index.html',cases[0][1]);
ck('the total amount is actually rendered', /data-label="Amount">16,072.00</.test(web));
ck('gross total is right', /data-label="Gross">7,685</.test(web));
ck('net total is right', /data-label="Net">7,305</.test(web));

// ── structural parity of the two forms ─────────────────────────────────────
{
  const web = fs.readFileSync(R+'dashboard/index.html','utf8');
  const app = fs.readFileSync(R+'mobile-app/www/index.html','utf8');
  for (const [label, src] of [['website', web], ['app', app]]) {
    ck(`${label}: Buyer box removed`, !/id="ld_buyer"/.test(src));
    ck(`${label}: no dead ld_fixed_label writes left behind`, !/ld_fixed_label/.test(src));
    ck(`${label}: load-level description box removed`, !/>Load description</.test(src));
    ck(`${label}: still sends Edge Trading as the buyer`, /buyer: BUYER_FIXED_NAME/.test(src));
    ck(`${label}: an old load's description is preserved on save`, /editingLoadDescription/.test(src));
    ck(`${label}: Date and Seller share the first row`, /Date<\/label>[\s\S]{0,260}?ld_party_label/.test(src));
    ck(`${label}: address and phone share the second row`, /ld_party_row2[\s\S]{0,800}?ld_seller_phone/.test(src));
    ck(`${label}: that row collapses on a sale, where phone is hidden`, /gridTemplateColumns = sale/.test(src));
    ck(`${label}: totals refresh from recomputeRowTotals itself`,
       /row\.querySelector\('\.ld-item-amount'\)\.value = fmtAmount\(amount\);[\s\S]{0,400}?updateItemTotals\(\);/.test(src));
    ck(`${label}: the totals element is not an item row`, /id="ld_item_totals"/.test(src) && !/item-row[^>]*ld_item_totals/.test(src));
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
