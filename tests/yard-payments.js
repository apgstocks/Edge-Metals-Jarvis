// ── tests/yard-payments.js ─────────────────────────────────────────────────
// Payments recorded against a load, per Apsara 2026-08-28: Pay beside
// Edit/Delete, mode + amount, anything short of the total is partial with a
// pending balance, and it has to show on the invoice.
//
// Three layers, because a bug in any one of them is a wrong number attached to
// money: the LEDGER arithmetic, the API contract, and the PDF actually
// rendering it. The PDF and API tests render/serve for real and read the
// result back rather than trusting that the right values were passed along.

const { execSync } = require('child_process');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'payments-'));
process.env.DATA_DIR=tmp; process.env.API_TOKEN='payments-test-token';
const R=path.join(__dirname,'..')+path.sep;
let pass=0,fail=0; const failures=[];
const ck=(n,c)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;failures.push(n);console.log('  FAIL  '+n);} };
const section=(t)=>console.log('\n=== '+t+' ===');

(async()=>{
  const P=require(R+'helpers/payments.js');
  section('the ledger');
  const S=(id,amt)=>P.paymentSummary(id,amt);
  ck('a load with no payments is unpaid', S('L1',1000).status==='unpaid' && S('L1',1000).pending===1000);

  await P.addPayment({load_id:'L1',mode:'Zelle',amount:400});
  let s=S('L1',1000);
  ck('a part payment reads as partial', s.status==='partial');
  ck('paid is right', s.paid===400);
  ck('pending is right', s.pending===600);

  await P.addPayment({load_id:'L1',mode:'Cash',amount:600});
  s=S('L1',1000);
  ck('settling the rest reads as paid', s.status==='paid');
  ck('pending drops to zero', s.pending===0);
  ck('both payments are kept as history', s.payments.length===2);
  ck('the modes are both recorded', s.payments.map(p=>p.mode).join()==='Zelle,Cash');

  // the floating-point case that would otherwise never settle
  const amt = 4010*2.2;   // 8822.000000000001
  await P.addPayment({load_id:'L2',mode:'Wire',amount:8822});
  ck('a load paid to the cent reads as PAID despite float error', S('L2',amt).status==='paid');
  ck('...and shows no phantom pending balance', S('L2',amt).pending===0);

  await P.addPayment({load_id:'L3',mode:'Cheque',amount:1500});
  s=S('L3',1000);
  ck('overpayment is flagged, not hidden', s.status==='overpaid');
  ck('overpayment never shows a negative pending', s.pending===0 && s.over===500);

  ck('an unpriced load reports paid but no balance', S('L4',null).status==='unpaid');
  await P.addPayment({load_id:'L4',mode:'Cash',amount:100});
  ck('...and says so rather than claiming paid in full', S('L4',null).status==='paid_amount_unknown' && S('L4',null).pending===null);

  let threw=null; try{ await P.addPayment({load_id:'L5',mode:'Zelle'}); }catch(e){threw=e.message;}
  ck('a payment with no amount is rejected', /amount is required/.test(threw||''));
  threw=null; try{ await P.addPayment({load_id:'L5',mode:'Bitcoin',amount:10}); }catch(e){threw=e.message;}
  ck('an unknown payment mode is rejected', /must be one of/.test(threw||''));
  threw=null; try{ await P.addPayment({load_id:'L5',mode:'Cash',amount:-5}); }catch(e){threw=e.message;}
  ck('a negative payment is rejected', /greater than zero/.test(threw||''));
  threw=null; try{ await P.addPayment({mode:'Cash',amount:5}); }catch(e){threw=e.message;}
  ck('a payment with no load is rejected', /load_id is required/.test(threw||''));

  ck('mode matching is case-insensitive but stored canonically',
     (await P.addPayment({load_id:'L6',mode:'zelle',amount:1})).mode==='Zelle');

  // purchases and sales can share an id without colliding
  await P.addPayment({load_id:'X1',load_kind:'sale',amount:50,mode:'Wire'});
  ck('load_kind is recorded so a purchase and a sale cannot be confused',
     P.paymentsForLoad('X1')[0].load_kind==='sale');

  const before=P.listPayments().length;
  await P.deletePaymentsForLoad('L1');
  ck('deleting a load clears its payments, leaving no orphans',
     P.paymentsForLoad('L1').length===0 && P.listPayments().length===before-2);


  section('advances — money paid before there is a load');
  {
    const { addLoad } = require(R+'helpers/loads');
  // advance paid BEFORE any load exists
  const adv = await P.addAdvance({seller:'Acme Metals',mode:'Wire',amount:5000,paid_on:'2026-08-15'});
  ck('an advance can be recorded with no load at all', !!adv.id && adv.load_id===null);
  ck('it is marked as an advance', adv.is_advance===true);
  ck('the seller holds the credit', P.advanceCredit('Acme Metals').available===5000);

  // it must NOT make a later load look part-paid on its own
  const l = await addLoad({date:'2026-08-20',seller:'Acme Metals',weight_unit:'lb',
    items:[{description:'Auto Casting',gross_weight:4210,tare_weight:200,price:2.2}]});
  let s = P.paymentSummary(l.id, l.amount);
  ck('an UNAPPLIED advance leaves the load unpaid — no money moves by itself',
     s.status==='unpaid' && s.paid===0 && s.pending===8822);

  // apply part of it
  await P.applyAdvance({load_id:l.id, advance_id:adv.id, amount:3000, paid_on:'2026-08-20'});
  s = P.paymentSummary(l.id, l.amount);
  ck('applying part of the advance part-pays the load', s.status==='partial' && s.paid===3000);
  ck('it appears as a normal payment row on the load', s.payments.length===1);
  ck('the row records which advance funded it', s.payments[0].applied_from===adv.id);
  ck('the advance credit drops by what was applied', P.advanceCredit('Acme Metals').available===2000);

  // split the SAME advance across a second load
  const l2 = await addLoad({date:'2026-08-22',seller:'Acme Metals',weight_unit:'lb',
    items:[{description:'Al Combo',gross_weight:2000,tare_weight:100,price:1}]});
  await P.applyAdvance({load_id:l2.id, advance_id:adv.id, amount:1900});
  ck('one advance can be split across several loads', P.paymentSummary(l2.id,l2.amount).status==='paid');
  ck('and the credit tracks it', P.advanceCredit('Acme Metals').available===100);

  // over-applying is refused, not silently capped
  let threw=null; try{ await P.applyAdvance({load_id:l.id, advance_id:adv.id, amount:500}); }catch(e){threw=e.message;}
  ck('applying more than the advance has left is REFUSED', /only has 100\.00 left/.test(threw||''));

  // ordinary payments still work alongside
  await P.addPayment({load_id:l.id,mode:'Cash',amount:5822});
  s = P.paymentSummary(l.id,l.amount);
  ck('an advance and a cash instalment settle a load together', s.status==='paid' && s.payments.length===2);
  ck('both are kept as separate rows', s.payments.map(p=>p.amount).sort((a,b)=>a-b).join()==='3000,5822');

  threw=null; try{ await P.addAdvance({mode:'Cash',amount:100}); }catch(e){threw=e.message;}
  ck('an advance with no seller is refused', /needs a seller/.test(threw||''));
  ck('a seller with no advances shows zero credit', P.advanceCredit('Nobody').available===0);

  }

  section('the ticket reflects it');
  {
    const { generateLoadPdf } = require(R+'helpers/pdf');
    const load = { id:'EDGE_01', load_number:1, date:'2026-08-28', seller:'Acme Metals',
      seller_address:'Dallas TX', weight_unit:'lb', created_at:new Date().toISOString(),
      items:[{description:'Auto Casting',gross_weight:4210,tare_weight:200,net_weight:4010,rate:2.2,price:2.2,amount:8822}],
      amount:8822 };
    const text = async (opts) => {
      const buf = await generateLoadPdf(load, opts);
      const f=path.join(tmp,'t.pdf'); fs.writeFileSync(f,buf);
      return execSync(`pdftotext -layout ${JSON.stringify(f)} -`).toString();
    };
    let t = await text({});
    ck('an unpaid ticket carries no payment section (no row of zeros)', !/PAID/.test(t));
    t = await text({ payment: { status:'partial', paid:4000, total:8822, pending:4822, over:0,
      payments:[{paid_on:'2026-08-28',mode:'Zelle',amount:4000,reference:'ZL-99'}] } });
    ck('a part payment prints the mode and reference', /Zelle/.test(t) && /ZL-99/.test(t));
    ck('it says PART PAID with the balance due', /PART PAID/.test(t) && /Balance due\s+4,822\.00/.test(t));
    t = await text({ payment: { status:'paid', paid:8822, total:8822, pending:0, over:0,
      payments:[{paid_on:'2026-08-28',mode:'Wire',amount:8822}] } });
    ck('a settled load says PAID IN FULL and shows no balance', /PAID IN FULL/.test(t) && !/Balance due/.test(t));
    t = await text({ payment: { status:'overpaid', paid:9000, total:8822, pending:0, over:178,
      payments:[{paid_on:'2026-08-28',mode:'Wire',amount:9000}] } });
    ck('an overpayment is stated rather than hidden', /OVERPAID/.test(t));
  }


  section('money is rounded to the cent on customer documents');
  {
    const { round2 } = require(R+'helpers/money.js');
    // The cases that actually misbehave with freight numbers.
    ck('13.5 x 1.15 rounds to 15.52, not 15.524999999999999', round2(13.5*1.15)===15.52);
    ck('1.005 x 100 rounds to 100.5', round2(1.005*100)===100.5);
    ck('21 x 2420 stays exact', round2(21*2420)===50820);

    // Accumulating RAW drifts; accumulating ROUNDED lines does not, and the
    // printed rows then add up to the printed total.
    let raw=0, perLine=0;
    for (let i=0;i<10;i++) { raw += 13.5*1.15; perLine += round2(13.5*1.15); }
    ck('summing raw line values drifts', String(raw)==='155.25000000000003');
    ck('summing ROUNDED lines does not', round2(perLine)===155.2);

    // And the source files must keep doing it.
    const files = ['helpers/invoiceSheet.js','helpers/proformaPdf.js','helpers/invoicePdf.js'];
    for (const f of files) {
      const src = fs.readFileSync(R+f,'utf8');
      const lines = src.split('\n').filter(l => /(weight|qty) \* rate/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      ck(`${f}: every qty x rate is wrapped in round2`, lines.length>0 && lines.every(l=>/round2\(/.test(l)));
    }
  }

  console.log('\n================================================================');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILED:'); failures.forEach(f=>console.log('  - '+f)); }
  fs.rmSync(tmp,{recursive:true,force:true});
  process.exit(fail?1:0);
})();
