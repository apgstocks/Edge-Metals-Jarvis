const fs=require('fs');const path=require('path');
const g=require('./helpers/gemini.js');
const dir='/sessions/nifty-youthful-lovelace/mnt/uploads';
const files=["Untitled design-3-ca00eb89.png","Untitled design-4-4fba1519.png","Untitled design-5-a3039b80.png","Untitled design-6-5b092e4c.png","Untitled design-7-ee9a44ee.png","WhatsApp Image 2026-08-08 at 02.24.18-bbb73109.jpeg","WhatsApp Image 2026-08-10 at 13.19.20.jpeg","WhatsApp Image 2026-08-10 at 15.51.57-4c7fc8fb.jpeg","WhatsApp Image 2026-08-10 at 16.50.44-670a297a.jpeg","WhatsApp Image 2026-08-10 at 21.04.24.jpeg","WhatsApp Image 2026-08-11 at 10.16.44 (1)-1a8eb8d1.jpeg","WhatsApp Image 2026-08-11 at 10.16.44-344a4ba4.jpeg","WhatsApp Image 2026-08-11 at 10.16.45 (1)-f8a25e61.jpeg","WhatsApp Image 2026-08-11 at 10.16.45 (2)-f533c78d.jpeg","WhatsApp Image 2026-08-11 at 10.16.45-dd59cfe1.jpeg","WhatsApp Image 2026-08-11 at 10.16.46 (2)-f89a6ba6.jpeg","WhatsApp Image 2026-08-11 at 10.16.46 (3)-b876001b.jpeg","WhatsApp Image 2026-08-11 at 10.16.46-78432342.jpeg","WhatsApp Image 2026-08-11 at 10.16.47 (1)-41f6e7fd.jpeg","WhatsApp Image 2026-08-11 at 10.16.47 (2)-a9ee1e09.jpeg","WhatsApp Image 2026-08-11 at 10.16.47-67989731.jpeg","c4338140-778a-4c58-bcc4-24d6db77b51e-1786179835469_image.png"];
// Known confirmed ground truths from earlier in this session
const truth = {
  "WhatsApp Image 2026-08-08 at 02.24.18-bbb73109.jpeg": 71920,
  "WhatsApp Image 2026-08-10 at 16.50.44-670a297a.jpeg": 81528,
  "WhatsApp Image 2026-08-10 at 21.04.24.jpeg": 2251,
  "WhatsApp Image 2026-08-11 at 10.16.46-78432342.jpeg": 28460,
  "WhatsApp Image 2026-08-11 at 10.16.46 (2)-f89a6ba6.jpeg": 28180,
  "WhatsApp Image 2026-08-11 at 10.16.47 (2)-a9ee1e09.jpeg": 79080,
};
(async()=>{
  const results=[];
  for (const f of files) {
    const mime = f.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    try {
      const b=fs.readFileSync(path.join(dir,f));
      const t0=Date.now();
      const r=await g.extractWeightFromImage(b.toString('base64'), mime, 1);
      const dt=Date.now()-t0;
      const t = truth[f];
      const verdict = t!=null ? (r.weight===t ? 'OK' : 'WRONG') : (r.not_a_scale_photo ? 'N/A(not scale)' : 'UNVERIFIED');
      results.push(`${verdict.padEnd(12)} ${f.slice(0,42).padEnd(43)} weight=${String(r.weight).padEnd(8)} truth=${t??'?'.padEnd(6)} amb=${r.ambiguous} alt=${r.alternate_weight??''} ${dt}ms`);
    } catch(e) {
      results.push(`ERROR        ${f.slice(0,42)} ${e.message}`);
    }
  }
  console.log('\n===FULL RESULTS===');
  results.forEach(r=>console.log(r));
})();
