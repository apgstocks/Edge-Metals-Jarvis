// ── tests/digest-precision.js ──────────────────────────────────────────────
// run: node tests/digest-precision.js
//
// Apsara, 2026-09-06: "waiting on her/team is fine. false positive is bad."
//
// That sentence is the precision/recall dial, set by the person who reads the
// list. Being wrong toward her own team costs a glance. Putting mail in her
// list that needed nothing from Edge Metals costs trust in the whole digest,
// and a digest she stops believing is worse than no digest.
//
// WHAT THIS PINS
//
// 1. An unstated direction is no longer read as "her". The schema defaulted
//    waiting_on to 'her', so a model response that simply did not mention
//    direction became the strongest, most disruptive claim available — from
//    no evidence at all.
//
// 2. Nothing is dropped to buy that precision. The dial used to have two
//    positions: flag it as hers, or bin it and never mention it again.
//    Borderline items now sit in an "I'm not sure about" bucket — still shown,
//    still numbered so "reply to 4" works, just not counted in "N emails
//    waiting on you".
//
// 3. It still FAILS OPEN on absence of evidence. My first attempt suppressed
//    needs_reply when the model was silent and headers were unreadable. That
//    is exactly what addressing() refuses to do a hundred lines earlier — "a
//    missing To is not evidence that someone else was asked" — with a
//    near-miss production outage behind the comment. Corrected: unestablished
//    means hedged, never hidden.
//
// The footer assertions are here because adding the bucket immediately broke
// the footer: an unsure-only digest claimed "these are things others owe you",
// the same contradiction that hit the colleague-only case on 31 Aug. A summary
// line that argues with the list above it teaches the reader to skip both.
const os=require('os'),fsb=require('fs'),pb=require('path');
process.env.DATA_DIR=fsb.mkdtempSync(pb.join(os.tmpdir(),'jarvis-prec-'));
const R=(p)=>pb.join(__dirname,'..',p);
const rw=require(R('workflow/replyWatch'));
let pass=0,fail=0;
const ck=(l,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?(pass++,console.log('  PASS  '+l)):(fail++,console.log(`  FAIL  ${l}\n    got:  ${JSON.stringify(g)}\n    want: ${JSON.stringify(w)}`));};
const it=(o)=>Object.assign({fromName:'X',summary:'s',asked_for:null,deadline:null,urgency:'normal',subject:'sub',needs_reply:false,confidence:0.9,waiting_on:'her'},o);

console.log('\n=== "waiting on you" must mean she was actually asked ===');
let d=rw.buildDigest([it({needs_reply:true,confidence:0.9,addressing_unknown:false})]);
ck('a solid, header-verified item is counted as hers', /1 email waiting on you/.test(d), true);

