// ADVERSARIAL TRAP AUDIT — runs against the REAL deployed brain.js.
// Run:  node tests/trap-audit.js
//
// Crosses EVERY pending type against EVERY class of message a human
// actually sends, and asserts that no pending can trap the manager:
// each one must have both a cancel escape and a fresh-command escape.
// await_relay_reply is the one deliberate exception (a reply there is
// relayed verbatim to whoever asked, so "cancel" is real content).
//
// Built 2026-08-20 after three separate live bugs of exactly this shape
// were found in production rather than in testing.
const brain = require('../workflow/brain.js');

const PENDINGS = [
 ['await_quote_cargo_details',{state:{originQuery:'Junk car',destinationQuery:'Eccomelt'}}],
 ['await_quote_scale_tickets',{state:{originQuery:'Junk car',destinationQuery:'Eccomelt'}}],
 ['await_quote_truckers',{options:['NTG','TQL','Matthew'],state:{originQuery:'LA',destinationQuery:'NY'}}],
 ['await_quote_trucker_retry',{unresolvedNames:['Bob'],state:{}}],
 ['await_contact_quote_recipient_retry',{state:{recipientQuery:'Ecco',details:'junk cars'}}],
 ['confirm_quote_lane',{options:['LA','LB'],field:'origin',state:{originQuery:'LA',destinationQuery:'NY'}}],
 ['confirm_quote_trucker',{options:['NTG','NTG2'],state:{}}],
 ['await_container_number',{}],
 ['await_manual_email_address',{target_name:'Jose',details:'pricing'}],
 ['await_domain_learn_name',{needs_name:['x@y.com'],domain:'y.com'}],
 ['await_domain_learn_confirm',{domain:'y.com'}],
 ['await_email_confirm',{target_name:'Jose',to:'j@x.com',subject:'S',body:'B'}],
 ['await_contact_disambiguation',{matches:[{name:'A',email:'a@x.com'}]}],
 ['await_bkg_no',{nextIntent:'show_booking_status'}],
 ['await_pricelist_city',{}],
 ['await_fact_batch',{candidates:['f1','f2']}],
 ['wizard_start',{}],
 ['wizard_confirm',{bkg_no:'B1',supplier_name:'S',trucker_name:'T'}],
 ['confirm_forward',{trucker_name:'T',bkg_no:'B1'}],
 ['await_followup_minutes',{}],
 ['await_relay_reply',{}],
];

// Message classes a human actually sends
const MSGS = [
 ['CANCEL','cancel'],
 ['CANCEL_WIDE','cancel all the quote requests'],
 ['NEVERMIND','nevermind'],
 ['FRESH_QUOTE','Send quote request from Junk car to Eccomelt'],
 ['FRESH_QUOTE_TYPO','XFSend quote request from Junk car to Eccomelt'],
 ['FRESH_CONTACT_QUOTE','quote to Eccomelt for junk cars'],
 ['YES','yes'],
 ['NO','no'],
 ['HELP','help'],
 ['MENU','menu'],
 ['CARGO','Al combo 40000 lbs $5000'],
 ['NUMBER','1'],
 ['FREETEXT','what is going on'],
 ['STATUS_CMD','status 274150389'],
];

const ctxFor = (ptype, pextra, text) => ({
  isManagerOrTeam:true, isManager:true, isTeam:false,
  pendingAction:{type:ptype,...pextra},
  text, textLower:text.toLowerCase(), chatId:'test@g.us',
  session:{menuContext:null}, activeBooking:null,
});

const rows=[];
for (const [ptype,pextra] of PENDINGS) {
  for (const [cls,text] of MSGS) {
    let intent='(needsAI)';
    try {
      const d = brain.policyDecide(ctxFor(ptype,pextra,text));
      intent = d.needsAI ? '(needsAI)' : d.intent;
    } catch(e){ intent='ERROR:'+e.message; }
    rows.push({ptype,cls,intent});
  }
}

// TRAP DETECTION
console.log('\n########## TRAP AUDIT ##########\n');
const problems=[];
for (const [ptype] of PENDINGS) {
  const get = c => (rows.find(r=>r.ptype===ptype&&r.cls===c)||{}).intent || '(none)';
  const canCancel = ['CANCEL','CANCEL_WIDE','NEVERMIND'].some(c=>get(c)==='resolve_pending');
  const canFresh  = ['FRESH_QUOTE','FRESH_QUOTE_TYPO'].some(c=>get(c)==='get_quote');
  const relay = ptype==='await_relay_reply';
  const flag=[];
  if(!canCancel && !relay) flag.push('NO CANCEL ESCAPE');
  if(!canFresh && !relay) flag.push('NO FRESH-COMMAND ESCAPE');
  const errs = rows.filter(r=>r.ptype===ptype&&r.intent.startsWith('ERROR'));
  if(errs.length) flag.push('THROWS: '+errs[0].intent);
  const status = flag.length?('  <-- '+flag.join(' | ')):'  ok';
  console.log(`${ptype.padEnd(38)} cancel=${canCancel?'Y':'N'} fresh=${canFresh?'Y':'N'}${status}`);
  if(flag.length && !relay) problems.push({ptype,flag});
}

console.log('\n########## FULL MATRIX ##########\n');
let cur='';
for (const r of rows){
  if(r.ptype!==cur){cur=r.ptype;console.log('\n['+cur+']');}
  console.log(`   ${r.cls.padEnd(20)} -> ${r.intent}`);
}
console.log('\n########## SUMMARY ##########');
if(problems.length){ console.log('PROBLEMS FOUND:'); problems.forEach(p=>console.log(' - '+p.ptype+': '+p.flag.join(', '))); }
else console.log('No traps detected: every pending type (except the deliberately-excluded relay) has both a cancel escape and a fresh-command escape.');
