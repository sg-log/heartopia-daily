import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bindReviewEnvelope } from './weather-deterministic-review.mjs';
import { inspectDailyCapture, parseSpecialWeather, weatherForSlot } from './weather-daily-review.mjs';

const START_SLOTS = ['00', '06', '12', '18'];
const SLOT_RECTS = [
  { x: .080, y: .675, w: .120, h: .165 },
  { x: .245, y: .675, w: .120, h: .165 },
  { x: .425, y: .675, w: .120, h: .165 },
  { x: .625, y: .675, w: .120, h: .165 },
  { x: .800, y: .675, w: .120, h: .165 }
];

function inferUniqueStart(attempts) {
  let best = null;
  for (const item of attempts || []) {
    const mapped = Array.isArray(item?.mapped) ? item.mapped.map(value => String(value || '').padStart(2, '0').slice(-2)) : [];
    const observed = mapped.filter(value => START_SLOTS.includes(value)).length;
    if (observed < 2) continue;
    const matches = [];
    for (const startSlot of START_SLOTS) {
      const startIndex = START_SLOTS.indexOf(startSlot);
      const expected = Array.from({ length: 5 }, (_, index) => START_SLOTS[(startIndex + index) % 4]);
      let mismatch = false;
      for (let index = 0; index < 5; index += 1) {
        if (START_SLOTS.includes(mapped[index]) && mapped[index] !== expected[index]) mismatch = true;
      }
      if (!mismatch) matches.push({ startSlot, expected });
    }
    if (matches.length !== 1) continue;
    const candidate = { ...matches[0], mapped, observed };
    if (!best || candidate.observed > best.observed) best = candidate;
  }
  return best;
}

async function warmRatios(page, imageDataUrl, rect) {
  return page.evaluate(async ({ imageDataUrl, rect, slotRects }) => {
    const image = await new Promise((resolve, reject) => { const item = new Image(); item.onload = () => resolve(item); item.onerror = reject; item.src = imageDataUrl; });
    const panel = document.createElement('canvas'); panel.width = rect.w; panel.height = rect.h;
    panel.getContext('2d').drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const rgbToHsv = (r,g,b) => { r/=255; g/=255; b/=255; const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min; let h=0; if(d){ if(max===r)h=((g-b)/d)%6; else if(max===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0)h+=360; } return {h,s:max?d/max:0,v:max}; };
    return slotRects.map(cell => {
      const sx=Math.round(cell.x*panel.width), sy=Math.round(cell.y*panel.height), sw=Math.round(cell.w*panel.width), sh=Math.round(cell.h*panel.height);
      const canvas=document.createElement('canvas'); canvas.width=Math.max(1,sw); canvas.height=Math.max(1,sh); const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(panel,sx,sy,sw,sh,0,0,sw,sh);
      const data=ctx.getImageData(0,0,sw,sh).data; let warm=0,foreground=0;
      const corners=[[1,1],[sw-2,1],[1,sh-2],[sw-2,sh-2]].map(([x,y])=>{const i=(y*sw+x)*4;return[data[i],data[i+1],data[i+2]]});
      const bg=corners.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corners.length);
      for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){const i=(y*sw+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);if(dist<18&&hsv.s<.15)continue;foreground++;if(hsv.h>=28&&hsv.h<=82&&hsv.s>=.18&&hsv.v>=.62)warm++;}
      return foreground ? warm/foreground : 0;
    });
  }, { imageDataUrl, rect, slotRects: SLOT_RECTS });
}

