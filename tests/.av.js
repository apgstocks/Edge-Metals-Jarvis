const { boot } = require('./helpers/e2e');
const fs=require('fs'), px=require('path');
(async () => {
  const j = await boot({});
  const f = px.join(j.dir, 'workflow.json');
  fs.writeFileSync(f, JSON.stringify({ HOU111:{supplier:'Eccomelt'}, HOU222:{supplier:'Eccomelt'} }, null, 2));
  const r = await j.say('show me available bookings from houston');
  console.log('\n  YOU:    show me available bookings from houston');
  console.log('  JARVIS: ' + ((r.json||{}).answer||'').replace(/\n/g,' | ').slice(0,200));
  await j.stop();
})();
