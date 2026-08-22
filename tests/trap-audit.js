// ADVERSARIAL TRAP AUDIT — runs against the REAL deployed brain.js.
// Run:  node tests/trap-audit.js
//
// Crosses EVERY pending type against EVERY class of message a human
// actually sends, and asserts that no pending can trap the manager.
// await_relay_reply is the one deliberate exception (a reply there is
// relayed verbatim to whoever asked, so "cancel" is real content).
//
// Built 2026-08-20 after three separate live bugs of exactly this shape
// were found in production rather than in testing.
//
// EXTENDED 2026-08-22 after this audit reported "no traps" while a REAL
// trap was live: with the end-of-day review (await_fact_batch) open,
// "Do we have any booking available for Houston?" got a canned "Reply
// with numbers" nag, and her actual question was never answered. Twice,
// on two different questions.
//
// Why the audit missed it: it only ever asserted TWO escapes — can you
// cancel out, and can a well-formed quote command jump the queue. Both
// were true for await_fact_batch, so it passed. Nobody ever asserted the
// thing Apsara actually cared about: CAN SHE ASK AN ORDINARY QUESTION AND
// GET AN ANSWER? The FREETEXT row was in the printed matrix the whole
// time, showing the nag — but no assertion looked at it, so it scrolled
// past as noise.
//
// The lesson generalizes beyond this bug: an audit only finds what it
// asserts on. Printing a value is not testing it. So there is now a THIRD
// assertion — QUESTION ESCAPE — using real questions from her actual
// working day, not synthetic filler like "what is going on".
//
// NOTE on `[arbitrated]`: since 2026-08-22 the pendings that must accept
// arbitrary text no longer assume the next message is the answer. They tag
// their decision `arbitrate: true`, and brain.js's process() asks
// helpers/pendingArbiter.js whether the message is an answer or a new
// request. This audit calls policyDecide directly, which is synchronous and
// therefore CANNOT run that step — so it marks those cells `[arbitrated]`
// and counts them as escaping. That is a real limitation to be aware of:
// this file verifies the arbiter is WIRED IN, not that its judgement is
// correct. Verdict quality needs a live Gemini run — see
// tests/arbiter-live.js.
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
 // Real questions from real working days — these are the ones that must
 // never be swallowed. Q_BOOKING and Q_MAIL are verbatim what Apsara sent
 // live on 2026-08-22 while the end-of-day review was open.
 ['Q_BOOKING','Do we have any booking available for Houston?'],
 ['Q_MAIL','check whether we received any mail from zimex recently'],
 ['Q_MONEY','who owes me money'],
 ['Q_ADDRESS','Junk car address'],
];

// Pendings whose valid answers are a CLOSED, checkable set (a digit, a
// listed name, a yes/no, a city). Anything not in that set is by
// definition not an answer, so a real question must be allowed through to
// normal classification instead of being met with a canned nag. These are
// the ones QUESTION ESCAPE is enforced on.
const CLOSED_SET = new Set([
 'await_fact_batch','await_pricelist_city','await_quote_truckers',
 'confirm_quote_lane','confirm_quote_trucker','await_contact_disambiguation',
 'await_email_confirm','await_domain_learn_confirm','await_bkg_no',
 'wizard_start','wizard_confirm','confirm_forward','await_followup_minutes',
]);

// Pendings that must accept ARBITRARY text as the answer (a cargo
// description, a container number, an email address, a relayed reply).
// These cannot distinguish a question from an answer by shape alone, so
// swallowing one is inherent to the design, NOT a bug to assert away.
// Reported separately as a known risk class — see the summary.
const VERBATIM_CAPTURE = new Set([
 'await_quote_cargo_details','await_quote_scale_tickets','await_container_number',
 'await_manual_email_address','await_domain_learn_name','await_quote_trucker_retry',
 'await_contact_quote_recipient_retry','await_relay_reply',
]);

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
      // A decision tagged `arbitrate` is NOT the final word — brain.js's
      // process() hands it to helpers/pendingArbiter.js, which can override
      // it and reclassify the message as a fresh request. policyDecide is
      // synchronous so it cannot make that call itself; this audit runs
      // against policyDecide alone, so without this marker it would report
      // an arbitrated pending as still swallowing questions.
      if (d.arbitrate) intent += ' [arbitrated]';
    } catch(e){ intent='ERROR:'+e.message; }
    rows.push({ptype,cls,intent});
  }
}

