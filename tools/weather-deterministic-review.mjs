import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const TARGET_ASPECT = 497 / 661;
const WEATHER_VALUES = ['晴', '雨', '流星群', '虹', '猛暑'];
const START_SLOTS = ['00', '06', '12', '18'];
const SLOT_RECTS = [
  { key: 'slot0', x: .105, y: .425, w: .110, h: .075 },
  { key: 'slot1', x: .275, y: .425, w: .110, h: .075 },
  { key: 'slot2', x: .450, y: .425, w: .110, h: .075 },
  { key: 'slot3', x: .640, y: .425, w: .110, h: .075 },
  { key: 'slot4', x: .835, y: .425, w: .110, h: .075 }
];
const TIME_BANDS = [
  { x: .055, y: .490, w: .900, h: .080 },
  { x: .055, y: .500, w: .900, h: .070 },
  { x: .055, y: .505, w: .900, h: .065 },
  { x: .055, y: .515, w: .900, h: .060 }
];
const CONFIDENCE_THRESHOLD = .58;
const HIGH_THRESHOLD = .72;
const MARGIN_THRESHOLD = .10;
const TEMPLATE_FILES = [
  ['晴', 'sun-day.png'],
  ['晴', 'sun-night-slot0.png'],
  ['晴', 'sun-night-slot1.png'],
  ['晴', 'sun-night-slot4.png'],
  ['猛暑', 'heatwave.png'],
  ['虹', 'rainbow.png'],
  ['流星群', 'meteor-shower.png'],
  ['雨', 'rain.png']
];
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

export function normalizeTargetDate(value) {
  const text = String(value || '').trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(text)) throw new Error('invalidTargetDate');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new Error('invalidTargetDate');
  return text;
}

