import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync('index.html', 'utf8');
const apps = fs.readFileSync('apps-script/weather-api.gs', 'utf8');
const workflow = fs.readFileSync('.github/workflows/weather-scheduled-run.yml', 'utf8');

test('admin UI exposes authenticated manual weather run controls', () => {
  for (const id of ['weatherAutomationDate','weatherAutomationSlot','runWeatherAutomationBtn','weatherAutomationStatus']) {
    assert.match(index, new RegExp(`id=["']${id}["']`));
  }
  assert.match(index, /action\s*:\s*["']requestWeatherAutomation["']/);
  assert.match(index, /adminKey\s*:\s*adminKeyValue\(\)/);
});

test('Apps Script guards GitHub dispatch behind admin auth and server-side token', () => {
  assert.match(apps, /GITHUB_ACTIONS_TOKEN_PROPERTY\s*=\s*["']GITHUB_ACTIONS_TOKEN["']/);
  assert.match(apps, /function requestWeatherAutomation_\(body\)/);
  assert.match(apps, /requireKey_\(body\.adminKey,\s*adminKey_\(\),\s*["']管理キー["']\)/);
  assert.match(apps, /actions\/workflows\/.*dispatches/);
  assert.match(apps, /PropertiesService\.getScriptProperties\(\)\.getProperty\(GITHUB_ACTIONS_TOKEN_PROPERTY\)/);
  assert.doesNotMatch(index, /github_pat_|ghp_[A-Za-z0-9]/);
});

test('manual workflow supports an explicit target date without changing scheduled dates', () => {
  assert.match(workflow, /target_date:/);
  assert.match(workflow, /MANUAL_TARGET_DATE:\s*\$\{\{\s*inputs\.target_date\s*\}\}/);
  assert.match(workflow, /ParseExact/);
  assert.match(workflow, /target_date=\$targetDate/);
});


test('admin cards can be collapsed to reduce long management pages', () => {
  assert.match(index, /data-admin-collapse-all/);
  assert.match(index, /data-admin-expand-all/);
  assert.match(index, /function setupAdminCardFolding\(\)/);
  assert.match(index, /adminCardCollapsed/);
  assert.match(index, /setupAdminCardFolding\(\)/);
  assert.match(index, /target\.closest\("\.adminCardFoldable"\)/);
});
