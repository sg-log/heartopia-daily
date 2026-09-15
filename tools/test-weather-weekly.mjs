import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateWeeklyReviewRecord, parseWeeklyReviewIssue, WEEKLY_REVIEW_MARKER } from './weather-weekly-review.mjs';
import { prepareWeeklyPendingPreview } from './weather-weekly-pending.mjs';
import { chooseApprovedBaseline, buildWeeklySubmitPayload, reportMatchesPayload } from './weather-weekly-submit.mjs';

function reviewFixture(baseSha, forecastSha, dayCount = 5) {
  return {
    schemaVersion:1, responseType:'weather-weekly-review',
    artifact:{runId:'123',id:'456',name:'weather-x-embed-evidence-123'},
    selectedReviewImages:[
      {
        role:'base-date', file:'raw-media-0.jpg', mimeType:'image/jpeg', captureSha256:baseSha, reviewStoredSha256:baseSha,
        reviewUrl:`https://script.google.com/macros/s/${'a'.repeat(43)}/exec?reviewToken=${'b'.repeat(43)}`,
        expiresAt:'2099-09-16T12:00:00Z'
      },
      {
        role:'weekly-forecast', file:'raw-media-1.jpg', mimeType:'image/jpeg', captureSha256:forecastSha, reviewStoredSha256:forecastSha,
        reviewUrl:`https://script.google.com/macros/s/${'c'.repeat(43)}/exec?reviewToken=${'d'.repeat(43)}`,
        expiresAt:'2099-09-16T12:00:00Z'
      }
    ],
    interpretation:{
      ready:true, baseDate:'2026-09-16', baseDateDescription:'別画像の日付欄で2026/09/16を確認',
      confidence:'high', summary:`翌日から${dayCount}日分を画像で確認。`, unresolved:[],
      days:Array.from({length:dayCount},(_,i)=>({
        date:`2026-09-${String(17+i).padStart(2,'0')}`, weather:[i%2?'雨':'晴'], visible:true, confidence:'high', description:`${i+1}日目の天気アイコンを確認`
      }))
    }
  };
}

test('accepts five visible days across separate date and forecast images', () => {
  const review=reviewFixture('a'.repeat(64),'b'.repeat(64),5);
  const normalized=validateWeeklyReviewRecord(review);
  assert.equal(normalized.interpretation.days.length,5);
  const event={issue:{number:99,title:'[weather-weekly-review-result]',user:{login:'sg-log'},body:`${WEEKLY_REVIEW_MARKER}\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\``}};
  assert.equal(parseWeeklyReviewIssue(event).issueNumber,99);
});

test('rejects date gaps, incomplete weather, and fewer than five days', () => {
  const review=reviewFixture('a'.repeat(64),'b'.repeat(64),5);
  review.interpretation.days[2].date='2026-09-21';
  assert.throws(()=>validateWeeklyReviewRecord(review),/must be 2026-09-19/);
  review.interpretation.days[2].date='2026-09-19';
  review.interpretation.days[4].weather=[];
  assert.throws(()=>validateWeeklyReviewRecord(review),/1\-4 values/);
  const tooShort=reviewFixture('a'.repeat(64),'b'.repeat(64),4);
  assert.throws(()=>validateWeeklyReviewRecord(tooShort),/Five to seven/);
});

test('prepares a multi-image weekly preview and leaves unseen trailing days empty', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-weather-'));
  const dir=path.join(root,'artifact'); fs.mkdirSync(dir,{recursive:true});
  const baseBytes=Buffer.from([0xff,0xd8,0xff,0xdb,1,2,3,4,0xff,0xd9]);
  const forecastBytes=Buffer.from([0xff,0xd8,0xff,0xdb,5,6,7,8,0xff,0xd9]);
  const baseSha=crypto.createHash('sha256').update(baseBytes).digest('hex');
  const forecastSha=crypto.createHash('sha256').update(forecastBytes).digest('hex');
  fs.writeFileSync(path.join(dir,'raw-media-0.jpg'),baseBytes);
  fs.writeFileSync(path.join(dir,'raw-media-1.jpg'),forecastBytes);
  fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify({
    status:'captured', capturedAt:'2026-09-16T00:00:00Z', evidence:{capturedAt:'2026-09-16T00:00:00Z'},
    rawMedia:[
      {file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:baseSha,byteSize:baseBytes.length,url:'https://pbs.twimg.com/media/base.jpg'},
      {file:'raw-media-1.jpg',mimeType:'image/jpeg',sha256:forecastSha,byteSize:forecastBytes.length,url:'https://pbs.twimg.com/media/forecast.jpg'}
    ]
  }));
  fs.writeFileSync(path.join(dir,'discovery-candidate.json'),JSON.stringify({
    retrievalStatus:'confirmed', sourceUrl:'https://x.com/example/status/1', sourceType:'x-official-embed',
    retrievalHistory:[{retrievedAt:'2026-09-16T00:00:00Z',retrievedUrl:'https://x.com/example/status/1'}]
  }));
  const review=reviewFixture(baseSha,forecastSha,5);
  const preview=prepareWeeklyPendingPreview({review,artifactDirectory:root,downloadedArtifact:review.artifact});
  assert.equal(preview.baseDate,'2026-09-16');
  assert.equal(preview.visibleWeekCount,5);
  assert.deepEqual(preview.weeks.week1,['晴']);
  assert.deepEqual(preview.weeks.week6,[]);
  assert.deepEqual(preview.weeks.week7,[]);
  assert.equal(preview.evidence.sha256,forecastSha);
  assert.equal(preview.sourceImageUrls.length,2);
  assert.equal(preview.reviewerBinding.allReviewedImages.length,2);
});

test('inherits approved hourly baseline and saves only visible consecutive weekly days', () => {
  const reports=[{date:'2026-09-16',startSlot:'06',slots:{slot0:['晴'],slot1:['雨'],slot2:['晴'],slot3:['晴'],slot4:['雨']}}];
  const baseline=chooseApprovedBaseline(reports,'2026-09-16');
  const bytes=Buffer.from([0xff,0xd8,0xff,1]);
  const weeks={week1:['晴'],week2:['雨'],week3:['晴'],week4:['晴'],week5:['雨'],week6:[],week7:[]};
  const preview={status:'prepared',baseDate:'2026-09-16',visibleWeekCount:5,weeks,summary:'5日分確認',sourceUrl:'https://x.com/example/status/1',sourceImageUrls:[],sourceType:'x-official-embed',retrievedAt:'2026-09-16T00:00:00Z',evidence:{mimeType:'image/jpeg',byteSize:bytes.length,sha256:'b'.repeat(64),kind:'original',capturedAt:'2026-09-16T00:00:00Z'}};
  const payload=buildWeeklySubmitPayload(preview,baseline,bytes);
  assert.deepEqual(payload.slots.slot1,['雨']);
  assert.deepEqual(payload.weeks.week5,['雨']);
  assert.deepEqual(payload.weeks.week6,[]);
  assert.equal(reportMatchesPayload({...payload,id:'p1'},payload),true);
});

test('refuses weekly pending when the same-date approved hourly baseline is absent', () => {
  assert.throws(()=>chooseApprovedBaseline([], '2026-09-16'),/No approved hourly weather/);
});
