import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}
function extFor(mime) { return mime === 'image/png' ? '.png' : '.jpg'; }
function parseArgs(argv) {
  const out = {};
  for (let i=0;i<argv.length;i+=2) {
    if (!argv[i]?.startsWith('--') || argv[i+1] === undefined) throw new Error('invalidArguments');
    out[argv[i].slice(2)] = argv[i+1];
  }
  return out;
}
async function loadVerifiedSelected(dir, review) {
  const selected = review?.selectedImage;
  if (!selected?.file || !selected?.captureSha256 || !selected?.mimeType) throw new Error('selectedImageMissing');
  const filePath = path.join(dir, selected.file);
  const bytes = await readFile(filePath);
  const mimeType = mimeFromBytes(bytes);
  const digest = sha256(bytes);
  if (mimeType !== selected.mimeType || digest !== selected.captureSha256) throw new Error('selectedImageBindingMismatch');
  return { filePath, bytes, mimeType, sha256:digest, byteSize:bytes.length };
}
async function writeComposite(daily, weekly, outputPath) {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:900, height:5200 }, deviceScaleFactor:1 });
    const dailyData = `data:${daily.mimeType};base64,${daily.bytes.toString('base64')}`;
    const weeklyData = `data:${weekly.mimeType};base64,${weekly.bytes.toString('base64')}`;
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff;font-family:Arial,sans-serif}
      main{width:820px;padding:20px;box-sizing:border-box}
      section{margin:0 0 18px}
      h2{margin:0 0 8px;font-size:22px}
      img{display:block;max-width:780px;width:auto;height:auto}
    </style><main>
      <section><h2>DAILY</h2><img id="daily" src="${dailyData}"></section>
      <section><h2>WEEKLY</h2><img id="weekly" src="${weeklyData}"></section>
    </main>`);
    await Promise.all([
      page.locator('#daily').waitFor({state:'visible'}),
      page.locator('#weekly').waitFor({state:'visible'})
    ]);
    const main = page.locator('main');
    for (const quality of [88,80,72,64]) {
      await main.screenshot({ path:outputPath, type:'jpeg', quality, animations:'disabled' });
      const bytes = await readFile(outputPath);
      if (bytes.length <= 500000) return bytes;
    }
    throw new Error('compositeEvidenceTooLarge');
  } finally {
    await browser.close();
  }
}

export async function composeCrossSourceEvidence({ dailyDir, dailyReviewPath, weeklyDir, weeklyReviewPath, outputDir, targetDate }) {
  await mkdir(outputDir,{recursive:true});
  const dailyReview = JSON.parse(await readFile(dailyReviewPath,'utf8'));
  const weeklyReview = JSON.parse(await readFile(weeklyReviewPath,'utf8'));
  if (!dailyReview?.ready || dailyReview?.interpretation?.ready !== true) throw new Error('dailyReviewNotReady');
  if (!weeklyReview?.ready || weeklyReview?.interpretation?.ready !== true) throw new Error('weeklyReviewNotReady');
  if (String(dailyReview.targetDate || '') !== targetDate || String(dailyReview.interpretation.observedDate || '') !== targetDate) throw new Error('dailyDateMismatch');
  if (String(weeklyReview.targetDate || '') !== targetDate) throw new Error('weeklyDateMismatch');
  const weeklyDays = Array.isArray(weeklyReview.interpretation.days) ? weeklyReview.interpretation.days : [];
  if (weeklyDays.length < 5 || weeklyDays.length > 7 || weeklyDays.some(day => day.visible !== true || day.confidence !== 'high' || !Array.isArray(day.weather) || !day.weather.length)) throw new Error('weeklyDaysNotReady');

  const dailyCapture = JSON.parse(await readFile(path.join(dailyDir,'capture.json'),'utf8'));
  const weeklyCapture = JSON.parse(await readFile(path.join(weeklyDir,'capture.json'),'utf8'));
  const daily = await loadVerifiedSelected(dailyDir,dailyReview);
  const weekly = await loadVerifiedSelected(weeklyDir,weeklyReview);

  const dailyName = 'daily-source' + extFor(daily.mimeType);
  const weeklyName = 'weekly-source' + extFor(weekly.mimeType);
  await copyFile(daily.filePath,path.join(outputDir,dailyName));
  await copyFile(weekly.filePath,path.join(outputDir,weeklyName));

  const compositeName = 'combined-evidence.jpg';
  const compositePath = path.join(outputDir,compositeName);
  const compositeBytes = await writeComposite(daily,weekly,compositePath);
  const compositeSha = sha256(compositeBytes);

  const dailyDiscovery = JSON.parse(await readFile(path.join(dailyDir,'discovery-candidate.json'),'utf8'));
  await writeFile(path.join(outputDir,'discovery-candidate.json'), JSON.stringify(dailyDiscovery,null,2)+'\n','utf8');
  await writeFile(path.join(outputDir,'post-content.txt'), `Cross-source verified weather evidence for ${targetDate}.\nDAILY: ${dailyCapture.sourceUrl}\nWEEKLY: ${weeklyCapture.sourceUrl}\n`, 'utf8');

  const capturedAt = [dailyCapture.capturedAt,weeklyCapture.capturedAt].filter(Boolean).sort().at(-1) || new Date().toISOString();
  const capture = {
    status:'captured',
    adapter:'cross-source-composite',
    sourceUrl:dailyCapture.sourceUrl,
    finalUrl:dailyCapture.finalUrl || dailyCapture.sourceUrl,
    sourceType:dailyCapture.sourceType,
    sourceId:dailyCapture.sourceId || null,
    capturedAt,
    postContent:{file:'post-content.txt'},
    rawMedia:[
      {file:dailyName,mimeType:daily.mimeType,byteSize:daily.byteSize,sha256:daily.sha256,sourceScope:'cross-source-daily'},
      {file:weeklyName,mimeType:weekly.mimeType,byteSize:weekly.byteSize,sha256:weekly.sha256,sourceScope:'cross-source-weekly'},
      {file:compositeName,mimeType:'image/jpeg',byteSize:compositeBytes.length,sha256:compositeSha,sourceScope:'cross-source-composite'}
    ],
    evidence:{file:compositeName,mimeType:'image/jpeg',byteSize:compositeBytes.length,sha256:compositeSha,kind:'screenshot',capturedAt}
  };
  await writeFile(path.join(outputDir,'capture.json'),JSON.stringify(capture,null,2)+'\n','utf8');

  const review = {
    schemaVersion:2,
    ready:true,
    targetDate,
    selectedImage:{file:compositeName,mimeType:'image/jpeg',captureSha256:compositeSha},
    pendingEvidenceFile:compositeName,
    interpretation:{
      ...dailyReview.interpretation,
      weeklyDays,
      confidence:'high',
      summary:`デイリーと週間を別の公開ゲーム内UI画像から判読し、対象日 ${targetDate} で統合。`,
      unresolved:[]
    },
    sources:{
      daily:{sourceUrl:String(dailyCapture.sourceUrl || '')},
      weekly:{sourceUrl:String(weeklyCapture.sourceUrl || '')}
    },
    diagnostics:{mode:'cross-source-daily-weekly'}
  };
  await writeFile(path.join(outputDir,'review.json'),JSON.stringify(review,null,2)+'\n','utf8');
  return {ready:true,reviewPath:path.join(outputDir,'review.json'),sourceUrl:dailyCapture.sourceUrl,weeklySourceUrl:weeklyCapture.sourceUrl,weeklyCount:weeklyDays.length,compositeSha256:compositeSha};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args=parseArgs(process.argv.slice(2));
  const required=['daily-dir','daily-review','weekly-dir','weekly-review','output-dir','target-date'];
  if(required.some(key=>!args[key])) throw new Error('invalidArguments');
  composeCrossSourceEvidence({
    dailyDir:path.resolve(args['daily-dir']),
    dailyReviewPath:path.resolve(args['daily-review']),
    weeklyDir:path.resolve(args['weekly-dir']),
    weeklyReviewPath:path.resolve(args['weekly-review']),
    outputDir:path.resolve(args['output-dir']),
    targetDate:args['target-date']
  }).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(`Cross-source compose failed: ${error.message}\n`);process.exitCode=1;});
}
