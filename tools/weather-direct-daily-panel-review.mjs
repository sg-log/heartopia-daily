import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { extractPostDates, normalizeTargetDate } from './weather-deterministic-review.mjs';

const START_SLOTS = ['00','06','12','18'];
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const X_POS = [.17,.335,.50,.67,.835];
const ICON_Y = .725;
const LABEL_Y = .785;
const TEMPLATE_FILES = [
  ['晴','sun-day.png'],['晴','sun-night-slot0.png'],['晴','sun-night-slot1.png'],['晴','sun-night-slot4.png'],
  ['猛暑','heatwave.png'],['虹','rainbow.png'],['流星群','meteor-shower.png'],['雨','rain.png']
];

function sha256(bytes){ return createHash('sha256').update(bytes).digest('hex'); }
function mimeFromBytes(bytes){
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png';
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}
function inferStartSlot(mapped){
  const observed=mapped.filter(v=>START_SLOTS.includes(v)).length;
  if(observed<3)return null;
  const matches=[];
  for(const startSlot of START_SLOTS){
    const startIndex=START_SLOTS.indexOf(startSlot);
    const expected=Array.from({length:5},(_,i)=>START_SLOTS[(startIndex+i)%START_SLOTS.length]);
    if(mapped.every((v,i)=>!START_SLOTS.includes(v)||v===expected[i]))matches.push({startSlot,expected,observed});
  }
  return matches.length===1?matches[0]:null;
}
async function loadTemplates(repoRoot){
  const out=[];
  for(const [weather,file] of TEMPLATE_FILES){
    const bytes=await readFile(path.join(repoRoot,'assets','weather-templates',file));
    out.push({weather,file,dataUrl:`data:image/png;base64,${bytes.toString('base64')}`});
  }
  return out;
}

