import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(args['--target-date'] || '')) throw new Error('Invalid --target-date');
  if (!args['--out']) throw new Error('Missing --out');
  const slot = String(args['--slot'] || '').trim();
  if (slot && !['morning','evening'].includes(slot)) throw new Error('Invalid --slot');
  return { targetDate: args['--target-date'], out: args['--out'], slot, comparisonSourcesFile:args['--comparison-sources-file'] || '' };
}

function sourcePlatformForHost(host) {
  if (host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com') return 'x';
  if (host === 'instagram.com' || host === 'www.instagram.com') return 'instagram';
  if (host === 'tiktok.com' || host === 'www.tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'youtu.be') return 'youtube';
  return 'web';
}

export function normalizeCandidateUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  for (let i = 0; i < 3; i++) {
    let u;
    try { u = new URL(text); } catch { return null; }
    if (u.protocol !== 'https:') return null;

    const redirectKeys = ['uddg', 'url', 'u', 'target'];
    if (/(^|\.)google\./.test(u.hostname.toLowerCase()) || u.hostname.toLowerCase() === 'google.com') redirectKeys.push('q');
    for (const key of redirectKeys) {
      const nested = u.searchParams.get(key);
      if (nested && /^https%?3A|^https:\/\//i.test(nested)) {
        try { text = decodeURIComponent(nested); } catch { text = nested; }
        u = null;
        break;
      }
    }
    if (!u) continue;

    const host = u.hostname.toLowerCase();
    const platform = sourcePlatformForHost(host);

    // Search navigation, account and policy links are not result evidence.
    if (['login.yahoo.co.jp', 'support.yahoo-net.jp', 'btoptout.yahoo.co.jp', 'privacy.lycorp.co.jp',
      'www.lycorp.co.jp', 'www.lycbiz.com', 'stamp.yahoo.co.jp'].includes(host)) return null;
    if (['www.yahoo.co.jp', 'yahoo.co.jp', 'chiebukuro.yahoo.co.jp'].includes(host) && u.pathname === '/') return null;

    if (platform === 'x') {
      const status = u.pathname.match(/^\/(?:i\/status|[A-Za-z0-9_]+\/status)\/(\d+)(?:\/(?:photo|video)\/[1-4])?\/?$/);
      if (!status) return null;
      const handle = u.pathname.match(/^\/([A-Za-z0-9_]+)\/status\//)?.[1] || '';
      return {
        url: `https://x.com/i/status/${status[1]}`,
        sourceType: 'x',
        sourcePlatform: 'x',
        sourceId: status[1],
        sourceHandle: handle
      };
    }

    if (host === 't.co' || host === 'pic.x.com') return null;
    if (host.endsWith('bing.com') || host.endsWith('duckduckgo.com') || host.endsWith('search.yahoo.co.jp') || /(^|\.)google\./.test(host) || host === 'google.com') return null;

    u.hash = '';
    return {
      url: u.toString(),
      sourceType: 'web',
      sourcePlatform: platform,
      sourceId: null
    };
  }
  return null;
}

function expectedStartSlotFor(slot) {
  return slot === 'morning' ? '06' : slot === 'evening' ? '18' : '';
}

function startSlotTokens(slot) {
  const start = expectedStartSlotFor(slot);
  if (!start) return [];
  const hour = String(Number(start));
  return [`${start}:00`, `${hour}:00`, `${start}時`, `${hour}時`, `${start}時開始`, `${hour}時開始`].map(v => v.toLowerCase());
}

export const DISCOVERY_PROVIDERS = ['bing', 'duckduckgo', 'yahoo-web', 'yahoo-realtime', 'google'];

export function buildQueries(targetDate, slot = '') {
  const [, month, day] = targetDate.split('-').map(Number);
  const start = expectedStartSlotFor(slot);
  const slotQueries = start ? [
    `ハートピア 天気 ${month}月${day}日 ${start}:00`,
    `ハートピア お天気予報 ${month}月${day}日 ${start}:00`
  ] : [];
  return [
    ...slotQueries,
    `ハートピア 天気 ${month}月${day}日`,
    `ハートピア スローライフ 天気 ${month}月${day}日`,
    `ハートピア 週間天気 ${month}月${day}日`,
    `ハートピア お天気 ${month}/${day}`,
    `ハートピア 天気予報 ${month}/${day}`,
    `Heartopia weather ${targetDate}`,
    `Heartopia weekly forecast ${targetDate}`,
    'ハートピア 天気',
    'Heartopia weather'
  ];
}

export function buildDynamicAuthorQueries(provider, handle, targetDate, slot = '') {
  if (!DISCOVERY_PROVIDERS.includes(provider)) return [];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) return [];
  const [, month, day] = targetDate.split('-').map(Number);
  const start = expectedStartSlotFor(slot);
  if (!start) return [];

  if (provider === 'yahoo-realtime') {
    const slashDate = targetDate.replaceAll('-', '/');
    return [
      `@${handle} ${slashDate} ${start}:00`,
      `@${handle} ${month}/${day} ${start}:00`,
      `${handle} ${month}/${day} ${start}:00`
    ];
  }

  return [
    `site:x.com/${handle}/status ${targetDate} ${start}:00`,
    `site:x.com/${handle}/status ${month}/${day} ${start}:00`,
    `site:x.com/${handle}/status ${month}月${day}日 ${start}:00`
  ];
}

function normalizeSearchText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function profileHeartopiaSignals(text) {
  const s = normalizeSearchText(text);
  const matchedTerms = ['ハートピア', 'heartopia'].filter((term) => s.includes(term));
  return {
    matched: matchedTerms.length > 0,
    matchedTerms
  };
}

export function extractXHandleFromText(text) {
  const match = String(text || '').match(/@([A-Za-z0-9_]{1,15})\b/);
  return match ? match[1] : '';
}

export function targetDateTokens(targetDate) {
  const match = String(targetDate || '').match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return [
    `${year}-${mm}-${dd}`,
    `${year}/${mm}/${dd}`,
    `${year}.${mm}.${dd}`,
    `${year}年${month}月${day}日`,
    `${month}月${day}日`,
    `${month}/${day}`,
    `${mm}/${dd}`
  ].map((value) => value.toLowerCase());
}

export function candidateRelevance(text, targetDate, slot = '') {
  const s = normalizeSearchText(text);
  const hasGame = s.includes('ハートピア') || s.includes('heartopia');
  const hasWeather = s.includes('天気') || s.includes('weather') || s.includes('予報') || s.includes('forecast');
  const dateMatched = targetDateTokens(targetDate).some((token) => s.includes(token));
  const forecastMatched = s.includes('天気予報') || s.includes('今日の天気') || s.includes('週間天気') || s.includes('週間予報') || s.includes('weather forecast') || s.includes('weekly forecast');
  const startSlotMatched = startSlotTokens(slot).some((token) => s.includes(token));
  let score = 0;
  if (hasGame) score += 4;
  if (hasWeather) score += 4;
  if (dateMatched) score += 5;
  if (forecastMatched) score += 2;
  if (startSlotMatched) score += 7;
  return { relevant: hasGame && hasWeather, dateMatched, forecastMatched, startSlotMatched, score };
}

function firstExplicitHour(text) {
  const match = normalizeSearchText(text).match(/(?:^|[\s、,;（(])([0-2]?\d)(?::00|時)/);
  return match ? String(Number(match[1])).padStart(2, '0') : '';
}

export function isSearchContextFallback({ sourceType, searchQuery, text }, targetDate, slot = '') {
  if (sourceType !== 'x' || !slot) return false;
  const queryRelevance = candidateRelevance(searchQuery, targetDate, slot);
  if (!queryRelevance.relevant) return false;
  const postRelevance = candidateRelevance(text, targetDate, slot);
  return postRelevance.dateMatched && firstExplicitHour(text) === expectedStartSlotFor(slot);
}

export function isDynamicAuthorFallback({ sourceType, sourceHandle, dynamicHandle, text }, targetDate, slot = '') {
  if (sourceType !== 'x' || !dynamicHandle || !slot) return false;
  if (String(sourceHandle || '').toLowerCase() !== String(dynamicHandle).toLowerCase()) return false;
  const postRelevance = candidateRelevance(text, targetDate, slot);
  return postRelevance.dateMatched && firstExplicitHour(text) === expectedStartSlotFor(slot);
}
export function isComparisonAuthorFallback({sourceType,sourceHandle,comparisonHandle,text},targetDate) {
  if(sourceType!=='x'||!comparisonHandle||String(sourceHandle||'').toLowerCase()!==String(comparisonHandle).toLowerCase())return false;
  // Known comparison accounts may use short captions or the abbreviated game
  // hashtag. Discovery is only a candidate gate; image date/identity stay strict.
  return candidateRelevance(text,targetDate).dateMatched || /天気|予報|weather|forecast/i.test(text||'');
}

async function inspectPublicXProfile(page, handle) {
  const result = {
    handle,
    status: 'not-checked',
    heartopiaMatched: false,
    matchedTerms: []
  };
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) return result;

  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(800);
    const description = await page.locator('[data-testid="UserDescription"]').first().innerText({ timeout: 1500 }).catch(() => '');
    const metaDescription = await page.locator('meta[name="description"]').first().getAttribute('content').catch(() => '');
    const ogDescription = await page.locator('meta[property="og:description"]').first().getAttribute('content').catch(() => '');
    const signals = profileHeartopiaSignals(`${description || ''} ${metaDescription || ''} ${ogDescription || ''}`);
    result.status = 'ok';
    result.heartopiaMatched = signals.matched;
    result.matchedTerms = signals.matchedTerms;
  } catch (err) {
    result.status = 'failed';
    result.error = String(err?.message || err).slice(0, 240);
  }
  return result;
}

