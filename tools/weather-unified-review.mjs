import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bindReviewEnvelope, inspectCapture } from './weather-deterministic-review.mjs';

const START_SLOTS = ['00', '06', '12', '18'];
const PANEL_VARIANTS = [
  { height: .94, aspect: .80, top: .03, right: .06 },
  { height: .92, aspect: .80, top: .04, right: .06 },
  { height: .96, aspect: .80, top: .02, right: .06 },
  { height: .94, aspect: .78, top: .03, right: .05 },
  { height: .94, aspect: .82, top: .03, right: .07 },
  { height: .94, aspect: .80, top: .03, right: .50 },
  { height: .94, aspect: .80, top: .03, right: .54 },
  { height: .94, aspect: .80, top: .03, right: .58 },
  { height: .92, aspect: .80, top: .04, right: .54 },
  { height: .96, aspect: .80, top: .02, right: .54 },
  { height: .94, aspect: .78, top: .03, right: .52 },
  { height: .94, aspect: .82, top: .03, right: .56 }
];
const WEEK_Y = [.594, .674, .754, .836, .916];
const WEEK_X = .846;
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

function normalizeTargetDate(value) {
  const text = String(value || '').trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(text)) throw new Error('invalidTargetDate');
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error('invalidTargetDate');
  return text;
}

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

export function inferStartSlotFromMappings(mappings) {
  const normalized = [];
  for (const mapping of mappings || []) {
    const values = Array.from({ length: 5 }, (_, index) => {
      const raw = String(mapping?.[index] || '').trim();
      if (!raw) return '';
      const value = raw.padStart(2, '0').slice(-2);
      return START_SLOTS.includes(value) ? value : '';
    });
    if (values.filter(Boolean).length >= 2) normalized.push(values);
  }
  if (!normalized.length) return null;

  const merged = Array(5).fill('');
  for (let index = 0; index < 5; index += 1) {
    const seen = [...new Set(normalized.map(values => values[index]).filter(Boolean))];
    if (seen.length === 1) merged[index] = seen[0];
  }
  if (merged.filter(Boolean).length >= 2) normalized.push(merged);

  let best = null;
  for (const mapped of normalized) {
    const observed = mapped.filter(Boolean).length;
    const matches = [];
    for (const startSlot of START_SLOTS) {
      const startIndex = START_SLOTS.indexOf(startSlot);
      const expected = Array.from({ length: 5 }, (_, index) => START_SLOTS[(startIndex + index) % START_SLOTS.length]);
      let mismatch = false;
      for (let index = 0; index < 5; index += 1) {
        if (mapped[index] && mapped[index] !== expected[index]) mismatch = true;
      }
      if (!mismatch) matches.push({ startSlot, expected });
    }
    if (matches.length !== 1) continue;
    const candidate = { ...matches[0], mapped, observed };
    if (!best || candidate.observed > best.observed) best = candidate;
  }
  return best;
}

function recoverDailyReview(result, targetDate) {
  if (result?.ready === true && result.interpretation?.ready === true && result.interpretation?.startSlot) return result;
  const attempts = result?.diagnostics?.ocrAttempts || [];
  let best = null;
  for (const attempt of attempts) {
    if (Number(attempt.highCount) !== 5 || Number(attempt.okCount) !== 5 || !Array.isArray(attempt.slots)) continue;
    const mappings = (attempt.ocr?.attempts || []).map(item => item.mapped).filter(Array.isArray);
    const inferred = inferStartSlotFromMappings(mappings);
    if (!inferred) continue;
    const minMargin = Math.min(...attempt.slots.map(slot => Number(slot.margin || 0)));
    const average = attempt.slots.reduce((sum, slot) => sum + Number(slot.bestScore || 0), 0) / attempt.slots.length;
    const candidate = { attempt, inferred, minMargin, average };
    if (!best || inferred.observed > best.inferred.observed ||
      (inferred.observed === best.inferred.observed && minMargin > best.minMargin) ||
      (inferred.observed === best.inferred.observed && minMargin === best.minMargin && average > best.average)) best = candidate;
  }
  if (!best) return result;
  const slots = best.attempt.slots.map((slot, index) => ({
    slot: `slot${index}`,
    visible: true,
    weather: [slot.value],
    confidence: 'high',
    description: `画像テンプレート判定 score=${Number(slot.bestScore).toFixed(3)} margin=${Number(slot.margin).toFixed(3)}`
  }));
  return {
    ...result,
    ready: true,
    interpretation: {
      ready: true,
      observedDate: targetDate,
      startSlot: best.inferred.startSlot,
      slots,
      confidence: 'high',
      summary: `投稿本文で${targetDate}を確認し、元画像の5枠をテンプレート照合。時刻ラベルは位置付きOCRで矛盾なく一致した${best.inferred.observed}枠から6時間刻みを確定。`,
      unresolved: []
    },
    diagnostics: { ...result.diagnostics, recoveredStartSlot: best.inferred }
  };
}