export function extractPostDates(text) {
  const source = String(text || '');
  const out = new Set();
  const patterns = [
    /\b(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\b/g,
    /(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const yyyy = match[1];
      const mm = String(Number(match[2])).padStart(2, '0');
      const dd = String(Number(match[3])).padStart(2, '0');
      try { out.add(normalizeTargetDate(`${yyyy}-${mm}-${dd}`)); } catch {}
    }
  }
  return [...out].sort();
}

export function postConfirmsTargetDate(text, targetDate) {
  return extractPostDates(text).includes(normalizeTargetDate(targetDate));
}

export function buildPanelCandidates(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 160) return [];
  const candidates = [];
  const seen = new Set();
  const add = (x, y, w, h, source) => {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (w < 120 || h < 160 || x < 0 || y < 0 || x + w > width || y + h > height) return;
    const key = `${x},${y},${w},${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ x, y, w, h, source });
  };
  const aspect = width / height;
  if (Math.abs(aspect - TARGET_ASPECT) <= .18) add(0, 0, width, height, 'whole-image');
  for (const heightFraction of [.72, .75, .78, .81]) {
    const h = height * heightFraction;
    const w = h * TARGET_ASPECT;
    for (const topFraction of [.07, .10, .12, .14]) {
      const y = height * topFraction;
      for (const rightFraction of [.03, .055, .08, .105]) {
        const x = width - width * rightFraction - w;
        add(x, y, w, h, 'right-panel-search');
      }
    }
  }
  return candidates;
}

function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}

async function imageDescriptor(filePath) {
  const bytes = await readFile(filePath);
  return {
    bytes,
    mimeType: mimeFromBytes(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

async function loadTemplates(repoRoot) {
  const templateRoot = path.join(repoRoot, 'assets', 'weather-templates');
  const templates = [];
  for (const [weather, file] of TEMPLATE_FILES) {
    const bytes = await readFile(path.join(templateRoot, file));
    templates.push({ weather, file, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
  }
  return templates;
}

async function scoreImage(page, imageDataUrl, templates) {
  return page.evaluate(async ({ imageDataUrl, templates, targetAspect, slotRects, thresholds }) => {
    const loadImage = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
    const [sourceImage, ...templateImages] = await Promise.all([
      loadImage(imageDataUrl),
      ...templates.map(item => loadImage(item.dataUrl))
    ]);
    const templateRecords = templates.map((item, index) => ({ ...item, image: templateImages[index] }));
    const rgbToHsv = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      let h = 0;
      if (d) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      return { h, s: max ? d / max : 0, v: max };
    };
    const feature = (canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      const corner = [[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y]) => {
        const i = (y * width + x) * 4; return [data[i], data[i+1], data[i+2]];
      });
      const bg = corner.reduce((acc, rgb) => [acc[0]+rgb[0], acc[1]+rgb[1], acc[2]+rgb[2]], [0,0,0]).map(v => v / corner.length);
      const bins = Array(12).fill(0);
      let count=0, sat=0, bright=0, dark=0, yellow=0, orange=0, red=0, green=0, blue=0, cyan=0, purple=0, edge=0;
      for (let y=1; y<height-1; y++) for (let x=1; x<width-1; x++) {
        const i=(y*width+x)*4, r=data[i], g=data[i+1], b=data[i+2];
        const dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);
        const hsv=rgbToHsv(r,g,b);
        if(dist<22 && hsv.s<.18) continue;
        count++; sat+=hsv.s;
        if(hsv.v>.72) bright++; if(hsv.v<.32) dark++;
        if(hsv.h<25 || hsv.h>=345) red++; if(hsv.h>=25&&hsv.h<52) orange++; if(hsv.h>=52&&hsv.h<78) yellow++;
        if(hsv.h>=78&&hsv.h<165) green++; if(hsv.h>=165&&hsv.h<205) cyan++; if(hsv.h>=205&&hsv.h<265) blue++; if(hsv.h>=265&&hsv.h<330) purple++;
        bins[Math.min(11,Math.floor(hsv.h/30))]++;
        const left=(y*width+x-1)*4, up=((y-1)*width+x)*4;
        if(Math.abs(r-data[left])+Math.abs(g-data[left+1])+Math.abs(b-data[left+2])+Math.abs(r-data[up])+Math.abs(g-data[up+1])+Math.abs(b-data[up+2])>110) edge++;
      }
      const d=Math.max(1,count);
      return { bins:bins.map(v=>v/d), countRatio:count/(width*height), sat:sat/d, bright:bright/d, dark:dark/d, yellow:yellow/d, orange:orange/d, red:red/d, green:green/d, blue:blue/d, cyan:cyan/d, purple:purple/d, edge:edge/d, diversity:bins.filter(v=>v/d>.035).length/bins.length };
    };
    const signature = (canvas) => {
      const ctx=canvas.getContext('2d',{willReadFrequently:true}), {width,height}=canvas, data=ctx.getImageData(0,0,width,height).data;
      const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});
      const bg=corner.reduce((a,rgb)=>[a[0]+rgb[0],a[1]+rgb[1],a[2]+rgb[2]],[0,0,0]).map(v=>v/corner.length);
      const pixels=[],mask=[];
      for(let y=0;y<height;y++) for(let x=0;x<width;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);mask.push(dist>=22||hsv.s>=.18?1:0);pixels.push([r,g,b]);}
      return {pixels,mask};
    };
    const heuristic=(f)=>{const s={晴:Math.max(f.yellow*.9+f.orange*.35+f.bright*.28-f.dark*.18,f.bright*.42+(1-f.sat)*.14),猛暑:f.yellow*.6+f.orange*.75+f.dark*.28+f.edge*.12,虹:f.diversity*.55+f.red*.35+f.green*.35+(f.blue+f.cyan)*.28,流星群:f.purple*.55+f.blue*.45+f.bright*.18+f.edge*.18,雨:f.blue*.65+f.cyan*.55+f.sat*.18};if(f.countRatio<.04)Object.keys(s).forEach(k=>s[k]*=.45);return s;};
    const featureSimilarity=(a,b)=>{const hist=a.bins.reduce((sum,v,i)=>sum+Math.min(v,b.bins[i]||0),0);const scalar=1-Math.min(1,(Math.abs(a.sat-b.sat)+Math.abs(a.bright-b.bright)+Math.abs(a.dark-b.dark)+Math.abs(a.edge-b.edge))/4);return hist*.72+scalar*.28;};
    const pixelSimilarity=(a,b)=>{let union=0,intersection=0,color=0,colorCount=0;for(let i=0;i<a.mask.length;i++){const am=a.mask[i],bm=b.mask[i];if(am||bm)union++;if(am&&bm){intersection++;const pa=a.pixels[i],pb=b.pixels[i],diff=(Math.abs(pa[0]-pb[0])+Math.abs(pa[1]-pb[1])+Math.abs(pa[2]-pb[2]))/(255*3);color+=1-diff;colorCount++;}}const maskScore=union?intersection/union:0,colorScore=colorCount?color/colorCount:0;return maskScore*.38+colorScore*.62;};
    const templateFeatures=templateRecords.map(t=>{const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d',{willReadFrequently:true}).drawImage(t.image,0,0,56,56);return{weather:t.weather,feature:feature(c),signature:signature(c)}});
    const classifyCanvas=(canvas)=>{const clearVsRainChromaticBoostV4=true,f=feature(canvas),sig=signature(canvas),scores=heuristic(f);for(const t of templateFeatures){const fs=featureSimilarity(f,t.feature),ps=pixelSimilarity(sig,t.signature),score=ps*.58+fs*.32+(scores[t.weather]||0)*.10;scores[t.weather]=Math.max(scores[t.weather]||0,score);}let ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);const topTwo=new Set(ranked.slice(0,2).map(item=>item[0]));if(topTwo.has('晴')&&topTwo.has('雨')&&(f.orange+f.yellow)>=.045&&f.bright>=.85){scores['晴']=Math.max(scores['晴']||0,(scores['雨']||0)+.12);ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);}const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0],margin=bestScore-secondScore,ok=bestScore>=thresholds.confidence&&margin>=thresholds.margin;return{value:ok?bestValue:'',bestValue,bestScore,secondValue,secondScore,margin,confidence:ok?(bestScore>=thresholds.high?'high':'medium'):'low'};};
    const buildCandidates=()=>{
      const width=sourceImage.naturalWidth,height=sourceImage.naturalHeight,out=[],seen=new Set();
      const add=(x,y,w,h,source)=>{x=Math.round(x);y=Math.round(y);w=Math.round(w);h=Math.round(h);if(w<120||h<160||x<0||y<0||x+w>width||y+h>height)return;const k=`${x},${y},${w},${h}`;if(seen.has(k))return;seen.add(k);out.push({x,y,w,h,source});};
      if(Math.abs(width/height-targetAspect)<=.18)add(0,0,width,height,'whole-image');
      for(const hf of [.72,.75,.78,.81]){const h=height*hf,w=h*targetAspect;for(const tf of [.07,.10,.12,.14])for(const rf of [.03,.055,.08,.105])add(width-width*rf-w,height*tf,w,h,'right-panel-search');}
      return out;
    };
    const panelCanvas=(r)=>{const c=document.createElement('canvas');c.width=r.w;c.height=r.h;c.getContext('2d').drawImage(sourceImage,r.x,r.y,r.w,r.h,0,0,r.w,r.h);return c;};
    const classifyPanel=(r)=>{const p=panelCanvas(r),slots=slotRects.map(rect=>{const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(p,Math.round(rect.x*p.width),Math.round(rect.y*p.height),Math.round(rect.w*p.width),Math.round(rect.h*p.height),0,0,56,56);return classifyCanvas(c);});const highCount=slots.filter(s=>s.confidence==='high').length,okCount=slots.filter(s=>s.value).length,avg=slots.reduce((s,v)=>s+v.bestScore,0)/slots.length,minMargin=Math.min(...slots.map(s=>s.margin));return{rect:r,slots,highCount,okCount,avg,minMargin};};
    const geometryAnchorV2=(panel)=>{
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
    return {width:sourceImage.naturalWidth,height:sourceImage.naturalHeight,best,ranked:rankedPanels};
  }, { imageDataUrl, templates, targetAspect: TARGET_ASPECT, slotRects: SLOT_RECTS, thresholds: { confidence: CONFIDENCE_THRESHOLD, high: HIGH_THRESHOLD, margin: MARGIN_THRESHOLD } });
}

async function readStartSlot(page, imageDataUrl, rect) {
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
        for(const line of tsv.split(/\r?\n/).slice(1)){
          const cols=line.split('\t');
          if(cols.length<12||cols[0]!=='5')continue;
          const token=String(cols.slice(11).join('\t')||'').trim();
          const match=token.match(/\d{1,2}/);
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

export async function inspectCapture({ captureDir, targetDate, repoRoot = path.resolve('.') }) {
  targetDate = normalizeTargetDate(targetDate);
  const capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8'));
  if (capture?.status !== 'captured' || !Array.isArray(capture.rawMedia) || !capture.rawMedia.length) throw new Error('captureNotReady');
  const postText = await readFile(path.join(captureDir, capture.postContent?.file || 'post-content.txt'), 'utf8');
  const dates = extractPostDates(postText);
  if (!dates.includes(targetDate)) {
    return { schemaVersion: 1, ready: false, targetDate, selectedImage: null, interpretation: { ready:false, observedDate:null, startSlot:null, slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:false,weather:[],confidence:'low',description:''})), confidence:'low', summary:'投稿本文で対象日を確認できませんでした。', unresolved:[`対象日 ${targetDate} が投稿本文にありません`] }, diagnostics:{postDates:dates} };
  }
  const templates = await loadTemplates(repoRoot);
  const browser = await chromium.launch({ headless: true });
  let best = null;
  try {
    const page = await browser.newPage();
    const panelCandidates = [];
    for (const media of capture.rawMedia.slice(0, 4)) {
      const filePath = path.join(captureDir, String(media.file || ''));
      let descriptor;
      try { descriptor = await imageDescriptor(filePath); } catch { continue; }
      if (descriptor.sha256 !== media.sha256 || descriptor.mimeType !== media.mimeType) continue;
      const imageDataUrl = `data:${descriptor.mimeType};base64,${descriptor.bytes.toString('base64')}`;
      const scored = await scoreImage(page, imageDataUrl, templates);
      for (const panel of scored.ranked || []) {
        const structure = await page.evaluate(async ({ imageDataUrl, rect }) => {
          const image = await new Promise((resolve, reject) => { const value = new Image(); value.onload=()=>resolve(value); value.onerror=reject; value.src=imageDataUrl; });
          const canvas=document.createElement('canvas'); canvas.width=rect.w; canvas.height=rect.h;
          const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
          const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
          let topBlue=0,topTotal=0,lowerLight=0,lowerTotal=0;
          const rgbToHsv=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:max?d/max:0,v:max};};
          for(let y=0;y<canvas.height;y+=2)for(let x=0;x<canvas.width;x+=2){const i=(y*canvas.width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b);if(y<canvas.height*.52){topTotal++;if(b>140&&g>105&&b>r*1.12&&hsv.s>.22&&hsv.h>=175&&hsv.h<=235)topBlue++;}else{lowerTotal++;if(hsv.v>=.72&&hsv.s<=.25)lowerLight++;}}
          const topBlueRatio=topTotal?topBlue/topTotal:0,lowerLightRatio=lowerTotal?lowerLight/lowerTotal:0;
          return { ready: topBlueRatio>=.20 && lowerLightRatio>=.35, topBlueRatio, lowerLightRatio };
        }, { imageDataUrl, rect: panel.rect });
        if (!structure.ready) continue;
        const right=(scored.width-panel.rect.x-panel.rect.w)/scored.width;
        const geometryDistance=Math.abs(panel.rect.h/scored.height-.75)+Math.abs(panel.rect.y/scored.height-.12)+Math.abs(right-.08);
        panelCandidates.push({ media, descriptor, imageDataUrl, panel, geometryDistance, structure });
      }
    }
    panelCandidates.sort((a,b)=>a.geometryDistance-b.geometryDistance||b.panel.highCount-a.panel.highCount||b.panel.okCount-a.panel.okCount||b.panel.minMargin-a.panel.minMargin||b.panel.avg-a.panel.avg);
    const ocrAttempts = [];
    for (const candidate of panelCandidates.slice(0, 8)) {
      const ocr = await readStartSlot(page, candidate.imageDataUrl, candidate.panel.rect);
      ocrAttempts.push({file:candidate.media.file,rect:candidate.panel.rect,geometryDistance:candidate.geometryDistance,highCount:candidate.panel.highCount,okCount:candidate.panel.okCount,slots:candidate.panel.slots,ocr});
      if (!ocr.startSlot) continue;
      if (!best || candidate.panel.highCount > best.panel.highCount ||
          (candidate.panel.highCount === best.panel.highCount && candidate.panel.minMargin > best.panel.minMargin) ||
          (candidate.panel.highCount === best.panel.highCount && candidate.panel.minMargin === best.panel.minMargin && candidate.panel.avg > best.panel.avg)) {
        best = { ...candidate, ocr };
      }
      if(candidate.panel.highCount===5&&candidate.panel.okCount===5&&ocr.startSlot)break;
    }
    if (!best || best.panel.highCount !== 5 || best.panel.okCount !== 5 || !best.ocr.startSlot) {
      const fallback = panelCandidates[0] || null;
      return { schemaVersion:1, ready:false, targetDate, selectedImage:null, interpretation:{ready:false,observedDate:targetDate,startSlot:null,slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:false,weather:[],confidence:'low',description:''})),confidence:'low',summary:'時刻ラベルで整合する天気5枠を高確信度で判読できませんでした。',unresolved:['時間別5枠と開始時刻の両方を高確信度で確定できませんでした']}, diagnostics:{postDates:dates,best:fallback?.panel||null,ocrAttempts} };
    }
    const slots=best.panel.slots.map((s,i)=>({slot:`slot${i}`,visible:true,weather:[s.value],confidence:'high',description:`画像テンプレート判定 score=${s.bestScore.toFixed(3)} margin=${s.margin.toFixed(3)}`}));
    const interpretation={ready:true,observedDate:targetDate,startSlot:best.ocr.startSlot,slots,confidence:'high',summary:`投稿本文で${targetDate}を確認し、元画像の天気パネルをテンプレート照合、時刻ラベルをOCRして5枠を判読。`,unresolved:[]};
    return { schemaVersion:1, ready:true, targetDate, selectedImage:{file:best.media.file,mimeType:best.media.mimeType,captureSha256:best.media.sha256}, interpretation, diagnostics:{postDates:dates,panel:best.panel.rect,ocr:best.ocr,ocrAttempts,slotScores:best.panel.slots.map(s=>({bestValue:s.bestValue,bestScore:s.bestScore,secondValue:s.secondValue,secondScore:s.secondScore,margin:s.margin}))} };
  } finally { await browser.close(); }
}

export function bindReviewEnvelope(draft, artifact) {
  if (!draft?.ready || !draft.selectedImage || draft.interpretation?.ready !== true) throw new Error('reviewNotReady');
  for (const value of [artifact?.runId, artifact?.id]) if (!/^[1-9]\d{0,19}$/.test(String(value||''))) throw new Error('invalidArtifactBinding');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(artifact?.name||''))) throw new Error('invalidArtifactBinding');
  return { schemaVersion:4, artifact:{runId:String(artifact.runId),id:String(artifact.id),name:String(artifact.name)}, reviewedImages:[draft.selectedImage], pendingEvidenceFile:draft.selectedImage.file, interpretation:draft.interpretation };
}

function parseArgs(argv) {
  const out={};
  for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}
  return out;
}

async function main() {
  const args=parseArgs(process.argv.slice(2));
  if(args.mode==='inspect'){
    if(!args['capture-dir']||!args['target-date']||!args.output)throw new Error('invalidArguments');
    const result=await inspectCapture({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});
    await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');
    process.stdout.write(`${JSON.stringify({ready:result.ready,selectedImage:result.selectedImage?.file||'',startSlot:result.interpretation?.startSlot||''})}\n`);
    if(!result.ready)process.exitCode=2;
    return;
  }
  if(args.mode==='bind'){
    if(!args.draft||!args.output||!args['artifact-run-id']||!args['artifact-id']||!args['artifact-name'])throw new Error('invalidArguments');
    const draft=JSON.parse(await readFile(path.resolve(args.draft),'utf8'));
    const envelope=bindReviewEnvelope(draft,{runId:args['artifact-run-id'],id:args['artifact-id'],name:args['artifact-name']});
    const json=JSON.stringify(envelope);
    const base64=Buffer.from(json,'utf8').toString('base64');
    await writeFile(path.resolve(args.output),`${JSON.stringify(envelope,null,2)}\n`,'utf8');
    if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,`review_payload_base64=${base64}\n`,{encoding:'utf8',flag:'a'});
    process.stdout.write(`${JSON.stringify({ready:true,artifactId:envelope.artifact.id,pendingEvidenceFile:envelope.pendingEvidenceFile})}\n`);
    return;
  }
  throw new Error('invalidArguments');
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Deterministic weather review failed: ${error.message}\n`);process.exitCode=1;});}
