const fs = require('fs');
const path = require('path');
const gemini = require('./helpers/gemini.js');

const dir = '/sessions/nifty-youthful-lovelace/mnt/uploads';
const files = fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f));

(async () => {
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const b64 = buf.toString('base64');
    const t0 = Date.now();
    try {
      const r = await gemini.extractWeightFromImage(b64, 'image/jpeg', 1);
      console.log(`RESULT ${f}: weight=${r.weight} ambiguous=${r.ambiguous} (${Date.now()-t0}ms)`);
    } catch (err) {
      console.log(`ERROR ${f}: ${err.message} (${Date.now()-t0}ms)`);
    }
    console.log('---');
  }
})();
