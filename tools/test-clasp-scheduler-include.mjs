import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const claspIgnore = fs.readFileSync(new URL('../.claspignore', import.meta.url), 'utf8');
const claspConfig = JSON.parse(fs.readFileSync(new URL('../.clasp.json', import.meta.url), 'utf8'));
const required = [
  'weather-api.gs',
  'weather-review-image.gs',
  'weather-scheduler.gs',
  'weather-calendar.gs',
  'weather-history.gs',
  'weather-private-sources.gs',
  'gift-code-config.gs',
  'gift-code-parser.gs',
  'gift-code-storage.gs',
  'gift-claim-backup.gs',
  'appsscript.json',
];

assert.equal(claspConfig.rootDir, 'apps-script', 'do not push unrelated files from repo root');
for (const file of required) {
  assert.match(claspIgnore, new RegExp('^!' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'),
    file + ' must be included in claspignore');
  assert.ok(fs.existsSync(new URL('../apps-script/' + file, import.meta.url)), file + ' must exist');
  if (file !== 'appsscript.json') {
    assert.ok(claspConfig.filePushOrder.includes('apps-script/' + file),
      file + ' must be in clasp filePushOrder');
  }
}
const actual = fs.readdirSync(new URL('../apps-script/', import.meta.url)).filter(name => name.endsWith('.gs')).sort();
const expected = required.filter(name => name.endsWith('.gs')).sort();
assert.deepEqual(actual, expected, 'every Apps Script .gs file must be explicitly included in the push list');

console.log('clasp complete Apps Script source inclusion test passed');