async function inspectImage(page, bytes, mimeType, templates){
  const dataUrl=`data:${mimeType};base64,${bytes.toString('base64')}`;
  return page.evaluate(async({dataUrl,templates,xPos,iconY,labelY,startSlots,tesseractUrl})=>{
    const load=src=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=src;});
    const [source,...templateImages]=await Promise.all([load(dataUrl),...templates.map(t=>load(t.dataUrl))]);
    const width=source.naturalWidth,height=source.naturalHeight,aspect=width/height;
    if(width<420||height<420||aspect<.84||aspect>1.16)return{ready:false,reason:'dailyPanelGeometryMismatch',width,height,aspect};

    const rgbToHsv=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:max?d/max:0,v:max};};
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0);
    const raw=ctx.getImageData(0,0,width,height).data;
    let blue=0,total=0;
    for(let y=Math.round(height*.08);y<Math.round(height*.91);y+=3)for(let x=Math.round(width*.06);x<Math.round(width*.94);x+=3){
      const i=(y*width+x)*4,hsv=rgbToHsv(raw[i],raw[i+1],raw[i+2]);total++;
      if(hsv.h>=175&&hsv.h<=260&&hsv.s>=.15&&hsv.v>=.42)blue++;
    }
    const blueRatio=total?blue/total:0;
    if(blueRatio<.34)return{ready:false,reason:'dailyPanelStructureMismatch',width,height,aspect,blueRatio};

    const signature=c=>{const cctx=c.getContext('2d',{willReadFrequently:true}),{width:w,height:h}=c,d=cctx.getImageData(0,0,w,h).data,corners=[[1,1],[w-2,1],[1,h-2],[w-2,h-2]].map(([x,y])=>{const i=(y*w+x)*4;return[d[i],d[i+1],d[i+2]]}),bg=corners.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corners.length),pixels=[],mask=[];for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,r=d[i],g=d[i+1],b=d[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);mask.push(dist>=18||hsv.s>=.15?1:0);pixels.push([r,g,b]);}return{pixels,mask};};
    const metrics=c=>{const cctx=c.getContext('2d',{willReadFrequently:true}),{width:w,height:h}=c,d=cctx.getImageData(0,0,w,h).data,corners=[[1,1],[w-2,1],[1,h-2],[w-2,h-2]].map(([x,y])=>{const i=(y*w+x)*4;return[d[i],d[i+1],d[i+2]]}),bg=corners.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corners.length);let fg=0,warm=0,cyan=0,purple=0,red=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,r=d[i],g=d[i+1],b=d[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);if(dist<18&&hsv.s<.15)continue;fg++;if(hsv.h>=28&&hsv.h<=82&&hsv.s>=.18&&hsv.v>=.55)warm++;if(hsv.h>=165&&hsv.h<205&&hsv.s>=.12)cyan++;if(hsv.h>=235&&hsv.h<=315&&hsv.s>=.10)purple++;if((hsv.h<20||hsv.h>=345)&&hsv.s>=.16)red++;}const den=Math.max(1,fg);return{warm:warm/den,cyan:cyan/den,purple:purple/den,red:red/den};};
    const similarity=(a,b)=>{let union=0,intersection=0,color=0,count=0;for(let i=0;i<a.mask.length;i++){if(a.mask[i]||b.mask[i])union++;if(a.mask[i]&&b.mask[i]){intersection++;const pa=a.pixels[i],pb=b.pixels[i],diff=(Math.abs(pa[0]-pb[0])+Math.abs(pa[1]-pb[1])+Math.abs(pa[2]-pb[2]))/765;color+=1-diff;count++;}}return(union?intersection/union:0)*.42+(count?color/count:0)*.58;};
    const prepared=templates.map((t,i)=>{const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(templateImages[i],0,0,56,56);return{weather:t.weather,sig:signature(c)};});
    const size=Math.max(44,Math.round(width*.105));
    const scores=xPos.map(cx=>{
      const sx=Math.max(0,Math.min(width-size,Math.round(width*cx-size/2))),sy=Math.max(0,Math.min(height-size,Math.round(height*iconY-size/2)));
      const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(source,sx,sy,size,size,0,0,56,56);
      const sig=signature(c),m=metrics(c),byWeather=new Map();
      for(const t of prepared){const v=similarity(sig,t.sig);byWeather.set(t.weather,Math.max(v,byWeather.get(t.weather)||0));}
      const ranked=[...byWeather.entries()].sort((a,b)=>b[1]-a[1]);
      let [value,bestScore]=ranked[0]||['',0];const secondScore=ranked[1]?.[1]||0;const margin=bestScore-secondScore;
      if(m.red>=.04&&m.cyan>=.12)value='虹';
      else if(m.purple>=.10&&m.warm>=.02)value='流星群';
      else if(m.cyan>=.58&&m.warm<.02)value='雨';
      else if(m.warm>=.025&&value!=='猛暑')value='晴';
      const high=(bestScore>=.43&&margin>=.008)||m.warm>=.025||(m.cyan>=.58&&m.warm<.02)||(m.red>=.04&&m.cyan>=.12);
      return{value,high,bestScore,margin,metrics:m,box:{x:sx,y:sy,size}};
    });

    if(!window.Tesseract)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=tesseractUrl;s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});
    const worker=await window.Tesseract.createWorker('eng',1,{logger:()=>{}});
    await worker.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7'});
    const mapped=Array(5).fill(''),ocrAttempts=[];
    try{
      for(let i=0;i<5;i++){
        const cw=Math.round(width*.14),ch=Math.round(height*.085),x=Math.max(0,Math.round(width*xPos[i]-cw/2)),y=Math.round(height*labelY),scale=9;
        const base=document.createElement('canvas');base.width=cw*scale;base.height=ch*scale;const bctx=base.getContext('2d',{willReadFrequently:true});bctx.drawImage(source,x,y,cw,ch,0,0,base.width,base.height);
        const variants=[base];
        for(const threshold of [155,185,210]){const c=document.createElement('canvas');c.width=base.width;c.height=base.height;const cctx=c.getContext('2d',{willReadFrequently:true});cctx.drawImage(base,0,0);const id=cctx.getImageData(0,0,c.width,c.height);for(let p=0;p<id.data.length;p+=4){const lum=.299*id.data[p]+.587*id.data[p+1]+.114*id.data[p+2],v=lum>=threshold?0:255;id.data[p]=v;id.data[p+1]=v;id.data[p+2]=v;id.data[p+3]=255;}cctx.putImageData(id,0,0);variants.push(c);}
        const attempts=[];
        for(let vi=0;vi<variants.length;vi++){const r=await worker.recognize(variants[vi]);const raw=String(r?.data?.text||'').replace(/\s+/g,'');let value='';for(const allowed of startSlots){if(raw.includes(allowed)){value=allowed;break;}}attempts.push({variantIndex:vi,raw,value});if(value){mapped[i]=value;break;}}
        ocrAttempts.push({index:i,value:mapped[i],attempts});
      }
    }finally{await worker.terminate();}

    return{ready:true,width,height,aspect,blueRatio,scores,mapped,ocrAttempts,dataUrl};
  },{dataUrl,templates,xPos:X_POS,iconY:ICON_Y,labelY:LABEL_Y,startSlots:START_SLOTS,tesseractUrl:TESSERACT_URL});
}

