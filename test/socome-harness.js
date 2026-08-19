const fs=require('fs');
const {cropDisplay}=require('/tmp/crop.js');
const { readSevenSegment } = require('/sessions/nifty-youthful-lovelace/mnt/Jarvis_July/helpers/sevenSegment');
const D='/sessions/nifty-youthful-lovelace/mnt/uploads/';
const SET=[['WhatsApp Image 2026-08-17 at 08.53.32 (1).jpeg',4223],['WhatsApp Image 2026-08-17 at 08.53.32.jpeg',4210],['WhatsApp Image 2026-08-17 at 08.53.33 (1).jpeg',4293],['WhatsApp Image 2026-08-17 at 08.53.33 (2).jpeg',4346],['WhatsApp Image 2026-08-17 at 08.53.33 (3).jpeg',3815],['WhatsApp Image 2026-08-17 at 08.53.33 (4).jpeg',4450],['WhatsApp Image 2026-08-17 at 08.53.33 (5).jpeg',3939],['WhatsApp Image 2026-08-17 at 08.53.33 (6).jpeg',4146],['WhatsApp Image 2026-08-17 at 08.53.33 (7).jpeg',3475],['WhatsApp Image 2026-08-17 at 08.53.33 (8).jpeg',3599]];
(async()=>{
  let ok=0,wrong=0,dec=0;
  for(const [f,exp] of SET){
    const crop=await cropDisplay(D+f);
    if(!crop){console.log('none ',exp,'-> crop failed');dec++;continue;}
    fs.writeFileSync('/tmp/crops/'+exp+'.jpg',crop);
    const r=await readSevenSegment(crop);
    let tag; if(r.weight===exp){tag='OK   ';ok++;} else if(r.weight===null){tag='none ';dec++;} else {tag='WRONG';wrong++;}
    console.log(tag,String(exp).padEnd(6),'->',String(r.weight).padEnd(8),(r.digits||'').padEnd(8),r.ms+'ms',r.reason==='ok'?'':r.reason);
  }
  console.log('\ncorrect='+ok+'  WRONG='+wrong+'  declined='+dec);
})().catch(e=>console.error(e.stack));
