import fs from 'node:fs';

const file = 'tools/weather-deterministic-review.mjs';
let text = fs.readFileSync(file, 'utf8');

function replaceOnce(needle, replacement, label) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`Missing patch target: ${label}`);
  if (text.indexOf(needle, index + needle.length) >= 0) throw new Error(`Non-unique patch target: ${label}`);
  text = text.slice(0, index) + replacement + text.slice(index + needle.length);
}

if (!text.includes('geometryAnchorV2')) {
  replaceOnce(
`const TIME_BANDS = [
  { x: .055, y: .465, w: .900, h: .105 },
  { x: .055, y: .485, w: .900, h: .105 },
  { x: .055, y: .505, w: .900, h: .105 },
  { x: .055, y: .525, w: .900, h: .105 }
];`,
`const TIME_BANDS = [
  { x: .055, y: .490, w: .900, h: .080 },
  { x: .055, y: .500, w: .900, h: .070 },
  { x: .055, y: .505, w: .900, h: .065 },
  { x: .055, y: .515, w: .900, h: .060 }
];`,
  'narrow time bands');

  replaceOnce(
`    let coarse=buildCandidates().map(classifyPanel).sort((a,b)=>b.highCount-a.highCount||b.okCount-a.okCount||b.avg-a.avg).slice(0,6);
    const refined=[];
    for(const base of coarse){for(let dy=-6;dy<=6;dy+=3)for(let dx=-6;dx<=6;dx+=3){const r={...base.rect,x:Math.max(0,Math.min(sourceImage.naturalWidth-base.rect.w,base.rect.x+dx)),y:Math.max(0,Math.min(sourceImage.naturalHeight-base.rect.h,base.rect.y+dy)),source:'refined'};refined.push(classifyPanel(r));}}
    const rankedPanels=[...coarse,...refined]
      .sort((a,b)=>b.highCount-a.highCount||b.okCount-a.okCount||b.minMargin-a.minMargin||b.avg-a.avg)
      .slice(0,64);
    const best=rankedPanels[0]||null;
    return {width:sourceImage.naturalWidth,height:sourceImage.naturalHeight,best,ranked:rankedPanels};`,
`    const geometryAnchorV2=(panel)=>{
      const right=(sourceImage.naturalWidth-panel.rect.x-panel.rect.w)/sourceImage.naturalWidth;
      return Math.abs(panel.rect.h/sourceImage.naturalHeight-.75)+Math.abs(panel.rect.y/sourceImage.naturalHeight-.12)+Math.abs(right-.08);
    };
    const allCoarse=buildCandidates().map(classifyPanel);
    const classifierTop=[...allCoarse].sort((a,b)=>b.highCount-a.highCount||b.okCount-a.okCount||b.avg-a.avg).slice(0,6);
    const anchor=[...allCoarse].sort((a,b)=>geometryAnchorV2(a)-geometryAnchorV2(b))[0]||null;
    const refineBases=[...classifierTop];
    if(anchor&&!refineBases.some(item=>item.rect.x===anchor.rect.x&&item.rect.y===anchor.rect.y&&item.rect.w===anchor.rect.w&&item.rect.h===anchor.rect.h))refineBases.unshift(anchor);
    const refined=[];
    for(const base of refineBases){for(let dy=-6;dy<=6;dy+=3)for(let dx=-6;dx<=6;dx+=3){const r={...base.rect,x:Math.max(0,Math.min(sourceImage.naturalWidth-base.rect.w,base.rect.x+dx)),y:Math.max(0,Math.min(sourceImage.naturalHeight-base.rect.h,base.rect.y+dy)),source:'refined'};refined.push(classifyPanel(r));}}
    const rankedPanels=[...allCoarse,...refined]
      .sort((a,b)=>geometryAnchorV2(a)-geometryAnchorV2(b)||b.highCount-a.highCount||b.okCount-a.okCount||b.minMargin-a.minMargin||b.avg-a.avg);
    const best=rankedPanels[0]||null;
    return {width:sourceImage.naturalWidth,height:sourceImage.naturalHeight,best,ranked:rankedPanels};`,
  'geometry anchored panel ranking');

  const start = text.indexOf('async function readStartSlot(page, imageDataUrl, rect) {');
  const end = text.indexOf('\nexport async function inspectCapture', start);
  if (start < 0 || end < 0) throw new Error('Missing patch target: readStartSlot');
  const replacement = `async function readStartSlot(page, imageDataUrl, rect) {
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
    const worker=await window.Tesseract.createWorker('eng',1,{logger:()=>{}});
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'});
    const attempts=[];
    try {
      for(const band of timeBands){
        const x=Math.round(band.x*panel.width),y=Math.round(band.y*panel.height),w=Math.round(band.w*panel.width),h=Math.round(band.h*panel.height);
        const base=document.createElement('canvas');base.width=Math.max(1,w*6);base.height=Math.max(1,h*6);
        const bctx=base.getContext('2d',{willReadFrequently:true});bctx.imageSmoothingEnabled=true;bctx.imageSmoothingQuality='high';bctx.drawImage(panel,x,y,w,h,0,0,base.width,base.height);
        const variants=[base];
        const binary=document.createElement('canvas');binary.width=base.width;binary.height=base.height;
        const ctx=binary.getContext('2d',{willReadFrequently:true});ctx.drawImage(base,0,0);
        const imageData=ctx.getImageData(0,0,binary.width,binary.height);
        for(let i=0;i<imageData.data.length;i+=4){
          const lum=.299*imageData.data[i]+.587*imageData.data[i+1]+.114*imageData.data[i+2];
          const value=lum>=185?0:255;
          imageData.data[i]=value;imageData.data[i+1]=value;imageData.data[i+2]=value;imageData.data[i+3]=255;
        }
        ctx.putImageData(imageData,0,0);variants.push(binary);
        for(let variantIndex=0;variantIndex<variants.length;variantIndex++){
          const result=await worker.recognize(variants[variantIndex]);
          const text=String(result?.data?.text||'').trim();
          const times=parseTimes(text);
          const evaluated=evaluateTimes(times);
          attempts.push({band,variantIndex,text,times,matches:evaluated.matches});
          if(evaluated.matches===5)return{startSlot:evaluated.startSlot,times,valid:evaluated.valid,attempts};
        }
      }
      const bestAttempt=[...attempts].sort((a,b)=>b.matches-a.matches)[0]||null;
      if(bestAttempt?.matches>=3){const evaluated=evaluateTimes(bestAttempt.times);return{startSlot:evaluated.startSlot,times:bestAttempt.times,valid:evaluated.valid,attempts};}
      return{startSlot:'',times:bestAttempt?.times||[],valid:[],attempts};
    } finally { await worker.terminate(); }
  }, { imageDataUrl, rect, timeBands: TIME_BANDS, startSlots: START_SLOTS });
}
`;
  text = text.slice(0,start) + replacement + text.slice(end);

  text = text.replace('        if (panel.okCount < 4 || panel.highCount < 2) continue;\n', '');
  text = text.replace('    for (const candidate of panelCandidates.slice(0, 16)) {', '    for (const candidate of panelCandidates.slice(0, 8)) {');
  replaceOnce(
`      if (!best || candidate.panel.highCount > best.panel.highCount ||
          (candidate.panel.highCount === best.panel.highCount && candidate.panel.minMargin > best.panel.minMargin) ||
          (candidate.panel.highCount === best.panel.highCount && candidate.panel.minMargin === best.panel.minMargin && candidate.panel.avg > best.panel.avg)) {
        best = { ...candidate, ocr };
      }`,
`      if (!best || candidate.panel.highCount > best.panel.highCount ||
          (candidate.panel.highCount === best.panel.highCount && candidate.panel.minMargin > best.panel.minMargin) ||
          (candidate.panel.highCount === best.panel.highCount && candidate.panel.minMargin === best.panel.minMargin && candidate.panel.avg > best.panel.avg)) {
        best = { ...candidate, ocr };
      }
      if(candidate.panel.highCount===5&&candidate.panel.okCount===5&&ocr.startSlot)break;`,
  'stop after exact ready candidate');

  fs.writeFileSync(file, text, 'utf8');
  console.log('Applied geometry-anchored weather review patch.');
} else {
  console.log('Geometry-anchored weather review patch already applied.');
}
