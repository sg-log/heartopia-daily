import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const TARGET_ASPECT = 497 / 661;
const WEATHER_VALUES = ['晴', '雨', '流星群', '虹', '猛暑'];
const START_SLOTS = ['00', '06', '12', '18'];
const SLOT_RECTS = [
  { key: 'slot0', x: .080, y: .418, w: .105, h: .070 },
  { key: 'slot1', x: .294, y: .418, w: .105, h: .070 },
  { key: 'slot2', x: .471, y: .418, w: .105, h: .070 },
  { key: 'slot3', x: .650, y: .418, w: .105, h: .070 },
  { key: 'slot4', x: .829, y: .418, w: .105, h: .070 }
];
const TIME_STRIP = { x: .075, y: .490, w: .850, h: .065 };
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
  for (const heightFraction of [.72, .76, .80, .84]) {
    const h = height * heightFraction;
    const w = h * TARGET_ASPECT;
    for (const topFraction of [.04, .07, .10, .13]) {
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
    const classifyCanvas=(canvas)=>{const f=feature(canvas),sig=signature(canvas),scores=heuristic(f);for(const t of templateFeatures){const fs=featureSimilarity(f,t.feature),ps=pixelSimilarity(sig,t.signature),score=ps*.58+fs*.32+(scores[t.weather]||0)*.10;scores[t.weather]=Math.max(scores[t.weather]||0,score);}const ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1]);const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0],margin=bestScore-secondScore,ok=bestScore>=thresholds.confidence&&margin>=thresholds.margin;return{value:ok?bestValue:'',bestValue,bestScore,secondValue,secondScore,margin,confidence:ok?(bestScore>=thresholds.high?'high':'medium'):'low'};};
    const buildCandidates=()=>{
      const width=sourceImage.naturalWidth,height=sourceImage.naturalHeight,out=[],seen=new Set();
      const add=(x,y,w,h,source)=>{x=Math.round(x);y=Math.round(y);w=Math.round(w);h=Math.round(h);if(w<120||h<160||x<0||y<0||x+w>width||y+h>height)return;const k=`${x},${y},${w},${h}`;if(seen.has(k))return;seen.add(k);out.push({x,y,w,h,source});};
      if(Math.abs(width/height-targetAspect)<=.18)add(0,0,width,height,'whole-image');
      for(const hf of [.72,.76,.80,.84]){const h=height*hf,w=h*targetAspect;for(const tf of [.04,.07,.10,.13])for(const rf of [.03,.055,.08,.105])add(width-width*rf-w,height*tf,w,h,'right-panel-search');}
      return out;
    };
    const panelCanvas=(r)=>{const c=document.createElement('canvas');c.width=r.w;c.height=r.h;c.getContext('2d').drawImage(sourceImage,r.x,r.y,r.w,r.h,0,0,r.w,r.h);return c;};
    const classifyPanel=(r)=>{const p=panelCanvas(r),slots=slotRects.map(rect=>{const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(p,Math.round(rect.x*p.width),Math.round(rect.y*p.height),Math.round(rect.w*p.width),Math.round(rect.h*p.height),0,0,56,56);return classifyCanvas(c);});const highCount=slots.filter(s=>s.confidence==='high').length,okCount=slots.filter(s=>s.value).length,avg=slots.reduce((s,v)=>s+v.bestScore,0)/slots.length,minMargin=Math.min(...slots.map(s=>s.margin));return{rect:r,slots,highCount,okCount,avg,minMargin};};
    let coarse=buildCandidates().map(classifyPanel).sort((a,b)=>b.highCount-a.highCount||b.okCount-a.okCount||b.avg-a.avg).slice(0,6);
    const refined=[];
    for(const base of coarse){for(let dy=-6;dy<=6;dy+=3)for(let dx=-6;dx<=6;dx+=3){const r={...base.rect,x:Math.max(0,Math.min(sourceImage.naturalWidth-base.rect.w,base.rect.x+dx)),y:Math.max(0,Math.min(sourceImage.naturalHeight-base.rect.h,base.rect.y+dy)),source:'refined'};refined.push(classifyPanel(r));}}
    const best=[...coarse,...refined].sort((a,b)=>b.highCount-a.highCount||b.okCount-a.okCount||b.minMargin-a.minMargin||b.avg-a.avg)[0]||null;
    return {width:sourceImage.naturalWidth,height:sourceImage.naturalHeight,best};
  }, { imageDataUrl, templates, targetAspect: TARGET_ASPECT, slotRects: SLOT_RECTS, thresholds: { confidence: CONFIDENCE_THRESHOLD, high: HIGH_THRESHOLD, margin: MARGIN_THRESHOLD } });
}