function providerUrl(provider, query) {
  const q = encodeURIComponent(query);
  if (provider === 'bing') return `https://www.bing.com/search?q=${q}`;
  if (provider === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${q}`;
  if (provider === 'yahoo-web') return `https://search.yahoo.co.jp/search?p=${q}`;
  if (provider === 'yahoo-realtime') return `https://search.yahoo.co.jp/realtime/search?p=${q}`;
  if (provider === 'google') return `https://www.google.com/search?q=${q}&num=20&hl=ja`;
  throw new Error(`Unknown provider ${provider}`);
}

async function collectFromPage(page, provider, query, targetDate, slot = '', limit = 40, dynamicHandle = '', comparisonHandle = '') {
  const url = providerUrl(provider, query);
  const result = { provider, query, url, status: 'ok', error: null, linksSeen: 0, candidates: [], diagnostics: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const rows = await page.locator('a[href]').evaluateAll((els) => els.slice(0, 300).map((a) => {
      const anchorText = (a.innerText || a.textContent || '').trim();
      let node = a.parentElement;
      let bestText = (node?.innerText || '').trim();
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const candidateText = (node.innerText || '').trim();
        const normalized = candidateText.replace(/\s+/g, ' ').toLowerCase();
        const hasGame = normalized.includes('ハートピア') || normalized.includes('heartopia');
        const hasWeather = normalized.includes('天気') || normalized.includes('weather') || normalized.includes('予報') || normalized.includes('forecast');
        if (candidateText.length > bestText.length && candidateText.length <= 1600) bestText = candidateText;
        if (candidateText.length >= 40 && candidateText.length <= 1600 && hasGame && hasWeather) {
          bestText = candidateText;
          break;
        }
        node = node.parentElement;
      }
      return { href: a.href || '', text: anchorText, parentText: bestText.slice(0, 1200) };
    }));
    result.linksSeen = rows.length;
    for (const row of rows) {
      const normalized = normalizeCandidateUrl(row.href);
      if (!normalized) continue;
      const contextText = `${row.text} ${row.parentText}`;
      const relevance = candidateRelevance(contextText, targetDate, slot);
      const sourceHandle = normalized.sourceHandle || (normalized.sourceType === 'x' ? extractXHandleFromText(contextText) : '');
      const searchContextFallback = !relevance.relevant && isSearchContextFallback({
        sourceType: normalized.sourceType,
        searchQuery: query,
        text: contextText
      }, targetDate, slot);
      const dynamicAuthorFallback = !relevance.relevant && isDynamicAuthorFallback({
        sourceType: normalized.sourceType,
        sourceHandle,
        dynamicHandle,
        text: contextText
      }, targetDate, slot);
      const comparisonAuthorFallback=!relevance.relevant&&isComparisonAuthorFallback({sourceType:normalized.sourceType,sourceHandle,comparisonHandle,text:contextText},targetDate);
      const keepReason = relevance.relevant
        ? 'strict-text'
        : searchContextFallback
          ? 'search-context-fallback'
          : dynamicAuthorFallback
            ? 'dynamic-author-fallback'
            : comparisonAuthorFallback ? 'comparison-author-fallback' : 'dropped-text-gate';
      if (normalized.sourceType === 'x' && result.diagnostics.length < 120) {
        result.diagnostics.push({
          sourceUrl: normalized.url,
          sourceId: normalized.sourceId,
          sourceHandle,
          keepReason,
          kept: keepReason !== 'dropped-text-gate',
          dateMatched: relevance.dateMatched,
          startSlotMatched: relevance.startSlotMatched,
          firstExplicitHour: firstExplicitHour(contextText)
        });
      }
      if (!relevance.relevant && !searchContextFallback && !dynamicAuthorFallback && !comparisonAuthorFallback) continue;
      result.candidates.push({
        sourceUrl: normalized.url,
        sourceType: normalized.sourceType,
        sourcePlatform: normalized.sourcePlatform,
        sourceId: normalized.sourceId,
        sourceHandle,
        discoverySource: provider,
        searchQuery: query,
        anchorText: row.text.slice(0, 300),
        context: row.parentText.slice(0, 1000),
        relevanceScore: relevance.score,
        dateMatched: relevance.dateMatched,
        forecastMatched: relevance.forecastMatched,
        startSlotMatched: relevance.startSlotMatched,
        strictTextRelevant: relevance.relevant,
        searchContextFallback,
        dynamicAuthorFallback,
        comparisonAuthorFallback,
        dynamicHandle: dynamicHandle || ''
      });
      if (result.candidates.length >= limit) break;
    }
  } catch (err) {
    result.status = 'failed';
    result.error = String(err?.message || err).slice(0, 500);
  }
  return result;
}

