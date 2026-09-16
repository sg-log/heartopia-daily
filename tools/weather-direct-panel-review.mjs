import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { extractPostDates, normalizeTargetDate } from './weather-deterministic-review.mjs';

const START_SLOTS = ['00', '06', '12', '18'];
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const DAILY_X = [.18, .325, .47, .655, .81];
const DAILY_Y = .455;
const WEEK_X = .815;
const WEEK_Y = [.594, .674, .754, .836, .916];
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

function addDays(dateText, days) {
  const date = new Date(`${normalizeTargetDate(dateText)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inferStartSlot(mapped) {
  const observed = Array.isArray(mapped) ? mapped.filter(value => START_SLOTS.includes(value)).length : 0;
  if (observed < 2) return null;
  const matches = [];
  for (const startSlot of START_SLOTS) {
    const startIndex = START_SLOTS.indexOf(startSlot);
    const expected = Array.from({ length: 5 }, (_, index) => START_SLOTS[(startIndex + index) % START_SLOTS.length]);
    if (mapped.every((value, index) => !START_SLOTS.includes(value) || value === expected[index])) matches.push({ startSlot, expected });
  }
  return matches.length === 1 ? { ...matches[0], mapped, observed } : null;
}

async function loadTemplates(repoRoot) {
  const root = path.join(repoRoot, 'assets', 'weather-templates');
  const templates = [];
  for (const [weather, file] of TEMPLATE_FILES) {
    const bytes = await readFile(path.join(root, file));
    templates.push({ weather, file, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
  }
  return templates;
}

async function inspectPanel(page, bytes, mimeType, templates) {
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  return page.evaluate(async ({ dataUrl, templates, dailyX, dailyY, weekX, weekY }) => {
    const load = src => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
    });
    const [source, ...templateImages] = await Promise.all([load(dataUrl), ...templates.map(item => load(item.dataUrl))]);
    const width = source.naturalWidth, height = source.naturalHeight, aspect = width / height;
    if (width < 190 || height < 230 || aspect < .72 || aspect > 1.02) return { ready:false, reason:'directPanelGeometryMismatch', width, height, aspect };

    const rgbToHsv=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:max?d/max:0,v:max};};
    const structural=document.createElement('canvas');structural.width=width;structural.height=height;const sctx=structural.getContext('2d',{willReadFrequently:true});sctx.drawImage(source,0,0);const raw=sctx.getImageData(0,0,width,height).data;
    let blue=0,blueTotal=0,light=0,lightTotal=0;
    for(let y=Math.round(height*.10);y<Math.round(height*.53);y+=2)for(let x=Math.round(width*.05);x<Math.round(width*.95);x+=2){const i=(y*width+x)*4,hsv=rgbToHsv(raw[i],raw[i+1],raw[i+2]);blueTotal++;if(hsv.h>=175&&hsv.h<=235&&hsv.s>=.20&&hsv.v>=.45)blue++;}
    for(let y=Math.round(height*.55);y<Math.round(height*.98);y+=2)for(let x=Math.round(width*.05);x<Math.round(width*.94);x+=2){const i=(y*width+x)*4,hsv=rgbToHsv(raw[i],raw[i+1],raw[i+2]);lightTotal++;if(hsv.v>=.72&&hsv.s<=.25)light++;}
    const blueRatio=blueTotal?blue/blueTotal:0,lightRatio=lightTotal?light/lightTotal:0;
    if(blueRatio<.35||lightRatio<.55)return{ready:false,reason:'directPanelStructureMismatch',width,height,aspect,blueRatio,lightRatio};

    const signature=canvas=>{const ctx=canvas.getContext('2d',{willReadFrequently:true}),{width,height}=canvas,data=ctx.getImageData(0,0,width,height).data;const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});const bg=corner.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corner.length);const pixels=[],mask=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);mask.push(dist>=18||hsv.s>=.15?1:0);pixels.push([r,g,b]);}return{pixels,mask};};
    const similarity=(a,b)=>{let union=0,intersection=0,color=0,count=0;for(let i=0;i<a.mask.length;i++){if(a.mask[i]||b.mask[i])union++;if(a.mask[i]&&b.mask[i]){intersection++;const pa=a.pixels[i],pb=b.pixels[i],diff=(Math.abs(pa[0]-pb[0])+Math.abs(pa[1]-pb[1])+Math.abs(pa[2]-pb[2]))/765;color+=1-diff;count++;}}return(union?intersection/union:0)*.42+(count?color/count:0)*.58;};
    const prepared=templates.map((item,index)=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=56;canvas.getContext('2d').drawImage(templateImages[index],0,0,56,56);return{weather:item.weather,file:item.file,sig:signature(canvas)};});
    const classify=(cx,cy,size)=>{const sx=Math.max(0,Math.min(width-size,Math.round(cx-size/2))),sy=Math.max(0,Math.min(height-size,Math.round(cy-size/2)));const canvas=document.createElement('canvas');canvas.width=canvas.height=56;canvas.getContext('2d').drawImage(source,sx,sy,size,size,0,0,56,56);const sig=signature(canvas),byWeather=new Map();for(const template of prepared){const value=similarity(sig,template.sig);byWeather.set(template.weather,Math.max(value,byWeather.get(template.weather)||0));}const ranked=[...byWeather.entries()].sort((a,b)=>b[1]-a[1]);const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0];return{bestValue,bestScore,secondValue,secondScore,margin:bestScore-secondScore,box:{x:sx,y:sy,size}};};
    const dailySize=Math.max(20,Math.round(width*.115));
    const weeklySize=Math.max(16,Math.round(width*.095));
    const daily=dailyX.map(x=>classify(width*x,height*dailyY,dailySize));
    const weekly=weekY.map(y=>classify(width*weekX,height*y,weeklySize));
    return{ready:true,width,height,aspect,blueRatio,lightRatio,daily,weekly,dataUrl};
  }, { dataUrl, templates, dailyX:DAILY_X, dailyY:DAILY_Y, weekX:WEEK_X, weekY:WEEK_Y });
}

async function readTimes(page, imageDataUrl, width, height) {
  if (!(await page.evaluate(() => Boolean(window.Tesseract)))) await page.addScriptTag({ url:TESSERACT_URL });
  return page.evaluate(async ({ imageDataUrl, width, height, dailyX, startSlots }) => {
    const image=await new Promise((resolve,reject)=>{const item=new Image();item.onload=()=>resolve(item);item.onerror=reject;item.src=imageDataUrl;});
    const worker=await window.Tesseract.createWorker('eng',1,{logger:()=>{}});
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7'});
    const mapped=Array(5).fill(''),attempts=[];
    try{
      for(let index=0;index<dailyX.length;index++){
        const cx=Math.round(width*dailyX[index]),x=Math.max(0,Math.round(cx-width*.065)),y=Math.round(height*.485),w=Math.round(width*.13),h=Math.max(14,Math.round(height*.075)),scale=10;
        const base=document.createElement('canvas');base.width=w*scale;base.height=h*scale;const bctx=base.getContext('2d',{willReadFrequently:true});bctx.imageSmoothingEnabled=true;bctx.imageSmoothingQuality='high';bctx.drawImage(image,x,y,w,h,0,0,base.width,base.height);
        const variants=[base];
        for(const threshold of [165,195]){const c=document.createElement('canvas');c.width=base.width;c.height=base.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(base,0,0);const id=ctx.getImageData(0,0,c.width,c.height);for(let i=0;i<id.data.length;i+=4){const lum=.299*id.data[i]+.587*id.data[i+1]+.114*id.data[i+2],v=lum>=threshold?0:255;id.data[i]=v;id.data[i+1]=v;id.data[i+2]=v;id.data[i+3]=255;}ctx.putImageData(id,0,0);variants.push(c);}
        const cell=[];
        for(let variantIndex=0;variantIndex<variants.length;variantIndex++){
          const result=await worker.recognize(variants[variantIndex]);const raw=String(result?.data?.text||'').replace(/\s+/g,'');let value='';for(const allowed of startSlots){if(raw.includes(allowed)){value=allowed;break;}}cell.push({variantIndex,raw,value});if(value){mapped[index]=value;break;}
        }
        attempts.push({index,cell,value:mapped[index]});
      }
    } finally { await worker.terminate(); }
    return{mapped,attempts};
  }, { imageDataUrl, width, height, dailyX:DAILY_X, startSlots:START_SLOTS });
}

function buildFailure(targetDate, diagnostics) {
  return {schemaVersion:2,ready:false,targetDate,selectedImage:null,interpretation:{ready:false,observedDate:targetDate,startSlot:null,slots:Array.from({length:5},(_,index)=>({slot:`slot${index}`,visible:false,weather:[],confidence:'low',description:''})),weeklyDays:[],confidence:'low',summary:'ゲーム内天気パネルを高確信度で判読できませんでした。',unresolved:['デイリー5枠・開始時刻・週間5日の全条件が未確定です']},diagnostics};
}

export async function inspectDirectPanelCapture({ captureDir, targetDate, repoRoot='.' }) {
  targetDate=normalizeTargetDate(targetDate);repoRoot=path.resolve(repoRoot);
  const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8'));
  const postText=await readFile(path.join(captureDir,capture.postContent?.file||'post-content.txt'),'utf8');
  if(capture?.status!=='captured'||!extractPostDates(postText).includes(targetDate)||!Array.isArray(capture.rawMedia)||!capture.rawMedia.length)return buildFailure(targetDate,{reason:'captureOrDateNotReady'});
  const templates=await loadTemplates(repoRoot),browser=await chromium.launch({headless:true}),attempts=[];
  try{
    const page=await browser.newPage();
    for(const media of capture.rawMedia.slice(0,6)){
      let bytes;try{bytes=await readFile(path.join(captureDir,String(media.file||'')));}catch{continue;}
      let mimeType;try{mimeType=mimeFromBytes(bytes);}catch{continue;}
      if(mimeType!==media.mimeType||sha256(bytes)!==media.sha256)continue;
      const inspected=await inspectPanel(page,bytes,mimeType,templates);const attempt={file:media.file,inspected};attempts.push(attempt);if(!inspected.ready)continue;
      const ocr=await readTimes(page,inspected.dataUrl,inspected.width,inspected.height);const inferred=inferStartSlot(ocr.mapped);attempt.ocr=ocr;attempt.inferred=inferred;
      const daily=inspected.daily.map((score,index)=>{const high=score.bestScore>=.50&&score.margin>=.025;return{slot:`slot${index}`,visible:true,weather:high?[score.bestValue]:[],confidence:high?'high':'low',description:`直接パネル天気アイコン照合 score=${score.bestScore.toFixed(3)} margin=${score.margin.toFixed(3)}`};});
      const weeklyDays=inspected.weekly.map((score,index)=>{const high=score.bestScore>=.50&&score.margin>=.025;return{date:addDays(targetDate,index+1),weather:high?[score.bestValue]:[],visible:true,confidence:high?'high':'low',description:`直接パネル週間アイコン照合 score=${score.bestScore.toFixed(3)} margin=${score.margin.toFixed(3)}`};});
      if(!inferred||!daily.every(item=>item.confidence==='high'&&item.weather.length===1)||!weeklyDays.every(item=>item.confidence==='high'&&item.weather.length===1))continue;
      return{schemaVersion:2,ready:true,targetDate,selectedImage:{file:media.file,mimeType:media.mimeType,captureSha256:media.sha256},interpretation:{ready:true,observedDate:targetDate,startSlot:inferred.startSlot,slots:daily,weeklyDays,confidence:'high',summary:`投稿本文で${targetDate}を確認し、同一のゲーム内天気パネルからデイリー5枠・時刻ラベル・翌日以降5日の週間欄を直接判読。`,unresolved:[]},diagnostics:{mode:'direct-game-weather-panel',selectedOriginal:media.file,ocr,inferred,structure:{blueRatio:inspected.blueRatio,lightRatio:inspected.lightRatio,width:inspected.width,height:inspected.height},dailyScores:inspected.daily,weeklyScores:inspected.weekly,attempts}};
    }
  }finally{await browser.close();}
  return buildFailure(targetDate,{mode:'direct-game-weather-panel',attempts});
}

function parseArgs(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}return out;}
async function main(){const args=parseArgs(process.argv.slice(2));if(!args['capture-dir']||!args['target-date']||!args.output)throw new Error('invalidArguments');const result=await inspectDirectPanelCapture({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');process.stdout.write(`${JSON.stringify({ready:result.ready,startSlot:result.interpretation?.startSlot||'',daily:result.interpretation?.slots?.map(x=>x.weather)||[],weekly:result.interpretation?.weeklyDays?.map(x=>x.weather)||[]})}\n`);if(!result.ready)process.exitCode=2;}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Direct panel weather review failed: ${error.message}\n`);process.exitCode=1;});}
