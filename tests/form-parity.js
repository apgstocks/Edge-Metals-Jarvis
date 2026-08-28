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


// ── the yard bot widget is ONE file, not two ───────────────────────────────
{
  const a = fs.readFileSync(R+'dashboard/yard-bot.js','utf8');
  const b = fs.readFileSync(R+'mobile-app/www/yard-bot.js','utf8');
  ck('the yard-bot widget is byte-identical in both hosts', a === b);
  ck('both hosts include it', /yard-bot\.js/.test(fs.readFileSync(R+'dashboard/index.html','utf8'))
     && /yard-bot\.js/.test(fs.readFileSync(R+'mobile-app/www/index.html','utf8')));
  // The bot must stay read-only. If it ever learns to POST somewhere that
  // acts, that is a different feature and needs a different conversation.
  const posts = (a.match(/\/api\/[a-z0-9\/-]+/g) || []);
  ck('the widget only ever calls the read-only ask endpoint',
     posts.every(u => u === '/api/yard/ask'));
  ck('the widget never touches the action-taking bot route', !/bot\/command/.test(a));
}


// ── payments exist on BOTH, and agree ──────────────────────────────────────
{
  const web = fs.readFileSync(R+'dashboard/index.html','utf8');
  const app = fs.readFileSync(R+'mobile-app/www/index.html','utf8');
  for (const [label, src] of [['website', web], ['app', app]]) {
    ck(`${label}: has a Pay button on the load card`, /btn-pay-load/.test(src));
    ck(`${label}: has the payment modal`, /id="payModal"/.test(src));
    ck(`${label}: offers all four modes`,
       ['Zelle','Wire','Cash','Cheque'].every(m => new RegExp(`value="${m}"`).test(src)));
    ck(`${label}: shows a payment badge on the card`, /paymentBadgeHtml\(l\)/.test(src));
    ck(`${label}: previews the pending amount before saving`, /function updatePayPreview/.test(src));
    ck(`${label}: reloads after saving rather than recomputing the balance locally`,
       /loadTab\('loads'\)/.test(src));
  }
  // The badge wording decides what a number MEANS. If the two drift, the same
  // load reads differently on a phone and a laptop.
  const grabFn = (src, name) => {
    const i = src.indexOf('function '+name+'('); if (i<0) return null;
    let d=0, j=src.indexOf('{', i);
    for (let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} }
  };
  const a = grabFn(web,'paymentBadgeHtml'), b = grabFn(app,'paymentBadgeHtml');
  const strip = (t) => String(t).replace(/\s+/g,' ').trim();
  ck('the payment badge logic is identical in both', !!a && strip(a)===strip(b));
  const pa = grabFn(web,'updatePayPreview'), pb = grabFn(app,'updatePayPreview');
  ck('the pending preview logic is identical in both', !!pa && strip(pa)===strip(pb));
}


// ── the draft autosave exists on BOTH, and agrees ──────────────────────────
{
  const web = fs.readFileSync(R+'dashboard/index.html','utf8');
  const app = fs.readFileSync(R+'mobile-app/www/index.html','utf8');
  for (const [label, src] of [['website', web], ['app', app]]) {
    ck(`${label}: autosaves the load form`, /queueLoadDraftSave/.test(src));
    ck(`${label}: says what the draft is doing`, /id="draftStatus"/.test(src) && /function setDraftStatus/.test(src));
    ck(`${label}: offers an unfinished load rather than applying it`,
       /id="draftBar"/.test(src) && /function offerLoadDraft|async function offerLoadDraft/.test(src));
    ck(`${label}: lists unfinished loads above the deck`, /id="draftStrip"/.test(src) && /function draftStripHtml/.test(src));
    ck(`${label}: saves drafts to the SERVER, not the browser`,
       /\/api\/load-drafts/.test(src) && !/localStorage[\s\S]{0,80}Draft/i.test(src));
    ck(`${label}: never drafts while editing an existing load`,
       /if \(editingLoadId\)[\s\S]{0,80}?return;/.test(src));
    ck(`${label}: clears the draft only after a save resolves`, /clearLoadDraft\(\);/.test(src));
  }
  const grabFn = (src, name) => {
    for (const kw of ['async function ','function ']) {
      const i = src.indexOf(kw+name+'('); if (i<0) continue;
      let d=0, j=src.indexOf('{', i);
      for (let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} }
    }
    return null;
  };
  const strip = (t) => String(t).replace(/\s+/g,' ').trim();
  for (const fn of ['itemHasContent','setDraftStatus','currentDraftPayload','saveLoadDraft',
                    'queueLoadDraftSave','clearLoadDraft','applyLoadDraft','offerLoadDraft',
                    'restoreLoadDraft','discardOfferedDraft','draftStripHtml','resumeDraft']) {
    ck(`draft: ${fn} is identical in both`, !!grabFn(web,fn) && strip(grabFn(web,fn)) === strip(grabFn(app,fn)));
  }
}


