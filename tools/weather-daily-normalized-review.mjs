import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bindReviewEnvelope, postConfirmsTargetDate } from './weather-deterministic-review.mjs';

const TARGET_ASPECT = 497 / 661;
const START_SLOTS = ['00', '06', '12', '18'];
const SLOT_RECTS = [
  { key: 'slot0', x: .105, y: .425, w: .110, h: .075 },
  { key: 'slot1', x: .275, y: .425, w: .110, h: .075 },
  { key: 'slot2', x: .450, y: .425, w: .110, h: .075 },
  { key: 'slot3', x: .640, y: .425, w: .110, h: .075 },
  { key: 'slot4', x: .835, y: .425, w: .110, h: .075 }
];
const OCR_BAND = { x: .055, y: .490, w: .900, h: .080 };
const READY_SCORE = .62;
const READY_MARGIN = .10;
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
const CROP_VARIANTS = [
  { left: .405, right: .915, top: .100, height: .750 },
  { left: .400, right: .915, top: .100, height: .750 },
  { left: .410, right: .915, top: .100, height: .750 },
  { left: .405, right: .905, top: .100, height: .750 },
  { left: .405, right: .925, top: .100, height: .750 },
  { left: .405, right: .915, top: .095, height: .755 },
  { left: .405, right: .915, top: .105, height: .745 },
  { left: .395, right: .920, top: .095, height: .760 }
];

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

async function normalizeWeatherColumn(page, bytes, mimeType, variant) {
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const result = await page.evaluate(async ({ dataUrl, variant, targetAspect }) => {
    const image = await new Promise((resolve, reject) => {
      const item = new Image(); item.onload = () => resolve(item); item.onerror = reject; item.src = dataUrl;
    });
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    const x = Math.round(sourceWidth * variant.left);
    const right = Math.round(sourceWidth * variant.right);
    const y = Math.round(sourceHeight * variant.top);
    const cropWidth = right - x;
    const cropHeight = Math.min(sourceHeight - y, Math.round(sourceHeight * variant.height));
    if (cropWidth < 120 || cropHeight < 160 || x < 0 || y < 0 || right > sourceWidth) return null;
    const outHeight = cropHeight;
    const outWidth = Math.round(outHeight * targetAspect);
    const canvas = document.createElement('canvas');
    canvas.width = outWidth; canvas.height = outHeight;
    canvas.getContext('2d').drawImage(image, x, y, cropWidth, cropHeight, 0, 0, outWidth, outHeight);
    return {
      base64: canvas.toDataURL('image/jpeg', .97).split(',')[1],
      sourceRect: { x, y, width: cropWidth, height: cropHeight },
      normalizedSize: { width: outWidth, height: outHeight }
    };
  }, { dataUrl, variant, targetAspect: TARGET_ASPECT });
  return result ? { ...result, bytes: Buffer.from(result.base64, 'base64') } : null;
}

