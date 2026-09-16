import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueries,
  normalizeCandidateUrl,
  candidateRelevance,
  mergeAndRankCandidates,
  targetDateTokens
} from './weather-public-discovery.mjs';

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

test('rejects X profile and media redirect links because they are not post evidence', () => {
  assert.equal(normalizeCandidateUrl('https://x.com/example?utm_source=yjrealtime'), null);
  assert.equal(normalizeCandidateUrl('https://twitter.com/example'), null);
  assert.equal(normalizeCandidateUrl('https://t.co/abc123'), null);
  assert.equal(normalizeCandidateUrl('https://pic.x.com/abc123'), null);
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

test('rejects unrelated X search-result text', () => {
  const result = candidateRelevance('かわいい猫の写真です', '2026-09-16');
  assert.equal(result.relevant, false);
  assert.equal(result.dateMatched, false);
});

test('recognizes Heartopia weather text and target date', () => {
  const result = candidateRelevance('ハートピア 今日の天気 9月16日 晴れ', '2026-09-16');
  assert.equal(result.relevant, true);
  assert.equal(result.dateMatched, true);
  assert.equal(result.forecastMatched, true);
  assert.ok(result.score >= 13);
});

test('date tokens include common Japanese and slash forms', () => {
  const tokens = targetDateTokens('2026-09-16');
  assert.ok(tokens.includes('2026-09-16'));
  assert.ok(tokens.includes('2026年9月16日'));
  assert.ok(tokens.includes('9月16日'));
  assert.ok(tokens.includes('09/16'));
});

test('mergeAndRankCandidates drops unrelated X links and prioritizes dated weather candidates', () => {
  const attempts = [
    {
      candidates: [
        {
          sourceUrl: 'https://x.com/i/status/1',
          sourceType: 'x',
          sourceId: '1',
          discoverySource: 'yahoo-realtime',
          searchQuery: 'ハートピア 天気',
          anchorText: '別ゲームの雑談',
          context: '今日はラーメンを食べた'
        },
        {
          sourceUrl: 'https://x.com/i/status/2',
          sourceType: 'x',
          sourceId: '2',
          discoverySource: 'yahoo-realtime',
          searchQuery: 'ハートピア 天気',
          anchorText: 'ハートピア 天気',
          context: 'ハートピアの天気予報まとめ'
        },
        {
          sourceUrl: 'https://x.com/i/status/3',
          sourceType: 'x',
          sourceId: '3',
          discoverySource: 'yahoo-realtime',
          searchQuery: 'ハートピア 天気 9月16日',
          anchorText: 'ハートピア 今日の天気',
          context: '9月16日のハートピア天気予報'
        }
      ]
    }
  ];
  const ranked = mergeAndRankCandidates(attempts, '2026-09-16');
  assert.deepEqual(ranked.map((item) => item.sourceId), ['3', '2']);
  assert.equal(ranked[0].dateMatched, true);
});
