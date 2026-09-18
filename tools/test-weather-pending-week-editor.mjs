import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scheduler = fs.readFileSync(new URL('../apps-script/weather-scheduler.gs', import.meta.url), 'utf8');
const functionStart = page.indexOf('async function approveWeatherReport(id){');
const functionEnd = page.indexOf('\nasync function rejectWeatherReport(id){', functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'approveWeatherReport was not found');
const approveSource = page.slice(functionStart, functionEnd);
const helperStart = page.indexOf('function pendingKeepsExistingWeeks(report){');
const helperEnd = page.indexOf('\nfunction pendingWeatherCard(r){', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'pending weekly helpers were not found');
const helperSource = page.slice(helperStart, helperEnd);

const slotKeys = ['slot0', 'slot1', 'slot2', 'slot3', 'slot4'];
const weekKeys = Array.from({ length: 7 }, (_, index) => `week${index + 1}`);
const originalSlots = Object.fromEntries(slotKeys.map((key, index) => [key, [index === 1 ? '雨' : '晴']]));
const originalWeeks = {
  week1: ['晴'],
  week2: ['雨'],
  week3: ['晴'],
  week4: ['晴'],
  week5: ['晴'],
  week6: [],
  week7: []
};

function values(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function makeContext(editedWeeks, options={}) {
  const calls = [];
  const saved = [];
  const upserted = [];
  const report = options.report || {
    id: '3d675261-1dad-4ab5-a089-21abe2e10a12',
    date: '2026-09-17',
    startSlot: '00',
    slots: originalSlots,
    weeks: originalWeeks,
    memo: 'production acceptance pending'
  };
  const context = vm.createContext({
    console,
    JSON,
    WEATHER_API_URL: 'https://example.invalid/exec',
    WEATHER_SLOT_KEYS: slotKeys,
    WEATHER_WEEK_KEYS: weekKeys,
    pendingWeatherReportsCache: [report],
    chipSelections: () => structuredClone(originalSlots),
    weekSelections: () => structuredClone(editedWeeks),
    weatherValues: values,
    normalizeWeatherSlots: item => structuredClone(item.slots),
    normalizeWeatherWeeks: item => {
      const source = item.weeks || item;
      return Object.fromEntries(weekKeys.map(key => [key, values(source[key])]));
    },
    normalizeApiDate: value => String(value),
    normalizeStartSlot: value => String(value),
    adminKeyValue: () => 'test-admin-key',
    apiPost: async body => { calls.push(body); return { ok: true }; },
    fetchPendingWeatherReports: async () => [],
    fetchApprovedWeather: async () => options.approvedReports || [],
    weatherData: () => options.approvedWeather || null,
    saveApprovedWeatherToApi: async item => { saved.push(structuredClone(item)); return { ok: true }; },
    upsertWeather: item => upserted.push(structuredClone(item)),
    save: () => {},
    renderToday: () => {},
    toast: () => {},
    E: { pendingWeatherStatus: { textContent: '' } }
  });
  vm.runInContext(helperSource, context, { filename: 'pendingWeeklyHelpers.js' });
  vm.runInContext(approveSource, context, { filename: 'approveWeatherReport.js' });
  return { context, calls, saved, upserted, report };
}

test('pending card reuses the weekly chip UI and initializes all seven saved days', () => {
  assert.match(page, /weekChipGroupHtml\(weekEditPrefix, reportDate, true\)/);
  assert.match(page, /setWeekSelections\(`pending-week-\$\{report\.id\}`, pendingInitialWeeks\(report\)\)/);
  assert.match(page, /週間予報（修正できます）/);
  assert.match(page, /週間予報（今回は変更なし）/);
  assert.match(page, /週間は白＝既存データ維持/);
  assert.match(page, /自動判読時の週間データ/);
  assert.equal((page.match(/id="pendingWeatherReports"/g) || []).length, 1, 'pending section must not be duplicated');
  assert.ok(page.indexOf('id="pendingWeatherReports"') < page.indexOf('id="runWeatherAutomationBtn"'), 'pending section must be the first admin card');
});

test('changing only week7 uses correction approval and preserves blank week6', async () => {
  const editedWeeks = structuredClone(originalWeeks);
  editedWeeks.week7 = ['流星群'];
  const { context, calls, saved, upserted } = makeContext(editedWeeks);

  await context.approveWeatherReport('3d675261-1dad-4ab5-a089-21abe2e10a12');

  assert.equal(saved.length, 1, 'corrected approved weather must be saved');
  assert.deepEqual(saved[0].weeks.week6, [], 'blank week6 must remain blank');
  assert.deepEqual(saved[0].weeks.week7, ['流星群'], 'edited week7 must be saved');
  assert.equal(upserted.length, 1, 'local approved weather must be updated');
  assert.equal(calls.some(call => call.action === 'approve'), false, 'unchanged approve path must not be used');
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify({
    action: 'reject',
    id: '3d675261-1dad-4ab5-a089-21abe2e10a12',
    adminKey: 'test-admin-key'
  }));
});