async function classifyAndBuildOcrImages(page, normalizedBytes, templates) {
  const imageDataUrl = `data:image/jpeg;base64,${normalizedBytes.toString('base64')}`;
  return page.evaluate(async ({ imageDataUrl, templates, slotRects, ocrBand, readyScore, readyMargin }) => {
    const loadImage = src => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
    });
    const [sourceImage, ...templateImages] = await Promise.all([
      loadImage(imageDataUrl), ...templates.map(item => loadImage(item.dataUrl))
    ]);
    const rgbToHsv = (r,g,b) => {
      r/=255; g/=255; b/=255;
      const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
      let h=0;
      if(d){ if(max===r)h=((g-b)/d)%6; else if(max===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0)h+=360; }
      return { h, s:max?d/max:0, v:max };
    };
    const feature = canvas => {
      const ctx=canvas.getContext('2d',{willReadFrequently:true}), {width,height}=canvas;
      const data=ctx.getImageData(0,0,width,height).data;
      const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});
      const bg=corner.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corner.length);
      const bins=Array(12).fill(0); let count=0,sat=0,bright=0,dark=0,yellow=0,orange=0,red=0,green=0,blue=0,cyan=0,purple=0,edge=0;
      for(let y=1;y<height-1;y++) for(let x=1;x<width-1;x++){
        const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]),hsv=rgbToHsv(r,g,b);
        if(dist<22&&hsv.s<.18) continue;
        count++; sat+=hsv.s; if(hsv.v>.72)bright++; if(hsv.v<.32)dark++;
        if(hsv.h<25||hsv.h>=345)red++; if(hsv.h>=25&&hsv.h<52)orange++; if(hsv.h>=52&&hsv.h<78)yellow++;
        if(hsv.h>=78&&hsv.h<165)green++; if(hsv.h>=165&&hsv.h<205)cyan++; if(hsv.h>=205&&hsv.h<265)blue++; if(hsv.h>=265&&hsv.h<330)purple++;
        bins[Math.min(11,Math.floor(hsv.h/30))]++;
        const left=(y*width+x-1)*4,up=((y-1)*width+x)*4;
        if(Math.abs(r-data[left])+Math.abs(g-data[left+1])+Math.abs(b-data[left+2])+Math.abs(r-data[up])+Math.abs(g-data[up+1])+Math.abs(b-data[up+2])>110)edge++;
      }
      const d=Math.max(1,count);
      return { bins:bins.map(v=>v/d),countRatio:count/(width*height),sat:sat/d,bright:bright/d,dark:dark/d,yellow:yellow/d,orange:orange/d,red:red/d,green:green/d,blue:blue/d,cyan:cyan/d,purple:purple/d,edge:edge/d,diversity:bins.filter(v=>v/d>.035).length/bins.length };
    };
    const signature = canvas => {
      const ctx=canvas.getContext('2d',{willReadFrequently:true}),{width,height}=canvas,data=ctx.getImageData(0,0,width,height).data;
      const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});
      const bg=corner.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corner.length);
      const pixels=[],mask=[];
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);mask.push(dist>=22||hsv.s>=.18?1:0);pixels.push([r,g,b]);}
      return {pixels,mask};
    };
    const heuristic=f=>{const s={晴:Math.max(f.yellow*.9+f.orange*.35+f.bright*.28-f.dark*.18,f.bright*.42+(1-f.sat)*.14),猛暑:f.yellow*.6+f.orange*.75+f.dark*.28+f.edge*.12,虹:f.diversity*.55+f.red*.35+f.green*.35+(f.blue+f.cyan)*.28,流星群:f.purple*.55+f.blue*.45+f.bright*.18+f.edge*.18,雨:f.blue*.65+f.cyan*.55+f.sat*.18};if(f.countRatio<.04)Object.keys(s).forEach(k=>s[k]*=.45);return s;};
    const featureSimilarity=(a,b)=>{const hist=a.bins.reduce((sum,v,i)=>sum+Math.min(v,b.bins[i]||0),0);const scalar=1-Math.min(1,(Math.abs(a.sat-b.sat)+Math.abs(a.bright-b.bright)+Math.abs(a.dark-b.dark)+Math.abs(a.edge-b.edge))/4);return hist*.72+scalar*.28;};
    const pixelSimilarity=(a,b)=>{let union=0,intersection=0,color=0,n=0;for(let i=0;i<a.mask.length;i++){if(a.mask[i]||b.mask[i])union++;if(a.mask[i]&&b.mask[i]){intersection++;const pa=a.pixels[i],pb=b.pixels[i],diff=(Math.abs(pa[0]-pb[0])+Math.abs(pa[1]-pb[1])+Math.abs(pa[2]-pb[2]))/765;color+=1-diff;n++;}}return(union?intersection/union:0)*.38+(n?color/n:0)*.62;};
    const prepared=templates.map((item,index)=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=56;canvas.getContext('2d').drawImage(templateImages[index],0,0,56,56);return{weather:item.weather,feature:feature(canvas),signature:signature(canvas)};});
    const classify = canvas => {
      const f=feature(canvas),sig=signature(canvas),scores=heuristic(f);
      for(const t of prepared){const fs=featureSimilarity(f,t.feature),ps=pixelSimilarity(sig,t.signature),score=ps*.58+fs*.32+(scores[t.weather]||0)*.10;scores[t.weather]=Math.max(scores[t.weather]||0,score);}
      let ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);
      const topTwo=new Set(ranked.slice(0,2).map(item=>item[0]));
      if(topTwo.has('晴')&&topTwo.has('雨')&&(f.orange+f.yellow)>=.045&&f.bright>=.85){scores['晴']=Math.max(scores['晴']||0,(scores['雨']||0)+.12);ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);}
      const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0];
      const margin=bestScore-secondScore, high=bestScore>=readyScore&&margin>=readyMargin;
      return {value:high?bestValue:'',bestValue,bestScore,secondValue,secondScore,margin,confidence:high?'high':'low'};
    };
    const slots=slotRects.map(rect=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=56;
      canvas.getContext('2d').drawImage(sourceImage,Math.round(rect.x*sourceImage.naturalWidth),Math.round(rect.y*sourceImage.naturalHeight),Math.round(rect.w*sourceImage.naturalWidth),Math.round(rect.h*sourceImage.naturalHeight),0,0,56,56);
      return classify(canvas);
    });
    const bx=Math.round(ocrBand.x*sourceImage.naturalWidth),by=Math.round(ocrBand.y*sourceImage.naturalHeight),bw=Math.round(ocrBand.w*sourceImage.naturalWidth),bh=Math.round(ocrBand.h*sourceImage.naturalHeight),scale=6;
    const base=document.createElement('canvas');base.width=Math.max(1,bw*scale);base.height=Math.max(1,bh*scale);
    const bctx=base.getContext('2d',{willReadFrequently:true});bctx.imageSmoothingEnabled=true;bctx.imageSmoothingQuality='high';bctx.drawImage(sourceImage,bx,by,bw,bh,0,0,base.width,base.height);
    const binary=document.createElement('canvas');binary.width=base.width;binary.height=base.height;
    const cctx=binary.getContext('2d',{willReadFrequently:true});cctx.drawImage(base,0,0);
    const imageData=cctx.getImageData(0,0,binary.width,binary.height);
    for(let i=0;i<imageData.data.length;i+=4){const lum=.299*imageData.data[i]+.587*imageData.data[i+1]+.114*imageData.data[i+2];const value=lum>=185?0:255;imageData.data[i]=value;imageData.data[i+1]=value;imageData.data[i+2]=value;imageData.data[i+3]=255;}
    cctx.putImageData(imageData,0,0);
    return {width:sourceImage.naturalWidth,height:sourceImage.naturalHeight,slots,ocrBand:{x:bx,y:by,w:bw,h:bh,scale},ocrImages:[base.toDataURL('image/png').split(',')[1],binary.toDataURL('image/png').split(',')[1]]};
  }, { imageDataUrl, templates, slotRects:SLOT_RECTS, ocrBand:OCR_BAND, readyScore:READY_SCORE, readyMargin:READY_MARGIN });
}