// ── the yard bot must not appear before sign-in ────────────────────────────
// Per Apsara 2026-08-29: the chat bubble was showing on the app's login
// screen. Driven against the two hosts' real sign-in shapes.
{
  const src = fs.readFileSync(R+'dashboard/yard-bot.js','utf8');
  const grab = (n) => { const i=src.indexOf('function '+n+'('); let d=0,j=src.indexOf('{',i);
    for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} } };
  const mkEl = (hidden) => ({ classList: { contains: (c) => c==='hidden' && hidden } });
  let els = {};
  const isSignedIn = new Function('document', 'return (' + grab('isSignedIn') + ')')({ getElementById: (id) => els[id] || null });

  els = { loginScreen: mkEl(false), appShell: mkEl(true) };
  ck('bot: hidden on the app login screen', isSignedIn() === false);
  els = { loginScreen: mkEl(true), appShell: mkEl(false) };
  ck('bot: shown once signed in', isSignedIn() === true);
  els = { loginScreen: mkEl(false), appShell: mkEl(true) };
  ck('bot: hidden again when the session expires', isSignedIn() === false);
  els = { loginScreen: mkEl(true), appShell: mkEl(true) };
  ck('bot: stays hidden in a transient state rather than guessing', isSignedIn() === false);
  els = {};
  ck('bot: shown on the website, where the server already gated it', isSignedIn() === true);

  ck('bot: clears the transcript on sign-out', /history = \[\];[\s\S]{0,40}greet\(\)/.test(src));
  ck('bot: refuses to send while signed out', /if \(!isSignedIn\(\)\)/.test(src));
  // The app's sign-in really does toggle .hidden on those two ids — if that
  // ever changes, the gate silently stops working, so assert it.
  const app = fs.readFileSync(R+'mobile-app/www/index.html','utf8');
  ck('bot: the app still toggles .hidden on loginScreen/appShell',
     /loginScreen'\)\.classList\.(add|remove)\('hidden'\)/.test(app)
     && /appShell'\)\.classList\.(add|remove)\('hidden'\)/.test(app));
}


// ── every amount the UI RENDERS carries a $ ────────────────────────────────
// Rewritten 2026-08-29 after it missed a real bug. The previous version
// asserted that fmtAmount and payMoney contain a $ — both true — while the
// payment badge used a THIRD, local formatter that did not, and shipped
// "PART PAID 12,000.00". Checking a formatter's definition proves nothing
// about what reaches the screen, so these RENDER the real functions and read
// the output.
{
  for (const p of ['dashboard/index.html','mobile-app/www/index.html']) {
    const src = fs.readFileSync(R+p,'utf8');
    const grab = (n) => { const i=src.indexOf('function '+n+'('); if(i<0) return null;
      let d=0,j=src.indexOf('{',i);
      for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} } };
    const payMoney = (n) => '$' + Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const badge = new Function('payMoney','return '+grab('paymentBadgeHtml'))(payMoney);
    const strip = (h) => String(h).replace(/<[^>]*>/g,'');

    const cases = [
      ['part paid',  { paid:12000, pending:4822, status:'partial' }, ['$12,000.00','$4,822.00']],
      ['paid',       { paid:8822, pending:0, status:'paid' },        ['$8,822.00']],
      ['overpaid',   { paid:9000, over:178, status:'overpaid' },     ['$178.00']],
      ['no price',   { paid:500, status:'paid_amount_unknown' },     ['$500.00']],
    ];
    for (const [label, pay, wants] of cases) {
      const out = strip(badge({ payment: pay }));
      ck(`${p}: badge (${label}) shows every amount with a $`,
         wants.every((w) => out.includes(w)));
      // A bare number with no $ in front is the exact defect that shipped.
      ck(`${p}: badge (${label}) has no un-prefixed amount`,
         !/(^|[^$\d.,])\d[\d,]*\.\d\d/.test(out));
    }
    ck(`${p}: nothing is shown when nothing has been paid`, badge({ payment:{ paid:0 } }) === '');

    // The totals line under the item rows, rendered for real.
    const fmtAmount = new Function('return ' + grab('fmtAmount'))();
    const mkRow = (g,t,n,a) => { const v={'.ld-item-gross':g,'.ld-item-tare':t,'.ld-item-net':n,'.ld-item-amount':a};
      return { querySelector: (s) => (s in v) ? { value: v[s]==null?'':String(v[s]) } : null }; };
    let elx = { innerHTML:'' };
    new Function('document','fmtAmount', grab('updateItemTotals') + ';updateItemTotals();')(
      { getElementById: () => elx, querySelectorAll: () => [mkRow(4210,200,4010,'$8,822.00'), mkRow(3475,180,3295,'$7,249.00')] },
      fmtAmount);
    const amt = (elx.innerHTML.match(/data-label="Amount">([^<]*)</)||[])[1];
    ck(`${p}: the item totals Amount renders with a single $`, amt === '$16,071.00');
  }
}