test('unchanged slots and weeks keep the direct approve path', async () => {
  const completeWeeks = Object.fromEntries(weekKeys.map((key, index) => [key, [index === 1 ? '雨' : '晴']]));
  const report = {
    id: '3d675261-1dad-4ab5-a089-21abe2e10a12',
    date: '2026-09-17',
    startSlot: '00',
    slots: originalSlots,
    weeks: completeWeeks,
    memo: 'production acceptance pending'
  };
  const { context, calls, saved, upserted } = makeContext(completeWeeks, {report});

  await context.approveWeatherReport('3d675261-1dad-4ab5-a089-21abe2e10a12');

  assert.equal(saved.length, 0);
  assert.equal(upserted.length, 0);
  assert.equal(JSON.stringify(calls), JSON.stringify([{
    action: 'approve',
    id: '3d675261-1dad-4ab5-a089-21abe2e10a12',
    adminKey: 'test-admin-key'
  }]));
});

test('daily-only pending stays white and approval preserves existing approved weeks', async () => {
  const blankWeeks = Object.fromEntries(weekKeys.map(key => [key, []]));
  const existingWeeks = Object.fromEntries(weekKeys.map((key, index) => [key, [index === 2 ? '流星群' : '晴']]));
  const report = {
    id: 'daily-only-report',
    date: '2026-09-18',
    startSlot: '06',
    slots: originalSlots,
    weeks: blankWeeks,
    memo: '自動判読 デイリーのみ（週間は既存維持）'
  };
  const { context, calls, saved } = makeContext(blankWeeks, {
    report,
    approvedWeather: {date:'2026-09-18', weeks:existingWeeks}
  });

  const initial = context.pendingInitialWeeks(report);
  assert.deepEqual(JSON.parse(JSON.stringify(initial)), blankWeeks, 'daily-only weekly chips must initialize white');

  await context.approveWeatherReport('daily-only-report');

  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].weeks, existingWeeks, 'white weeks must be replaced with existing approved weeks');
  assert.equal(saved[0].memo.includes('デイリーのみ（週間は既存維持）'), false, 'pending-only marker is removed on approval');
  assert.equal(calls.some(call => call.action === 'approve'), false);
  assert.equal(calls.at(-1).action, 'reject');
});

test('acceptance-only scheduler branch is removed while normal four attempts remain', () => {
  assert.doesNotMatch(scheduler, /WEATHER_SCHEDULER_ACCEPTANCE_TEST|WEATHER_SCHEDULER_ACCEPTANCE_20260918|morning-acceptance-test|2026-09-18/);
  for (const name of ['morning-primary', 'morning-retry', 'evening-primary', 'evening-retry']) {
    assert.match(scheduler, new RegExp(name));
  }
  assert.match(scheduler, /everyMinutes\(WEATHER_SCHEDULER_INTERVAL_MINUTES\)/);
});