async function cropPanel(page, bytes, mimeType, variant) {
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const result = await page.evaluate(async ({ dataUrl, variant }) => {
    const image = await new Promise((resolve, reject) => {
      const item = new Image(); item.onload = () => resolve(item); item.onerror = reject; item.src = dataUrl;
    });
    const height = Math.round(image.naturalHeight * variant.height);
    const width = Math.round(height * variant.aspect);
    const x = Math.max(0, Math.min(image.naturalWidth - width, Math.round(image.naturalWidth - image.naturalWidth * variant.right - width)));
    const y = Math.max(0, Math.min(image.naturalHeight - height, Math.round(image.naturalHeight * variant.top)));
    if (width < 120 || height < 160 || x + width > image.naturalWidth || y + height > image.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(image, x, y, width, height, 0, 0, width, height);
    return { base64: canvas.toDataURL('image/jpeg', .94).split(',')[1], width, height, rect: { x, y, width, height } };
  }, { dataUrl, variant });
  return result ? { ...result, bytes: Buffer.from(result.base64, 'base64') } : null;
}

async function loadTemplateData(repoRoot) {
  const root = path.join(repoRoot, 'assets', 'weather-templates');
  const templates = [];
  for (const [weather, file] of TEMPLATE_FILES) {
    const bytes = await readFile(path.join(root, file));
    templates.push({ weather, file, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
  }
  return templates;
}

async function classifyWeekly(page, panelBytes, templates, targetDate) {
  const imageDataUrl = `data:image/jpeg;base64,${panelBytes.toString('base64')}`;
  const scores = await page.evaluate(async ({ imageDataUrl, templates, weekY, weekX }) => {
    const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload=()=>resolve(image); image.onerror=reject; image.src=src; });
    const [source, ...templateImages] = await Promise.all([load(imageDataUrl), ...templates.map(item => load(item.dataUrl))]);
    const rgbToHsv=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:max?d/max:0,v:max};};
    const signature=canvas=>{const ctx=canvas.getContext('2d',{willReadFrequently:true}),{width,height}=canvas,data=ctx.getImageData(0,0,width,height).data;const corner=[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>{const i=(y*width+x)*4;return[data[i],data[i+1],data[i+2]]});const bg=corner.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(v=>v/corner.length);const pixels=[],mask=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hsv=rgbToHsv(r,g,b),dist=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);mask.push(dist>=20||hsv.s>=.16?1:0);pixels.push([r,g,b]);}return{pixels,mask};};
    const similarity=(a,b)=>{let union=0,intersection=0,color=0,count=0;for(let i=0;i<a.mask.length;i++){if(a.mask[i]||b.mask[i])union++;if(a.mask[i]&&b.mask[i]){intersection++;const pa=a.pixels[i],pb=b.pixels[i],diff=(Math.abs(pa[0]-pb[0])+Math.abs(pa[1]-pb[1])+Math.abs(pa[2]-pb[2]))/765;color+=1-diff;count++;}}return(union?intersection/union:0)*.42+(count?color/count:0)*.58;};
    const prepared=templates.map((item,index)=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=56;canvas.getContext('2d').drawImage(templateImages[index],0,0,56,56);return{weather:item.weather,file:item.file,sig:signature(canvas)};});
    return weekY.map(centerY=>{
      const size=Math.max(18,Math.round(source.naturalWidth*.105));
      const sx=Math.max(0,Math.min(source.naturalWidth-size,Math.round(source.naturalWidth*weekX-size/2)));
      const sy=Math.max(0,Math.min(source.naturalHeight-size,Math.round(source.naturalHeight*centerY-size/2)));
      const canvas=document.createElement('canvas');canvas.width=canvas.height=56;canvas.getContext('2d').drawImage(source,sx,sy,size,size,0,0,56,56);
      const sig=signature(canvas);
      const byWeather=new Map();
      for(const template of prepared){const value=similarity(sig,template.sig);byWeather.set(template.weather,Math.max(value,byWeather.get(template.weather)||0));}
      const ranked=[...byWeather.entries()].sort((a,b)=>b[1]-a[1]);
      const [bestValue,bestScore]=ranked[0]||['',0],[secondValue,secondScore]=ranked[1]||['',0];
      return{bestValue,bestScore,secondValue,secondScore,margin:bestScore-secondScore,box:{x:sx,y:sy,size}};
    });
  }, { imageDataUrl, templates, weekY: WEEK_Y, weekX: WEEK_X });

  const days = scores.map((score, index) => {
    const high = score.bestScore >= .62 && score.margin >= .045;
    return {
      date: addDays(targetDate, index + 1),
      weather: high ? [score.bestValue] : [],
      visible: true,
      confidence: high ? 'high' : 'low',
      description: `週間アイコン照合 score=${score.bestScore.toFixed(3)} margin=${score.margin.toFixed(3)}`
    };
  });
  return { ready: days.every(day => day.confidence === 'high' && day.weather.length === 1), days, scores };
}

