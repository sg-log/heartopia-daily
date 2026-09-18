import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../assets/weather-screenshot-core.js');

const sunny = () => ({
  bestValue:'晴', bestScore:.60, secondValue:'雨', secondScore:.40, margin:.20,
  metrics:{warm:.03,cyan:0,purple:0,red:0}
});
const unresolved = () => ({
  bestValue:'晴', bestScore:.20, secondValue:'雨', secondScore:.199, margin:.001,
  metrics:{warm:0,cyan:0,purple:0,red:0}
});

test('全画面スクショは画像全体の比率だけではrejectせず、発見済みパネルを選ぶ', () => {
  const selected = core.selectPanelCandidate([
    {sourceAspect:21/9,structureConfirmed:false,dailyHighCount:0},
    {sourceAspect:21/9,structureConfirmed:true,dailyHighCount:5,structureScore:1.2,dailyScore:3}
  ]);
  assert.equal(selected?.dailyHighCount, 5);
});

test('パネル切り抜き画像も確認済み候補として選ぶ', () => {
  const crop = {sourceAspect:1,structureConfirmed:true,dailyHighCount:5,structureScore:.5,dailyScore:3};
  assert.equal(core.selectPanelCandidate([crop]), crop);
});

test('startSlot 06 の5枠を正しく推定する', () => {
  assert.deepEqual(core.expectedSlots('06'), ['06','12','18','00','06']);
  assert.equal(core.inferStartSlot(['06','12','18','00','06'])?.startSlot, '06');
});

test('dailyの晴・雨・虹・流星群・猛暑を本番ヒューリスティックで解決する', () => {
  const base={bestScore:.50,margin:.02};
  assert.equal(core.resolveDailyScore({...base,bestValue:'雨',metrics:{warm:.03}}).value,'晴');
  assert.equal(core.resolveDailyScore({...base,bestValue:'晴',metrics:{cyan:.60,warm:0}}).value,'雨');
  assert.equal(core.resolveDailyScore({...base,bestValue:'晴',metrics:{red:.05,cyan:.13}}).value,'虹');
  assert.equal(core.resolveDailyScore({...base,bestValue:'流星群',metrics:{purple:.11,warm:.03}}).value,'流星群');
  assert.equal(core.resolveDailyScore({...base,bestValue:'猛暑',metrics:{warm:.08}}).value,'猛暑');
});

test('daily-onlyはdaily候補を返しweeklyを空にする', () => {
  const review = core.buildManualReview({
    panelConfirmed:true,
    dailyScores:Array.from({length:5},sunny),
    mappedTimes:['06','12','18','00','06'],
    weeklyPanelConfirmed:false,
    weeklyScores:Array.from({length:5},sunny)
  });
  assert.deepEqual(review.slots.map(item=>item.value), ['晴','晴','晴','晴','晴']);
  assert.equal(review.startSlot, '06');
  assert.deepEqual(review.weeks, []);
});

test('OCR失敗時に既存フォーム値を開始時刻として採用しない', () => {
  const review = core.buildManualReview({
    panelConfirmed:true,
    dailyScores:Array.from({length:5},sunny),
    mappedTimes:['','','','',''],
    fallbackStartSlot:'18'
  });
  assert.equal(review.startSlot, '');
});

test('一部の枠が読めなくても他の候補を捨てない', () => {
  const review = core.buildManualReview({
    panelConfirmed:true,
    dailyScores:[sunny(),sunny(),unresolved(),sunny(),sunny()],
    mappedTimes:['06','12','18','','06']
  });
  assert.equal(review.slots.length, 5);
  assert.deepEqual(review.slots.map(item=>item.value), ['晴','晴','','晴','晴']);
  assert.equal(review.slots[2].confidence, '未判定');
  assert.equal(review.startSlot, '06');
});

test('天気パネル構造が未確認なら天気値を確定しない', () => {
  const review = core.buildManualReview({
    panelConfirmed:false,
    dailyScores:Array.from({length:5},sunny),
    mappedTimes:['06','12','18','00','06']
  });
  assert.deepEqual(review.slots, []);
  assert.equal(review.startSlot, '');
});

test('管理画面から全体比率hard rejectとフォーム値fallbackを除去した', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /layoutMatches\s*\(/);
  assert.doesNotMatch(html, /start\.startSlot\s*\|\|\s*E\.quickWeatherStartSlot\.value/);
  assert.doesNotMatch(html, /weatherScreenshotCandidates\?\.startSlot\s*\|\|\s*E\.quickWeatherStartSlot\.value/);
  assert.match(html, /開始時刻は自動判定できませんでした/);
  assert.match(html, /天気パネルを自動で特定できませんでした/);
});
