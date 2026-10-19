import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bindReviewEnvelope, buildPanelCandidates, extractPostDates, postConfirmsTargetDate } from './weather-deterministic-review.mjs';

// Geometry regression coverage for the 16:9 game screenshot evidence shape.
test('extracts Heartopia post dates in Japanese and numeric forms', () => {
  const text = 'ハートピア 2026年9月14日 / 午前10:10 · 2026/09/14';
  assert.deepEqual(extractPostDates(text), ['2026-09-14']);
  assert.equal(postConfirmsTargetDate(text, '2026-09-14'), true);
  assert.equal(postConfirmsTargetDate(text, '2026-09-15'), false);
});

test('forecast heading wins over publication timestamps and weekly dates', () => {
  const text='10/17(土)\nハートピア お天気予報\n00:00〜翌05:59 晴れ\n午前1:10 · 2026年10月18日';
  assert.equal(postConfirmsTargetDate(text,'2026-10-17'),true);
  assert.equal(postConfirmsTargetDate(text,'2026-10-18'),false);
  assert.equal(postConfirmsTargetDate('天気予報\n午前1:10 · 2026年10月18日','2026-10-18'),false);
  assert.equal(postConfirmsTargetDate('2026/10/17 天気\n週間予報 2026/10/18 晴れ','2026-10-18'),false);
  assert.equal(postConfirmsTargetDate('1/1 天気\n午後11:00 · 2026年12月31日','2027-01-01'),true);
});

test('the same X post cannot be submitted for a different day under another URL spelling', () => {
  const api=fs.readFileSync(new URL('../apps-script/weather-api.gs',import.meta.url),'utf8');
  const c=vm.createContext({formatDateValue:v=>v,weatherSubmitFailure_:code=>new Error(code)});
  vm.runInContext(api.slice(api.indexOf('function rejectReusedWeatherPost_'),api.indexOf('function evidenceHash_')),c);
  const rows=[['date','sourceUrl'],['2026-10-17','https://x.com/author/status/2111557865853100069?s=20']];
  assert.throws(()=>c.rejectReusedWeatherPost_(rows,rows[0],'2026-10-18','https://x.com/i/status/2111557865853100069'),/invalidEvidencePayload/);
  assert.doesNotThrow(()=>c.rejectReusedWeatherPost_(rows,rows[0],'2026-10-17','https://x.com/i/status/2111557865853100069'));
  assert.doesNotThrow(()=>c.rejectReusedWeatherPost_(rows,rows[0],'2026-10-18','https://example.com/forecast'));
});

test('builds bounded right-side weather panel candidates for a landscape screenshot', () => {
  const candidates = buildPanelCandidates(680, 383);
  assert.ok(candidates.length >= 40);
  assert.ok(candidates.every(item => item.x >= 0 && item.y >= 0 && item.x + item.w <= 680 && item.y + item.h <= 383));
  assert.ok(candidates.some(item => item.x >= 380 && item.x <= 450 && item.y >= 20 && item.y <= 60));
});

test('binds a ready deterministic review to immutable artifact ids', () => {
  const draft = {
    ready: true,
    selectedImage: { file:'raw-media-1.jpg', mimeType:'image/jpeg', captureSha256:'a'.repeat(64) },
    interpretation: {
      ready:true, observedDate:'2026-09-14', startSlot:'06',
      slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:true,weather:['晴'],confidence:'high',description:'visible'})),
      confidence:'high', summary:'verified', unresolved:[]
    }
  };
  const envelope = bindReviewEnvelope(draft, { runId:'123', id:'456', name:'weather-evidence-123' });
  assert.equal(envelope.schemaVersion, 4);
  assert.equal(envelope.artifact.id, '456');
  assert.equal(envelope.pendingEvidenceFile, 'raw-media-1.jpg');
  assert.deepEqual(envelope.reviewedImages, [draft.selectedImage]);
});
