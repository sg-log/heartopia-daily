import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { extractPostDates, normalizeTargetDate } from './weather-deterministic-review.mjs';
import { inspectRecoveredDailyCapture } from './weather-daily-recovery-review.mjs';

const WEEK_X = .90;
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

async function loadTemplates(repoRoot) {
  const root = path.join(repoRoot, 'assets', 'weather-templates');
  const templates = [];
  for (const [weather, file] of TEMPLATE_FILES) {
    const bytes = await readFile(path.join(root, file));
    templates.push({ weather, file, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
  }
  return templates;
}

async function inspectWeeklyPanel(page, bytes, mimeType, templates) {
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  return page.evaluate(async ({ dataUrl, templates, weekX, weekY }) => {
    const load = src => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
    });
    const [source, ...templateImages] = await Promise.all([load(dataUrl), ...templates.map(item => load(item.dataUrl))]);
    const width = source.naturalWidth, height = source.naturalHeight, aspect = width / height;
    if (width < 190 || height < 230 || aspect < .72 || aspect > 1.02) {
      return { ready:false, reason:'directPanelGeometryMismatch', width, height, aspect };
    }

    const rgbToHsv=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:max?d/max:0,v:max};};
    const structural=document.createElement('canvas');structural.width=width;structural.height=height;const sctx=structural.getContext('2d',{willReadFrequently:true});sctx.drawImage(source,0,0);const raw=sctx.getImageData(0,0,width,height).data;
    let blue=0,blueTotal=0,light=0,lightTotal=0;
    for(let y=Math.round(height*.10);y<Math.round(height*.53);y+=2)for(let x=Math.round(width*.05);x<Math.round(width*.95);x+=2){const i=(y*width+x)*4,hsv=rgbToHsv(raw[i],raw[i+1],raw[i+2]);blueTotal++;if(hsv.h>=175&&hsv.h<=235&&hsv.s>=.20&&hsv.v>=.45)blue++;}
    for(let y=Math.round(height*.55);y<Math.round(height*.97);y+=2)for(let x=Math.round(width*.05);x<Math.round(width*.88);x+=2){const i=(y*width+x)*4,hsv=rgbToHsv(raw[i],raw[i+1],raw[i+2]);lightTotal++;if(hsv.v>=.72&&hsv.s<=.25)light++;}
    const blueRatio=blueTotal?blue/blueTotal:0,lightRatio=lightTotal?light/lightTotal:0;
    if(blueRatio<.35||lightRatio<.55)return{ready:false,reason:'directPanelStructureMismatch',width,height,aspect,blueRatio,lightRatio};

    const signature=canvas=>{const ctx=canvas.getContext('2d',{willReadFrequently:true}),{width,height}=canvas,data=ctx.getImageData(0,0,width,height).data;const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});const bg=corner.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corner.length);const pixels=[],mask=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);mask.push(dist>=18||hsv.s>=.15?1:0);pixels.push([r,g,b]);}return{pixels,mask};};
    const similarity=(a,b)=>{let union=0,intersection=0,color=0,count=0;for(let i=0;i<a.mask.length;i++){if(a.mask[i]||b.mask[i])union++;if(a.mask[i]&&b.mask[i]){intersection++;const pa=a.pixels[i],pb=b.pixels[i],diff=(Math.abs(pa[0]-pb[0])+Math.abs(pa[1]-pb[1])+Math.abs(pa[2]-pb[2]))/765;color+=1-diff;count++;}}return(union?intersection/union:0)*.42+(count?color/count:0)*.58;};
    const prepared=templates.map((item,index)=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=56;canvas.getContext('2d').drawImage(templateImages[index],0,0,56,56);return{weather:item.weather,sig:signature(canvas)};});
    const size=Math.max(16,Math.round(width*.105));
    const scores=weekY.map(centerY=>{
      const sx=Math.max(0,Math.min(width-size,Math.round(width*weekX-size/2)));
      const sy=Math.max(0,Math.min(height-size,Math.round(height*centerY-size/2)));
      const canvas=document.createElement('canvas');canvas.width=canvas.height=56;canvas.getContext('2d').drawImage(source,sx,sy,size,size,0,0,56,56);
      const sig=signature(canvas),byWeather=new Map();
      for(const template of prepared){const value=similarity(sig,template.sig);byWeather.set(template.weather,Math.max(value,byWeather.get(template.weather)||0));}
      const ranked=[...byWeather.entries()].sort((a,b)=>b[1]-a[1]);
      const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0];
      return{bestValue,bestScore,secondValue,secondScore,margin:bestScore-secondScore,box:{x:sx,y:sy,size}};
    });
    return{ready:true,width,height,aspect,blueRatio,lightRatio,scores};
  }, { dataUrl, templates, weekX:WEEK_X, weekY:WEEK_Y });
}

