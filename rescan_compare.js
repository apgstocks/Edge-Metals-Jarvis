const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const gemini = require('./helpers/gemini.js');

async function downscale(buf, maxDim, q) {
  if (!maxDim) return sharp(buf).rotate().jpeg({ quality: q }).toBuffer();
  const meta = await sharp(buf).rotate().metadata();
  let w = meta.width, h = meta.height;
  if (w > maxDim || h > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  return sharp(buf).rotate().resize({ width: w, height: h }).jpeg({ quality: q }).toBuffer();
}

const dir = '/sessions/nifty-youthful-lovelace/mnt/uploads';
const cases = [
  ['WhatsApp Image 2026-08-08 at 02.24.18-bbb73109.jpeg', 71920],
  ['WhatsApp Image 2026-08-10 at 16.50.44.jpeg', 81528],
  ['WhatsApp Image 2026-08-11 at 10.16.46.jpeg', 28460],
];
const settings = [[1600, 90], [null, 95]];

(async () => {
  for (const [maxDim, q] of settings) {
    let correct = 0, total = 0;
    for (const [f, truth] of cases) {
      const p = path.join(dir, f);
      const orig = fs.readFileSync(p);
      const client = await downscale(orig, maxDim, q);
      total++;
      try {
        const r = await gemini.extractWeightFromImage(client.toString('base64'), 'image/jpeg', 1);
        const ok = r.weight === truth;
        if (ok) correct++;
        console.log(`  [${maxDim||'orig'}px] ${ok?'OK  ':'WRONG'} ${f.slice(0,30)} got=${r.weight} want=${truth}`);
      } catch (err) {
        console.log(`  [${maxDim||'orig'}px] ERROR ${f.slice(0,30)} ${err.message}`);
      }
    }
    console.log(`SET maxDim=${maxDim||'orig'} q=${q}: ${correct}/${total}\n`);
  }
})();
