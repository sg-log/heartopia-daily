import test from 'node:test';
import assert from 'node:assert/strict';
import { combineDailyWeeklyReviews, inferStartSlotFromMappings, extractTimedMeteorIntervals, applyTimedSpecialWeatherHints, extractFullDayStartSlotSupplement, recoverVisualDailyWithTextStartSlot } from './weather-unified-review.mjs';

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

test('accepts text only as an explicit full-day start-slot supplement', () => {
  assert.deepEqual(extractFullDayStartSlotSupplement('06:00～翌05:59　晴れ'), { startSlot:'06', sourceLine:'06:00～翌05:59　晴れ' });
  assert.equal(extractFullDayStartSlotSupplement('06:00～17:59　晴れ'), null);
  assert.equal(extractFullDayStartSlotSupplement('たぶん朝6時から晴れ'), null);
});

test('recovers daily only when all five weather slots came from the image', () => {
  const daily = {
    ready:false,
    targetDate:'2026-09-17',
    diagnostics:{
      ocrAttempts:[{
        file:'raw-media-0.jpg', highCount:0,
        slots:Array.from({length:5},()=>({value:'晴',confidence:'medium',bestScore:.67,margin:.16}))
      }]
    }
  };
  const capture = { rawMedia:[{file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:'a'.repeat(64)}] };
  const recovered = recoverVisualDailyWithTextStartSlot(daily, '06:00～翌05:59　晴れ', capture);
  assert.equal(recovered.ready, true);
  assert.equal(recovered.interpretation.startSlot, '06');
  assert.deepEqual(recovered.interpretation.slots.map(slot=>slot.weather), Array(5).fill(['晴']));
  assert.equal(recovered.diagnostics.weatherSource, 'image-primary');
  assert.equal(recovered.diagnostics.textUse, 'start-slot-only');

  const incomplete = structuredClone(daily);
  incomplete.diagnostics.ocrAttempts[0].slots[4].value = '';
  assert.equal(recoverVisualDailyWithTextStartSlot(incomplete, '06:00～翌05:59　晴れ', capture).ready, false);
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

test('stops for review when timed 流星雨 text conflicts with the game UI image', () => {
  const postText = '09/16(水)\nお天気予報\n00:00～17:59　晴れ\n18:00～23:59　流星雨\n翌00:00～05:59　雨';
  assert.deepEqual(extractTimedMeteorIntervals(postText).map(item => [item.startMinute, item.endMinute, item.weather]), [[1080, 1439, '流星群']]);
  const result = {
    ready: true,
    interpretation: {
      ready: true, startSlot: '06', summary: 'visual',
      slots: [
        {slot:'slot0',weather:['晴'],confidence:'high',description:'visual'},
        {slot:'slot1',weather:['晴'],confidence:'high',description:'visual'},
        {slot:'slot2',weather:['晴'],confidence:'high',description:'visual'},
        {slot:'slot3',weather:['雨'],confidence:'high',description:'visual'},
        {slot:'slot4',weather:['晴'],confidence:'high',description:'visual'}
      ]
    },
    diagnostics: {}
  };
  const checked = applyTimedSpecialWeatherHints(result, postText);
  assert.equal(checked.ready, false);
  assert.equal(checked.interpretation.ready, false);
  assert.deepEqual(checked.interpretation.slots.map(slot => slot.weather), [['晴'],['晴'],['晴'],['雨'],['晴']]);
  assert.equal(checked.diagnostics.textWeatherConflicts.length, 1);
  assert.deepEqual(result.interpretation.slots[2].weather, ['晴']);
});

test('does not override a slot from an untimed meteor mention', () => {
  const result = {ready:true,interpretation:{ready:true,startSlot:'06',slots:[{slot:'slot0',weather:['晴']}]} };
  assert.equal(applyTimedSpecialWeatherHints(result, '今日は流星群が見たい').interpretation.slots[0].weather[0], '晴');
});