function runTesseractTsv(imageBytes) {
  return new Promise((resolve, reject) => {
    const args=['stdin','stdout','-l','eng','--psm','7','-c','tessedit_char_whitelist=0123456789','-c','preserve_interword_spaces=1','tsv'];
    const child=spawn('tesseract',args,{stdio:['pipe','pipe','pipe']});
    const stdout=[],stderr=[];
    child.stdout.on('data',chunk=>stdout.push(chunk)); child.stderr.on('data',chunk=>stderr.push(chunk));
    child.on('error',reject);
    child.on('close',code=>{if(code===0)resolve(Buffer.concat(stdout).toString('utf8'));else reject(new Error(`tesseractExit${code}:${Buffer.concat(stderr).toString('utf8').slice(0,200)}`));});
    child.stdin.end(imageBytes);
  });
}

function inferStartFromMapped(mapped) {
  const observed=mapped.filter(Boolean).length;
  if(observed<2)return null;
  const matches=[];
  for(const startSlot of START_SLOTS){
    const startIndex=START_SLOTS.indexOf(startSlot);
    const expected=Array.from({length:5},(_,index)=>START_SLOTS[(startIndex+index)%START_SLOTS.length]);
    if(mapped.every((value,index)=>!value||value===expected[index]))matches.push({startSlot,expected,observed});
  }
  return matches.length===1?matches[0]:null;
}

function parseOcrTsv(tsv, analysis) {
  const allowed=new Set(START_SLOTS),slotCenters=SLOT_RECTS.map(cell=>(cell.x+cell.w/2)*analysis.width),words=[];
  for(const line of String(tsv||'').split(/\r?\n/).slice(1)){
    const cols=line.split('\t'); if(cols.length<12||cols[0]!=='5')continue;
    const token=String(cols.slice(11).join('\t')||'').trim(), match=token.match(/^\D*(\d{1,2})\D*$/); if(!match)continue;
    const value=String(Number(match[1])%24).padStart(2,'0'); if(!allowed.has(value))continue;
    const left=Number(cols[6]),width=Number(cols[8]); if(!Number.isFinite(left)||!Number.isFinite(width))continue;
    const centerPanel=analysis.ocrBand.x+(left+width/2)/analysis.ocrBand.scale;
    let nearest=0,distance=Infinity;
    for(let index=0;index<slotCenters.length;index++){const d=Math.abs(slotCenters[index]-centerPanel);if(d<distance){nearest=index;distance=d;}}
    if(distance<=analysis.width*.11)words.push({value,index:nearest,centerPanel,token});
  }
  const mapped=Array(5).fill('');
  for(const word of words){if(!mapped[word.index])mapped[word.index]=word.value;}
  return {mapped,words,inferred:inferStartFromMapped(mapped)};
}

