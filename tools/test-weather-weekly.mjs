import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateWeeklyReviewRecord, parseWeeklyReviewIssue, WEEKLY_REVIEW_MARKER } from './weather-weekly-review.mjs';
import { prepareWeeklyPendingPreview } from './weather-weekly-pending.mjs';
import { chooseApprovedBaseline, buildWeeklySubmitPayload, reportMatchesPayload } from './weather-weekly-submit.mjs';

function reviewFixture(sha) {
  return {
    schemaVersion:1, responseType:'weather-weekly-review',
    artifact:{runId:'123',id:'456',name:'heartopia-weather-evidence-123'},
    selectedReviewImage:{
      file:'raw-media-0.jpg', mimeType:'image/jpeg', captureSha256:sha, reviewStoredSha256:sha,
      reviewUrl:`https://script.google.com/macros/s/${'a'.repeat(43)}/exec?reviewToken=${'b'.repeat(43)}`,
      expiresAt:'2026-09-16T12:00:00Z'
    },
    interpretation:{
      ready:true, baseDate:'2026-09-16', confidence:'high', summary:'翌日から7日後まで全枠を画像で確認。', unresolved:[],
      days:Array.from({length:7},(_,i)=>({
        date:`2026-09-${String(17+i).padStart(2,'0')}`, weather:[i%2?'雨':'晴'], visible:true, confidence:'high', description:`${i+1}日目の天気アイコンを確認`
      }))
    }
  };
}

test('validates strict seven-day dates and owner issue envelope', () => {
  const sha='a'.repeat(64); const review=reviewFixture(sha);
  const normalized=validateWeeklyReviewRecord(review);
  assert.equal(normalized.interpretation.days.length,7);
  const event={issue:{number:99,title:'[weather-weekly-review-result]',user:{login:'sg-log'},body:`${WEEKLY_REVIEW_MARKER}\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\``}};
  assert.equal(parseWeeklyReviewIssue(event).issueNumber,99);
});

test('rejects weekday/date inference and incomplete weather', () => {
  const review=reviewFixture('a'.repeat(64));
  review.interpretation.days[2].date='2026-09-21';
  assert.throws(()=>validateWeeklyReviewRecord(review),/must be 2026-09-19/);
  review.interpretation.days[2].date='2026-09-19';
  review.interpretation.days[4].weather=[];
  assert.throws(()=>validateWeeklyReviewRecord(review),/1\-4 values/);
});

test('prepares weekly payload only when selected raw media matches capture bytes', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-weather-'));
  const dir=path.join(root,'artifact'); fs.mkdirSync(dir,{recursive:true});
  const bytes=Buffer.from([0xff,0xd8,0xff,0xdb,1,2,3,4,5]);
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(dir,'raw-media-0.jpg'),bytes);
  fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify({
    status:'captured', capturedAt:'2026-09-16T00:00:00Z', evidence:{capturedAt:'2026-09-16T00:00:00Z'},
    rawMedia:[{file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:sha,byteSize:bytes.length,url:'https://pbs.twimg.com/media/test.jpg'}]
  }));
  fs.writeFileSync(path.join(dir,'discovery-candidate.json'),JSON.stringify({
    retrievalStatus:'confirmed', sourceUrl:'https://x.com/example/status/1', sourceType:'x-official-embed',
    retrievalHistory:[{retrievedAt:'2026-09-16T00:00:00Z',retrievedUrl:'https://x.com/example/status/1'}]
  }));
  const review=reviewFixture(sha);
  const preview=prepareWeeklyPendingPreview({review,artifactDirectory:root,downloadedArtifact:review.artifact});
  assert.equal(preview.baseDate,'2026-09-16');
  assert.deepEqual(preview.weeks.week1,['晴']);
  assert.equal(preview.evidence.sha256,sha);
});

test('inherits approved hourly baseline and keeps reviewed weeks', () => {
  const reports=[{date:'2026-09-16',startSlot:'06',slots:{slot0:['晴'],slot1:['雨'],slot2:['晴'],slot3:['晴'],slot4:['雨']}}];
  const baseline=chooseApprovedBaseline(reports,'2026-09-16');
  const bytes=Buffer.from([0xff,0xd8,0xff,1]);
  const preview={status:'prepared',baseDate:'2026-09-16',weeks:Object.fromEntries(Array.from({length:7},(_,i)=>[`week${i+1}`,['晴']])),summary:'7日分確認',sourceUrl:'https://x.com/example/status/1',sourceImageUrls:[],sourceType:'x-official-embed',retrievedAt:'2026-09-16T00:00:00Z',evidence:{mimeType:'image/jpeg',byteSize:bytes.length,sha256:'b'.repeat(64),kind:'original',capturedAt:'2026-09-16T00:00:00Z'}};
  const payload=buildWeeklySubmitPayload(preview,baseline,bytes);
  assert.deepEqual(payload.slots.slot1,['雨']);
  assert.deepEqual(payload.weeks.week7,['晴']);
  assert.equal(reportMatchesPayload({...payload,id:'p1'},payload),true);
});

test('refuses weekly pending when the same-date approved hourly baseline is absent', () => {
  assert.throws(()=>chooseApprovedBaseline([], '2026-09-16'),/No approved hourly weather/);
});