export async function inspectDirectDailyPanelCapture({captureDir,targetDate,repoRoot=path.resolve('.')}){
  targetDate=normalizeTargetDate(targetDate);
  const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8'));
  if(capture?.status!=='captured'||!Array.isArray(capture.rawMedia)||!capture.rawMedia.length)return{ready:false,targetDate,diagnostics:{reason:'captureNotReady'}};
  const postText=await readFile(path.join(captureDir,capture.postContent?.file||'post-content.txt'),'utf8');
  if(!extractPostDates(postText).includes(targetDate))return{ready:false,targetDate,diagnostics:{reason:'targetDateNotConfirmed'}};
  const templates=await loadTemplates(repoRoot),browser=await chromium.launch({headless:true}),attempts=[];
  try{
    const page=await browser.newPage();
    for(const media of capture.rawMedia.slice(0,4)){
      let bytes;try{bytes=await readFile(path.join(captureDir,String(media.file||'')));}catch{continue;}
      let mimeType;try{mimeType=mimeFromBytes(bytes);}catch{continue;}
      if(mimeType!==media.mimeType||sha256(bytes)!==media.sha256)continue;
      const inspected=await inspectImage(page,bytes,mimeType,templates);
      const attempt={file:media.file,inspected};attempts.push(attempt);
      if(!inspected.ready)continue;
      const inferred=inferStartSlot(inspected.mapped);attempt.inferred=inferred;
      if(!inferred||!inspected.scores.every(s=>s.high&&s.value))continue;
      const slots=inspected.scores.map((s,i)=>({slot:`slot${i}`,visible:true,weather:[s.value],confidence:'high',description:`デイリー専用UI画像判定 score=${s.bestScore.toFixed(3)} margin=${s.margin.toFixed(3)}`}));
      return{schemaVersion:1,ready:true,targetDate,selectedImage:{file:media.file,mimeType:media.mimeType,captureSha256:media.sha256},interpretation:{ready:true,observedDate:targetDate,startSlot:inferred.startSlot,slots,confidence:'high',summary:`投稿本文で${targetDate}を確認し、同一投稿のデイリー天気UIから5枠と時刻ラベルを直接判読。`,unresolved:[]},diagnostics:{mode:'direct-daily-only-panel',selectedOriginal:media.file,structure:{width:inspected.width,height:inspected.height,blueRatio:inspected.blueRatio},mapped:inspected.mapped,ocrAttempts:inspected.ocrAttempts,scores:inspected.scores,attempts}};
    }
  }finally{await browser.close();}
  return{ready:false,targetDate,diagnostics:{reason:'directDailyPanelNotReady',attempts}};
}

function parseArgs(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}return out;}
async function main(){const args=parseArgs(process.argv.slice(2));if(!args['capture-dir']||!args['target-date']||!args.output)throw new Error('invalidArguments');const result=await inspectDirectDailyPanelCapture({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');process.stdout.write(`${JSON.stringify({ready:result.ready,selectedImage:result.selectedImage?.file||'',startSlot:result.interpretation?.startSlot||'',daily:result.interpretation?.slots?.map(s=>s.weather)||[]})}\n`);if(!result.ready)process.exitCode=2;}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Direct daily panel review failed: ${error.message}\n`);process.exitCode=1;});}
