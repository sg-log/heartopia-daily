import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueries,
  buildKnownAuthorQueries,
  normalizeCandidateUrl,
  candidateRelevance,
  profileHeartopiaSignals,
  isSlotContextFallback,
  isKnownAuthorFallback,
  mergeAndRankCandidates,
  selectDiversifiedCandidates,
  targetDateTokens
} from './weather-public-discovery.mjs';

test('normalizes X status URLs without account dependency', () => {
  assert.deepEqual(normalizeCandidateUrl('https://x.com/example/status/2099304671949230199/photo/1?s=20'), {
    url: 'https://x.com/i/status/2099304671949230199',
    sourceType: 'x',
    sourcePlatform: 'x',
    sourceId: '2099304671949230199',
    sourceHandle: 'example'
  });
  assert.deepEqual(normalizeCandidateUrl('https://twitter.com/foo/status/1234567890'), {
    url: 'https://x.com/i/status/1234567890',
    sourceType: 'x',
    sourcePlatform: 'x',
    sourceId: '1234567890',
    sourceHandle: 'foo'
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

test('unwraps Google result redirects and rejects Google search pages', () => {
  const wrapped = 'https://www.google.com/url?q=' + encodeURIComponent('https://x.com/sylfley/status/2102000000000000000');
  const result = normalizeCandidateUrl(wrapped);
  assert.equal(result?.url, 'https://x.com/i/status/2102000000000000000');
  assert.equal(result?.sourceHandle, 'sylfley');
  assert.equal(normalizeCandidateUrl('https://www.google.com/search?q=heartopia'), null);
});

test('preserves generic public HTTPS result URLs', () => {
  assert.deepEqual(normalizeCandidateUrl('https://example.org/weather#today'), {
    url: 'https://example.org/weather',
    sourceType: 'web',
    sourcePlatform: 'web',
    sourceId: null
  });
});

test('builds date-specific and broad query variants', () => {
  assert.deepEqual(buildQueries('2026-09-15'), [
    'ハートピア 天気 9月15日',
    'ハートピア スローライフ 天気 9月15日',
    'Heartopia weather 2026-09-15'
  ]);
  assert.deepEqual(buildQueries('2026-09-15', 'morning').slice(0, 2), [
    'ハートピア 天気 9月15日 06:00',
    'ハートピア お天気予報 9月15日 06:00'
  ]);
  assert.deepEqual(buildQueries('2026-09-15', 'evening').slice(0, 2), [
    'ハートピア 天気 9月15日 18:00',
    'ハートピア お天気予報 9月15日 18:00'
  ]);
});

test('builds known-author X queries for the current slot', () => {
  const queries = buildKnownAuthorQueries('sylfley', '2026-09-20', 'evening');
  assert.equal(queries.length, 3);
  assert.ok(queries.every(q => q.includes('site:x.com/sylfley/status')));
  assert.ok(queries.every(q => q.includes('18:00')));
  assert.deepEqual(buildKnownAuthorQueries('bad handle!', '2026-09-20', 'evening'), []);
});

test('slot-aware relevance rewards only the current start slot', () => {
  const morning06 = candidateRelevance('ハートピア 天気 9月16日 06:00開始', '2026-09-16', 'morning');
  const morning00 = candidateRelevance('ハートピア 天気 9月16日 00:00開始', '2026-09-16', 'morning');
  const evening18 = candidateRelevance('ハートピア 天気 9月16日 18:00開始', '2026-09-16', 'evening');
  assert.equal(morning06.startSlotMatched, true);
  assert.equal(morning00.startSlotMatched, false);
  assert.equal(evening18.startSlotMatched, true);
  assert.ok(morning06.score > morning00.score);
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

test('keeps exact-date exact-slot X posts from a Heartopia weather realtime query even when post text is natural', () => {
  const fallback = isSlotContextFallback({
    sourceType: 'x',
    discoverySource: 'yahoo-realtime',
    searchQuery: 'ハートピア 天気 9月20日 18:00',
    text: 'つちやん☆ @sylfley 2026/09/20 18:00-24:00 虹だよー'
  }, '2026-09-20', 'evening');
  assert.equal(fallback, true);
});

test('broad Yahoo realtime Heartopia-weather query keeps exact-date exact-slot natural posts', () => {
  const base = {
    sourceType: 'x',
    discoverySource: 'yahoo-realtime',
    searchQuery: 'ハートピア 天気',
    text: '2026/09/20 18:00-24:00 虹だよー'
  };
  assert.equal(isSlotContextFallback(base, '2026-09-20', 'evening'), true);
  assert.equal(isSlotContextFallback({ ...base, sourceType: 'web' }, '2026-09-20', 'evening'), false);
  assert.equal(isSlotContextFallback({ ...base, discoverySource: 'yahoo-web' }, '2026-09-20', 'evening'), false);
  assert.equal(isSlotContextFallback({ ...base, searchQuery: 'ゲーム 雑談' }, '2026-09-20', 'evening'), false);
  assert.equal(isSlotContextFallback({ ...base, text: '2026/09/20 12:00-18:00 虹だよー' }, '2026-09-20', 'evening'), false);
});

test('known-author fallback accepts natural exact-slot posts without game/weather words', () => {
  assert.equal(isKnownAuthorFallback({
    sourceType: 'x',
    sourceHandle: 'sylfley',
    knownHandle: 'sylfley',
    text: '2026/09/20 18:00-24:00 虹だよー'
  }, '2026-09-20', 'evening'), true);
});

test('known-author fallback remains fail-closed for wrong author/date/start hour', () => {
  const base = {
    sourceType: 'x',
    sourceHandle: 'sylfley',
    knownHandle: 'sylfley',
    text: '2026/09/20 18:00-24:00 虹だよー'
  };
  assert.equal(isKnownAuthorFallback({ ...base, sourceHandle: 'someone_else' }, '2026-09-20', 'evening'), false);
  assert.equal(isKnownAuthorFallback({ ...base, text: '2026/09/19 18:00-24:00 虹だよー' }, '2026-09-20', 'evening'), false);
  assert.equal(isKnownAuthorFallback({ ...base, text: '2026/09/20 12:00-18:00 虹だよー' }, '2026-09-20', 'evening'), false);
});

test('profile Heartopia signal recognizes Japanese and English game references only as a weak signal', () => {
  assert.deepEqual(profileHeartopiaSignals('ハートピア中心に遊んでます'), {
    matched: true,
    matchedTerms: ['ハートピア']
  });
  assert.deepEqual(profileHeartopiaSignals('Heartopia screenshots and notes'), {
    matched: true,
    matchedTerms: ['heartopia']
  });
  assert.deepEqual(profileHeartopiaSignals('ゲームいろいろ'), {
    matched: false,
    matchedTerms: []
  });
});

test('date tokens include common Japanese and slash forms', () => {
  const tokens = targetDateTokens('2026-09-16');
  assert.ok(tokens.includes('2026-09-16'));
  assert.ok(tokens.includes('2026年9月16日'));
  assert.ok(tokens.includes('9月16日'));
  assert.ok(tokens.includes('09/16'));
});

test('mergeAndRankCandidates drops unrelated links and prioritizes dated weather candidates', () => {
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
          sourceUrl: 'https://example.org/weather',
          sourceType: 'web',
          sourceId: null,
          discoverySource: 'bing',
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
  assert.equal(ranked[0].sourceId, '3');
  assert.equal(ranked[0].dateMatched, true);
  assert.ok(ranked.some((item) => item.sourceType === 'web'));
  assert.ok(!ranked.some((item) => item.sourceId === '1'));
});

test('merge keeps exact-slot fallback posts for strict image verification', () => {
  const attempts = [{
    candidates: [{
      sourceUrl: 'https://x.com/i/status/92018',
      sourceType: 'x',
      sourcePlatform: 'x',
      sourceId: '92018',
      discoverySource: 'yahoo-realtime',
      searchQuery: 'ハートピア 天気',
      anchorText: 'つちやん☆',
      context: '2026/09/20 18:00-24:00 虹だよー',
      relevanceScore: 12,
      dateMatched: true,
      forecastMatched: false,
      startSlotMatched: true,
      strictTextRelevant: false,
      slotContextFallback: true
    }]
  }];
  const ranked = mergeAndRankCandidates(attempts, '2026-09-20', 24, 'evening');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sourceId, '92018');
  assert.equal(ranked[0].slotContextFallback, true);
  assert.equal(ranked[0].strictTextRelevant, false);
});

test('merge keeps known-author fallback candidates for strict image review', () => {
  const attempts = [{
    candidates: [{
      sourceUrl: 'https://x.com/i/status/9201801',
      sourceType: 'x',
      sourcePlatform: 'x',
      sourceId: '9201801',
      sourceHandle: 'sylfley',
      discoverySource: 'google',
      searchQuery: 'site:x.com/sylfley/status 2026-09-20 18:00',
      anchorText: 'つちやん☆',
      context: '2026/09/20 18:00-24:00 虹だよー',
      relevanceScore: 12,
      dateMatched: true,
      forecastMatched: false,
      startSlotMatched: true,
      strictTextRelevant: false,
      slotContextFallback: false,
      knownAuthorFallback: true,
      knownHandle: 'sylfley'
    }]
  }];
  const ranked = mergeAndRankCandidates(attempts, '2026-09-20', 24, 'evening');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].knownAuthorFallback, true);
  assert.equal(ranked[0].knownHandle, 'sylfley');
});

test('profile Heartopia signal only breaks otherwise equal ranking ties', () => {
  const selected = selectDiversifiedCandidates([
    {
      sourceUrl: 'https://x.com/i/status/501',
      sourceType: 'x',
      sourcePlatform: 'x',
      sourceId: '501',
      discoverySource: 'yahoo-realtime',
      relevanceScore: 12,
      dateMatched: true,
      startSlotMatched: true,
      forecastMatched: false,
      profileHeartopiaMatched: false,
      discoveries: [{ discoverySource: 'yahoo-realtime', searchQuery: 'ハートピア 天気' }]
    },
    {
      sourceUrl: 'https://x.com/i/status/502',
      sourceType: 'x',
      sourcePlatform: 'x',
      sourceId: '502',
      discoverySource: 'yahoo-realtime',
      relevanceScore: 12,
      dateMatched: true,
      startSlotMatched: true,
      forecastMatched: false,
      profileHeartopiaMatched: true,
      discoveries: [{ discoverySource: 'yahoo-realtime', searchQuery: 'ハートピア 天気' }]
    }
  ], 2);
  assert.equal(selected[0].sourceId, '502');
});

test('diversification does not give X or Yahoo Realtime an intrinsic ranking bonus', () => {
  const candidates = [];
  for (let i = 0; i < 8; i++) {
    candidates.push({
      sourceUrl: `https://x.com/i/status/${100 + i}`,
      sourceType: 'x',
      sourceId: String(100 + i),
      discoverySource: 'yahoo-realtime',
      relevanceScore: 15,
      dateMatched: true,
      forecastMatched: true,
      discoveries: [{ discoverySource: 'yahoo-realtime', searchQuery: 'q' }]
    });
  }
  for (let i = 0; i < 4; i++) {
    candidates.push({
      sourceUrl: `https://example${i}.org/weather`,
      sourceType: 'web',
      sourceId: null,
      discoverySource: i % 2 ? 'bing' : 'yahoo-web',
      relevanceScore: 15,
      dateMatched: true,
      forecastMatched: true,
      discoveries: [{ discoverySource: i % 2 ? 'bing' : 'yahoo-web', searchQuery: 'q' }]
    });
  }
  const selected = selectDiversifiedCandidates(candidates, 8);
  assert.ok(selected.some((item) => item.sourceType === 'web'));
  assert.ok(selected.filter((item) => item.discoverySource === 'yahoo-realtime').length <= 4);
});
