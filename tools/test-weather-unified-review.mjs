import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combineDailyWeeklyReviews,
  inferStartSlotFromMappings,
  extractTimedMeteorIntervals,
  extractFullDayStartSlotHint,
  applyTimedSpecialWeatherHints,
  recoverDailyImageFirstWithTextStart
} from './weather-unified-review.mjs';

test('recovers a unique 06 start from two positioned labels without guessing weather', () => {
  const result = inferStartSlotFromMappings([
    ['06', '', '', '00', ''],
    ['', '', '', '00', '06']
  ]);
  assert.equal(result?.startSlot, '06');
  assert.deepEqual(result?.expected, ['06', '12', '18', '00', '06']);
  assert.ok(result.observed >= 2);
});

test('does not recover a start slot from one label', () => {
  assert.equal(inferStartSlotFromMappings([['', '', '18', '', '']]), null);
});

test('rejects conflicting positioned labels rather than forcing a sequence', () => {
  const result = inferStartSlotFromMappings([
    ['06', '', '', '18', ''],
    ['', '12', '', '', '']
  ]);
  assert.equal(result, null);
});

test('extracts only a full-day start slot from the target-date text block', () => {
  const text = '09/17(木)\nお天気予報\n06:00～翌05:59　晴れ\n09/19 06:00より新イベント開始\n09/16(水)\n18:00～23:59 流星雨';
  assert.deepEqual(extractFullDayStartSlotHint(text, '2026-09-17'), {
    startSlot: '06', weather: '晴', sourceLine: '06:00～翌05:59　晴れ'
  });
});

test('does not use a different-date weather line as the start-slot supplement', () => {
  const text = '09/17(木)\nお天気予報\n09/16(水)\n06:00～翌05:59　雨';
  assert.equal(extractFullDayStartSlotHint(text, '2026-09-17'), null);
});

test('recovers image-derived five slots when only start time is missing and text agrees', () => {
  const slots = Array.from({length:5}, () => ({value:'晴',bestScore:.66,margin:.16,confidence:'medium'}));
  const daily = {ready:false,diagnostics:{ocrAttempts:[{file:'raw-media-0.jpg',rect:{x:1,y:2,w:3,h:4},geometryDistance:.002,okCount:5,slots}]}};
  const capture = {rawMedia:[{file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:'a'.repeat(64)}]};
  const result = recoverDailyImageFirstWithTextStart(daily, capture, '09/17(木)\n06:00～翌05:59 晴れ', '2026-09-17');
  assert.equal(result.ready, true);
  assert.equal(result.interpretation.startSlot, '06');
  assert.deepEqual(result.interpretation.slots.map(item => item.weather), Array(5).fill(['晴']));
  assert.equal(result.interpretation.confidence, 'medium');
  assert.equal(result.selectedImage.file, 'raw-media-0.jpg');
});

test('stops recovery when image weather conflicts with the text supplement', () => {
  const slots = Array.from({length:5}, () => ({value:'晴',bestScore:.66,margin:.16,confidence:'medium'}));
  slots[2] = {value:'雨',bestScore:.66,margin:.16,confidence:'medium'};
  const daily = {ready:false,diagnostics:{ocrAttempts:[{file:'raw-media-0.jpg',geometryDistance:.002,okCount:5,slots}]}};
  const capture = {rawMedia:[{file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:'a'.repeat(64)}]};
  const result = recoverDailyImageFirstWithTextStart(daily, capture, '09/17(木)\n06:00～翌05:59 晴れ', '2026-09-17');
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics.textStartSlotSupplementRejected.reason, 'imageTextWeatherConflict');
});

test('combines daily and weekly evidence from separate captured images', () => {
  const daily = {
    schemaVersion: 1,
    ready: true,
    targetDate: '2026-09-17',
    selectedImage: { file:'raw-media-0.jpg', mimeType:'image/jpeg', captureSha256:'a'.repeat(64) },
    interpretation: {
      ready:true,
      observedDate:'2026-09-17',
      startSlot:'06',
      slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:true,weather:['晴'],confidence:'high',description:'daily'})),
      confidence:'high', summary:'daily verified', unresolved:[]
    },
    diagnostics:{mode:'daily'}
  };
  const weekly = {
    schemaVersion: 1,
    ready: true,
    targetDate: '2026-09-17',
    selectedImage: { file:'evidence.jpg', mimeType:'image/jpeg', captureSha256:'b'.repeat(64) },
    interpretation: {
      ready:true,
      days:Array.from({length:5},(_,i)=>({date:`2026-09-${String(18+i).padStart(2,'0')}`,weather:['雨'],visible:true,confidence:'high',description:'weekly'})),
      confidence:'high', summary:'weekly verified', unresolved:[]
    },
    diagnostics:{mode:'weekly'}
  };
  const combined = combineDailyWeeklyReviews(daily, weekly, {diagnostics:{reason:'single-image-not-ready'}});
  assert.equal(combined.ready, true);
  assert.equal(combined.pendingEvidenceFile, 'raw-media-0.jpg');
  assert.equal(combined.reviewedImages.length, 2);
  assert.deepEqual(combined.interpretation.slots.map(item=>item.weather), Array(5).fill(['晴']));
  assert.deepEqual(combined.interpretation.weeklyDays.map(item=>item.weather), Array(5).fill(['雨']));
  assert.equal(combined.diagnostics.mode, 'split-daily-weekly-evidence');
});

