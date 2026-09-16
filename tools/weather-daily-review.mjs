import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  bindReviewEnvelope,
  extractPostDates,
  inspectCapture,
  normalizeTargetDate
} from './weather-deterministic-review.mjs';

const START_SLOTS = ['00', '06', '12', '18'];
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
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
const SUMMARY_PANEL_VARIANTS = [
  { x: .408, y: .184, w: .552, h: .334 },
  { x: .414, y: .190, w: .542, h: .324 },
  { x: .420, y: .196, w: .532, h: .314 },
  { x: .404, y: .190, w: .548, h: .326 },
  { x: .418, y: .184, w: .538, h: .332 }
];
const SUMMARY_SLOT_RECTS = [
  { x: .080, y: .675, w: .120, h: .165 },
  { x: .245, y: .675, w: .120, h: .165 },
  { x: .425, y: .675, w: .120, h: .165 },
  { x: .625, y: .675, w: .120, h: .165 },
  { x: .800, y: .675, w: .120, h: .165 }
];
const SUMMARY_TIME_BANDS = [
  { x: .040, y: .835, w: .920, h: .155 },
  { x: .040, y: .855, w: .920, h: .130 },
  { x: .055, y: .840, w: .890, h: .145 }
];

function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseSpecialWeather(text) {
  const source = String(text || '');
  const out = [];
  const pattern = /【特殊天気】\s*(流星群|虹|猛暑|雪|桜)\s*[｜|]\s*(\d{1,2}):(\d{2})\s*[〜～~-]\s*(\d{1,2}|24):(\d{2})/g;
  for (const match of source.matchAll(pattern)) {
    const start = Number(match[2]) + Number(match[3]) / 60;
    let end = Number(match[4]) + Number(match[5]) / 60;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= 24 || end < 0 || end > 24) continue;
    if (end <= start) end += 24;
    out.push({ weather: match[1], start, end });
  }
  return out;
}

export function weatherForSlot(baseWeather, startSlot, index, specialWeather) {
  const values = [baseWeather].filter(Boolean);
  const start = Number(startSlot) + index * 6;
  const end = start + 6;
  for (const special of specialWeather || []) {
    for (const offset of [0, 24]) {
      const specialStart = special.start + offset;
      const specialEnd = special.end + offset;
      if (Math.max(start, specialStart) < Math.min(end, specialEnd) && !values.includes(special.weather)) values.push(special.weather);
    }
  }
  return values;
}

