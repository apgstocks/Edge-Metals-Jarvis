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


  // ── the log lands in the yard folder's log/ subfolder ────────────────────
  {
    const log = require(R+'helpers/yardChatLog');
    ck('logs live under yard/log/', /[\\/\\\\]yard[\\/\\\\]log$/.test(cfg.YARD_CHAT_DIR));
    ck('a day file sits inside it', log.logPathFor('2026-08-29').endsWith(path.join('yard','log','2026-08-29.jsonl')));
    // Drive mirroring must never be able to break answering.
    ck('a Drive mirror is available', typeof log.syncDayToDrive === 'function');
    // This suite once uploaded FIXTURES into the live Drive Yard folder. The
    // guard in helpers/drive.js closes that; this proves the guard is armed,
    // so a future edit here cannot quietly start writing to the real yard.
    ck('the test runner disables Drive', process.env.JARVIS_TEST === '1');
    let reachedDrive = false;
    try { require(R+'helpers/drive'); } catch (e) {}
    try {
      const d = require(R+'helpers/drive');
      await d.uploadYardChatLog('2026-08-29', Buffer.from('x'));
      reachedDrive = true;
    } catch (e) {
      ck('Drive refuses to authenticate under test', /disabled under JARVIS_TEST/.test(e.message));
    }
    ck('no test can write to the live yard folder', !reachedDrive);
    // ...and mirroring still fails SOFT, so logging can never break answering.
    const out = await log.syncDayToDrive('2026-08-29').catch(() => 'threw');
    ck('mirroring fails soft, never throws', out !== 'threw');
  }

  // ── a bare "How" is a follow-up, not a command ───────────────────────────
  {
    // Apsara asked "How" after a figure and got "I cannot perform actions".
    // The expansion is done in code precisely because the model's reading of a
    // single word was not reliable, so this asserts the CODE, not the phrasing
    // of any particular reply.
    const src = fs.readFileSync(R+'helpers/yardAsk.js','utf8');
    const m = /const FOLLOW_UP = (\/.*\/i);/.exec(src);
    ck('the follow-up pattern exists', !!m);
    if (m) {
      const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), 'i');
      for (const w of ['How','how?','Why','Show me','break it down','which ones','explain','More'])
        ck(`"${w}" is treated as a follow-up`, re.test(w));
      for (const w of ['How much do we owe?','Why did Acme not pay','show me the loads for Acme'])
        ck(`"${w}" is NOT swallowed as a bare follow-up`, !re.test(w));
    }
    ck('expansion only applies when there IS a previous answer',
       /FOLLOW_UP\.test\(q\) && lastAnswer/.test(src));
    ck('it is spelled out as an explain request, not an action',
       /request to EXPLAIN, not to perform an action/.test(src));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  srv.close(); fs.rmSync(tmp,{recursive:true,force:true}); process.exit(fail?1:0);
})();
