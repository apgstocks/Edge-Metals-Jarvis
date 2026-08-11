const sharp = require('sharp');
const fs = require('fs');

(async () => {
  const buf = fs.readFileSync('/sessions/nifty-youthful-lovelace/mnt/uploads/WhatsApp Image 2026-08-11 at 10.16.47.jpeg');
  const { data, info } = await sharp(buf).rotate().resize({ width: 500, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const mask = new Uint8Array(w*h);
  let minX=w,maxX=0,minY=h,maxY=0,lit=0;
  for (let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*channels; const r=data[i],g=data[i+1],b=data[i+2];
    if (r>140 && (r-g)>60 && (r-b)>60) {
      mask[y*w+x]=1; lit++;
      if (x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y;
    }
  }
  console.log('lit px', lit, 'raw bbox frac', (minX/w).toFixed(3), (minY/h).toFixed(3), (maxX/w).toFixed(3), (maxY/h).toFixed(3));

  // Get precise original-resolution coordinates with a small margin (not the 22%/12% padding used in production)
  const meta = await sharp(buf).rotate().metadata();
  const W = meta.width, H = meta.height;
  const marginX = (maxX-minX)/w * 0.15, marginY = (maxY-minY)/h * 0.6; // generous Y since digits are tall relative to width here
  const x0f = Math.max(0, minX/w - marginX), x1f = Math.min(1, maxX/w + marginX);
  const y0f = Math.max(0, minY/h - marginY), y1f = Math.min(1, maxY/h + marginY);
  const left = Math.round(x0f*W), top = Math.round(y0f*H);
  const width = Math.round((x1f-x0f)*W), height = Math.round((y1f-y0f)*H);
  console.log('crop region (orig px)', left, top, width, height);

  const cropped = await sharp(buf).rotate().extract({left, top, width, height}).jpeg({quality:95}).toBuffer();
  fs.writeFileSync('/sessions/nifty-youthful-lovelace/mnt/outputs/precise_crop_47.jpg', cropped);
  console.log('wrote precise_crop_47.jpg', cropped.length, 'bytes');
})();