async function loadTemplates(repoRoot) {
  const root = path.join(repoRoot, 'assets', 'weather-templates');
  const out = [];
  for (const [weather, file] of TEMPLATE_FILES) {
    const bytes = await readFile(path.join(root, file));
    out.push({ weather, file, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
  }
  return out;
}

async function inspectSummaryCard(page, imageDataUrl, templates) {
  return page.evaluate(async ({ imageDataUrl, templates, panelVariants, slotRects }) => {
    const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload=()=>resolve(image); image.onerror=reject; image.src=src; });
    const [source, ...templateImages] = await Promise.all([load(imageDataUrl), ...templates.map(item => load(item.dataUrl))]);
    const aspect = source.naturalWidth / source.naturalHeight;
    if (source.naturalWidth < 420 || source.naturalHeight < 500 || aspect < .70 || aspect > .92) return { candidates: [] };
    const rgbToHsv=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:max?d/max:0,v:max};};
    const signature=canvas=>{const ctx=canvas.getContext('2d',{willReadFrequently:true}),{width,height}=canvas,data=ctx.getImageData(0,0,width,height).data;const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});const bg=corner.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corner.length);const pixels=[],mask=[];let warm=0,pale=0,blue=0,foreground=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);const fg=dist>=18||hsv.s>=.15;mask.push(fg?1:0);pixels.push([r,g,b]);if(!fg)continue;foreground++;if(hsv.h>=28&&hsv.h<=82&&hsv.s>=.18&&hsv.v>=.62)warm++;if(hsv.v>=.72&&hsv.s<=.30)pale++;if(hsv.h>=175&&hsv.h<=245&&hsv.s>=.15)blue++;}const d=Math.max(1,foreground);return{pixels,mask,warm:warm/d,pale:pale/d,blue:blue/d};};
    const similarity=(a,b)=>{let union=0,intersection=0,color=0,count=0;for(let i=0;i<a.mask.length;i++){if(a.mask[i]||b.mask[i])union++;if(a.mask[i]&&b.mask[i]){intersection++;const pa=a.pixels[i],pb=b.pixels[i],diff=(Math.abs(pa[0]-pb[0])+Math.abs(pa[1]-pb[1])+Math.abs(pa[2]-pb[2]))/765;color+=1-diff;count++;}}return(union?intersection/union:0)*.40+(count?color/count:0)*.60;};
    const prepared=templates.map((item,index)=>{const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(templateImages[index],0,0,56,56);return{weather:item.weather,file:item.file,sig:signature(c)};});
    const classify=canvas=>{const sig=signature(canvas),byWeather=new Map();for(const t of prepared){let value=similarity(sig,t.sig);if(t.weather==='晴')value+=sig.warm*.20;if(t.weather==='雨')value+=sig.pale*.08+sig.blue*.04;byWeather.set(t.weather,Math.max(value,byWeather.get(t.weather)||0));}const ranked=[...byWeather.entries()].sort((a,b)=>b[1]-a[1]);const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0];const margin=bestScore-secondScore;const confident=bestScore>=.55&&margin>=.055;return{value:confident?bestValue:'',bestValue,bestScore,secondValue,secondScore,margin,confidence:confident?'high':'low'};};
    const candidates=[];
    for(let variantIndex=0;variantIndex<panelVariants.length;variantIndex++){
      const v=panelVariants[variantIndex];
      const rect={x:Math.round(source.naturalWidth*v.x),y:Math.round(source.naturalHeight*v.y),w:Math.round(source.naturalWidth*v.w),h:Math.round(source.naturalHeight*v.h)};
      if(rect.x<0||rect.y<0||rect.x+rect.w>source.naturalWidth||rect.y+rect.h>source.naturalHeight)continue;
      const panel=document.createElement('canvas');panel.width=rect.w;panel.height=rect.h;panel.getContext('2d').drawImage(source,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
      const slots=slotRects.map(cell=>{const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(panel,Math.round(cell.x*panel.width),Math.round(cell.y*panel.height),Math.round(cell.w*panel.width),Math.round(cell.h*panel.height),0,0,56,56);return classify(c);});
      const okCount=slots.filter(slot=>slot.value).length;
      const average=slots.reduce((sum,slot)=>sum+slot.bestScore,0)/slots.length;
      const minMargin=Math.min(...slots.map(slot=>slot.margin));
      candidates.push({variantIndex,rect,slots,okCount,average,minMargin});
    }
    candidates.sort((a,b)=>b.okCount-a.okCount||b.minMargin-a.minMargin||b.average-a.average);
    return{width:source.naturalWidth,height:source.naturalHeight,candidates};
  }, { imageDataUrl, templates, panelVariants: SUMMARY_PANEL_VARIANTS, slotRects: SUMMARY_SLOT_RECTS });
}