function buildFailure(targetDate, diagnostics) {
  return {schemaVersion:2,ready:false,targetDate,selectedImage:null,interpretation:{ready:false,observedDate:targetDate,startSlot:null,slots:Array.from({length:5},(_,index)=>({slot:`slot${index}`,visible:false,weather:[],confidence:'low',description:''})),weeklyDays:[],confidence:'low',summary:'ゲーム内天気パネルを高確信度で判読できませんでした。',unresolved:['デイリー5枠・開始時刻・週間5日の全条件が未確定です']},diagnostics};
}

export async function inspectDirectPanelCapture({ captureDir, targetDate, repoRoot='.' }) {
  targetDate=normalizeTargetDate(targetDate);repoRoot=path.resolve(repoRoot);
  const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8'));
  const postText=await readFile(path.join(captureDir,capture.postContent?.file||'post-content.txt'),'utf8');
  if(capture?.status!=='captured'||!extractPostDates(postText).includes(targetDate)||!Array.isArray(capture.rawMedia)||!capture.rawMedia.length){
    return buildFailure(targetDate,{reason:'captureOrDateNotReady'});
  }

  const daily=await inspectRecoveredDailyCapture({captureDir,targetDate,repoRoot});
  if(!daily?.ready||daily.interpretation?.ready!==true||!daily.interpretation?.startSlot||!Array.isArray(daily.interpretation?.slots)||daily.interpretation.slots.length!==5){
    return buildFailure(targetDate,{reason:'verifiedDailyNotReady',dailyDiagnostics:daily?.diagnostics||null});
  }

  const templates=await loadTemplates(repoRoot),browser=await chromium.launch({headless:true}),attempts=[];
  try{
    const page=await browser.newPage();
    for(const media of capture.rawMedia.slice(0,6)){
      let bytes;try{bytes=await readFile(path.join(captureDir,String(media.file||'')));}catch{continue;}
      let mimeType;try{mimeType=mimeFromBytes(bytes);}catch{continue;}
      if(mimeType!==media.mimeType||sha256(bytes)!==media.sha256)continue;
      const inspected=await inspectWeeklyPanel(page,bytes,mimeType,templates);attempts.push({file:media.file,inspected});
      if(!inspected.ready)continue;
      const weeklyDays=inspected.scores.map((score,index)=>{
        const high=score.bestScore>=.53&&score.margin>=.035;
        return{date:addDays(targetDate,index+1),weather:high?[score.bestValue]:[],visible:true,confidence:high?'high':'low',description:`直接パネル週間アイコン照合 score=${score.bestScore.toFixed(3)} margin=${score.margin.toFixed(3)}`};
      });
      if(!weeklyDays.every(item=>item.confidence==='high'&&item.weather.length===1))continue;
      return{schemaVersion:2,ready:true,targetDate,selectedImage:{file:media.file,mimeType:media.mimeType,captureSha256:media.sha256},interpretation:{...daily.interpretation,weeklyDays,summary:`${daily.interpretation.summary} 同じ公開投稿のゲーム内天気パネルから週間5日も直接判読。`},diagnostics:{mode:'verified-daily-plus-direct-weekly',selectedOriginal:media.file,dailyDiagnostics:daily.diagnostics,structure:{blueRatio:inspected.blueRatio,lightRatio:inspected.lightRatio,width:inspected.width,height:inspected.height},weeklyScores:inspected.scores,attempts}};
    }
  }finally{await browser.close();}
  return buildFailure(targetDate,{mode:'verified-daily-plus-direct-weekly',dailyDiagnostics:daily.diagnostics,attempts});
}

function parseArgs(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}return out;}
async function main(){const args=parseArgs(process.argv.slice(2));if(!args['capture-dir']||!args['target-date']||!args.output)throw new Error('invalidArguments');const result=await inspectDirectPanelCapture({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');process.stdout.write(`${JSON.stringify({ready:result.ready,startSlot:result.interpretation?.startSlot||'',daily:result.interpretation?.slots?.map(x=>x.weather)||[],weekly:result.interpretation?.weeklyDays?.map(x=>x.weather)||[]})}\n`);if(!result.ready)process.exitCode=2;}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Direct panel weather review failed: ${error.message}\n`);process.exitCode=1;});}
