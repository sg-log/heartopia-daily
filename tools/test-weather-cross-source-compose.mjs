import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { composeCrossSourceEvidence } from './weather-cross-source-compose.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQMcAAAAASUVORK5CYII=', 'base64');
const SHA = createHash('sha256').update(PNG).digest('hex');

function day(date, weather='晴') {
  return { date, weather:[weather], visible:true, confidence:'high', description:'test' };
}

test('composes separate daily and weekly evidence into one reviewable artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'heartopia-cross-source-'));
  try {
    const dailyDir=path.join(root,'daily'), weeklyDir=path.join(root,'weekly'), outDir=path.join(root,'out');
    await Promise.all([mkdir(dailyDir),mkdir(weeklyDir)]);
    await writeFile(path.join(dailyDir,'daily.png'),PNG);
    await writeFile(path.join(weeklyDir,'weekly.png'),PNG);
    const dailyCapture={status:'captured',sourceUrl:'https://x.com/i/status/1',finalUrl:'https://x.com/i/status/1',sourceType:'x',sourceId:'1',capturedAt:'2026-09-22T00:00:00Z'};
    const weeklyCapture={status:'captured',sourceUrl:'https://x.com/i/status/2',finalUrl:'https://x.com/i/status/2',sourceType:'x',sourceId:'2',capturedAt:'2026-09-22T00:01:00Z'};
    await writeFile(path.join(dailyDir,'capture.json'),JSON.stringify(dailyCapture));
    await writeFile(path.join(weeklyDir,'capture.json'),JSON.stringify(weeklyCapture));
    await writeFile(path.join(dailyDir,'discovery-candidate.json'),JSON.stringify({sourceUrl:dailyCapture.sourceUrl,retrievalStatus:'confirmed',retrievalHistory:[{retrievedAt:'2026-09-22T00:00:00Z',retrievedUrl:dailyCapture.sourceUrl}]}));
    const dailyReview={
      ready:true,targetDate:'2026-09-22',selectedImage:{file:'daily.png',mimeType:'image/png',captureSha256:SHA},
      interpretation:{ready:true,observedDate:'2026-09-22',startSlot:'06',slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:true,weather:['晴'],confidence:'high',description:'test'})),weeklyDays:[],confidence:'high',summary:'daily',unresolved:[]}
    };
    const weeklyReview={
      ready:true,targetDate:'2026-09-22',selectedImage:{file:'weekly.png',mimeType:'image/png',captureSha256:SHA},
      interpretation:{ready:true,baseDate:'2026-09-22',days:[
        day('2026-09-23'),day('2026-09-24'),day('2026-09-25'),day('2026-09-26'),day('2026-09-27')
      ],confidence:'high',summary:'weekly',unresolved:[]}
    };
    const dailyReviewPath=path.join(root,'daily-review.json'), weeklyReviewPath=path.join(root,'weekly-review.json');
    await writeFile(dailyReviewPath,JSON.stringify(dailyReview));
    await writeFile(weeklyReviewPath,JSON.stringify(weeklyReview));
    const result=await composeCrossSourceEvidence({dailyDir,dailyReviewPath,weeklyDir,weeklyReviewPath,outputDir:outDir,targetDate:'2026-09-22'});
    assert.equal(result.ready,true);
    assert.equal(result.weeklyCount,5);
    assert.equal(result.weeklySourceUrl,weeklyCapture.sourceUrl);
    const review=JSON.parse(await readFile(path.join(outDir,'review.json'),'utf8'));
    assert.equal(review.sources.daily.sourceUrl,dailyCapture.sourceUrl);
    assert.equal(review.sources.weekly.sourceUrl,weeklyCapture.sourceUrl);
    assert.equal(review.interpretation.weeklyDays.length,5);
    const capture=JSON.parse(await readFile(path.join(outDir,'capture.json'),'utf8'));
    assert.equal(capture.rawMedia.length,3);
    assert.equal(capture.evidence.file,'combined-evidence.jpg');
    assert.ok(capture.evidence.byteSize > 0 && capture.evidence.byteSize <= 500000);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
