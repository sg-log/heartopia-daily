import test from 'node:test';
import assert from 'node:assert/strict';
import { inferStartSlotFromMappings } from './weather-unified-review.mjs';

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
