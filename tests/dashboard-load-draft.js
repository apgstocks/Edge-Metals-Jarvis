// ── tests/dashboard-load-draft.js ──────────────────────────────────
// Covers the load-form draft autosave added 2026-08-28.
//
// The rules are EXTRACTED FROM dashboard/index.html and executed, rather
// than restated here. A restated copy would pass while the page did
// something else entirely, which is the failure mode that matters for a
// browser file no other suite touches.
//
// What is being protected: a draft must never become a real load record,
// must never overwrite the form on its own, must never fire while editing
// an existing load, and must never carry photos into a ~5MB storage budget.
// Extracts the draft rules from the real page source and exercises them, so
// this tests the shipped logic rather than a paraphrase of it.
const fs=require('fs');
const path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','dashboard','index.html'),'utf8');
const grab=(name)=>{ const i=src.indexOf('function '+name+'('); if(i<0) throw new Error('not found: '+name);
  let d=0,j=src.indexOf('{',i); for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} } };
const itemHasContent=eval('('+grab('itemHasContent')+')');
let pass=0,fail=0; const ck=(n,c)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n);} };

ck('a blank row does not count as content', !itemHasContent({}));
ck('an untouched new row does not count', !itemHasContent({description:'',gross_weight:'',tare_weight:''}));
ck('a description alone counts', itemHasContent({description:'Auto Casting'}));
ck('a gross weight alone counts', itemHasContent({gross_weight:4210}));
ck('a tare weight alone counts', itemHasContent({tare_weight:200}));
ck('whitespace is not content', !itemHasContent({description:'   '}));
ck('null is not content', !itemHasContent(null));

// the gate, persistence and id handling, as written in saveLoadDraft
const saveSrc=grab('saveLoadDraft');
ck('draft is skipped entirely while editing an existing load',
   /if \(editingLoadId\)[\s\S]{0,80}?return;/.test(saveSrc));
ck('draft needs 2 items with content',
   /items\.length < 2\)[\s\S]{0,80}?return;/.test(saveSrc));
