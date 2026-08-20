// Simulates the exact live infinite-cancel-loop scenario against the REAL modules
const path='../data/brain.json'; const fs=require('fs');
const backup = fs.existsSync(path)? fs.readFileSync(path,'utf8') : null;
const actions = require('../workflow/actions.js');

// silence outbound sends, capture them instead
const sent=[];
actions._setSendHook && actions._setSendHook(t=>sent.push(t));

(async()=>{
 const CHAT='sim-test@g.us';
 // Clean slate
 await actions.clearAllPending(CHAT);

 console.log('=== 1. DUPLICATE STACKING (the root cause) ===');
 const mk = () => ({type:'await_quote_cargo_details',state:{originQuery:'Junk car',destinationQuery:'Eccomelt'}});
 let r = await actions.setPending(CHAT, mk());
 console.log('  1st setPending  ->', JSON.stringify(r));
 for (let i=2;i<=6;i++){
   r = await actions.setPending(CHAT, mk());
   console.log(`  ${i}th setPending  ->`, JSON.stringify(r));
 }
 const q = actions.getQueuedPendings ? actions.getQueuedPendings(CHAT) : null;
 console.log('  queue depth after 6 identical requests:', (q?q.length:'n/a'), '(was 5 before fix, expect 0)');

 console.log('\n=== 2. DIFFERENT lane still queues normally (no over-dedupe) ===');
 r = await actions.setPending(CHAT,{type:'await_quote_cargo_details',state:{originQuery:'LA',destinationQuery:'NY'}});
 console.log('  different lane  ->', JSON.stringify(r), '| queue depth:', actions.getQueuedPendings(CHAT).length, '(expect 1)');
 r = await actions.setPending(CHAT,{type:'await_quote_scale_tickets',state:{originQuery:'Junk car',destinationQuery:'Eccomelt'}});
 console.log('  different type  ->', JSON.stringify(r), '| queue depth:', actions.getQueuedPendings(CHAT).length, '(expect 2)');

 console.log('\n=== 3. "cancel all" drains EVERYTHING ===');
 const before = 1 + actions.getQueuedPendings(CHAT).length;
 const res = await actions.clearAllPending(CHAT);
 console.log(`  before: 1 active + ${before-1} queued = ${before} total`);
 console.log('  clearAllPending reported count:', res.count, '(expect', before, ')');
 console.log('  active after:', actions.getPending(CHAT), '| queue after:', actions.getQueuedPendings(CHAT).length, '(expect null / 0)');

 console.log('\n=== 4. No infinite loop: cancel-all leaves nothing to promote ===');
 const promoted = await actions.promoteQueued(CHAT);
 console.log('  promoteQueued returned:', promoted, '(expect null — nothing left to re-ask)');

 if(backup!==null) fs.writeFileSync(path,backup);
 console.log('\nDone. brain.json restored.');
})().catch(e=>{ if(backup!==null) fs.writeFileSync(path,backup); console.error('ERR',e); });