test('does not combine split evidence when weekly data is incomplete', () => {
  const daily = {
    ready:true,
    targetDate:'2026-09-17',
    selectedImage:{file:'raw-media-0.jpg',mimeType:'image/jpeg',captureSha256:'a'.repeat(64)},
    interpretation:{ready:true,observedDate:'2026-09-17',startSlot:'06',slots:[],confidence:'high',summary:'daily',unresolved:[]}
  };
  const weekly = {
    ready:true,
    targetDate:'2026-09-17',
    selectedImage:{file:'evidence.jpg',mimeType:'image/jpeg',captureSha256:'b'.repeat(64)},
    interpretation:{ready:true,days:[],confidence:'high',summary:'weekly',unresolved:[]}
  };
  assert.equal(combineDailyWeeklyReviews(daily, weekly), null);
});

test('target-date meteor text only corroborates matching image weather', () => {
  const postText = '09/16(水)\nお天気予報\n00:00～17:59　晴れ\n18:00～23:59　流星雨\n翌00:00～05:59　雨';
  assert.deepEqual(extractTimedMeteorIntervals(postText).map(item => [item.startMinute, item.endMinute, item.weather]), [[1080, 1439, '流星群']]);
  const result = {
    ready: true,
    targetDate: '2026-09-16',
    interpretation: {
      ready: true, observedDate:'2026-09-16', startSlot: '06', summary: 'visual', unresolved: [],
      slots: [
        {slot:'slot0',weather:['晴'],confidence:'high',description:'visual'},
        {slot:'slot1',weather:['晴'],confidence:'high',description:'visual'},
        {slot:'slot2',weather:['流星群'],confidence:'high',description:'visual'},
        {slot:'slot3',weather:['雨'],confidence:'high',description:'visual'},
        {slot:'slot4',weather:['晴'],confidence:'high',description:'visual'}
      ]
    },
    diagnostics: {}
  };
  const checked = applyTimedSpecialWeatherHints(result, postText);
  assert.equal(checked.ready, true);
  assert.equal(checked.diagnostics.textWeatherCorroborations.length, 1);
  assert.deepEqual(checked.interpretation.slots.map(slot => slot.weather), [['晴'],['晴'],['流星群'],['雨'],['晴']]);
});

test('does not let a prior-day quoted meteor line override target-date image weather', () => {
  const result = {ready:true,targetDate:'2026-09-17',interpretation:{ready:true,observedDate:'2026-09-17',startSlot:'06',unresolved:[],slots:[{slot:'slot0',weather:['晴']},{slot:'slot1',weather:['晴']},{slot:'slot2',weather:['晴']},{slot:'slot3',weather:['晴']},{slot:'slot4',weather:['晴']}]}};
  const text = '09/17(木)\n06:00～翌05:59 晴れ\n09/16(水)\n18:00～23:59 流星雨';
  const checked = applyTimedSpecialWeatherHints(result, text);
  assert.equal(checked.ready, true);
  assert.deepEqual(checked.interpretation.slots.map(slot => slot.weather), Array(5).fill(['晴']));
});

test('stops automation when target-date meteor text conflicts with image weather', () => {
  const result = {ready:true,targetDate:'2026-09-16',interpretation:{ready:true,observedDate:'2026-09-16',startSlot:'06',summary:'visual',unresolved:[],slots:[{slot:'slot0',weather:['晴']},{slot:'slot1',weather:['晴']},{slot:'slot2',weather:['晴']},{slot:'slot3',weather:['雨']},{slot:'slot4',weather:['晴']}]}};
  const checked = applyTimedSpecialWeatherHints(result, '09/16(水)\n18:00～23:59 流星雨');
  assert.equal(checked.ready, false);
  assert.equal(checked.interpretation.ready, false);
  assert.equal(checked.diagnostics.textWeatherConflicts.length, 1);
});

test('does not override a slot from an untimed meteor mention', () => {
  const result = {ready:true,targetDate:'2026-09-17',interpretation:{ready:true,observedDate:'2026-09-17',startSlot:'06',slots:[{slot:'slot0',weather:['晴']}]} };
  assert.equal(applyTimedSpecialWeatherHints(result, '09/17(木)\n今日は流星群が見たい').interpretation.slots[0].weather[0], '晴');
});
