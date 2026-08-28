// ── tests/yard-chat-log.js ──────────────────────────────────────────────────
// The yard assistant's daily transcript, per Apsara 2026-08-29: "keep on
// storing the conversations of yard assistant somewhere. so per day one log."
//
// The assertions that matter are the failure ones. A transcript is a
// convenience; the question being answered is not. So: a corrupt line must
// cost that line and not the day, and an unwritable log must still answer.
// Both are exercised for real here — a junk line is appended, and the
// directory is made read-only mid-run.
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cl-')); process.env.DATA_DIR=tmp; process.env.API_TOKEN='t';
const R=path.join(__dirname,'..')+path.sep;
const cfg=require(R+'config.js');
const { addLoad } = require(R+'helpers/loads');
const app=require(R+'api.js').createApi(); const srv=http.createServer(app).listen(0);
const call=(m,p,b)=>new Promise(r=>{const d=b?JSON.stringify(b):null;
 const q=http.request({port:srv.address().port,path:p,method:m,headers:{Authorization:'Bearer t','Content-Type':'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},x=>{let s='';x.on('data',c=>s+=c);x.on('end',()=>{try{r(JSON.parse(s))}catch(e){r(s)}})}); if(d)q.write(d); q.end();});
let pass=0,fail=0; const ck=(n,c)=>{c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n));};
(async()=>{
  await new Promise(r=>srv.once('listening',r));
  await addLoad({date:'2026-08-25',seller:'Acme Metals',weight_unit:'lb',items:[{description:'Auto Casting',gross_weight:4210,tare_weight:200,price:2.2}]});

  await call('POST','/api/yard/ask',{question:'How much do we owe in total?', source:'app'});
  await call('POST','/api/yard/ask',{question:'Who do we owe money to?', source:'app'});

  const log = require(R+'helpers/yardChatLog');
  const today = log.localDay();
  ck('a log file exists for today', fs.existsSync(log.logPathFor(today)));
  ck('the file is named by DAY', /\d{4}-\d{2}-\d{2}\.jsonl$/.test(log.logPathFor(today)));
  const rows = log.readDay(today);
  ck('both exchanges were recorded', rows.length === 2);
  ck('the question is stored', /owe in total/.test(rows[0].question));
  ck('the answer is stored', rows[0].answer && rows[0].answer.length > 5);
  ck('the time is stored', /^\d{4}-\d{2}-\d{2}T/.test(rows[0].at));
  ck('which client asked is stored', rows[0].source === 'app');
  ck('oldest first — the order it happened in', rows[0].question !== rows[1].question && /owe in total/.test(rows[0].question));

  const viaApi = await call('GET','/api/yard/chat-log?day='+today);
  ck('the day is readable back over the API', viaApi.entries && viaApi.entries.length === 2);
  const days = await call('GET','/api/yard/chat-log');
  ck('the day list includes today', Array.isArray(days.days) && days.days.includes(today));

  // a corrupt line must not destroy the day
  fs.appendFileSync(log.logPathFor(today), 'this is not json\n');
  ck('a malformed line is skipped, not fatal', log.readDay(today).length === 2);

  // logging failure must not break answering
  fs.chmodSync(cfg.YARD_CHAT_DIR, 0o500);
  const still = await call('POST','/api/yard/ask',{question:'Who do we owe money to?'});
  ck('an unwritable log still answers the question', !!(still && still.answer));
  fs.chmodSync(cfg.YARD_CHAT_DIR, 0o700);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  srv.close(); fs.rmSync(tmp,{recursive:true,force:true}); process.exit(fail?1:0);
})();
