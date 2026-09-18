require('/sessions/rcw-01pavfkg7jryerfupzvlcftt/mnt/Jarvis_July/node_modules/dotenv').config(); const R='/sessions/rcw-01pavfkg7jryerfupzvlcftt/mnt/Jarvis_July';
const { getGmailRead, listMessages, getMessage, getEmailContent } = require(R+'/helpers/gmail.js');
const rw = require(R+'/workflow/replyWatch.js');
const I = require(R+'/helpers/mailImportance.js');
const H=(m,n)=>((m.payload&&m.payload.headers)||[]).find(h=>(h.name||'').toLowerCase()===n)?.value||'';
(async()=>{
  const g=await getGmailRead();
  const msgs=await listMessages(g,'newer_than:3d DALA61376400',10);
  for (const r of msgs.slice(0,4)) {
    const m=await getMessage(g,r.id); const {body}=getEmailContent(m.payload||{});
    const v=rw.extractLatestMessage(body||m.snippet||'');
    console.log('\n=== '+H(m,'date')+' | '+H(m,'from').replace(/<.*/,''));
    console.log('    '+H(m,'subject').slice(0,70));
    // every date-shaped token the change detector can see
    console.log('    dates found:', JSON.stringify(I.datesIn(v).map(d=>d.raw)));
    for (const line of v.split('\n')) if (/09-16|09\/16|cut|erd/i.test(line)) console.log('    > '+line.trim().slice(0,110));
  }
})().catch(e=>{console.error('CRASH',e.message);process.exit(1);});
