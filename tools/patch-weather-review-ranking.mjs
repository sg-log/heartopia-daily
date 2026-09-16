import fs from 'node:fs';

const file = 'tools/weather-deterministic-review.mjs';
let text = fs.readFileSync(file, 'utf8');

function replaceOnce(needle, replacement, label) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`Missing patch target: ${label}`);
  if (text.indexOf(needle, index + needle.length) >= 0) throw new Error(`Non-unique patch target: ${label}`);
  text = text.slice(0, index) + replacement + text.slice(index + needle.length);
}

if (!text.includes('const TIME_BANDS = [')) {
  replaceOnce(
`const SLOT_RECTS = [
  { key: 'slot0', x: .080, y: .418, w: .105, h: .070 },
  { key: 'slot1', x: .294, y: .418, w: .105, h: .070 },
  { key: 'slot2', x: .471, y: .418, w: .105, h: .070 },
  { key: 'slot3', x: .650, y: .418, w: .105, h: .070 },
  { key: 'slot4', x: .829, y: .418, w: .105, h: .070 }
];
const TIME_STRIP = { x: .075, y: .490, w: .850, h: .065 };`,
`const SLOT_RECTS = [
  { key: 'slot0', x: .105, y: .425, w: .110, h: .075 },
  { key: 'slot1', x: .275, y: .425, w: .110, h: .075 },
  { key: 'slot2', x: .450, y: .425, w: .110, h: .075 },
  { key: 'slot3', x: .640, y: .425, w: .110, h: .075 },
  { key: 'slot4', x: .835, y: .425, w: .110, h: .075 }
];
const TIME_BANDS = [
  { x: .055, y: .465, w: .900, h: .105 },
  { x: .055, y: .485, w: .900, h: .105 },
  { x: .055, y: .505, w: .900, h: .105 },
  { x: .055, y: .525, w: .900, h: .105 }
];`,
  'weather layout constants');

  replaceOnce(
`async function readStartSlot(page, imageDataUrl, rect) {
  await page.addScriptTag({ url: TESSERACT_URL });
  return page.evaluate(async ({ imageDataUrl, rect, timeStrip, startSlots }) => {
    const image = await new Promise((resolve, reject) => { const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=imageDataUrl; });
    const panel=document.createElement('canvas');panel.width=rect.w;panel.height=rect.h;panel.getContext('2d').drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
    const x=Math.round(timeStrip.x*panel.width),y=Math.round(timeStrip.y*panel.height),w=Math.round(timeStrip.w*panel.width),h=Math.round(timeStrip.h*panel.height);
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,w*3);canvas.height=Math.max(1,h*3);const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(panel,x,y,w,h,0,0,canvas.width,canvas.height);
    const result=await window.Tesseract.recognize(canvas,'eng',{tessedit_char_whitelist:'0123456789',logger:()=>{}});
    const times=(result?.data?.text||'').match(/\\d{1,2}/g)?.map(value=>String(Number(value)).padStart(2,'0').slice(-2))||[];
    const valid=times.filter(value=>startSlots.includes(value)).slice(0,5);
    const hourAt=(start,index)=>startSlots[(startSlots.indexOf(start)+index)%startSlots.length];
    if(valid.length===5&&valid.every((value,index)=>value===hourAt(valid[0],index)))return{startSlot:valid[0],times,valid};
    if(valid.length>=3&&startSlots.includes(valid[0])){const matches=valid.filter((value,index)=>value===hourAt(valid[0],index)).length;if(matches>=3)return{startSlot:valid[0],times,valid};}
    return{startSlot:'',times,valid};
  }, { imageDataUrl, rect, timeStrip: TIME_STRIP, startSlots: START_SLOTS });
}`,
`async function readStartSlot(page, imageDataUrl, rect) {
  if (!(await page.evaluate(() => Boolean(window.Tesseract)))) await page.addScriptTag({ url: TESSERACT_URL });
  return page.evaluate(async ({ imageDataUrl, rect, timeBands, startSlots }) => {
    const image = await new Promise((resolve, reject) => { const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=imageDataUrl; });
    const panel=document.createElement('canvas');panel.width=rect.w;panel.height=rect.h;panel.getContext('2d').drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
    const hourAt=(start,index)=>startSlots[(startSlots.indexOf(start)+index)%startSlots.length];
    const parseTimes=(value)=>((String(value||'').match(/\\d{1,2}/g)||[]).map(v=>String(Number(v)).padStart(2,'0').slice(-2))).filter(v=>startSlots.includes(v));
    const evaluateTimes=(times)=>{
      for(let offset=0;offset<times.length;offset++){
        const sequence=times.slice(offset,offset+5);
        if(sequence.length===5&&sequence.every((value,index)=>value===hourAt(sequence[0],index)))return{startSlot:sequence[0],valid:sequence,matches:5};
      }
      let best={startSlot:'',valid:[],matches:0};
      for(let offset=0;offset<times.length;offset++){
        const sequence=times.slice(offset,offset+5);
        if(!sequence.length||!startSlots.includes(sequence[0]))continue;
        const matches=sequence.filter((value,index)=>value===hourAt(sequence[0],index)).length;
        if(matches>best.matches)best={startSlot:matches>=3?sequence[0]:'',valid:sequence,matches};
      }
      return best;
    };
    const attempts=[];
    for(const band of timeBands){
      const x=Math.round(band.x*panel.width),y=Math.round(band.y*panel.height),w=Math.round(band.w*panel.width),h=Math.round(band.h*panel.height);
      const base=document.createElement('canvas');base.width=Math.max(1,w*6);base.height=Math.max(1,h*6);
      const bctx=base.getContext('2d',{willReadFrequently:true});bctx.imageSmoothingEnabled=false;bctx.drawImage(panel,x,y,w,h,0,0,base.width,base.height);
      const variants=[base];
      for(const threshold of [165,185,205]){
        const binary=document.createElement('canvas');binary.width=base.width;binary.height=base.height;
        const ctx=binary.getContext('2d',{willReadFrequently:true});ctx.drawImage(base,0,0);
        const imageData=ctx.getImageData(0,0,binary.width,binary.height);
        for(let i=0;i<imageData.data.length;i+=4){
          const lum=.299*imageData.data[i]+.587*imageData.data[i+1]+.114*imageData.data[i+2];
          const value=lum>=threshold?0:255;
          imageData.data[i]=value;imageData.data[i+1]=value;imageData.data[i+2]=value;imageData.data[i+3]=255;
        }
        ctx.putImageData(imageData,0,0);variants.push(binary);
      }
      for(let variantIndex=0;variantIndex<variants.length;variantIndex++){
        const result=await window.Tesseract.recognize(variants[variantIndex],'eng',{tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7',logger:()=>{}});
        const text=String(result?.data?.text||'').trim();
        const times=parseTimes(text);
        const evaluated=evaluateTimes(times);
        attempts.push({band,variantIndex,text,times,matches:evaluated.matches});
        if(evaluated.matches===5)return{startSlot:evaluated.startSlot,times,valid:evaluated.valid,attempts};
      }
    }
    const bestAttempt=attempts.sort((a,b)=>b.matches-a.matches)[0]||null;
    if(bestAttempt?.matches>=3){const evaluated=evaluateTimes(bestAttempt.times);return{startSlot:evaluated.startSlot,times:bestAttempt.times,valid:evaluated.valid,attempts};}
    return{startSlot:'',times:bestAttempt?.times||[],valid:[],attempts};
  }, { imageDataUrl, rect, timeBands: TIME_BANDS, startSlots: START_SLOTS });
}`,
  'start slot OCR search');

  text = text.replace('.slice(0,16);', '.slice(0,64);');
  text = text.replace('if (panel.okCount < 5 || panel.highCount < 3) continue;', 'if (panel.okCount < 4 || panel.highCount < 2) continue;');
  text = text.replace('panelCandidates.push({ media, descriptor, imageDataUrl, panel });', `const right=(scored.width-panel.rect.x-panel.rect.w)/scored.width;\n        const geometryDistance=Math.abs(panel.rect.h/scored.height-.75)+Math.abs(panel.rect.y/scored.height-.12)+Math.abs(right-.08);\n        panelCandidates.push({ media, descriptor, imageDataUrl, panel, geometryDistance });`);
  text = text.replace('panelCandidates.sort((a,b)=>b.panel.highCount-a.panel.highCount||b.panel.okCount-a.panel.okCount||b.panel.minMargin-a.panel.minMargin||b.panel.avg-a.panel.avg);', 'panelCandidates.sort((a,b)=>a.geometryDistance-b.geometryDistance||b.panel.highCount-a.panel.highCount||b.panel.okCount-a.panel.okCount||b.panel.minMargin-a.panel.minMargin||b.panel.avg-a.panel.avg);');
  text = text.replace('for (const candidate of panelCandidates.slice(0, 12)) {', 'for (const candidate of panelCandidates.slice(0, 16)) {');
  text = text.replace('ocrAttempts.push({file:candidate.media.file,rect:candidate.panel.rect,highCount:candidate.panel.highCount,okCount:candidate.panel.okCount,ocr});', 'ocrAttempts.push({file:candidate.media.file,rect:candidate.panel.rect,geometryDistance:candidate.geometryDistance,highCount:candidate.panel.highCount,okCount:candidate.panel.okCount,ocr});');

  fs.writeFileSync(file, text, 'utf8');
  console.log('Applied weather time-row detection patch.');
} else {
  console.log('Weather time-row detection patch already applied.');
}