// TRAP DETECTION
console.log('\n########## TRAP AUDIT ##########\n');
const problems=[];
const verbatimRisk=[];
for (const [ptype] of PENDINGS) {
  const get = c => (rows.find(r=>r.ptype===ptype&&r.cls===c)||{}).intent || '(none)';
  const canCancel = ['CANCEL','CANCEL_WIDE','NEVERMIND'].some(c=>get(c)==='resolve_pending');
  const canFresh  = ['FRESH_QUOTE','FRESH_QUOTE_TYPO'].some(c=>get(c)==='get_quote');
  const relay = ptype==='await_relay_reply';

  // QUESTION ESCAPE — a real business question must reach real handling.
  // It counts as escaping if it resolves to a genuine answering intent OR
  // falls through to the AI classifier. It counts as SWALLOWED if it gets
  // a canned 'reply' nag or is captured as though it were the answer.
  const QCLASSES = ['Q_BOOKING','Q_MAIL','Q_MONEY','Q_ADDRESS'];
  const swallowed = QCLASSES.filter(c => {
    const i = get(c);
    if (i.includes('[arbitrated]')) return false; // the arbiter gets to override this
    return i === 'reply' || (i !== '(needsAI)' && i.endsWith('_received'));
  });
  const arbitrated = QCLASSES.some(c => get(c).includes('[arbitrated]'));
  const canAsk = swallowed.length === 0;

  const flag=[];
  if(!canCancel && !relay) flag.push('NO CANCEL ESCAPE');
  if(!canFresh && !relay) flag.push('NO FRESH-COMMAND ESCAPE');
  if(!canAsk && CLOSED_SET.has(ptype)) flag.push('SWALLOWS QUESTIONS: '+swallowed.join(','));
  const errs = rows.filter(r=>r.ptype===ptype&&r.intent.startsWith('ERROR'));
  if(errs.length) flag.push('THROWS: '+errs[0].intent);
  const status = flag.length?('  <-- '+flag.join(' | ')):'  ok';
  console.log(`${ptype.padEnd(38)} cancel=${canCancel?'Y':'N'} fresh=${canFresh?'Y':'N'} ask=${canAsk?'Y':'N'}${arbitrated?' (via arbiter)':''}${status}`);
  if(flag.length && !relay) problems.push({ptype,flag});
  if(!canAsk && VERBATIM_CAPTURE.has(ptype)) verbatimRisk.push({ptype,swallowed});
}

console.log('\n########## FULL MATRIX ##########\n');
let cur='';
for (const r of rows){
  if(r.ptype!==cur){cur=r.ptype;console.log('\n['+cur+']');}
  console.log(`   ${r.cls.padEnd(20)} -> ${r.intent}`);
}
console.log('\n########## SUMMARY ##########');
if(problems.length){ console.log('PROBLEMS FOUND:'); problems.forEach(p=>console.log(' - '+p.ptype+': '+p.flag.join(', '))); }
else console.log('No traps detected: every closed-set pending has a cancel escape, a fresh-command escape, AND lets a real question through.');

if(verbatimRisk.length){
  console.log('\n########## KNOWN RISK CLASS (not failures) ##########');
  console.log('These pendings must accept arbitrary text as the answer, so they');
  console.log('cannot tell a question from an answer by shape alone. A question');
  console.log('asked while one is open is captured as the answer. Inherent to the');
  console.log('design, escapable via "cancel" — but it is the remaining place');
  console.log('where Jarvis can still look like it ignored her:\n');
  verbatimRisk.forEach(v=>console.log('  '+v.ptype.padEnd(38)+' swallows: '+v.swallowed.join(',')));
  console.log('\nFixing this properly means asking the AI "is this an answer to the');
  console.log('open question, or a new request?" rather than assuming answer.');
}
process.exit(problems.length?1:0);
