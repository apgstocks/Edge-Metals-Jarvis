const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const gemini = require('./helpers/gemini.js');

async function simulateClientDownscale(buf) {
  const meta = await sharp(buf).rotate().metadata();
  let w = meta.width, h = meta.height;
  const maxDim = 1600;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale); h = Math.round(h * scale);
  }
  return sharp(buf).rotate().resize({ width: w, height: h }).jpeg({ quality: 90 }).toBuffer();
}

const dir = '/sessions/nifty-youthful-lovelace/mnt/uploads';
// dedupe by file size (hash-suffixed copies are byte-identical to originals)
const seen = new Set();
const files = fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f)).filter(f => {
  const size = fs.statSync(path.join(dir, f)).size;
  if (seen.has(size)) return false;
  seen.add(size);
  return true;
});
console.log('testing', files.length, 'unique files');

(async () => {
  for (const f of files) {
    const orig = fs.readFileSync(path.join(dir, f));
    const client = await simulateClientDownscale(orig);
    try {
      const r = await gemini.extractWeightFromImage(client.toString('base64'), 'image/jpeg', 1);
      console.log(f, '=>', r.weight, 'ambiguous:', r.ambiguous);
    } catch (err) {
      console.log(f, 'ERROR', err.message);
    }
  }
})();
