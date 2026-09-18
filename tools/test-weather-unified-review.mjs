import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTimedMeteorIntervals, applyTimedSpecialWeatherHints } from './weather-unified-review.mjs';
import { resolveWeekly } from './weather-direct-panel-review.mjs';
import { buildUnifiedBindings } from './weather-unified-bind.mjs';

function readyDraft(weeklyDays) {
  const draft = {
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
  if (weeklyDays !== undefined) draft.interpretation.weeklyDays = weeklyDays;
  return draft;
}

test('binds same-image daily plus weekly review as one reviewed image', () => {
  const weeklyDays = Array.from({length:5},(_,i)=>({
    date:`2026-09-${String(18+i).padStart(2,'0')}`,
    weather:['雨'], visible:true, confidence:'high', description:'weekly'
  }));
  const bindings = buildUnifiedBindings(readyDraft(weeklyDays), {runId:'123',id:'456',name:'weather-evidence'});
  assert.equal(bindings.weeklyCount, 5);
  assert.equal(bindings.fullEnvelope.reviewedImages.length, 1);
  assert.equal(bindings.fullEnvelope.pendingEvidenceFile, 'raw-media-0.jpg');
  assert.equal(bindings.fullEnvelope.interpretation.weeklyDays.length, 5);
  assert.equal('weeklyDays' in bindings.bridgeEnvelope.interpretation, false);
});

test('binds daily-only review with zero weekly days', () => {
  const bindings = buildUnifiedBindings(readyDraft(), {runId:'123',id:'456',name:'weather-evidence'});
  assert.equal(bindings.weeklyCount, 0);
  assert.equal(bindings.fullEnvelope.reviewedImages.length, 1);
  assert.equal(bindings.fullEnvelope.interpretation.weeklyDays, undefined);
});

test('rejects split reviewed images and incomplete weekly data', () => {
  const split = readyDraft();
  split.reviewedImages = [split.selectedImage, {file:'weekly.jpg',mimeType:'image/jpeg',captureSha256:'b'.repeat(64)}];
  assert.throws(() => buildUnifiedBindings(split, {runId:'123',id:'456',name:'weather-evidence'}), /splitReviewedImagesNotSupported/);

  const incomplete = readyDraft([{date:'2026-09-18',weather:['雨'],visible:true,confidence:'high'}]);
  assert.throws(() => buildUnifiedBindings(incomplete, {runId:'123',id:'456',name:'weather-evidence'}), /unifiedWeeklyNotReady/);
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


test('weekly heuristic recognizes pale-purple meteor streaks without overriding rainbow', () => {
  const meteor = resolveWeekly({
    bestValue:'晴', bestScore:.57, margin:.01,
    metrics:{red:0,cyan:0,warm:.43,yellowOrange:.47,palePurple:.035}
  });
  assert.deepEqual(meteor, {value:'流星群',high:true});

  const rainbow = resolveWeekly({
    bestValue:'雨', bestScore:.57, margin:.01,
    metrics:{red:.22,cyan:.34,warm:.06,yellowOrange:.09,palePurple:.03}
  });
  assert.deepEqual(rainbow, {value:'虹',high:true});

  const sunny = resolveWeekly({
    bestValue:'晴', bestScore:.58, margin:.03,
    metrics:{red:0,cyan:0,warm:.53,yellowOrange:.57,palePurple:0}
  });
  assert.deepEqual(sunny, {value:'晴',high:true});
});