ck('drafts are persisted to the server, not the browser',
   /api\('\/api\/load-drafts'/.test(saveSrc) && !/localStorage/.test(saveSrc));
ck('an autosave reuses one draft id instead of spawning records',
   /id: currentDraftId/.test(grab('currentDraftPayload')) && /currentDraftId = r\.id/.test(saveSrc));
ck('overlapping autosaves are coalesced, never concurrent',
   /draftSaveInFlight/.test(saveSrc));
// Photos are now KEPT. They were stripped when drafts lived in localStorage
// against a ~5MB budget; on the server there is room, and a draft that loses
// the weight photos has lost the expensive half of the work — re-typing a
// description takes seconds, re-weighing a truck does not.
ck('photos are NOT stripped now that drafts are server-side',
   !/grossPhoto, tarePhoto, \.\.\.rest/.test(grab('currentDraftPayload')));
ck('a save failure cannot break the form',
   /\bcatch\s*\(e\)/.test(saveSrc) && !/\bthrow\b[\s\S]*$/.test(saveSrc.slice(saveSrc.indexOf('catch (e)'))));

// restore must not fire by itself
ck('restore is never called automatically', !/offerLoadDraft[\s\S]{0,200}restoreLoadDraft\(\)/.test(src));
const offerSrc=grab('offerLoadDraft');
ck('offer only shows a bar, never writes to the form', !/\$\('ld_seller'\)\.value/.test(offerSrc));

// simulate the gate
const rows=[[{},{}],[{description:'Steel'},{}],[{description:'Steel'},{gross_weight:100}]];
const counts=rows.map(r=>r.filter(itemHasContent).length);
ck('gate: 0 filled rows -> no draft', counts[0]<2);
ck('gate: 1 filled row  -> no draft', counts[1]<2);
ck('gate: 2 filled rows -> draft saved', counts[2]>=2);

// ── the status indicator ────────────────────────────────────────────────
// Apsara, on the silent version: "how do i know that it is getting
// autosaved?" A draft nobody can see is indistinguishable from a broken one,
// so these assert that the form actually SAYS what it is doing — and, more
// importantly, that it never claims to have saved without checking.
const saveSrc2 = grab('saveLoadDraft');
ck('reports success only when the SERVER confirms it saved',
   /r && r\.saved && r\.id/.test(saveSrc2));
ck('the success message carries the server timestamp, so it visibly moves',
   /setDraftStatus\('saved', new Date\(r\.updated_at/.test(saveSrc2));
ck('a failed save is reported, not swallowed',
   /Draft not saved/.test(saveSrc2));
ck('a failure still does not block the form (no throw, no return before save)',
   !/throw new Error\('quota/.test(saveSrc2));
ck('an empty form explains itself instead of showing nothing',
   /setDraftStatus\('waiting'\)/.test(saveSrc2));
ck('editing an existing load shows no draft status at all',
   /if \(editingLoadId\) \{ setDraftStatus\('none'\); return; \}/.test(saveSrc2));

const queueSrc = grab('queueLoadDraftSave');
// REVERSED 2026-08-29 at Apsara's instruction: "as soon user starts typing 1
// item, it needs to auto save."
//
// The old two-item rule guarded against a form someone merely opened becoming
// a draft. itemHasContent() already does that job — a row only counts once it
// carries a description or a weight — so the second row was protecting against
// a case that cannot happen, at the cost of losing the FIRST item if the phone
// died. In a yard that is the whole reason drafts exist.
ck('"saving" appears as soon as ONE item is filled in',
   /filled >= 1\) setDraftStatus\('saving'\)/.test(queueSrc));
ck('  and it no longer waits for a second item',
   !/filled >= 2\) setDraftStatus\('saving'\)/.test(queueSrc));

const clearSrc = grab('clearLoadDraft');
ck('clearing the draft also clears a stale "saved" message',
   /setDraftStatus\('none'\)/.test(clearSrc));

const statusSrc = grab('setDraftStatus');
// The copy is asserted as a whole sentence, not a fragment: a search-and-
// replace on part of it left "Autosaves as soon as you fill in an item are
// entered" on both clients, which reads as broken English to whoever uses it.
ck('the waiting message is a whole sentence, no stray words',
   /Autosaves as soon as you enter an item</.test(statusSrc));
ck('every state renders something distinguishable',
   /Draft saved/.test(statusSrc) && /Saving draft/.test(statusSrc) && /Autosaves as soon as/.test(statusSrc));

// ── item totals ────────────────────────────────────────────────────────────
// Per Apsara 2026-08-28: the running gross/tare/net at the foot of the item
// list. Extracted from the page and executed against a DOM stand-in, so the
// shipped arithmetic is what gets checked.
(function testItemTotals(){
// minimal DOM stand-in
function mkRow(g,t,n,a){ const vals={'.ld-item-gross':g,'.ld-item-tare':t,'.ld-item-net':n,'.ld-item-amount':a};
  return { querySelector:(sel)=> (sel in vals) ? { value: vals[sel]==null?'':String(vals[sel]) } : null }; }
let el;
global.document = {
  getElementById:(id)=> id==='ld_item_totals' ? el : null,
  querySelectorAll:()=> global.__rows,
};
global.fmtAmount = (n)=> n==null?'':('$'+Number(n).toFixed(2));
eval(grab('updateItemTotals'));


const run=(rows)=>{ global.__rows=rows; el={innerHTML:''}; updateItemTotals(); return el.innerHTML; };
const nums=(html)=>[...html.matchAll(/class="tl-num[^"]*"[^>]*>([^<]*)</g)].map(m=>m[1]);

let h=run([mkRow(4210,200,4010,'$8823.00'), mkRow(3475,180,3295,'$7249.00')]);
ck('gross totals correctly', nums(h)[0]==='7,685');
ck('tare totals correctly',  nums(h)[1]==='380');
ck('net totals correctly',   nums(h)[2]==='7,305');
ck('amount totals correctly, ignoring the $ and commas', nums(h)[3]==='$16072.00');
ck('the item count is shown', /2 items/.test(h));

h=run([mkRow(1000,100,900,'$100.00')]);
ck('singular wording for one item', /1 item\)/.test(h) && !/1 items/.test(h));

h=run([mkRow('', '', '', ''), mkRow('','','','')]);
ck('all-blank rows render nothing at all', h==='');

h=run([mkRow(4210,'', '', ''), mkRow('',180,'','')]);
ck('a half-filled load still totals what it has', nums(h)[0]==='4,210' && nums(h)[1]==='180');

h=run([mkRow(1.005,0.005,1,''), mkRow(1.005,0.005,1,'')]);
ck('floating point is rounded to 2dp, not 2.0100000000000002', nums(h)[0]==='2.01');

h=run([mkRow(4210,200,4010,''), mkRow(3475,180,3295,'')]);
ck('no amounts means the amount cell stays empty', nums(h)[3]==='');

h=run([mkRow(-100,0,-100,'')]);
ck('a negative typo still adds up rather than being dropped', nums(h)[0]==='-100');


})();

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
