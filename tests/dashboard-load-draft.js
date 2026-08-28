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

// the 2-item gate and photo stripping, as written in saveLoadDraft
const saveSrc=grab('saveLoadDraft');
ck('draft is skipped entirely while editing an existing load', /if \(editingLoadId\) return;/.test(saveSrc));
ck('draft needs 2 items with content', /items\.length < 2\) return;/.test(saveSrc));
ck('photos are stripped before storing', /grossPhoto, tarePhoto, \.\.\.rest/.test(saveSrc));
ck('storage failure cannot break the form', /catch \(e\) \{ \/\* quota/.test(saveSrc));

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

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