async function inspectUnifiedCapture({ captureDir, targetDate, repoRoot }) {
  targetDate = normalizeTargetDate(targetDate);
  repoRoot = path.resolve(repoRoot || '.');
  const capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8'));
  const postFile = capture.postContent?.file || 'post-content.txt';
  const postText = await readFile(path.join(captureDir, postFile), 'utf8');
  const baseline = await inspectCapture({ captureDir, targetDate, repoRoot });
  if (capture?.status !== 'captured' || !Array.isArray(capture.rawMedia) || !capture.rawMedia.length) return baseline;

  const templates = await loadTemplateData(repoRoot);
  const browser = await chromium.launch({ headless: true });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'heartopia-weather-unified-'));
  const diagnostics = [];
  try {
    const page = await browser.newPage();
    for (const media of capture.rawMedia.slice(0, 6)) {
      const originalPath = path.join(captureDir, String(media.file || ''));
      let originalBytes;
      try { originalBytes = await readFile(originalPath); } catch { continue; }
      let originalMime;
      try { originalMime = mimeFromBytes(originalBytes); } catch { continue; }
      if (originalMime !== media.mimeType || sha256(originalBytes) !== media.sha256) continue;

      for (let variantIndex = 0; variantIndex < PANEL_VARIANTS.length; variantIndex += 1) {
        const crop = await cropPanel(page, originalBytes, originalMime, PANEL_VARIANTS[variantIndex]);
        if (!crop) continue;
        const workDir = path.join(tempRoot, `${String(media.file).replace(/[^A-Za-z0-9._-]/g,'_')}-${variantIndex}`);
        await mkdir(workDir, { recursive: true });
        const cropFile = 'raw-media-0.jpg';
        await writeFile(path.join(workDir, cropFile), crop.bytes);
        await writeFile(path.join(workDir, 'post-content.txt'), postText, 'utf8');
        const cropSha = sha256(crop.bytes);
        const synthetic = {
          status: 'captured',
          sourceUrl: capture.sourceUrl,
          finalUrl: capture.finalUrl || capture.sourceUrl,
          sourceType: capture.sourceType,
          sourceId: capture.sourceId,
          capturedAt: capture.capturedAt,
          postContent: { file: 'post-content.txt' },
          rawMedia: [{ url: media.url, file: cropFile, mimeType: 'image/jpeg', byteSize: crop.bytes.length, sha256: cropSha }],
          evidence: { file: cropFile, mimeType: 'image/jpeg', byteSize: crop.bytes.length, sha256: cropSha, kind: 'screenshot', capturedAt: capture.capturedAt }
        };
        await writeFile(path.join(workDir, 'capture.json'), `${JSON.stringify(synthetic, null, 2)}\n`, 'utf8');
        let daily = await inspectCapture({ captureDir: workDir, targetDate, repoRoot });
        daily = recoverDailyReview(daily, targetDate);
        const weekly = await classifyWeekly(page, crop.bytes, templates, targetDate);
        diagnostics.push({ file: media.file, variantIndex, cropRect: crop.rect, dailyReady: daily.ready, weeklyReady: weekly.ready, dailyDiagnostics: daily.diagnostics, weeklyScores: weekly.scores });
        if (!daily.ready || !weekly.ready) continue;

        const interpretation = {
          ...daily.interpretation,
          weeklyDays: weekly.days,
          summary: `${daily.interpretation.summary} 同じ元画像の週間欄から翌日以降5日分もテンプレート照合で判読。`
        };
        return {
          schemaVersion: 2,
          ready: true,
          targetDate,
          selectedImage: { file: media.file, mimeType: media.mimeType, captureSha256: media.sha256 },
          interpretation,
          diagnostics: { mode: 'unified-panel-search', selectedOriginal: media.file, selectedCrop: crop.rect, attempts: diagnostics }
        };
      }
    }
  } finally {
    await browser.close();
    await rm(tempRoot, { recursive: true, force: true });
  }

  return {
    ...baseline,
    schemaVersion: 2,
    ready: false,
    interpretation: {
      ...(baseline.interpretation || {}),
      ready: false,
      weeklyDays: [],
      confidence: 'low',
      summary: 'デイリー5枠と週間5日を同じ公開証拠から高確信度で確定できませんでした。',
      unresolved: ['デイリー5枠・開始時刻・週間5日の全条件を満たす公開証拠がありません']
    },
    diagnostics: { baseline: baseline.diagnostics, unifiedAttempts: diagnostics }
  };
}

