import fs from 'node:fs';

const file = 'tools/weather-deterministic-review.mjs';
let text = fs.readFileSync(file, 'utf8');
let changed = false;

if (!text.includes('clearVsRainChromaticBoostV4')) {
  const needle = "    const classifyCanvas=(canvas)=>{const f=feature(canvas),sig=signature(canvas),scores=heuristic(f);for(const t of templateFeatures){const fs=featureSimilarity(f,t.feature),ps=pixelSimilarity(sig,t.signature),score=ps*.58+fs*.32+(scores[t.weather]||0)*.10;scores[t.weather]=Math.max(scores[t.weather]||0,score);}const ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0],margin=bestScore-secondScore,ok=bestScore>=thresholds.confidence&&margin>=thresholds.margin;return{value:ok?bestValue:'',bestValue,bestScore,secondValue,secondScore,margin,confidence:ok?(bestScore>=thresholds.high?'high':'medium'):'low'};};";
  const replacement = "    const classifyCanvas=(canvas)=>{const clearVsRainChromaticBoostV4=true,f=feature(canvas),sig=signature(canvas),scores=heuristic(f);for(const t of templateFeatures){const fs=featureSimilarity(f,t.feature),ps=pixelSimilarity(sig,t.signature),score=ps*.58+fs*.32+(scores[t.weather]||0)*.10;scores[t.weather]=Math.max(scores[t.weather]||0,score);}let ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);const topTwo=new Set(ranked.slice(0,2).map(item=>item[0]));if(topTwo.has('晴')&&topTwo.has('雨')&&(f.orange+f.yellow)>=.045&&f.bright>=.85){scores['晴']=Math.max(scores['晴']||0,(scores['雨']||0)+.12);ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);}const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0],margin=bestScore-secondScore,ok=bestScore>=thresholds.confidence&&margin>=thresholds.margin;return{value:ok?bestValue:'',bestValue,bestScore,secondValue,secondScore,margin,confidence:ok?(bestScore>=thresholds.high?'high':'medium'):'low'};};";
  if (!text.includes(needle)) throw new Error('Missing classifyCanvas patch target.');
  text = text.replace(needle, replacement);
  changed = true;
}

if (!text.includes('timeLabelRowV4')) {
  const start = text.indexOf('async function readStartSlot(page, imageDataUrl, rect) {');
  const end = text.indexOf('\nexport async function inspectCapture', start);
  if (start < 0 || end < 0) throw new Error('Missing readStartSlot patch target.');

  const replacement = `async function readStartSlot(page, imageDataUrl, rect) {
  if (!(await page.evaluate(() => Boolean(window.Tesseract)))) await page.addScriptTag({ url: TESSERACT_URL });
  return page.evaluate(async ({ imageDataUrl, rect, slotRects, startSlots }) => {
    const timeLabelRowV4=true;
    const image = await new Promise((resolve, reject) => { const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=imageDataUrl; });
    const panel=document.createElement('canvas');panel.width=rect.w;panel.height=rect.h;panel.getContext('2d').drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
    const worker=await window.Tesseract.createWorker('eng',1,{logger:()=>{}});
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'});
    const allowed=new Set(startSlots);
    const slotCenters=slotRects.map(cell=>(cell.x+cell.w/2)*panel.width);
    const attempts=[];
    const evaluateMapped=(mapped)=>{
      let best={startSlot:'',matches:0,mismatches:99,expected:[]};
      for(const startSlot of startSlots){
        const startIndex=startSlots.indexOf(startSlot);
        const expected=Array.from({length:5},(_,index)=>startSlots[(startIndex+index)%startSlots.length]);
        let matches=0,mismatches=0,observed=0;
        for(let index=0;index<5;index++){
          if(!mapped[index])continue;
          observed++;
          if(mapped[index]===expected[index])matches++;else mismatches++;
        }
        const candidate={startSlot,matches,mismatches,observed,expected};
        if(mismatches===0&&matches>=4)return candidate;
        if(matches>best.matches||(matches===best.matches&&mismatches<best.mismatches))best=candidate;
      }
      return best;
    };
    try {
      const band={x:.055,y:.490,w:.900,h:.080};
      const x=Math.round(band.x*panel.width),y=Math.round(band.y*panel.height),w=Math.round(band.w*panel.width),h=Math.round(band.h*panel.height),scale=6;
      const base=document.createElement('canvas');base.width=Math.max(1,w*scale);base.height=Math.max(1,h*scale);
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
        const result=await worker.recognize(variants[variantIndex],{}, {tsv:true});
        const raw=String(result?.data?.text||'').trim();
        const tsv=String(result?.data?.tsv||'');
        const words=[];
        for(const line of tsv.split(/\\r?\\n/).slice(1)){
          const cols=line.split('\\t');
          if(cols.length<12||cols[0]!=='5')continue;
          const token=String(cols.slice(11).join('\\t')||'').trim();
          const match=token.match(/\\d{1,2}/);
          if(!match)continue;
          const value=String(Number(match[0])).padStart(2,'0').slice(-2);
          if(!allowed.has(value))continue;
          const left=Number(cols[6]),width=Number(cols[8]);
          if(!Number.isFinite(left)||!Number.isFinite(width))continue;
          const centerPanel=x+(left+width/2)/scale;
          let nearest=0,nearestDistance=Infinity;
          for(let index=0;index<slotCenters.length;index++){
            const distance=Math.abs(slotCenters[index]-centerPanel);
            if(distance<nearestDistance){nearest=index;nearestDistance=distance;}
          }
          if(nearestDistance<=panel.width*.10)words.push({value,index:nearest,centerPanel,token});
        }
        const mapped=Array(5).fill('');
        for(const word of words){if(!mapped[word.index])mapped[word.index]=word.value;}
        const evaluated=evaluateMapped(mapped);
        attempts.push({variantIndex,raw,mapped,words,matches:evaluated.matches,mismatches:evaluated.mismatches});
        if(evaluated.mismatches===0&&evaluated.matches>=4){
          return{startSlot:evaluated.startSlot,times:evaluated.expected,valid:mapped.filter(Boolean),attempts,inferred:true};
        }
      }
      const fallback=[...attempts].sort((a,b)=>b.matches-a.matches||a.mismatches-b.mismatches)[0]||null;
      return{startSlot:'',times:fallback?.mapped||[],valid:(fallback?.mapped||[]).filter(Boolean),attempts,inferred:false};
    } finally { await worker.terminate(); }
  }, { imageDataUrl, rect, slotRects: SLOT_RECTS, startSlots: START_SLOTS });
}
`;
  text = text.slice(0,start) + replacement + text.slice(end);
  changed = true;
}

if (changed) {
  fs.writeFileSync(file, text, 'utf8');
  console.log('Applied real-image weather review calibration v4.');
} else {
  console.log('Real-image weather review calibration v4 already applied.');
}
