import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueries, normalizeCandidateUrl } from './weather-public-discovery.mjs';

test('normalizes X status URLs without account dependency', () => {
  assert.deepEqual(normalizeCandidateUrl('https://x.com/example/status/2099304671949230199/photo/1?s=20'), {
    url: 'https://x.com/i/status/2099304671949230199',
    sourceType: 'x',
    sourceId: '2099304671949230199'
  });
  assert.deepEqual(normalizeCandidateUrl('https://twitter.com/foo/status/1234567890'), {
    url: 'https://x.com/i/status/1234567890',
    sourceType: 'x',
    sourceId: '1234567890'
  });
});

test('unwraps DuckDuckGo redirect and rejects search-provider pages', () => {
  const wrapped = 'https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://x.com/user/status/999');
  assert.equal(normalizeCandidateUrl(wrapped)?.url, 'https://x.com/i/status/999');
  assert.equal(normalizeCandidateUrl('https://www.bing.com/search?q=heartopia'), null);
  assert.equal(normalizeCandidateUrl('http://x.com/u/status/1'), null);
});

test('preserves generic public HTTPS result URLs', () => {
  assert.deepEqual(normalizeCandidateUrl('https://example.org/weather#today'), {
    url: 'https://example.org/weather',
    sourceType: 'web',
    sourceId: null
  });
});

test('builds date-specific and broad query variants', () => {
  assert.deepEqual(buildQueries('2026-09-15'), [
    'ハートピア 天気 9月15日',
    'Heartopia weather 2026-09-15',
    'ハートピア 天気'
  ]);
});
