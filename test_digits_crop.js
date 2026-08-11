const fs = require('fs');
const visionOcr = require('./helpers/visionOcr.js');
const gemini = require('./helpers/gemini.js');

(async () => {
  const buf = fs.readFileSync('/sessions/nifty-youthful-lovelace/mnt/outputs/digits_only_47.jpg');
  const b64 = buf.toString('base64');

  const visionText = await visionOcr.detectText(b64);
  console.log('=== VISION ===');
  console.log(JSON.stringify(visionText));
  console.log('extracted:', visionOcr.extractWeightNumberFromCrop(visionText));

  console.log('=== GEMINI x4 ===');
  for (let i = 0; i < 4; i++) {
    const r = await gemini.extractWeightFromImage(b64, 'image/jpeg', 1);
    console.log(i, r && r.weight, r && r.raw_text);
  }
})();
