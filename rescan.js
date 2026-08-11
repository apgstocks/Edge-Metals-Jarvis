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
  ['WhatsApp Image 2026-08-10 at 21.04.24.jpeg', 2251],
  ['WhatsApp Image 2026-08-10 at 16.50.44.jpeg', 81528],
  ['WhatsApp Image 2026-08-11 at 10.16.46 (2).jpeg', 28180],
  ['WhatsApp Image 2026-08-11 at 10.16.46.jpeg', 28460],
  ['WhatsApp Image 2026-08-11 at 10.16.47 (2).jpeg', 79080],
];

const settings = [[1600, 90], [3000, 95], [null, 95]];

(async () => {
  for (const [maxDim, q] of settings) {
    let correct = 0, total = 0;
    const results = [];
    for (const [f, truth] of cases) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      const orig = fs.readFileSync(p);
      const client = await downscale(orig, maxDim, q);
      total++;
      try {
        const r = await gemini.extractWeightFromImage(client.toString('base64'), 'image/jpeg', 1);
        const ok = r.weight === truth;
        if (ok) correct++;
        results.push(`${f.slice(0,25)}: got ${r.weight} want ${truth} ${ok?'OK':'WRONG'}`);
      } catch (err) {
        results.push(`${f.slice(0,25)}: ERROR ${err.message}`);
      }
    }
    console.log(`RESULT_SET maxDim=${maxDim||'orig'} q=${q}: ${correct}/${total} correct`);
    results.forEach(r => console.log('  ' + r));
  }
})();
