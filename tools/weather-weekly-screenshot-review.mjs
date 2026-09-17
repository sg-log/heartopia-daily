import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { extractPostDates, normalizeTargetDate } from './weather-deterministic-review.mjs';

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

function addDays(dateText, amount) {
  const date = new Date(`${normalizeTargetDate(dateText)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}
async function loadTemplates(repoRoot) {
  const root = path.join(repoRoot, 'assets', 'weather-templates');
  const result = [];
  for (const [weather, file] of TEMPLATE_FILES) {
    const bytes = await readFile(path.join(root, file));
    result.push({ weather, file, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
  }
  return result;
}

async function inspectScreenshot(page, imageDataUrl, templates) {
  return page.evaluate(async ({ imageDataUrl, templates }) => {
    const load = src => new Promise((resolve, reject) => { const im = new Image(); im.onload=()=>resolve(im); im.onerror=reject; im.src=src; });
    const [source, ...templateImages] = await Promise.all([load(imageDataUrl), ...templates.map(t=>load(t.dataUrl))]);
    const full = document.createElement('canvas'); full.width=source.naturalWidth; full.height=source.naturalHeight;
    const fctx=full.getContext('2d',{willReadFrequently:true}); fctx.drawImage(source,0,0);
    const pixels=fctx.getImageData(0,0,full.width,full.height).data;
    const rgbToHsv=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:max?d/max:0,v:max};};
    const signature=canvas=>{const ctx=canvas.getContext('2d',{willReadFrequently:true}),{width,height}=canvas,data=ctx.getImageData(0,0,width,height).data;const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});const bg=corner.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corner.length);const pix=[],mask=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);mask.push(dist>=18||hsv.s>=.15?1:0);pix.push([r,g,b]);}return{pix,mask};};
    const similarity=(a,b)=>{let union=0,intersection=0,color=0,n=0;for(let i=0;i<a.mask.length;i++){if(a.mask[i]||b.mask[i])union++;if(a.mask[i]&&b.mask[i]){intersection++;const p=a.pix[i],q=b.pix[i],diff=(Math.abs(p[0]-q[0])+Math.abs(p[1]-q[1])+Math.abs(p[2]-q[2]))/765;color+=1-diff;n++;}}return(union?intersection/union:0)*.42+(n?color/n:0)*.58;};
    const prepared=templates.map((t,i)=>{const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(templateImages[i],0,0,56,56);return{weather:t.weather,file:t.file,sig:signature(c)};});
    const classifyBoxes=(boxes)=>boxes.map(box=>{
      const c=document.createElement('canvas');c.width=c.height=56;c.getContext('2d').drawImage(source,box.x,box.y,box.size,box.size,0,0,56,56);const sig=signature(c),byWeather=new Map();
      for(const t of prepared){const value=similarity(sig,t.sig);byWeather.set(t.weather,Math.max(value,byWeather.get(t.weather)||0));}
      const ranked=[...byWeather.entries()].sort((a,b)=>b[1]-a[1]);const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0];
      return{bestValue,bestScore,secondValue,secondScore,margin:bestScore-secondScore,box};
    });
    const finalize=(scores,extra={})=>{const days=scores.map(s=>({weather:s.bestScore>=.50&&s.margin>=.025?s.bestValue:'',confidence:s.bestScore>=.50&&s.margin>=.025?'high':'low',...s}));return{ready:days.every(d=>d.confidence==='high'&&d.weather),days,width:full.width,height:full.height,...extra};};

    const inspectEmbeddedGamePanel=()=>{
      const step=4,gw=Math.ceil(full.width/step),gh=Math.ceil(full.height/step),grid=new Uint8Array(gw*gh);
      for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
        let hits=0,total=0;
        for(let yy=gy*step;yy<Math.min(full.height,(gy+1)*step);yy+=2)for(let xx=gx*step;xx<Math.min(full.width,(gx+1)*step);xx+=2){const i=(yy*full.width+xx)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];total++;if(b>80&&b>r*1.15&&b>g*1.03&&r<145&&g<160)hits++;}
        if(hits>=Math.max(1,Math.ceil(total*.40)))grid[gy*gw+gx]=1;
      }
      const seen=new Uint8Array(grid.length),components=[];
      for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
        const start=gy*gw+gx;if(!grid[start]||seen[start])continue;const q=[[gx,gy]];seen[start]=1;let qi=0,minX=gx,maxX=gx,minY=gy,maxY=gy,count=0;
        while(qi<q.length){const [x,y]=q[qi++];count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){if(nx<0||ny<0||nx>=gw||ny>=gh)continue;const ni=ny*gw+nx;if(grid[ni]&&!seen[ni]){seen[ni]=1;q.push([nx,ny]);}}}
        const box={x:minX*step,y:minY*step,w:(maxX-minX+1)*step,h:(maxY-minY+1)*step,count};
        if(box.w>=120&&box.h>=80&&box.w/box.h>=1.15&&box.w/box.h<=1.8)components.push(box);
      }
      components.sort((a,b)=>b.count-a.count);
      for(const purple of components.slice(0,6)){
        const panelW=Math.round(purple.w*1.20),left=Math.max(0,Math.round(purple.x-purple.w*.12)),top=Math.max(0,Math.round(purple.y-purple.w*.015)),panelH=Math.round(panelW*1.13);
        if(left+panelW>full.width||top+panelH>full.height)continue;
        const lowerTop=Math.round(top+panelH*.53),lowerBottom=Math.round(top+panelH*.98);let light=0,total=0;
        for(let y=lowerTop;y<lowerBottom;y+=2)for(let x=left+Math.round(panelW*.04);x<left+Math.round(panelW*.96);x+=2){const i=(y*full.width+x)*4,hsv=rgbToHsv(pixels[i],pixels[i+1],pixels[i+2]);total++;if(hsv.v>=.68&&hsv.s<=.30)light++;}
        const lightRatio=total?light/total:0;if(lightRatio<.48)continue;
        const size=Math.max(14,Math.min(60,Math.round(panelW*.085))),centerX=left+panelW*.84;
        const boxes=[.60,.68,.76,.84,.92].map(rel=>({x:Math.max(0,Math.round(centerX-size/2)),y:Math.max(0,Math.round(top+panelH*rel-size/2)),size}));
        const result=finalize(classifyBoxes(boxes),{mode:'embedded-game-panel',embeddedPanel:{x:left,y:top,w:panelW,h:panelH},purpleComponent:purple,panelBackgroundRatio:lightRatio});
        if(result.ready)return result;
      }
      return null;
    };

    const step=4, gw=Math.ceil(full.width/step), gh=Math.ceil(full.height/step), grid=new Uint8Array(gw*gh);
    for(let gy=Math.floor(gh*.42);gy<gh;gy++) for(let gx=0;gx<gw;gx++){
      let hits=0,total=0;
      for(let yy=gy*step;yy<Math.min(full.height,(gy+1)*step);yy+=2) for(let xx=gx*step;xx<Math.min(full.width,(gx+1)*step);xx+=2){
        const i=(yy*full.width+xx)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2],hsv=rgbToHsv(r,g,b); total++;
        if(b>140&&g>105&&b>r*1.12&&hsv.s>.22&&hsv.h>=175&&hsv.h<=235) hits++;
      }
      if(hits>=Math.max(1,Math.ceil(total*.35))) grid[gy*gw+gx]=1;
    }
    const seen=new Uint8Array(grid.length),components=[];
    for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
      const start=gy*gw+gx;if(!grid[start]||seen[start])continue;
      const q=[[gx,gy]];seen[start]=1;let qi=0,minX=gx,maxX=gx,minY=gy,maxY=gy,count=0;
      while(qi<q.length){const [x,y]=q[qi++];count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){if(nx<0||ny<0||nx>=gw||ny>=gh)continue;const ni=ny*gw+nx;if(grid[ni]&&!seen[ni]){seen[ni]=1;q.push([nx,ny]);}}}
      const box={x:minX*step,y:minY*step,w:(maxX-minX+1)*step,h:(maxY-minY+1)*step,count};
      if(box.w>=90&&box.h>=55&&box.y>=full.height*.42&&box.w/box.h>=1.05&&box.w/box.h<=2.2)components.push(box);
    }
    components.sort((a,b)=>(b.count*step*step)-(a.count*step*step));
    const header=components[0];
    if(!header){const embedded=inspectEmbeddedGamePanel();if(embedded)return embedded;return{ready:false,reason:'weeklyHeaderNotFound',components:components.slice(0,8),width:full.width,height:full.height};}

    const panelLeft=Math.max(0,Math.round(header.x+header.w*.03));
    const panelRight=Math.min(full.width,Math.round(header.x+header.w*.97));
    const panelTop=Math.max(0,Math.round(header.y+header.h*1.10));
    const panelBottom=Math.min(full.height,Math.round(header.y+header.h*1.75));
    let panelLight=0,panelTotal=0;
    for(let y=panelTop;y<panelBottom;y+=2)for(let x=panelLeft;x<panelRight;x+=2){
      const i=(y*full.width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2],hsv=rgbToHsv(r,g,b);
      panelTotal++;
      if(hsv.v>=.72&&hsv.s<=.25)panelLight++;
    }
    const panelBackgroundRatio=panelTotal?panelLight/panelTotal:0;
    if(panelBackgroundRatio<.40){const embedded=inspectEmbeddedGamePanel();if(embedded)return embedded;return{ready:false,reason:'weeklyPanelBackgroundNotFound',header,panelBackgroundRatio,components:components.slice(0,8),width:full.width,height:full.height};}

    const centersY=[.08,.25,.42,.59,.78].map(v=>header.y+header.h+header.h*v);
    const centerX=header.x+header.w*1.02;
    const size=Math.max(14,Math.min(28,Math.round(header.w*.10)));
    const scores=classifyBoxes(centersY.map(cy=>({x:Math.max(0,Math.round(centerX-size/2)),y:Math.max(0,Math.round(cy-size/2)),size})));
    const legacy=finalize(scores,{header,panelBackgroundRatio,mode:'legacy-weekly-header'});
    if(legacy.ready)return legacy;
    const embedded=inspectEmbeddedGamePanel();if(embedded)return embedded;
    return legacy;
  }, { imageDataUrl, templates });
}

export async function inspectWeeklyScreenshot({ captureDir, targetDate, repoRoot=path.resolve('.') }) {
  targetDate=normalizeTargetDate(targetDate);
  const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8'));
  if(capture?.status!=='captured') return {ready:false,reason:'captureNotReady'};
  const postText=await readFile(path.join(captureDir,capture.postContent?.file||'post-content.txt'),'utf8');
  const postDates=extractPostDates(postText);
  if(!postDates.includes(targetDate)) return {ready:false,reason:'targetDateNotConfirmed',postDates};

  const candidates=[];
  const weeklyRaw = Array.isArray(capture.rawMedia) ? (capture.adapter==='x-official-embed' ? capture.rawMedia.filter(media=>media?.sourceScope==='exact-status') : capture.rawMedia) : [];
  for(const media of weeklyRaw.slice(0,4)) {
    if(media?.file&&media?.sha256&&media?.mimeType) candidates.push({file:media.file,sha256:media.sha256,mimeType:media.mimeType,kind:'raw-media'});
  }
  if(capture.evidence?.file&&capture.evidence?.sha256&&capture.evidence?.mimeType) {
    candidates.push({file:capture.evidence.file,sha256:capture.evidence.sha256,mimeType:capture.evidence.mimeType,kind:'embed-evidence'});
  }
  if(!candidates.length) return {ready:false,reason:'weeklyEvidenceImageNotFound'};

  const templates=await loadTemplates(repoRoot),browser=await chromium.launch({headless:true});
  const attempts=[];
  try {
    const page=await browser.newPage();
    for(const candidate of candidates) {
      try {
        const bytes=await readFile(path.join(captureDir,candidate.file));
        const mimeType=mimeFromBytes(bytes),digest=sha256(bytes);
        if(digest!==candidate.sha256||mimeType!==candidate.mimeType) {
          attempts.push({file:candidate.file,kind:candidate.kind,ready:false,reason:'bindingMismatch'});
          continue;
        }
        const inspected=await inspectScreenshot(page,`data:${mimeType};base64,${bytes.toString('base64')}`,templates);
        attempts.push({file:candidate.file,kind:candidate.kind,...inspected});
        if(!inspected.ready) continue;
        const days=inspected.days.map((day,index)=>({date:addDays(targetDate,index+1),weather:[day.weather],visible:true,confidence:'high',description:`週間欄アイコン照合 score=${day.bestScore.toFixed(3)} margin=${day.margin.toFixed(3)}`}));
        return{schemaVersion:1,ready:true,targetDate,selectedImage:{file:candidate.file,mimeType,captureSha256:digest},interpretation:{ready:true,baseDate:targetDate,baseDateDescription:`投稿本文/表示日時で${targetDate}を確認。`,days,confidence:'high',summary:'公開投稿の取得済みゲーム内UI画像から、表示されている5日分のみ判読。',unresolved:[]},diagnostics:{mode:inspected.mode||'weekly-captured-image',selectedKind:candidate.kind,header:inspected.header||null,embeddedPanel:inspected.embeddedPanel||null,panelBackgroundRatio:inspected.panelBackgroundRatio,scores:inspected.days,attempts}};
      } catch(error) {
        attempts.push({file:candidate.file,kind:candidate.kind,ready:false,reason:'inspectError',message:String(error?.message||error)});
      }
    }
  } finally { await browser.close(); }
  return{ready:false,targetDate,selectedImage:null,diagnostics:{reason:'weeklyPanelNotFoundInCapturedImages',attempts}};
}

function parseArgs(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}return out;}
async function main(){const args=parseArgs(process.argv.slice(2));if(!args['capture-dir']||!args['target-date']||!args.output)throw new Error('invalidArguments');const result=await inspectWeeklyScreenshot({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');process.stdout.write(`${JSON.stringify({ready:result.ready,days:result.interpretation?.days?.map(d=>d.weather)||[],reason:result.reason||result.diagnostics?.reason||''})}\n`);if(!result.ready)process.exitCode=2;}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Weekly screenshot review failed: ${error.message}\n`);process.exitCode=1;});}