function rankCandidates(candidates) {
  return [...candidates].sort((a, b) =>
    Number(Boolean(b.dateMatched)) - Number(Boolean(a.dateMatched)) ||
    Number(Boolean(b.startSlotMatched)) - Number(Boolean(a.startSlotMatched)) ||
    Number(Boolean(b.profileHeartopiaMatched)) - Number(Boolean(a.profileHeartopiaMatched)) ||
    Number(Boolean(b.forecastMatched)) - Number(Boolean(a.forecastMatched)) ||
    Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0) ||
    b.discoveries.length - a.discoveries.length ||
    String(a.sourceUrl).localeCompare(String(b.sourceUrl))
  );
}

export function selectDiversifiedCandidates(candidates, limit = 24) {
  const ranked = rankCandidates(candidates);
  const selected = [];
  const selectedUrls = new Set();
  const providerCounts = new Map();
  const platformCounts = new Map();
  const authorCounts = new Map();
  const providerCap = Math.max(3, Math.ceil(limit / 3));
  const platformCap = Math.max(4, Math.ceil(limit * 0.5));
  const authorCap = Math.max(2, Math.ceil(limit / 6));
  const add = (candidate) => {
    if (selectedUrls.has(candidate.sourceUrl)) return false;
    selected.push(candidate);
    selectedUrls.add(candidate.sourceUrl);
    providerCounts.set(candidate.discoverySource, (providerCounts.get(candidate.discoverySource) || 0) + 1);
    const platform = candidate.sourcePlatform || candidate.sourceType || 'web';
    platformCounts.set(platform, (platformCounts.get(platform) || 0) + 1);
    const handle = String(candidate.sourceHandle || '').toLowerCase();
    if (handle) authorCounts.set(handle, (authorCounts.get(handle) || 0) + 1);
    return true;
  };

  // Put one result per author ahead of additional posts by the same author.
  // This applies inside the bounded review budget, not merely to the tail of the pool.
  const firstAuthors = new Set();
  for (const candidate of ranked) {
    if (selected.length >= Math.min(limit, 8)) break;
    const handle = String(candidate.sourceHandle || '').toLowerCase();
    const author = handle ? `x:${handle}` : candidate.sourceType === 'x' ? candidate.sourceUrl : new URL(candidate.sourceUrl).hostname;
    if (firstAuthors.has(author)) continue;
    firstAuthors.add(author);
    add(candidate);
  }

  // Search route and destination platform diversify the pool only. They do not
  // determine truth: date/game/weather relevance ranks candidates, and later
  // stages must verify the actual in-game weather UI image.
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const platform = candidate.sourcePlatform || candidate.sourceType || 'web';
    const handle = String(candidate.sourceHandle || '').toLowerCase();
    if ((providerCounts.get(candidate.discoverySource) || 0) >= providerCap) continue;
    if ((platformCounts.get(platform) || 0) >= platformCap) continue;
    if (handle && (authorCounts.get(handle) || 0) >= authorCap) continue;
    add(candidate);
  }
  // Relax provider/platform caps first, but keep per-author diversity while
  // there are still alternatives from other authors.
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const handle = String(candidate.sourceHandle || '').toLowerCase();
    if (handle && (authorCounts.get(handle) || 0) >= authorCap) continue;
    add(candidate);
  }
  // Only if diversity cannot fill the bounded pool do we relax the author cap.
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    add(candidate);
  }
  return selected;
}