async function readStartSlot(page, imageDataUrl, rect) {
  await page.addScriptTag({ url: TESSERACT_URL });
  return page.evaluate(async ({ imageDataUrl, rect, timeStrip, startSlots }) => {
    const image = await new Promise((resolve, reject) => { const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=imageDataUrl; });
    const panel=document.createElement('canvas');panel.width=rect.w;panel.height=rect.h;panel.getContext('2d').drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
    const x=Math.round(timeStrip.x*panel.width),y=Math.round(timeStrip.y*panel.height),w=Math.round(timeStrip.w*panel.width),h=Math.round(timeStrip.h*panel.height);
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,w*3);canvas.height=Math.max(1,h*3);const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(panel,x,y,w,h,0,0,canvas.width,canvas.height);
    const result=await window.Tesseract.recognize(canvas,'eng',{tessedit_char_whitelist:'0123456789',logger:()=>{}});
    const times=(result?.data?.text||'').match(/\d{1,2}/g)?.map(value=>String(Number(value)).padStart(2,'0').slice(-2))||[];
    const valid=times.filter(value=>startSlots.includes(value)).slice(0,5);
    const hourAt=(start,index)=>startSlots[(startSlots.indexOf(start)+index)%startSlots.length];
    if(valid.length===5&&valid.every((value,index)=>value===hourAt(valid[0],index)))return{startSlot:valid[0],times,valid};
    if(valid.length>=3&&startSlots.includes(valid[0])){const matches=valid.filter((value,index)=>value===hourAt(valid[0],index)).length;if(matches>=3)return{startSlot:valid[0],times,valid};}
    return{startSlot:'',times,valid};
  }, { imageDataUrl, rect, timeStrip: TIME_STRIP, startSlots: START_SLOTS });
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
    for (const media of capture.rawMedia.slice(0, 4)) {
      const filePath = path.join(captureDir, String(media.file || ''));
      let descriptor;
      try { descriptor = await imageDescriptor(filePath); } catch { continue; }
      if (descriptor.sha256 !== media.sha256 || descriptor.mimeType !== media.mimeType) continue;
      const imageDataUrl = `data:${descriptor.mimeType};base64,${descriptor.bytes.toString('base64')}`;
      const scored = await scoreImage(page, imageDataUrl, templates);
      const candidate = scored.best ? { media, descriptor, imageDataUrl, scored } : null;
      if (!candidate) continue;
      const rank = [candidate.scored.best.highCount, candidate.scored.best.okCount, candidate.scored.best.minMargin, candidate.scored.best.avg];
      const prior = best ? [best.scored.best.highCount,best.scored.best.okCount,best.scored.best.minMargin,best.scored.best.avg] : null;
      if (!prior || rank.some((value,index)=>value>prior[index] && rank.slice(0,index).every((v,i)=>v===prior[i]))) best = candidate;
    }
    if (!best || best.scored.best.highCount !== 5 || best.scored.best.okCount !== 5) {
      return { schemaVersion:1, ready:false, targetDate, selectedImage:null, interpretation:{ready:false,observedDate:targetDate,startSlot:null,slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:false,weather:[],confidence:'low',description:''})),confidence:'low',summary:'天気5枠を高確信度で判読できませんでした。',unresolved:['時間別5枠の画像判定が高確信度に達しませんでした']}, diagnostics:{postDates:dates,best:best?.scored?.best||null} };
    }
    const ocr = await readStartSlot(page, best.imageDataUrl, best.scored.best.rect);
    if (!ocr.startSlot) {
      return { schemaVersion:1, ready:false, targetDate, selectedImage:{file:best.media.file,mimeType:best.media.mimeType,captureSha256:best.media.sha256}, interpretation:{ready:false,observedDate:targetDate,startSlot:null,slots:best.scored.best.slots.map((s,i)=>({slot:`slot${i}`,visible:true,weather:s.value?[s.value]:[],confidence:s.confidence,description:`画像テンプレート判定 score=${s.bestScore.toFixed(3)} margin=${s.margin.toFixed(3)}`})),confidence:'low',summary:'時刻ラベルを確定できませんでした。',unresolved:['開始時刻を画像内の時刻ラベルから確定できませんでした']}, diagnostics:{postDates:dates,panel:best.scored.best.rect,ocr} };
    }
    const slots=best.scored.best.slots.map((s,i)=>({slot:`slot${i}`,visible:true,weather:[s.value],confidence:'high',description:`画像テンプレート判定 score=${s.bestScore.toFixed(3)} margin=${s.margin.toFixed(3)}`}));
    const interpretation={ready:true,observedDate:targetDate,startSlot:ocr.startSlot,slots,confidence:'high',summary:`投稿本文で${targetDate}を確認し、元画像の天気パネルをテンプレート照合、時刻ラベルをOCRして5枠を判読。`,unresolved:[]};
    return { schemaVersion:1, ready:true, targetDate, selectedImage:{file:best.media.file,mimeType:best.media.mimeType,captureSha256:best.media.sha256}, interpretation, diagnostics:{postDates:dates,panel:best.scored.best.rect,ocr,slotScores:best.scored.best.slots.map(s=>({bestValue:s.bestValue,bestScore:s.bestScore,secondValue:s.secondValue,secondScore:s.secondScore,margin:s.margin}))} };
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
