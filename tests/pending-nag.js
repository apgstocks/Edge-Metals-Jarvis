// ── tests/pending-nag.js ───────────────────────────────────────────────────
// run: node tests/pending-nag.js
//
// Apsara, 2026-09-06: "What if i dont want pending list?" — and, asked which
// one and what instead: the "still waiting" nags, replaced by
// "tell me one at a time, as it arrives."
//
// WHAT SHE WAS DESCRIBING. The tail in brain.js appended a reminder after
// EVERY unrelated message for as long as a pending sat unanswered. Earlier in
// this same session she pasted one back at Jarvis verbatim: a question about
// Houston bookings answered with the booking PLUS "(Still waiting: end-of-day
// review — 1. remember: ... 2. remember: ...)". It is not a list she opens.
// It is a list that follows her around.
//
// THE RULE NOW, and the reason it is two rules rather than "stop nagging":
//
//   OPTIONAL — Jarvis raised it for its own benefit. Nobody is waiting, nothing
//   is held, an unanswered one costs nothing. These NEVER chase her; not
//   answering is an answer, and they expire on their own.
//
//   GATE — it is holding something of hers, above all an unsent drafted email.
//   Exactly ONE reminder, then silence. Not zero: sitting silently on a draft
//   she thinks went out is worse than one nudge. Not forever: that is the
//   thing she asked to stop.
//
// A new pending type is a GATE by omission. That direction is deliberate — an
// unwanted nag is an annoyance, a draft that vanishes without a word is a lost
// customer reply.
const os=require('os'),fsb=require('fs'),pb=require('path');
process.env.DATA_DIR=fsb.mkdtempSync(pb.join(os.tmpdir(),'jarvis-nag-'));
const R=(p)=>pb.join(__dirname,'..',p);
const brain=require(R('workflow/brain'));
const actions=require(R('workflow/actions'));
let pass=0,fail=0;
const ck=(l,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?(pass++,console.log('  PASS  '+l)):(fail++,console.log(`  FAIL  ${l}\n    got:  ${JSON.stringify(g)}\n    want: ${JSON.stringify(w)}`));};

console.log('\n=== which pendings are allowed to chase her ===');
const O=brain.OPTIONAL_PENDINGS;
ck('the end-of-day review she quoted back never nags', O.has('await_fact_batch'), true);
ck('the daily wizard poke never nags', O.has('wizard_start'), true);
ck('"what is this link for" never nags', O.has('await_link_purpose'), true);
// The ones HOLDING something of hers must stay gates.
for (const t of ['await_email_confirm','wizard_confirm','await_fact_conflict','await_manual_email_address','await_verify_apply','await_cc_pattern_confirm'])
  ck(`${t} is a GATE, not optional`, O.has(t), false);
ck('an unknown/new pending type defaults to GATE', O.has('await_something_new_2027'), false);

(async()=>{
console.log('\n=== a gate reminds once, then goes quiet ===');
const SENT=[];
actions.init({sendMessage:async(_c,t)=>{SENT.push(t);return true;},sendToManager:async()=>true,sendToTeam:async()=>true,pushAlert:async()=>true});
await actions.setPending('chatX',{type:'await_email_confirm',to:'a@b.com',target_name:'Zimex',subject:'S',body:'B'});
let p=actions.getPending('chatX');
ck('pending starts un-reminded', !!p.reminded_at, false);
await actions.markPendingReminded('chatX');
p=actions.getPending('chatX');
ck('marking records it', !!p.reminded_at, true);
ck('the pending itself SURVIVES — the draft is not thrown away', p.type, 'await_email_confirm');
ck('...and still holds what it was holding', p.body, 'B');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
})().catch(e=>{console.error('CRASHED:',e);process.exit(1);});