async function readSummaryStartSlot(page, imageDataUrl, rect) {
  if (!(await page.evaluate(() => Boolean(window.Tesseract)))) await page.addScriptTag({ url: TESSERACT_URL });
  return page.evaluate(async ({ imageDataUrl, rect, bands, slotRects, startSlots }) => {
    const image=await new Promise((resolve,reject)=>{const item=new Image();item.onload=()=>resolve(item);item.onerror=reject;item.src=imageDataUrl;});
    const panel=document.createElement('canvas');panel.width=rect.w;panel.height=rect.h;panel.getContext('2d').drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
    const worker=await window.Tesseract.createWorker('eng',1,{logger:()=>{}});
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'});
    const centers=slotRects.map(cell=>(cell.x+cell.w/2)*panel.width),allowed=new Set(startSlots),attempts=[];
    try{
      for(let bandIndex=0;bandIndex<bands.length;bandIndex++){
        const band=bands[bandIndex],x=Math.round(band.x*panel.width),y=Math.round(band.y*panel.height),w=Math.round(band.w*panel.width),h=Math.round(band.h*panel.height),scale=7;
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,w*scale);canvas.height=Math.max(1,h*scale);const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(panel,x,y,w,h,0,0,canvas.width,canvas.height);
        const variants=[canvas];
        const binary=document.createElement('canvas');binary.width=canvas.width;binary.height=canvas.height;const bctx=binary.getContext('2d',{willReadFrequently:true});bctx.drawImage(canvas,0,0);const id=bctx.getImageData(0,0,binary.width,binary.height);for(let i=0;i<id.data.length;i+=4){const lum=.299*id.data[i]+.587*id.data[i+1]+.114*id.data[i+2],v=lum>=178?0:255;id.data[i]=v;id.data[i+1]=v;id.data[i+2]=v;id.data[i+3]=255;}bctx.putImageData(id,0,0);variants.push(binary);
        for(let variantIndex=0;variantIndex<variants.length;variantIndex++){
          const result=await worker.recognize(variants[variantIndex],{}, {tsv:true});const raw=String(result?.data?.text||'').trim(),tsv=String(result?.data?.tsv||''),mapped=Array(5).fill(''),words=[];
          for(const line of tsv.split(/\r?\n/).slice(1)){const cols=line.split('\t');if(cols.length<12||cols[0]!=='5')continue;const token=String(cols.slice(11).join('\t')||'').trim(),match=token.match(/\d{1,2}/);if(!match)continue;const value=String(Number(match[0])).padStart(2,'0').slice(-2);if(!allowed.has(value))continue;const left=Number(cols[6]),width=Number(cols[8]);if(!Number.isFinite(left)||!Number.isFinite(width))continue;const center=x+(left+width/2)/scale;let nearest=0,distance=Infinity;for(let i=0;i<centers.length;i++){const d=Math.abs(centers[i]-center);if(d<distance){nearest=i;distance=d;}}if(distance<=panel.width*.095&&!mapped[nearest]){mapped[nearest]=value;words.push({value,index:nearest,token});}}
          for(const startSlot of startSlots){const startIndex=startSlots.indexOf(startSlot),expected=Array.from({length:5},(_,i)=>startSlots[(startIndex+i)%4]);let matches=0,mismatches=0;for(let i=0;i<5;i++){if(!mapped[i])continue;if(mapped[i]===expected[i])matches++;else mismatches++;}attempts.push({bandIndex,variantIndex,raw,mapped:[...mapped],words,matches,mismatches});if(mismatches===0&&matches>=3)return{startSlot,times:expected,valid:mapped.filter(Boolean),attempts,inferred:true};}
        }
      }
      return{startSlot:'',times:[],valid:[],attempts,inferred:false};
    }finally{await worker.terminate();}
  }, { imageDataUrl, rect, bands: SUMMARY_TIME_BANDS, slotRects: SUMMARY_SLOT_RECTS, startSlots: START_SLOTS });
}