export function mergeAndRankCandidates(attempts, targetDate, limit = 24, slot = '') {
  const merged = new Map();
  for (const attempt of attempts || []) {
    for (const c of attempt.candidates || []) {
      const key = c.sourceUrl;
      if (!key) continue;
      if (!merged.has(key)) merged.set(key, { ...c, discoveries: [] });
      const record = merged.get(key);
      record.discoveries.push({ discoverySource: c.discoverySource, searchQuery: c.searchQuery });
      const relevance = candidateRelevance(`${record.anchorText || ''} ${record.context || ''}`, targetDate, slot);
      record.relevanceScore = Math.max(Number(record.relevanceScore || 0), relevance.score);
      record.dateMatched = Boolean(record.dateMatched || relevance.dateMatched);
      record.forecastMatched = Boolean(record.forecastMatched || relevance.forecastMatched);
      record.startSlotMatched = Boolean(record.startSlotMatched || relevance.startSlotMatched);
      record.strictTextRelevant = Boolean(record.strictTextRelevant || relevance.relevant);
      record.searchContextFallback = Boolean(record.searchContextFallback || c.searchContextFallback);
      record.dynamicAuthorFallback = Boolean(record.dynamicAuthorFallback || c.dynamicAuthorFallback);
      record.comparisonAuthorFallback = Boolean(record.comparisonAuthorFallback || c.comparisonAuthorFallback);
      record.profileHeartopiaMatched = Boolean(record.profileHeartopiaMatched || c.profileHeartopiaMatched);
      record.profileHeartopiaTerms = [...new Set([...(record.profileHeartopiaTerms || []), ...(c.profileHeartopiaTerms || [])])];
      if (!record.profileCheckStatus && c.profileCheckStatus) record.profileCheckStatus = c.profileCheckStatus;
      if (!record.dynamicHandle && c.dynamicHandle) record.dynamicHandle = c.dynamicHandle;
      if (!record.sourceHandle && c.sourceHandle) record.sourceHandle = c.sourceHandle;
    }
  }
  const relevant = [...merged.values()].filter((candidate) => {
    const strict = candidateRelevance(`${candidate.anchorText || ''} ${candidate.context || ''}`, targetDate, slot).relevant;
    return strict || candidate.searchContextFallback === true || candidate.dynamicAuthorFallback === true || candidate.comparisonAuthorFallback === true;
  });
  return selectDiversifiedCandidates(relevant, limit);
}

