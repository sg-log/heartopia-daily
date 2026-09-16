import fs from 'node:fs';

const file = 'tools/weather-deterministic-review.mjs';
let text = fs.readFileSync(file, 'utf8');

if (!text.includes('timeLabelCellsV3')) {
  const start = text.indexOf('async function readStartSlot(page, imageDataUrl, rect) {');
  const end = text.indexOf('\nexport async function inspectCapture', start);
  if (start < 0 || end < 0) throw new Error('Missing readStartSlot patch target.');

  const replacement = `async function readStartSlot(page, imageDataUrl, rect) {
  if (!(await page.evaluate(() => Boolean(window.Tesseract)))) await page.addScriptTag({ url: TESSERACT_URL });
  return page.evaluate(async ({ imageDataUrl, rect, slotRects, startSlots }) => {
    const timeLabelCellsV3=true;
    const image = await new Promise((resolve, reject) => { const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=imageDataUrl; });
    const panel=document.createElement('canvas');panel.width=rect.w;panel.height=rect.h;panel.getContext('2d').drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
    const worker=await window.Tesseract.createWorker('eng',1,{logger:()=>{}});
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'8'});
    const allowed=new Set(startSlots);
    const attempts=[];
    const values=[];
    try {
      for(let index=0;index<slotRects.length;index++){
        const cell=slotRects[index];
        const center=(cell.x+cell.w/2)*panel.width;
        const w=Math.round(.135*panel.width),h=Math.round(.090*panel.height);
        const x=Math.max(0,Math.round(center-w/2)),y=Math.round(.485*panel.height);
        const base=document.createElement('canvas');base.width=Math.max(1,w*8);base.height=Math.max(1,h*8);
        const bctx=base.getContext('2d',{willReadFrequently:true});bctx.imageSmoothingEnabled=true;bctx.imageSmoothingQuality='high';bctx.drawImage(panel,x,y,w,h,0,0,base.width,base.height);
        const variants=[base];
        const binary=document.createElement('canvas');binary.width=base.width;binary.height=base.height;
        const ctx=binary.getContext('2d',{willReadFrequently:true});ctx.drawImage(base,0,0);
        const imageData=ctx.getImageData(0,0,binary.width,binary.height);
        for(let i=0;i<imageData.data.length;i+=4){
          const lum=.299*imageData.data[i]+.587*imageData.data[i+1]+.114*imageData.data[i+2];
          const value=lum>=180?0:255;
          imageData.data[i]=value;imageData.data[i+1]=value;imageData.data[i+2]=value;imageData.data[i+3]=255;
        }
        ctx.putImageData(imageData,0,0);variants.push(binary);
        let accepted='';
        for(let variantIndex=0;variantIndex<variants.length;variantIndex++){
          const result=await worker.recognize(variants[variantIndex]);
          const raw=String(result?.data?.text||'').trim();
          const match=raw.match(/\\d{1,2}/);
          const value=match?String(Number(match[0])).padStart(2,'0').slice(-2):'';
          attempts.push({index,variantIndex,raw,value});
          if(allowed.has(value)){accepted=value;break;}
        }
        values.push(accepted);
      }
      if(values.length===5&&values.every(Boolean)){
        const firstIndex=startSlots.indexOf(values[0]);
        if(firstIndex>=0&&values.every((value,index)=>value===startSlots[(firstIndex+index)%startSlots.length])){
          return{startSlot:values[0],times:values,valid:values,attempts};
        }
      }
      return{startSlot:'',times:values,valid:values.filter(Boolean),attempts};
    } finally { await worker.terminate(); }
  }, { imageDataUrl, rect, slotRects: SLOT_RECTS, startSlots: START_SLOTS });
}
`;
  text = text.slice(0,start) + replacement + text.slice(end);
  text = text.replace(
    "ocrAttempts.push({file:candidate.media.file,rect:candidate.panel.rect,geometryDistance:candidate.geometryDistance,highCount:candidate.panel.highCount,okCount:candidate.panel.okCount,ocr});",
    "ocrAttempts.push({file:candidate.media.file,rect:candidate.panel.rect,geometryDistance:candidate.geometryDistance,highCount:candidate.panel.highCount,okCount:candidate.panel.okCount,slots:candidate.panel.slots,ocr});"
  );
  fs.writeFileSync(file, text, 'utf8');
  console.log('Applied fixed-position time label OCR patch.');
} else {
  console.log('Fixed-position time label OCR patch already applied.');
}