export function bindUnifiedReviewEnvelope(draft, artifact) {
  if (!draft?.ready || !Array.isArray(draft.interpretation?.weeklyDays) || draft.interpretation.weeklyDays.length < 5) throw new Error('unifiedReviewNotReady');
  return bindReviewEnvelope(draft, artifact);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('invalidArguments');
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'inspect') {
    if (!args['capture-dir'] || !args['target-date'] || !args.output) throw new Error('invalidArguments');
    const result = await inspectUnifiedCapture({ captureDir: path.resolve(args['capture-dir']), targetDate: args['target-date'], repoRoot: path.resolve(args['repo-root'] || '.') });
    await writeFile(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ready: result.ready, selectedImage: result.selectedImage?.file || '', startSlot: result.interpretation?.startSlot || '', weeklyCount: result.interpretation?.weeklyDays?.length || 0 })}\n`);
    if (!result.ready) process.exitCode = 2;
    return;
  }
  if (args.mode === 'bind') {
    if (!args.draft || !args.output || !args['artifact-run-id'] || !args['artifact-id'] || !args['artifact-name']) throw new Error('invalidArguments');
    const draft = JSON.parse(await readFile(path.resolve(args.draft), 'utf8'));
    const envelope = bindUnifiedReviewEnvelope(draft, { runId: args['artifact-run-id'], id: args['artifact-id'], name: args['artifact-name'] });
    const base64 = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    await writeFile(path.resolve(args.output), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `review_payload_base64=${base64}\n`, { encoding: 'utf8', flag: 'a' });
    process.stdout.write(`${JSON.stringify({ ready: true, artifactId: envelope.artifact.id, pendingEvidenceFile: envelope.pendingEvidenceFile, weeklyCount: envelope.interpretation.weeklyDays.length })}\n`);
    return;
  }
  throw new Error('invalidArguments');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`Unified weather review failed: ${error.message}\n`); process.exitCode = 1; });
}
