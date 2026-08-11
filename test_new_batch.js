const fs = require('fs');
const path = require('path');
const gemini = require('./helpers/gemini.js');

const dir = '/sessions/nifty-youthful-lovelace/mnt/uploads';
const files = ['Untitled design-3.png','Untitled design-4.png','Untitled design-5.png','Untitled design-6.png','Untitled design-7.png'];

(async () => {
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { console.log('MISSING', f); continue; }
    const buf = fs.readFileSync(p);
    const b64 = buf.toString('base64');
    const t0 = Date.now();
    try {
      const r = await gemini.extractWeightFromImage(b64, 'image/png', 1);
      console.log(`RESULT ${f}: weight=${r.weight} ambiguous=${r.ambiguous} (${Date.now()-t0}ms)`);
    } catch (err) {
      console.log(`ERROR ${f}: ${err.message} (${Date.now()-t0}ms)`);
    }
  }
})();