function inferStartFromPostText(postText, slots) {
  const anchors=[];
  const pattern=/(流星群|虹|猛暑|雨|晴)[\s\S]{0,40}?(\d{1,2}):00/g;
  for(const match of String(postText||'').matchAll(pattern)){
    const weather=match[1],hour=Number(match[2])%24;
    if(!START_SLOTS.includes(String(hour).padStart(2,'0')))continue;
    const indexes=slots.map((slot,index)=>slot.value===weather?index:-1).filter(index=>index>=0);
    if(indexes.length!==1)continue;
    const start=((hour-6*indexes[0])%24+24)%24, startSlot=String(start).padStart(2,'0');
    if(START_SLOTS.includes(startSlot))anchors.push({weather,hour,index:indexes[0],startSlot});
  }
  const distinct=[...new Set(anchors.map(anchor=>anchor.startSlot))];
  return distinct.length===1?{startSlot:distinct[0],anchors}:null;
}

async function determineStartSlot(analysis, postText) {
  const attempts=[];
  for(let index=0;index<analysis.ocrImages.length;index++){
    try{
      const tsv=await runTesseractTsv(Buffer.from(analysis.ocrImages[index],'base64'));
      const parsed=parseOcrTsv(tsv,analysis); attempts.push({variantIndex:index,...parsed});
      if(parsed.inferred)return{startSlot:parsed.inferred.startSlot,times:parsed.inferred.expected,method:'local-tesseract',attempts,textAnchors:[]};
    }catch(error){attempts.push({variantIndex:index,error:String(error?.message||error),mapped:[],words:[]});}
  }
  const merged=Array(5).fill('');
  for(let index=0;index<5;index++){
    const values=[...new Set(attempts.map(item=>item.mapped?.[index]).filter(Boolean))];
    if(values.length===1)merged[index]=values[0];
  }
  const mergedInference=inferStartFromMapped(merged);
  if(mergedInference)return{startSlot:mergedInference.startSlot,times:mergedInference.expected,method:'local-tesseract-merged',attempts,textAnchors:[]};
  const textInference=inferStartFromPostText(postText,analysis.slots);
  if(textInference){const startIndex=START_SLOTS.indexOf(textInference.startSlot);return{startSlot:textInference.startSlot,times:Array.from({length:5},(_,i)=>START_SLOTS[(startIndex+i)%START_SLOTS.length]),method:'post-text-weather-anchor',attempts,textAnchors:textInference.anchors};}
  return{startSlot:'',times:merged,method:'unresolved',attempts,textAnchors:[]};
}

function emptyResult(targetDate, summary, unresolved, diagnostics={}) {
  return {schemaVersion:1,ready:false,targetDate,selectedImage:null,interpretation:{ready:false,observedDate:null,startSlot:null,slots:Array.from({length:5},(_,index)=>({slot:`slot${index}`,visible:false,weather:[],confidence:'low',description:''})),confidence:'low',summary,unresolved},diagnostics};
}