export function comparisonSourceQueries(targetDate, handles) {
  if(!Array.isArray(handles) || handles.length>10 || handles.some(h=>typeof h!=='string' || !/^[A-Za-z0-9_]{1,15}$/.test(h))) throw Error('Invalid private source configuration');
  const [,month,day]=targetDate.split('-').map(Number);
  return [...new Set(handles)].flatMap(handle=>[
    `from:${handle} 天気 ${month}/${day}`,
    `@${handle} ${month}月${day}日`
  ]);
}

export async function discover(targetDate, slot = '', comparisonHandles = []) {
  // Explicit comparison mode only; the normal scheduled collector passes no handles.
  const fixedQueries=comparisonSourceQueries(targetDate,comparisonHandles);
  const queries = fixedQueries.length ? fixedQueries : buildQueries(targetDate, slot);
  // Invariant: no person and no single search provider is fixed as the truth source.
  // Every configured public search route gets the same generic Heartopia-weather
  // queries. Authors are discovered from the current run, then optionally expanded.
  const providers = fixedQueries.length ? ['yahoo-realtime','bing'] : DISCOVERY_PROVIDERS;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await context.newPage();
  const attempts = [];
  const profileChecks = [];
  const dynamicHandles = [];
  try {
    // First pass: broad multi-provider discovery with no author fixed in advance.
    await Promise.all(providers.map(async provider => {
      const searchPage=await context.newPage();
      try { for(const query of queries) {
        const comparisonHandle=fixedQueries.length ? query.match(/(?:from:|@)([A-Za-z0-9_]+)/)?.[1] || '' : '';
        attempts.push(await collectFromPage(searchPage,provider,query,targetDate,slot,40,'',comparisonHandle));
      } }
      finally { await searchPage.close(); }
    }));

    // Discover authors from this run itself, including visible X results that the
    // text gate dropped. Prefer handles with target-date/current-slot clues.
    const handleScores = new Map();
    for (const attempt of attempts) {
      for (const item of attempt.diagnostics || []) {
        const handle = String(item.sourceHandle || '').trim();
        if (!handle) continue;
        const key = handle.toLowerCase();
        const score =
          (item.dateMatched ? 4 : 0) +
          (item.startSlotMatched ? 3 : 0) +
          (item.kept ? 1 : 0);
        const current = handleScores.get(key);
        if (!current || score > current.score) handleScores.set(key, { handle, score });
      }
    }
    const handlesToCheck = (fixedQueries.length ? [] : [...handleScores.values()])
      .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
      .slice(0, 12)
      .map((item) => item.handle);

    for (const handle of handlesToCheck) {
      const check = await inspectPublicXProfile(page, handle);
      profileChecks.push(check);
      if (check.heartopiaMatched) dynamicHandles.push(handle);
    }

    // Second pass: expand only authors discovered in this run whose public profile
    // contains Heartopia context. This is dynamic and never relies on a saved person.
    await Promise.all(providers.map(async provider => {
      const searchPage=await context.newPage();
      try { for(const handle of dynamicHandles) for(const query of buildDynamicAuthorQueries(provider,handle,targetDate,slot)) {
        attempts.push(await collectFromPage(searchPage,provider,query,targetDate,slot,20,handle));
      }} finally { await searchPage.close(); }
    }));

    const profileByHandle = new Map(
      profileChecks.map((check) => [String(check.handle || '').toLowerCase(), check])
    );
    for (const attempt of attempts) {
      for (const candidate of attempt.candidates || []) {
        const check = profileByHandle.get(String(candidate.sourceHandle || '').toLowerCase());
        if (!check) continue;
        candidate.profileCheckStatus = check.status;
        candidate.profileHeartopiaMatched = check.heartopiaMatched;
        candidate.profileHeartopiaTerms = check.matchedTerms;
      }
    }
  } finally {
    await browser.close();
  }

  const candidates = mergeAndRankCandidates(attempts, targetDate, 24, slot);
  const selectedUrls = new Set(candidates.map((candidate) => candidate.sourceUrl));
  const xTrace = attempts.flatMap((attempt) =>
    (attempt.diagnostics || []).map((item) => ({
      provider: attempt.provider,
      searchQuery: attempt.query,
      ...item,
      selectedFinal: selectedUrls.has(item.sourceUrl)
    }))
  ).slice(0, 600);
  return {
    schemaVersion: 4,
    responseType: 'weather-public-discovery',
    targetDate,
    generatedAt: new Date().toISOString(),
    providers,
    dynamicHandles,
    attempts: attempts.map(({ provider, query, status, error, linksSeen, candidates }) => ({ provider, query, status, error, linksSeen, candidateCount: candidates.length })),
    profileChecks,
    xTrace,
    candidates
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { targetDate, out, slot, comparisonSourcesFile } = parseArgs(process.argv.slice(2));
  const privateConfig=comparisonSourcesFile ? JSON.parse(await fs.readFile(comparisonSourcesFile,'utf8')) : {handles:[]};
  const timer=setTimeout(()=>{console.error('Weather discovery reached its time limit.');process.exit(1);},180000);
  const result = await discover(targetDate, slot, privateConfig.handles);
  clearTimeout(timer);
  await fs.writeFile(out, `${JSON.stringify(result)}\n`, 'utf8');
  console.log(JSON.stringify({candidateCount:result.candidates.length, configuredAccounts:privateConfig.handles.length}));
}
