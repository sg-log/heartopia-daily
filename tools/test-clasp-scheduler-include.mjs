import assert from 'node:assert/strict';
import fs from 'node:fs';

const claspIgnore = fs.readFileSync(new URL('../.claspignore', import.meta.url), 'utf8');
const claspConfig = JSON.parse(fs.readFileSync(new URL('../.clasp.json', import.meta.url), 'utf8'));

assert.match(claspIgnore, /^!weather-scheduler\.gs$/m, 'clasp must not ignore weather-scheduler.gs');
assert.ok(
  Array.isArray(claspConfig.filePushOrder) && claspConfig.filePushOrder.includes('apps-script/weather-scheduler.gs'),
  'weather-scheduler.gs must be present in clasp filePushOrder'
);

console.log('clasp scheduler include test passed');
