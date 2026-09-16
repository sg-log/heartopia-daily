import test from 'node:test';
import assert from 'node:assert/strict';
import { bindReviewEnvelope, buildPanelCandidates, extractPostDates, postConfirmsTargetDate } from './weather-deterministic-review.mjs';

test('extracts Heartopia post dates in Japanese and numeric forms', () => {
  const text = 'ハートピア 2026年9月14日 / 午前10:10 · 2026/09/14';
  assert.deepEqual(extractPostDates(text), ['2026-09-14']);
  assert.equal(postConfirmsTargetDate(text, '2026-09-14'), true);
  assert.equal(postConfirmsTargetDate(text, '2026-09-15'), false);
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
