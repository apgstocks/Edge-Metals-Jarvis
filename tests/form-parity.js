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
  // updateTruckingSummary joins document and fmtAmount as a declared
  // collaborator (2026-09-20) — updateItemTotals refreshes the payable line
  // at the end, and this comparison is about the totals the two clients
  // compute, not about that call.
  const fn=new Function('document','fmtAmount','updateTruckingSummary', grabFrom(file,'updateItemTotals')+'; return updateItemTotals;');
  fn(ctx.document,ctx.fmtAmount,()=>{})();
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

  // ── THE BOT SAYS WHICH FAILURE IT WAS ─────────────────────────────────
  // Apsara, 2026-09-15: "why am i getting message as i cant reach the server
  // right now from chat bot in edge yard app?"
  //
  // Because the catch was blanket — one sentence for a 403, a 500 and a real
  // outage, three problems needing three different reactions. The likeliest
  // is the one it hid best: /api/yard/ask is NOT in api.js's
  // STAFF_ALLOWED_PATH_PREFIXES, so a staff session gets 403 on every
  // question while the Loads tab keeps working, which reads as an outage and
  // is a permission.
  ck('bot: a refusal carries its status out of callApi',
     /err\.status = r\.status;/.test(a),
     'without the status the catch cannot tell a refusal from an outage');
  ck('bot: a staff session is told it is a PERMISSION, not an outage',
     /signed in as staff/i.test(a), 'the 403 branch is missing');
  ck('bot:   and told what to do about it',
     /admin password/i.test(a));
  // The app's api() throws with NO status on the error, and /api/yard/ask
  // answers a 500 with { ok, answer } and no `error` field — so the message
  // is literally 'request failed (500)'. Without recovering the number from
  // that text, a server error still reported as unreachable in the app, which
  // is the half the first version of this fix missed.
  ck('bot: the status is recovered from the message when it is not on the error',
     a.indexOf('request failed \\((\\d{3})\\)') !== -1,
     'the app never attaches err.status, so the text is the only source');
  ck('bot: an expired session says so',
     /session has expired/i.test(a));
  ck('bot: a server error is named as one, not as unreachable',
     /reached an error answering that/i.test(a));
  ck('bot: only a request that never completed says "cannot reach"',
     /can't reach the server right now\. "\s*\n?\s*\+ 'Check the connection/.test(a)
     || /can't reach the server right now/.test(a.split('} else {')[1] || ''),
     'that sentence must live in the no-status branch only');
  // The staff gate is a DELIBERATE money boundary, not an oversight: the bot
  // can read spend_report and petty_cash, and /api/payments is kept off the
  // staff list for the same reason. So the fix is to SAY so, never to widen
  // the allowlist — pinned here so nobody "fixes" it the easy way.
  {
    const apiSrc = fs.readFileSync(R+'api.js','utf8');
    const line = (apiSrc.match(/const STAFF_ALLOWED_PATH_PREFIXES = \[[^\]]*\]/) || [''])[0];
    ck('bot: /api/yard/ask stays OFF the staff allowlist',
       !/yard/.test(line),
       'the assistant can read spend_report; letting staff reach it undoes the payments boundary');
  }
  ck('both hosts include it', /yard-bot\.js/.test(fs.readFileSync(R+'dashboard/index.html','utf8'))
     && /yard-bot\.js/.test(fs.readFileSync(R+'mobile-app/www/index.html','utf8')));
  // This used to assert the widget was read-only. That WAS the boundary, and
  // the comment here said any change to it "needs a different conversation" —
  // which is exactly what happened: Apsara, 2026-08-29, "it can do anything
  // but within scope of edge yard". So the assertion is not deleted, it is
  // moved to the boundary that replaced it.
  //
  // The new invariant is narrower and stronger than "read-only": the widget
  // may ask, and may confirm a proposal the SERVER made, and nothing else.
  const posts = (a.match(/\/api\/[a-z0-9\/-]+/g) || []);
  const ALLOWED = ['/api/yard/ask', '/api/yard/act', '/api/yard/cancel-action'];
  ck('the widget calls only the three yard endpoints',
     posts.every(u => ALLOWED.includes(u)));
  ck('the widget never touches the action-taking bot route', !/bot\/command/.test(a));
  // The heart of it. If the confirm call ever carries an amount, a load id or
  // a payment mode, then what gets written is whatever the page sent — and the
  // server-side validation of the proposal becomes decorative.
  const act = /callApi\('\/api\/yard\/act',\s*\{([^}]*)\}/.exec(a);
  ck('the confirm call exists', !!act);
  if (act) {
    const body = act[1];
    ck('confirming sends only the opaque proposal id (plus source)',
       /\bid:\s*p\.id\b/.test(body) && !/amount|load_id|mode|seller|items/.test(body));
  }
  ck('the widget cannot delete anything', !/delete/i.test(a) || !/\/api\/(loads|payments)/.test(a));
  // A proposal must never be auto-confirmed. The whole design is one human tap.
  ck('confirming is bound to a click, not fired automatically',
     /\.yb-yes'\)\.addEventListener\('click'/.test(a));
  ck('the greeting no longer claims it cannot change anything',
     !/I read the data, but I can.t change anything/.test(a));
}


