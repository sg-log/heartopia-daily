import { readFile,writeFile,mkdir,copyFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { inspectDirectDailyPanelCapture } from '../weather-direct-daily-panel-review.mjs';
import { inspectDirectPanelCapture } from '../weather-direct-panel-review.mjs';
import { inspectWeeklyScreenshot } from '../weather-weekly-screenshot-review.mjs';
import { extractPostDates } from '../weather-deterministic-review.mjs';
import { sha,json,plusDays } from './core.mjs';

// Old recognizers propose values. V2 owns date, source binding, strict acceptance,
// independent daily/weekly results and the evidence copied into the result.
export function strictDaily(proposal,expectedStartSlot) {
  if(!proposal?.ready || proposal.interpretation?.startSlot!==expectedStartSlot)return false;
  const d=proposal.diagnostics, scores=d?.scores||d?.dailyScores;
  if(!Array.isArray(scores)||scores.length!==5)return false;
  return scores.every((s,i)=>{
    const value=proposal.interpretation.slots[i]?.weather?.[0];
    const template=s.templateValue||s.bestValue;
    return value===template&&s.bestScore>=.43&&s.margin>=.008;
  });
}
async function verifyWeeklyDates(bytes,mime,scores,targetDate) {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.addScriptTag({url:'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'});
    const rows=await page.evaluate(async({dataUrl,boxes})=>{
      const im=await new Promise((ok,no)=>{const im=new Image();im.onload=()=>ok(im);im.onerror=no;im.src=dataUrl;});
      const worker=await Tesseract.createWorker('eng',1,{logger:()=>{}});
      await worker.setParameters({tessedit_char_whitelist:'0123456789/.-',tessedit_pageseg_mode:'7'});
      try {
        const out=[];
        for(const b of boxes){
          const x=Math.max(0,b.x-b.size*7),y=Math.max(0,b.y-b.size*.2),w=b.x-x,h=b.size*1.4;
          const c=document.createElement('canvas');c.width=w*4;c.height=h*4;
          c.getContext('2d').drawImage(im,x,y,w,h,0,0,c.width,c.height);
          out.push((await worker.recognize(c)).data.text.trim());
        }return out;
      }finally{await worker.terminate();}
    },{dataUrl:`data:${mime};base64,${bytes.toString('base64')}`,boxes:scores.map(s=>s.box)});
    const expected=rows.map((_,i)=>plusDays(targetDate,i+1));
    const matched=rows.map((text,i)=>{
      const [,m,d]=expected[i].split('-').map(Number);
      return new RegExp(`(?:^|\\D)0?${m}[/.\\-]0?${d}(?:\\D|$)`).test(text);
    });
    return {ready:rows.length===5&&matched.every(Boolean),rows,expected,matched};
  }finally{await browser.close();}
}
async function bind(proposal,capture,dir,kind){
  const selected=proposal.selectedImage;
  const media=capture.rawMedia.find(m=>m.file===selected?.file);
  if(!media||media.sha256!==selected.captureSha256)throw Error('unboundEvidence');
  const bytes=await readFile(path.join(dir,media.file));
  if(sha(bytes)!==media.sha256)throw Error('evidenceHashMismatch');
  return {file:media.file,sha256:media.sha256,mimeType:media.mimeType,sourceUrl:capture.sourceUrl,mediaUrl:media.url,sourceScope:media.sourceScope,kind};
}
export async function review(dir,targetDate,startSlot){
  const capture=JSON.parse(await readFile(path.join(dir,'capture.json'),'utf8'));
  const text=await readFile(path.join(dir,'post-content.txt'),'utf8');
  const dates=extractPostDates(text);
  const result={daily:{ready:false,reason:'targetDateNotConfirmed'},weekly:{ready:false,reason:'targetDateNotConfirmed'},dateEvidence:{kind:'source-page-explicit-date',dates}};
  if(!dates.includes(targetDate))return result;
  // A query date and an upload timestamp are never injected into the source text.
  const proposals=[];
  const daily=await inspectDirectDailyPanelCapture({captureDir:dir,targetDate});proposals.push(daily);
  if(!strictDaily(daily,startSlot))proposals.push(await inspectDirectPanelCapture({captureDir:dir,targetDate}));
  result.daily={ready:false,reason:'dailyUiOrSlotNotVerified'};
  for(const p of proposals){
    if(!strictDaily(p,startSlot))continue;
    const evidence=await bind(p,capture,dir,'daily');
    result.daily={ready:true,startSlot,slots:p.interpretation.slots.map(s=>s.weather),evidence,diagnostics:p.diagnostics};break;
  }
  const w=await inspectWeeklyScreenshot({captureDir:dir,targetDate});
  result.weekly={ready:false,reason:w.reason||w.diagnostics?.reason||'weeklyUiNotVerified',diagnostics:w.diagnostics};
  if(w.ready){
    const evidence=await bind(w,capture,dir,'weekly');
    const labels=await verifyWeeklyDates(await readFile(path.join(dir,evidence.file)),evidence.mimeType,w.diagnostics.scores,targetDate);
    result.weekly={ready:false,reason:'weeklyDateLabelsNotVerified',labels,diagnostics:w.diagnostics};
    if(labels.ready)result.weekly={ready:true,days:w.interpretation.days.map(d=>({date:d.date,weather:d.weather})),evidence,labels,diagnostics:w.diagnostics};
  }
  return result;
}