export async function inspectDailyCapture({ captureDir, targetDate, repoRoot='.' }) {
  const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8'));
  if(capture?.status!=='captured'||!Array.isArray(capture.rawMedia)||!capture.rawMedia.length)throw new Error('captureNotReady');
  const postText=await readFile(path.join(captureDir,capture.postContent?.file||'post-content.txt'),'utf8');
  if(!postConfirmsTargetDate(postText,targetDate))return emptyResult(targetDate,'投稿本文で対象日を確認できませんでした。',[`対象日 ${targetDate} が投稿本文にありません`],{postDateMatched:false});
  const templates=await loadTemplates(repoRoot),browser=await chromium.launch({headless:true}),diagnostics=[];
  try{
    const page=await browser.newPage();
    for(const media of capture.rawMedia.slice(0,4)){
      const filePath=path.join(captureDir,String(media.file||'')); let originalBytes;
      try{originalBytes=await readFile(filePath);}catch{continue;}
      let originalMime; try{originalMime=mimeFromBytes(originalBytes);}catch{continue;}
      if(originalMime!==media.mimeType||sha256(originalBytes)!==media.sha256)continue;
      for(let variantIndex=0;variantIndex<CROP_VARIANTS.length;variantIndex++){
        const normalized=await normalizeWeatherColumn(page,originalBytes,originalMime,CROP_VARIANTS[variantIndex]); if(!normalized)continue;
        const analysis=await classifyAndBuildOcrImages(page,normalized.bytes,templates);
        const start=await determineStartSlot(analysis,postText);
        const allHigh=analysis.slots.length===5&&analysis.slots.every(slot=>slot.confidence==='high'&&slot.value);
        diagnostics.push({file:media.file,variantIndex,sourceRect:normalized.sourceRect,normalizedSize:normalized.normalizedSize,slots:analysis.slots,start});
        if(!allHigh||!start.startSlot)continue;
        const slots=analysis.slots.map((slot,index)=>({slot:`slot${index}`,visible:true,weather:[slot.value],confidence:'high',description:`固定座標テンプレート判定 score=${slot.bestScore.toFixed(3)} margin=${slot.margin.toFixed(3)}`}));
        const interpretation={ready:true,observedDate:targetDate,startSlot:start.startSlot,slots,confidence:'high',summary:`投稿本文で${targetDate}を確認し、元画像の5枠を固定座標テンプレート照合。時刻は${start.method==='post-text-weather-anchor'?'本文の時刻付き天気と画像を照合':'runner内OCR'}して6時間刻みを確定。`,unresolved:[]};
        return{schemaVersion:1,ready:true,targetDate,selectedImage:{file:media.file,mimeType:media.mimeType,captureSha256:media.sha256},interpretation,diagnostics:{mode:'normalized-fixed-five-slot',selectedOriginal:media.file,selectedVariant:variantIndex,sourceRect:normalized.sourceRect,normalizedSize:normalized.normalizedSize,start,slotScores:analysis.slots,attempts:diagnostics}};
      }
    }
  }finally{await browser.close();}
  return emptyResult(targetDate,'時間別5枠と開始時刻を高確信度で確定できませんでした。',['時間別5枠と開始時刻の両方を高確信度で確定できませんでした'],{mode:'normalized-fixed-five-slot',attempts:diagnostics});
}

function parseArgs(argv){const out={};for(let index=0;index<argv.length;index+=2){if(!argv[index]?.startsWith('--')||argv[index+1]===undefined)throw new Error('invalidArguments');out[argv[index].slice(2)]=argv[index+1];}return out;}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  if(args.mode==='inspect'){
    if(!args['capture-dir']||!args['target-date']||!args.output)throw new Error('invalidArguments');
    const result=await inspectDailyCapture({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});
    await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');
    process.stdout.write(`${JSON.stringify({ready:result.ready,selectedImage:result.selectedImage?.file||'',startSlot:result.interpretation?.startSlot||'',slots:result.interpretation?.slots?.map(slot=>slot.weather)||[]})}\n`);
    if(!result.ready)process.exitCode=2; return;
  }
  if(args.mode==='bind'){
    if(!args.draft||!args.output||!args['artifact-run-id']||!args['artifact-id']||!args['artifact-name'])throw new Error('invalidArguments');
    const draft=JSON.parse(await readFile(path.resolve(args.draft),'utf8')); if(!draft?.ready)throw new Error('dailyReviewNotReady');
    const envelope=bindReviewEnvelope(draft,{runId:args['artifact-run-id'],id:args['artifact-id'],name:args['artifact-name']});
    const base64=Buffer.from(JSON.stringify(envelope),'utf8').toString('base64');
    await writeFile(path.resolve(args.output),`${JSON.stringify(envelope,null,2)}\n`,'utf8');
    if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,`review_payload_base64=${base64}\n`,{encoding:'utf8',flag:'a'});
    process.stdout.write(`${JSON.stringify({ready:true,artifactId:envelope.artifact.id,pendingEvidenceFile:envelope.pendingEvidenceFile})}\n`); return;
  }
  throw new Error('invalidArguments');
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Daily normalized weather review failed: ${error.message}\n`);process.exitCode=1;});}