// ── payments exist on BOTH, and agree ──────────────────────────────────────
{
  const web = fs.readFileSync(R+'dashboard/index.html','utf8');
  const app = fs.readFileSync(R+'mobile-app/www/index.html','utf8');
  for (const [label, src] of [['website', web], ['app', app]]) {
    ck(`${label}: has a Pay button on the load card`, /btn-pay-load/.test(src));
    ck(`${label}: has the payment modal`, /id="payModal"/.test(src));
    // TWO modes when RECEIVING a payment, per Apsara 2026-09-16: "in receive
    // payment-i should have only cash and bank transfer". Five when PAYING a
    // supplier — that is money going the other way, and restricting it too
    // was an over-reach that shipped and broke her supplier payments for a
    // day (see tests/yard-payment-modes.js).
    //
    // So the list is built per row by openPayModal, and this reads the code
    // that builds it rather than <option> tags that no longer exist. What
    // parity means here is that BOTH clients make the same distinction.
    const payModes = (() => {
      const m = src.replace(/<!--[\s\S]*?-->/g, '')
                   .match(/const payModes = sale \? \[([^\]]*)\] : \[([^\]]*)\]/);
      return m ? { sale: m[1], purchase: m[2] } : null;
    })();
    // Against the SERVER, not a list spelled out here. Receive payment was
    // widened on 2026-09-23 ("Remove just wire") and a hardcoded pair went
    // red for that rather than for a real break. What parity means is that
    // the client offers exactly what addPayment will accept.
    const srvSale = require(R + 'helpers/payments').modesForKind('sale');
    const asList = (x) => (x || '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
    ck(`${label}: receiving a payment offers exactly what the server accepts`,
       !!payModes && JSON.stringify(asList(payModes.sale)) === JSON.stringify(srvSale),
       `client ${JSON.stringify(asList(payModes && payModes.sale))} vs server ${JSON.stringify(srvSale)}`);
    ck(`${label}: and Wire is not among them`,
       !!payModes && !asList(payModes.sale).includes('Wire'), JSON.stringify(payModes && payModes.sale));
    ck(`${label}: paying a supplier keeps Zelle, Wire and Cheque`,
       !!payModes && ['Zelle', 'Wire', 'Cheque'].every((m) => payModes.purchase.includes(m)),
       JSON.stringify(payModes && payModes.purchase));
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
  // currentDraftPayload and applyLoadDraft are BACK in this list as of
  // 2026-09-02. They were pulled out yesterday when the MM/DD/YYYY work landed
  // on the website only, leaving the app with native date inputs — two
  // different widgets cannot share one read/write path. Today the app got the
  // same text-plus-picker fields, so the divergence closed and byte-identity
  // is true again. Restored rather than left relaxed: a weaker check that is
  // no longer needed is a weaker check nobody remembers to tighten.
  for (const fn of ['itemHasContent','setDraftStatus','currentDraftPayload','saveLoadDraft',
                    'queueLoadDraftSave','clearLoadDraft','applyLoadDraft','offerLoadDraft',
                    'restoreLoadDraft','discardOfferedDraft','draftStripHtml','resumeDraft',
                    'toUsDate','toIsoDate','fmtDate','wireUsDateField']) {
    ck(`draft: ${fn} is identical in both`, !!grabFn(web,fn) && strip(grabFn(web,fn)) === strip(grabFn(app,fn)));
  }

  // ── currentDraftPayload / applyLoadDraft: a DELIBERATE divergence ───────
  //
  // These two were byte-compared with the ten above until 2026-09-02. They no
  // longer match, and that is correct rather than drift:
  //
  //   website  <input id="ld_date"> holds MM/DD/YYYY text, so it converts —
  //            toIsoDate on the way out, toUsDate on the way back in.
  //   app      <input type="date"> is a native picker whose .value is ALREADY
  //            YYYY-MM-DD, so there is nothing to convert.
  //
  // Two different input widgets cannot have identical read/write code. But
  // byte-identity was only ever a proxy for the thing that matters: a draft
  // saved on the phone has to open on the laptop and vice versa, and that
  // requires both to put the SAME shape on the wire.
  //
  // So this asserts the invariant directly instead of the proxy. It is a
  // stronger check, not a weaker one — the old comparison would have passed
  // two identical functions that both wrote the wrong format.
  {
    const stubs = (dateValue, whichFile) => {
      const el = { value: dateValue };
      const src = whichFile;
      const helpers = ['toIsoDate','toUsDate'].map((h) => grabFn(src,h)).filter(Boolean).join('\n');
      return { el, helpers };
    };

    // OUT: what each client sends to the server, given a date entered in that
    // client's own field format.
    const outOf = (src, fieldValue) => {
      const helpers = ['toIsoDate','toUsDate'].map((h) => grabFn(src,h)).filter(Boolean).join('\n');
      const fn = new Function('$','syncItemsFromDom','currentDraftId','currentLoadItems',
                              'itemHasContent','editingLoadDescription',
        helpers + '\n' + grabFn(src,'currentDraftPayload') + '; return currentDraftPayload;')(
        (id) => (id === 'ld_date' ? { value: fieldValue } : { value: '' }),
        () => {}, null, [], () => false, '');
      return fn().date;
    };
    ck('draft: the website sends ISO to the server', outOf(web, '09/02/2026') === '2026-09-02');
    ck('draft: the app sends ISO to the server', outOf(app, '09/02/2026') === '2026-09-02');
    // Same INPUT now, not just the same output — the two fields hold the same
    // format, so this compares like with like.
    ck('draft: both clients put the SAME date on the wire',
       outOf(web, '09/02/2026') === outOf(app, '09/02/2026'));

    // IN: a draft written by EITHER client (always ISO) must load into each
    // client's field in the format that field expects.
    const inTo = (src, stored) => {
      const helpers = ['toIsoDate','toUsDate'].map((h) => grabFn(src,h)).filter(Boolean).join('\n');
      const seen = {};
      const fn = new Function('$','currentLoadItems','renderItemRows','setDraftStatus',
                              'currentDraftId','editingLoadDescription','loadModalMode',
                              'blankLoadItem','applyLoadModalMode','fmtRate',
        helpers + '\n' + grabFn(src,'applyLoadDraft') + '; return applyLoadDraft;')(
        (id) => (seen[id] = seen[id] || { value: '' }),
        [], () => {}, () => {}, null, '', 'purchase',
        () => ({}), () => {}, (v) => v);
      // The date is written near the top of the function; anything further in
      // that still needs a stub is not what is under test here, so a later
      // throw does not invalidate the field we came to read. It is reported
      // rather than swallowed so a genuinely broken function is visible.
      let threw = '';
      try { fn({ date: stored, items: [] }); } catch (e) { threw = e.message; }
      const got = seen['ld_date'] ? seen['ld_date'].value : '(not set)';
      if (!got && threw) return 'THREW before setting the date: ' + threw;
      return got;
    };
    ck('draft: an ISO draft opens as MM/DD/YYYY on the website', inTo(web, '2026-09-02') === '09/02/2026');
    // Was '2026-09-02' until 2026-09-02, when the app stopped using native
    // date inputs. Both clients now show the same thing on the same draft,
    // which is what this file exists to be able to say.
    ck('draft: and the same in the app, now that it converts too', inTo(app, '2026-09-02') === '09/02/2026');

    // The divergence must stay EXACTLY this narrow. If the two functions ever
    // differ by more than the date conversion, that is drift again and this
    // catches it.
    // Unwraps toIsoDate(...) / toUsDate(...) by finding the MATCHING close
    // paren. A regex cannot do this: [^)]* stops at the first ')', so
    // toIsoDate($('ld_date').value) came out as $('ld_date'.value) and the
    // comparison failed against correct code. Caught while writing this.
    const unwrap = (t, name) => {
      let out = t, i;
      while ((i = out.indexOf(name + '(')) !== -1) {
        const open = i + name.length;
        let depth = 0, close = -1;
        for (let k = open; k < out.length; k++) {
          if (out[k] === '(') depth++;
          else if (out[k] === ')') { depth--; if (!depth) { close = k; break; } }
        }
        if (close === -1) break;
        out = out.slice(0, i) + out.slice(open + 1, close) + out.slice(close + 1);
      }
      return out;
    };
    const norm = (t) => unwrap(unwrap(strip(t), 'toIsoDate'), 'toUsDate');
    for (const fn of ['currentDraftPayload','applyLoadDraft']) {
      ck(`draft: ${fn} differs ONLY by the date conversion`,
         !!grabFn(web,fn) && norm(grabFn(web,fn)) === norm(grabFn(app,fn)));
    }
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
  // INVERTED 2026-08-29, deliberately. This used to assert the bubble stayed
  // hidden when neither element was visible — "don't guess". That default cost
  // the feature: Apsara reported "yard assistant not there", and a gate that
  // defaults to OFF turns every state I failed to anticipate into a silently
  // missing feature with no way to diagnose it.
  //
  // It now fails SAFE: hidden only when the login screen is definitively up.
  // The requirement was only ever "not on the sign-in page", and this meets it
  // while failing in the harmless direction — at worst a bubble on a screen it
  // need not be on, rather than no assistant at all.
  els = { loginScreen: mkEl(true), appShell: mkEl(true) };
  ck('bot: an unrecognised state SHOWS the bubble rather than losing it', isSignedIn() === true);
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
    // paymentBadgeHtml reads two free variables besides payMoney since
    // 2026-09-23: esc, and IS_SUPER — the Jarvis profile is the only one that
    // gets a clickable badge on a settled load. Both are injected so the
    // function runs here exactly as it does on the page, and so the two
    // profiles can be compared below.
    const esc = (v) => String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const mkBadge = (isSuper) =>
      new Function('payMoney','esc','IS_SUPER','return '+grab('paymentBadgeHtml'))(payMoney, esc, isSuper);
    const badge = mkBadge(false);
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

    // ── THE WAY BACK INTO A SETTLED LOAD ──────────────────────────────
    // Apsara, 2026-09-23: "Make the paid badge open only on jarvis profile."
    // A settled load hides Pay, and Pay is the only other way into the
    // payment history — so if this badge stops being clickable for her, a
    // wrongly paid load becomes unreversible again with nothing to show it.
    const superBadge = mkBadge(true);
    const settledCases = [['paid', { paid: 8822, pending: 0, status: 'paid' }],
                          ['overpaid', { paid: 9000, over: 178, status: 'overpaid' }]];
    for (const [label, pay] of settledCases) {
      ck(`${p}: ${label} badge opens the payments for the Jarvis profile`,
         /pay-badge-open/.test(superBadge({ id: 'L1', payment: pay })),
         superBadge({ id: 'L1', payment: pay }));
      ck(`${p}:   and carries the load it belongs to`,
         /data-open-payments="L1"/.test(superBadge({ id: 'L1', payment: pay })));
      ck(`${p}:   but NOT for an ordinary admin`,
         !/pay-badge-open/.test(badge({ id: 'L1', payment: pay })),
         badge({ id: 'L1', payment: pay }));
    }
    // A load still owing is reached by Pay, which is where a payment is
    // added — this badge must not become a second door to the same place.
    ck(`${p}: a part-paid badge never opens, even for Jarvis`,
       !/pay-badge-open/.test(superBadge({ id: 'L1', payment: { paid: 1, pending: 2, status: 'partial' } })));
    ck(`${p}: nothing is shown when nothing has been paid`, badge({ payment:{ paid:0 } }) === '');

    // The totals line under the item rows, rendered for real.
    const fmtAmount = new Function('return ' + grab('fmtAmount'))();
    const mkRow = (g,t,n,a) => { const v={'.ld-item-gross':g,'.ld-item-tare':t,'.ld-item-net':n,'.ld-item-amount':a};
      return { querySelector: (s) => (s in v) ? { value: v[s]==null?'':String(v[s]) } : null }; };
    let elx = { innerHTML:'' };
    // Third argument is updateTruckingSummary — see the note on run() above.
    new Function('document','fmtAmount','updateTruckingSummary', grab('updateItemTotals') + ';updateItemTotals();')(
      { getElementById: () => elx, querySelectorAll: () => [mkRow(4210,200,4010,'$8,822.00'), mkRow(3475,180,3295,'$7,249.00')] },
      fmtAmount, () => {});
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
    // esc and IS_SUPER injected — see the note on the other lift above.
    const esc2 = (v) => String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const badge = new Function('payMoney','esc','IS_SUPER','return '+grab('paymentBadgeHtml'))(payMoney, esc2, false);
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

// ── Proforma wizard parity — payment terms ─────────────────────────────────
// Apsara, 2026-09-02: "mimic this proforma behaviour in docs of mobile app",
// after the dashboard's wizard was changed on 2026-09-01 to ASK for payment
// terms alongside the material instead of leaving it to the details step.
//
// Why this belongs in a parity file rather than a mobile-only one: payment
// terms stopped being a PDF-only field on 2026-09-01. It is now what
// helpers/proformaSheetLog.js writes into the Terms column of the Edge Metals
// sheet. Two screens that ask for it differently would put different things in
// one financial column depending on which device the proforma was raised from.
{
  const dash = fs.readFileSync(R + 'dashboard/documents.html', 'utf8');
  const mob  = fs.readFileSync(R + 'mobile-app/www/index.html', 'utf8');

  // 1. Both ask on the MATERIAL step, not only on the details/review step.
  ck('dashboard asks for payment terms on the material step',
     /id="pfWiz_payment_term"/.test(dash));
  ck('mobile asks for payment terms on the material step',
     /id="pfw_paymentTerm2"/.test(mob));

  // 2. Both offer the same suggestions, so the two screens cannot drift into
  //    different house wordings for the same deal term.
  const listOf = (src) => {
    const m = src.match(/PF_PAY_TERM_SUGGESTIONS\s*=\s*\[([\s\S]*?)\]/);
    if (!m) return null;
    return (m[1].match(/'([^']+)'/g) || []).map(x => x.slice(1, -1));
  };
  const dl = listOf(dash), ml = listOf(mob);
  ck('dashboard defines a payment-terms suggestion list', Array.isArray(dl) && dl.length > 0);
  ck('mobile defines one too', Array.isArray(ml) && ml.length > 0);
  ck('the two suggestion lists are identical', JSON.stringify(dl) === JSON.stringify(ml));
  ck('LC is offered on both', !!dl && dl.includes('LC') && !!ml && ml.includes('LC'));

  // 3. Both prefill from this customer's pricing memory. The mobile side was
  //    fetching /api/customer-pricing/lookup, reading trade_terms and
  //    port_discharge off the response, and DROPPING payment_terms — so a
  //    customer on LC arrived on the standard T/T wording. That is the bug
  //    this assertion exists to keep fixed.
  ck('dashboard applies remembered payment terms', /info\.payment_terms/.test(dash));
  ck('mobile applies remembered payment terms',    /info\.payment_terms/.test(mob));

  // 4. Neither may overwrite what she typed. Both guard with a touched flag.
  ck('dashboard guards her typing', /_pfPaymentTermFromWizard/.test(dash));
  ck('mobile guards her typing',    /paymentTermTouched/.test(mob));

  // 5. Both still send the field the sheet log reads. A rename here produces a
  //    blank Terms column rather than an error, so it is pinned on both sides.
  ck('dashboard sends payment_term', /payment_term:/.test(dash));
  ck('mobile sends payment_term',    /payment_term: pfw\.paymentTerm/.test(mob));

  // 6. Per-container invoice numbering needs item_code sent ALONGSIDE
  //    container_no on both, or proformaSheetLog.js cannot build
  //    "<date>_<item>_<container>" and the sheet gets a bare number.
  ck('mobile sends item_code per container', /item_code: docDeriveItemCode/.test(mob));

  // 7. Dates: MM/DD/YYYY display with a real picker, on both.
  for (const [label, src] of [['dashboard', dash], ['mobile', mob]]) {
    ck(`${label} tidies date fields to MM/DD/YYYY`, /function wireUsDateField/.test(src));
    ck(`${label} attaches a calendar picker to them`,
       /type = 'date'|type=\x27date\x27|native\.type = 'date'/.test(src) || /showPicker/.test(src));
  }
}

// ── A SALE TAKES MONEY IN, ON BOTH CLIENTS ──────────────────────────────
// Apsara, 2026-09-15: "In add sales ,there should be receive payment na
// instead of pay..WHy didnt you tell me taht?" — and then, asked what she
// meant: "I am telling about add sales in mobile app".
//
// The Loads list merges purchases and sales (the map that sets _kind aliases
// a sale's buyer into `seller`), and every word around the money was written
// for a purchase: a Pay button, "Record payment", "Load total", "already
// paid". On a row she SOLD that describes money leaving for material she is
// being paid for.
//
// The ledger was already right — helpers/spendReport.js marks load_kind
// 'sale' as direction 'in' and labels it "Sale" — so this was never a money
// bug, only a reading one. That is the version that looks considered while
// saying the opposite of what happened.
//
// PINNED ON BOTH FILES because the screen exists twice, which is this file's
// whole reason to exist. The app is the one she was actually looking at.
{
  const dash = fs.readFileSync(R + 'dashboard/index.html', 'utf8');
  const mob  = fs.readFileSync(R + 'mobile-app/www/index.html', 'utf8');

  for (const [label, src] of [['dashboard', dash], ['mobile', mob]]) {
    ck(`${label}: the button on a SALE says Receive payment`,
       /_kind === 'sale' \? 'Receive payment' : 'Pay'/.test(src),
       'a sale row offering "Pay" reads as money going out');
    ck(`${label}:   while a purchase still says Pay`,
       /: 'Pay'\}<\/button>/.test(src));

    const modal = grabFrom(label === 'dashboard' ? 'dashboard/index.html' : 'mobile-app/www/index.html',
                           'openPayModal');
    ck(`${label}: the modal decides its own direction`,
       /const sale = payingLoad\.kind === 'sale'/.test(modal), modal.slice(0, 120));
    ck(`${label}:   retitling itself Receive payment for a sale`,
       /sale \? 'Receive payment' : 'Record payment'/.test(modal));
    ck(`${label}:   and reporting money already RECEIVED, not paid`,
       /already \$\{sale \? 'received' : 'paid'\}/.test(modal),
       '"already paid" on a sale is the same inversion one line down');
    ck(`${label}:   calling the row a Sale rather than a Load`,
       (modal.match(/sale \? 'Sale' : 'Load'/g) || []).length >= 1, modal.slice(-400));
    ck(`${label}:   with no bare "already paid" left on the sale path`,
       !/already paid \$\{payMoney/.test(modal));
  }

  // The markup the title is written into has to exist, or the assignment is a
  // silent no-op and the heading stays "Record payment" forever.
  for (const [label, src] of [['dashboard', dash], ['mobile', mob]])
    ck(`${label}: the pay modal heading has an id to write to`,
       /id="payModalTitle"/.test(src));
}

// ── EXPENSES EXIST ON BOTH CLIENTS ──────────────────────────────────────
// Apsara, 2026-09-15: "there is a expense tab in app but not website".
//
// True since the tab was built on 2026-08-19. The website carried a single
// "Expenses $X" figure inside the Spend Report, so what was spent could be
// totalled at the desk and never read — which is also why "check in expenses"
// had nowhere to go.
//
// THIS FILE EXISTS TO CATCH THAT AND DID NOT, because it only ever guarded
// the Load form. The two clients have now drifted in BOTH directions: Edge
// Metals is website-only, Expenses was app-only. So the rules the two expense
// screens share are asserted on both files here, and every rule below is one
// somebody could plausibly "simplify" on one side alone.
{
  const dash = fs.readFileSync(R+'dashboard/index.html','utf8');
  const mob  = fs.readFileSync(R+'mobile-app/www/index.html','utf8');

  for (const [label, src] of [['dashboard', dash], ['mobile', mob]]) {
    ck(`expenses: ${label} has the tab`, /renderExpensesTab/.test(src));
    ck(`expenses: ${label}   can add, edit and delete`,
       /openExpenseModal/.test(src) && /btn-edit-expense/.test(src)
       && /btn-delete-expense/.test(src) && /method: 'DELETE'/.test(src));
    // Every list comes from the SERVER. Hardcoding any of them lets the form
    // offer something the server rejects — an option that silently does not
    // take, which is how "cash app" once saved as null.
    ck(`expenses: ${label}   takes its categories from the server`,
       /expenseCategories = data\.categories/.test(src));
    ck(`expenses: ${label}   and its methods, default and retired list`,
       /expenseMethods = data\.methods/.test(src)
       && /expenseDefaultMethod = data\.default_method/.test(src)
       && /expenseRetiredMethods = Array\.isArray\(data\.retired_methods\)/.test(src));
    // A retired method on an existing expense is kept and marked; a legacy
    // free-text one shows blank. Her rule: "leave old entries blank".
    ck(`expenses: ${label}   keeps a retired method as a marked option`,
       /no longer offered/.test(src));
    ck(`expenses: ${label}   and offers back only what the server accepts`,
       /acceptable \? \(expenseMethods/.test(src) || /acceptable \|\| acceptable\.includes/.test(src),
       'otherwise legacy free text becomes a selectable option that saves as null');
    // The default must not reach the EDIT path: an old expense with no method
    // would come up reading "Cash", and saving would rewrite it AND withdraw
    // from petty cash for money that may never have left the box.
    ck(`expenses: ${label}   never defaults the method on an edit`,
       /: \(expenseDefaultMethod \|\| ''\)/.test(src),
       'the default belongs to a NEW expense only');
    // A cash expense draws petty cash down. A negative balance nobody
    // mentions is one nobody reconciles.
    ck(`expenses: ${label}   warns when petty cash did not cover it`,
       /cash_shortfall/.test(src));
    ck(`expenses: ${label}   and strips our internal Validation: label`,
       /replace\(\/\^Validation:/.test(src));
  }

  // The same field list on both, so the two screens can be diffed by eye.
  for (const id of ['exp_date','exp_amount','exp_category','exp_description','exp_vendor','exp_payment']) {
    ck(`expenses: both forms have ${id}`,
       new RegExp('id="'+id+'"').test(dash) && new RegExp('id="'+id+'"').test(mob));
  }

  // ── AND THE MODAL HAS TO EXIST WHEN THE TAB DOES ──────────────────────
  // The first version of the website tab put this markup beside #payModal,
  // which LOOKS like page markup and is not: it lives inside renderLoads's
  // `$('viewRoot').innerHTML = ...` template, so it existed only while the
  // Loads tab was on screen and every id was null anywhere else. Built on
  // demand and appended to body now, like openLedgerForm.
  ck('expenses: the website builds its modal on demand, not inside another tab',
     /document\.body\.insertAdjacentHTML\('beforeend', expenseModalHtml\(\)\)/.test(dash),
     'markup inside renderLoads only exists while Loads is rendered');
  ck('expenses:   and removes it on close, so none stack up',
     /const el = \$\('expenseModal'\);\s*\n\s*if \(el\) el\.remove\(\);/.test(dash));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