// ── the payment DATE reaches the load card ─────────────────────────────────
// Per Apsara 2026-08-29: "record payment date as well." It was already stored,
// shown in the Pay form's history and printed on the ticket — the load card
// was the one place it never reached, which is where she looks while working.
{
  for (const p of ['dashboard/index.html','mobile-app/www/index.html']) {
    const src = fs.readFileSync(R+p,'utf8');
    const grab = (n) => { const i=src.indexOf('function '+n+'('); if(i<0) return null;
      let d=0,j=src.indexOf('{',i);
      for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} } };
    const payMoney = (n) => '$' + Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const badge = new Function('payMoney','return '+grab('paymentBadgeHtml'))(payMoney);
    const strip = (h) => String(h).replace(/<[^>]*>/g,'');
    const rows = [{ paid_on:'2026-08-20', mode:'Zelle', amount:8000 },
                  { paid_on:'2026-08-22', mode:'Cash',  amount:4000 }];

    ck(`${p}: a part-paid badge shows the payment date`,
       /Aug 22/.test(strip(badge({ payment:{ paid:12000, pending:4822, status:'partial', payments:rows } }))));
    ck(`${p}: a settled badge shows it too`,
       /Aug 22/.test(strip(badge({ payment:{ paid:8822, pending:0, status:'paid', payments:[rows[1]] } }))));
    ck(`${p}: with instalments it shows the LAST date, not the first`,
       !/Aug 20/.test(strip(badge({ payment:{ paid:12000, pending:1, status:'partial', payments:rows } }))));
    ck(`${p}: no payment dates -> no stray separator`,
       strip(badge({ payment:{ paid:100, pending:5, status:'partial', payments:[] } })) === 'PART PAID $100.00 · $5.00 pending');

    // THE TIMEZONE TRAP. new Date('2026-08-22') is UTC midnight, which renders
    // as the 21st anywhere west of Greenwich. A payment dated the 22nd showing
    // as the 21st is the kind of small wrongness nobody notices until it
    // matters, so this pins the date to what was actually entered.
    const out = strip(badge({ payment:{ paid:1, pending:1, status:'partial', payments:[{ paid_on:'2026-01-01', amount:1 }] } }));
    ck(`${p}: a 1 Jan payment does not render as 31 Dec`, /Jan 1/.test(out) && !/Dec 31/.test(out));
    ck(`${p}: the date is parsed from the string, not through UTC`,
       /new Date\(Number\(m\[1\]\), Number\(m\[2\]\) - 1, Number\(m\[3\]\)\)/.test(src));
    ck(`${p}: a malformed date is dropped rather than printed as Invalid Date`,
       !/Invalid/.test(strip(badge({ payment:{ paid:1, pending:1, status:'partial', payments:[{ paid_on:'nonsense', amount:1 }] } }))));
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
