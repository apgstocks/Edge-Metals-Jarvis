const sharp = require('sharp');
const fs = require('fs');
const visionOcr = require('./helpers/visionOcr.js');

// Reimplements just the locate + crop math with a SMALLER pad for
// pixel-locate boxes, to test the double-padding hypothesis directly
// before touching production code.
async function locateRed(buf) {
  const targetWidth = 500;
  const { data, info } = await sharp(buf).resize({ width: targetWidth, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const mask = new Uint8Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const i=(y*w+x)*channels; const r=data[i],g=data[i+1],b=data[i+2];
    if (r>140 && (r-g)>60 && (r-b)>60) mask[y*w+x]=1;
  }
  const R=25;
  const dilated = new Uint8Array(w*h);
  for (let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(!mask[y*w+x]) continue;
    const yS=Math.max(0,y-R), yE=Math.min(h-1,y+R), xS=Math.max(0,x-R), xE=Math.min(w-1,x+R);
    for(let ny=yS;ny<=yE;ny++){const base=ny*w; for(let nx=xS;nx<=xE;nx++) dilated[base+nx]=1;}
  }
  const labels = new Int32Array(w*h).fill(-1);
  let nextLabel=0; const comps=[]; const stack=[];
  for (let y=0;y<h;y++) for(let x=0;x<w;x++){
    const idx=y*w+x;
    if(!dilated[idx]||labels[idx]!==-1) continue;
    const label=nextLabel++;
    let minX=x,maxX=x,minY=y,maxY=y,litCount=0;
    stack.push(idx); labels[idx]=label;
    while(stack.length){
      const cur=stack.pop(); const cy=(cur/w)|0, cx=cur%w;
      if(mask[cur]) litCount++;
      if(cx<minX)minX=cx; if(cx>maxX)maxX=cx; if(cy<minY)minY=cy; if(cy>maxY)maxY=cy;
      if(cx>0&&dilated[cur-1]&&labels[cur-1]===-1){labels[cur-1]=label;stack.push(cur-1);}
      if(cx<w-1&&dilated[cur+1]&&labels[cur+1]===-1){labels[cur+1]=label;stack.push(cur+1);}
      if(cy>0&&dilated[cur-w]&&labels[cur-w]===-1){labels[cur-w]=label;stack.push(cur-w);}
      if(cy<h-1&&dilated[cur+w]&&labels[cur+w]===-1){labels[cur+w]=label;stack.push(cur+w);}
    }
    comps.push({litCount,minX,maxX,minY,maxY});
  }
  comps.sort((a,b)=>b.litCount-a.litCount);
  const top = comps[0];
  const boxW=(top.maxX-top.minX)/w, boxH=(top.maxY-top.minY)/h;
  // ORIGINAL internal pad (25%/8%)
  const padX0=boxW*0.08, padY0=boxH*0.25;
  return {
    x_min: Math.max(0, top.minX/w - padX0), y_min: Math.max(0, top.minY/h - padY0),
    x_max: Math.min(1, top.maxX/w + padX0), y_max: Math.min(1, top.maxY/h + padY0),
  };
}

async function cropReducedPad(buf, box, padFrac) {
  const meta = await sharp(buf).metadata();
  const w = meta.width, h = meta.height;
  const padX = (box.x_max-box.x_min)*padFrac, padY=(box.y_max-box.y_min)*padFrac;
  const left = Math.max(0, Math.round((box.x_min-padX)*w));
  const top = Math.max(0, Math.round((box.y_min-padY)*h));
  const right = Math.min(w, Math.round((box.x_max+padX)*w));
  const bottom = Math.min(h, Math.round((box.y_max+padY)*h));
  const cropW=right-left, cropH=bottom-top;
  const scale = Math.min(4, Math.max(1, 2000/cropW));
  return sharp(buf).extract({left,top,width:cropW,height:cropH}).resize({width:Math.round(cropW*scale), kernel:'lanczos3'}).jpeg({quality:97}).toBuffer();
}

(async () => {
  const buf = fs.readFileSync('/sessions/nifty-youthful-lovelace/mnt/uploads/WhatsApp Image 2026-08-11 at 10.16.47.jpeg');
  const rotated = await sharp(buf).rotate().jpeg({quality:95}).toBuffer();
  const box = await locateRed(rotated);
  console.log('box', box);
  for (const padFrac of [0.12, 0.05, 0.02, 0.0]) {
    const crop = await cropReducedPad(rotated, box, padFrac);
    fs.writeFileSync(`/sessions/nifty-youthful-lovelace/mnt/outputs/pad_${padFrac}_47.jpg`, crop);
    const text = await visionOcr.detectText(crop.toString('base64'));
    console.log(`padFrac=${padFrac}:`, JSON.stringify(text));
  }
})();