d=rw.buildDigest([it({needs_reply:true,confidence:0.65,addressing_unknown:false})]);
ck('a marginal-confidence item is NOT counted as hers', /email waiting on you/.test(d), false);
ck("...it is shown as 'not sure' instead", /1 I'm not sure about/.test(d), true);

// FAIL OPEN on absence of evidence. A missing To header is not evidence that
// somebody else was asked — addressing() says so explicitly, with a near-miss
// production outage behind the comment. So a headerless email the model DID
// judge, confidently, still counts as hers.
d=rw.buildDigest([it({needs_reply:true,confidence:0.9,addressing_unknown:true,direction_unstated:false})]);
ck('a confident judgement on a headerless email still counts as hers', /1 email waiting on you/.test(d), true);
// ...but if NOBODY established the direction — model silent AND headers
// unreadable — the claim rests on nothing and is hedged.
d=rw.buildDigest([it({needs_reply:true,confidence:0.9,addressing_unknown:true,direction_unstated:true})]);
ck('a direction nobody established is NOT counted as hers', /email waiting on you/.test(d), false);
ck('...it is shown as not sure', /I'm not sure about/.test(d), true);

console.log('\n=== nothing is silently dropped ===');
const items=[it({needs_reply:true,confidence:0.9}), it({needs_reply:true,confidence:0.62}), it({needs_reply:false,waiting_on:'them',asked_for:'the EDO number'})];
d=rw.buildDigest(items);
ck('every item is still listed and numbered', (d.match(/^\s*\d+\./gm)||[]).length, 3);
ck('the sure one is counted as hers', /1 email waiting on you/.test(d), true);
ck('the unsure one is counted separately', /1 I'm not sure about/.test(d), true);

console.log('\n=== the footer must not contradict the list ===');
d=rw.buildDigest([it({needs_reply:true,confidence:0.9,addressing_unknown:true,direction_unstated:true})]);
ck('an unsure-only digest does NOT claim these are things others owe her',
   /things others owe you/.test(d), false);
ck('...it still tells her how to reply', /reply to 1/.test(d), true);
ck('...and explains why they are in the maybe pile', /might not need you at all/.test(d), true);

console.log('\n=== the Tiffany case: a third party was also asked ===');
// REAL MISS, sent in by Apsara 2026-09-06. Tiffany at eccomelt wrote to
// Matthew Whittaker at schneider.com AND to Apsara, offering appointment
// slots. The digest read it as "Tiffany offers you Friday 9/11".
// Apsara: "she didnt offer me. she was mailing matthew."
//
// Headers cannot settle it alone — she IS on the To line. What was missing is
// that somebody outside BOTH companies was on that line too.
const ADDR = (to, cc, from) => rw.addressing(to, cc, 'apsara@edgemetals.com', null, from);

const tiff = ADDR('Matthew Ellis Whittaker <WhittakerM@schneider.com>, Apsara Gopalakrishnan <apsara@edgemetals.com>',
                  'Bose Alagarsamy <bose@edgemetals.com>', 'Tiffany Furleigh <tfurleigh@eccomelt.com>');
ck('Tiffany/Schneider: a third party on the To line is detected', tiff.thirdPartyInTo, true);
ck('...and named', tiff.thirdPartyLabel, 'Matthew Ellis Whittaker');
ck('...she is still correctly seen as addressed', tiff.inTo, true);

// MUST NOT over-trigger. Both of these are real headers from the same batch.
const andy = ADDR('Bose <bose@edgemetals.com>, Apsara <apsara@edgemetals.com>, Accounting <accounts@edgemetals.com>',
                  '', 'Andy Park <Export@mkmetaltrading.com>');
ck('an email to Edge Metals only is NOT third-party', andy.thirdPartyInTo, false);

// A sender copying THEIR OWN colleagues is completely normal and still means
// the question is for Edge Metals. This is the case that would have made the
// rule useless if it were written as "any external address on To".
const marc = ADDR('Accounting Edge <accounts@edgemetals.com>, Andy Park <Export@mkmetaltrading.com>, Nancy Kim <Account@mkmetaltrading.com>',
                  'Bose <bose@edgemetals.com>', 'Marc Kang <MarcKang@mkmetaltrading.com>');
ck("a sender's own colleagues on To are NOT a third party", marc.thirdPartyInTo, false);

d = rw.buildDigest([it({needs_reply:true,confidence:0.9,third_party_addressed:true,fromName:'Tiffany'})]);
ck('a third-party item is not counted as waiting on her', /email waiting on you/.test(d), false);
ck('...it is shown as not sure', /I'm not sure about/.test(d), true);

console.log('\n=== her stated preference: her/team is fine ===');
d=rw.buildDigest([it({needs_reply:false,waiting_on:'colleague',confidence:0.9})]);
ck('a colleague item is untouched by this change', /your team is handling/.test(d), true);
d=rw.buildDigest([it({needs_reply:false,waiting_on:'them',asked_for:'the EDO',confidence:0.9})]);
ck("an owed item is untouched", /you're waiting on 1/.test(d), true);

console.log('\n=== an unstated direction is no longer read as "her" ===');
const a=rw.assess;
(async()=>{
const Module=require('module');const orig=Module._load;
Module._load=function(req){const r=orig.apply(this,arguments);
 if(req==='../helpers/gemini'||(req&&req.endsWith&&req.endsWith('helpers/gemini')))
   return {...r,callGeminiJSON:async()=>({needs_reply:true,confidence:0.9,summary:'x'})}; // NO waiting_on
 return r;};
delete require.cache[require.resolve(R('workflow/replyWatch'))];
const rw2=require(R('workflow/replyWatch'));
const res=await rw2.assess({from:'a@b.com',subject:'s',body:'b',date:new Date().toISOString()});
// NOT dropped — shown as unsure. Suppressing it would fail closed on absence
// of evidence, which addressing() explicitly refuses to do.
ck('model omitted waiting_on + no headers -> still surfaced, not silently dropped', res && res.needs_reply, true);
ck('...but marked so the digest can hedge it', !!(res && res.direction_unstated && res.addressing_unknown), true);
const dd = rw2.buildDigest([Object.assign({fromName:'X',subject:'s'}, res)]);
ck('...and it lands in the not-sure bucket, not "waiting on you"', /I'm not sure about/.test(dd), true);
ck('...and it is recorded as unstated, not asserted', res && res.direction_unstated, true);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})();