export async function inspectRecoveredDailyCapture({ captureDir, targetDate, repoRoot = path.resolve('.') }) {
  const result = await inspectDailyCapture({ captureDir, targetDate, repoRoot });
  if (result?.ready === true) return result;
  const attempts = result?.diagnostics?.summaryCardAttempts || [];
  if (!attempts.length) return result;
  const capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8'));
  const postText = await readFile(path.join(captureDir, capture.postContent?.file || 'post-content.txt'), 'utf8');
  const specials = parseSpecialWeather(postText);
  let chosen = null;
  for (const attempt of attempts) {
    if (!Array.isArray(attempt.slots) || attempt.slots.length !== 5) continue;
    if (!attempt.slots.every(slot => slot?.bestValue && slot?.confidence === 'high')) continue;
    const inferred = inferUniqueStart(attempt.ocr?.attempts || []);
    if (!inferred) continue;
    chosen = { attempt, inferred };
    break;
  }
  if (!chosen) return result;
  const media = (capture.rawMedia || []).find(item => item.file === chosen.attempt.file);
  if (!media) return result;
  const bytes = await readFile(path.join(captureDir, media.file));
  const imageDataUrl = `data:${media.mimeType};base64,${bytes.toString('base64')}`;
  const browser = await chromium.launch({ headless: true });
  let warmth;
  try {
    const page = await browser.newPage();
    warmth = await warmRatios(page, imageDataUrl, chosen.attempt.rect);
  } finally { await browser.close(); }
  const slots = chosen.attempt.slots.map((slot, index) => {
    let base = slot.bestValue;
    const pair = new Set([slot.bestValue, slot.secondValue]);
    if (pair.has('晴') && pair.has('雨') && Number(warmth[index]) < .02) base = '雨';
    return {
      slot: `slot${index}`,
      visible: true,
      weather: weatherForSlot(base, chosen.inferred.startSlot, index, specials),
      confidence: 'high',
      description: `概要カード判定 score=${Number(slot.bestScore).toFixed(3)} margin=${Number(slot.margin).toFixed(3)} warm=${Number(warmth[index]).toFixed(3)}`
    };
  });
  return {
    schemaVersion: 1,
    ready: true,
    targetDate,
    selectedImage: { file: media.file, mimeType: media.mimeType, captureSha256: media.sha256 },
    interpretation: {
      ready: true,
      observedDate: targetDate,
      startSlot: chosen.inferred.startSlot,
      slots,
      confidence: 'high',
      summary: `対象日の概要カードを直接判読。位置付き時刻ラベル${chosen.inferred.observed}点が唯一の6時間系列に一致し、5枠を確定。特殊天気は投稿本文の明示時間帯を併記。`,
      unresolved: []
    },
    diagnostics: { mode: 'daily-summary-card-recovered', inferred: chosen.inferred, warmth, sourceAttempt: chosen.attempt }
  };
}

function parseArgs(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}return out;}
async function main(){const args=parseArgs(process.argv.slice(2));if(args.mode==='inspect'){const result=await inspectRecoveredDailyCapture({captureDir:path.resolve(args['capture-dir']),targetDate:args['target-date'],repoRoot:path.resolve(args['repo-root']||'.')});await writeFile(path.resolve(args.output),`${JSON.stringify(result,null,2)}\n`,'utf8');process.stdout.write(`${JSON.stringify({ready:result.ready,startSlot:result.interpretation?.startSlot||'',slots:result.interpretation?.slots?.map(item=>item.weather)||[]})}\n`);if(!result.ready)process.exitCode=2;return;}if(args.mode==='bind'){const draft=JSON.parse(await readFile(path.resolve(args.draft),'utf8'));const envelope=bindReviewEnvelope(draft,{runId:args['artifact-run-id'],id:args['artifact-id'],name:args['artifact-name']});const base64=Buffer.from(JSON.stringify(envelope),'utf8').toString('base64');await writeFile(path.resolve(args.output),`${JSON.stringify(envelope,null,2)}\n`,'utf8');if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,`review_payload_base64=${base64}\n`,{encoding:'utf8',flag:'a'});return;}throw new Error('invalidArguments');}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(error=>{process.stderr.write(`Daily recovery review failed: ${error.message}\n`);process.exitCode=1;});}