export async function inspectDailyCapture({ captureDir, targetDate, repoRoot = path.resolve('.') }) {
  targetDate = normalizeTargetDate(targetDate);
  const capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8'));
  const postText = await readFile(path.join(captureDir, capture.postContent?.file || 'post-content.txt'), 'utf8');
  const dates = extractPostDates(postText);
  if (capture?.status !== 'captured' || !Array.isArray(capture.rawMedia) || !capture.rawMedia.length || !dates.includes(targetDate)) {
    return inspectCapture({ captureDir, targetDate, repoRoot });
  }
  const templates = await loadTemplates(repoRoot);
  const specialWeather = parseSpecialWeather(postText);
  const browser = await chromium.launch({ headless: true });
  const attempts=[];
  try{
    const page=await browser.newPage();
    for(const media of capture.rawMedia.slice(0,4)){
      const filePath=path.join(captureDir,String(media.file||''));let bytes;try{bytes=await readFile(filePath);}catch{continue;}let mime;try{mime=mimeFromBytes(bytes);}catch{continue;}if(mime!==media.mimeType||sha256(bytes)!==media.sha256)continue;
      const imageDataUrl=`data:${mime};base64,${bytes.toString('base64')}`;
      const scored=await inspectSummaryCard(page,imageDataUrl,templates);
      for(const candidate of scored.candidates.slice(0,3)){
        const ocr=await readSummaryStartSlot(page,imageDataUrl,candidate.rect);
        attempts.push({file:media.file,rect:candidate.rect,slots:candidate.slots,ocr});
        if(candidate.okCount!==5||!ocr.startSlot)continue;
        const slots=candidate.slots.map((slot,index)=>({slot:`slot${index}`,visible:true,weather:weatherForSlot(slot.value,ocr.startSlot,index,specialWeather),confidence:'high',description:`概要カードの天気アイコン判定 score=${slot.bestScore.toFixed(3)} margin=${slot.margin.toFixed(3)}`}));
        return{schemaVersion:1,ready:true,targetDate,selectedImage:{file:media.file,mimeType:media.mimeType,captureSha256:media.sha256},interpretation:{ready:true,observedDate:targetDate,startSlot:ocr.startSlot,slots,confidence:'high',summary:`投稿本文で${targetDate}を確認し、概要カードの「今日の天気」5枠と時刻ラベルを直接判読。特殊天気は投稿本文の明示時間帯を同じ6時間枠へ追加。`,unresolved:[]},diagnostics:{mode:'daily-summary-card',postDates:dates,specialWeather,attempts}};
      }
    }
  }finally{await browser.close();}
  const fallback=await inspectCapture({captureDir,targetDate,repoRoot});
  if(fallback.ready)return fallback;
  return{...fallback,diagnostics:{...(fallback.diagnostics||{}),summaryCardAttempts:attempts}};
}

function parseArgs(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}return out;}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  if(args.mode==='inspect'){
    if(!args['capture-dir']||!args['target-date']||!args.output)throw new Error('invalidArguments');
    const result=await inspectDailyCapture({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});
    await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');
    process.stdout.write(`${JSON.stringify({ready:result.ready,selectedImage:result.selectedImage?.file||'',startSlot:result.interpretation?.startSlot||''})}\n`);
    if(!result.ready)process.exitCode=2;
    return;
  }
  if(args.mode==='bind'){
    if(!args.draft||!args.output||!args['artifact-run-id']||!args['artifact-id']||!args['artifact-name'])throw new Error('invalidArguments');
    const draft=JSON.parse(await readFile(path.resolve(args.draft),'utf8'));
    const envelope=bindReviewEnvelope(draft,{runId:args['artifact-run-id'],id:args['artifact-id'],name:args['artifact-name']});
    const base64=Buffer.from(JSON.stringify(envelope),'utf8').toString('base64');
    await writeFile(path.resolve(args.output),`${JSON.stringify(envelope,null,2)}\n`,'utf8');
    if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,`review_payload_base64=${base64}\n`,{encoding:'utf8',flag:'a'});
    process.stdout.write(`${JSON.stringify({ready:true,artifactId:envelope.artifact.id,pendingEvidenceFile:envelope.pendingEvidenceFile})}\n`);
    return;
  }
  throw new Error('invalidArguments');
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Daily weather review failed: ${error.message}\n`);process.exitCode=1;});}
