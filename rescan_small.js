const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const gemini = require('./helpers/gemini.js');

async function downscale(buf, maxDim, q) {
  let w, h;
  const meta = await sharp(buf).rotate().metadata();
  w = meta.width; h = meta.height;
  if (maxDim && (w > maxDim || h > maxDim)) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  return sharp(buf).rotate().resize({ width: w, height: h }).jpeg({ quality: q }).toBuffer();
}

const dir = '/sessions/nifty-youthful-lovelace/mnt/uploads';
const cases = [
  ['WhatsApp Image 2026-08-08 at 02.24.18-bbb73109.jpeg', 71920],
  ['WhatsApp Image 2026-08-10 at 21.04.24.jpeg', 2251],
];

(async () => {
  for (const [f, truth] of cases) {
    const p = path.join(dir, f);
    const orig = fs.readFileSync(p);
    const client = await downscale(orig, 1600, 90);
    const r = await gemini.extractWeightFromImage(client.toString('base64'), 'image/jpeg', 1);
    console.log('RESULT', f, 'got', r.weight, 'want', truth);
  }
})().catch(e => console.error('FATAL', e));
