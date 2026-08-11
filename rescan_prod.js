const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const gemini = require('./helpers/gemini.js');

async function downscale(buf, maxDim, q) {
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

(async () => {
  let correct = 0, total = 0;
  for (const [f, truth] of cases) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { console.log('MISSING', f); continue; }
    const orig = fs.readFileSync(p);
    const client = await downscale(orig, 1600, 90);
    total++;
    try {
      const r = await gemini.extractWeightFromImage(client.toString('base64'), 'image/jpeg', 1);
      const ok = r.weight === truth;
      if (ok) correct++;
      console.log(`${ok ? 'OK  ' : 'WRONG'} ${f} got=${r.weight} want=${truth} alt=${r.alternate_weight} ambiguous=${r.ambiguous}`);
    } catch (err) {
      console.log('ERROR', f, err.message);
    }
  }
  console.log(`\nTOTAL: ${correct}/${total} correct at production setting (1600px, q90)`);
})();
