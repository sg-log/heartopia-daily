import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const REPO_FULL_NAME = 'sg-log/heartopia-daily';
export const SEED_KNOWN_X_AUTHORS = ['sylfley'];
const X_EPOCH_MS = 1288834974657n;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(args['--target-date'] || '')) throw new Error('Invalid --target-date');
  if (!args['--out']) throw new Error('Missing --out');
  const slot = String(args['--slot'] || '').trim();
  if (slot && !['morning','evening'].includes(slot)) throw new Error('Invalid --slot');
  return { targetDate: args['--target-date'], out: args['--out'], slot };
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

    for (const key of ['uddg', 'url', 'u', 'target']) {
      const nested = u.searchParams.get(key);
      if (nested && /^https%?3A|^https:\/\//i.test(nested)) {
        try { text = decodeURIComponent(nested); } catch { text = nested; }
        u = null;
        break;
      }
    }
    if (!u) continue;

    const host = u.hostname.toLowerCase();

    if ((host === 'google.com' || host === 'www.google.com') && u.pathname === '/url') {
      const nested = u.searchParams.get('q') || u.searchParams.get('url');
      if (nested && /^https%?3A|^https:\/\//i.test(nested)) {
        try { text = decodeURIComponent(nested); } catch { text = nested; }
        continue;
      }
    }

    const platform = sourcePlatformForHost(host);

    if (platform === 'x') {
      const iStatus = u.pathname.match(/^\/i\/status\/(\d+)(?:\/(?:photo|video)\/[1-4])?\/?$/);
      const userStatus = u.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:\/(?:photo|video)\/[1-4])?\/?$/);
      if (!iStatus && !userStatus) return null;
      const sourceId = iStatus?.[1] || userStatus?.[2] || '';
      const sourceAuthor = userStatus?.[1]?.toLowerCase() || '';
      return {
        url: `https://x.com/i/status/${sourceId}`,
        sourceType: 'x',
        sourcePlatform: 'x',
        sourceId,
        ...(sourceAuthor ? { sourceAuthor } : {})
      };
    }

    if (host === 't.co' || host === 'pic.x.com') return null;
    if (host.endsWith('bing.com') || host.endsWith('duckduckgo.com') || host.endsWith('search.yahoo.co.jp') || host === 'google.com' || host === 'www.google.com') return null;

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
    `Heartopia weather ${targetDate}`
  ];
}

function normalizeSearchText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
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

export function xStatusJstDate(sourceId) {
  try {
    const id = BigInt(String(sourceId || ''));
    if (id <= 0n) return '';
    const ms = Number((id >> 22n) + X_EPOCH_MS);
    if (!Number.isFinite(ms)) return '';
    const jst = new Date(ms + 9 * 60 * 60 * 1000);
    const year = jst.getUTCFullYear();
    const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
    const day = String(jst.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return '';
  }
}

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

export function isKnownAuthorCandidate({ sourceType, sourceAuthor, sourceId }, targetDate, knownAuthors = SEED_KNOWN_X_AUTHORS) {
  if (sourceType !== 'x') return false;
  const author = normalizeHandle(sourceAuthor);
  if (!author || !knownAuthors.map(normalizeHandle).includes(author)) return false;
  return xStatusJstDate(sourceId) === targetDate;
}

export function buildKnownAuthorQueries(targetDate, slot = '', knownAuthors = SEED_KNOWN_X_AUTHORS) {
  const start = expectedStartSlotFor(slot);
  return knownAuthors.map((raw) => {
    const handle = normalizeHandle(raw);
    return `site:x.com/${handle}/status ${targetDate}${start ? ` ${start}:00` : ''}`;
  });
}

export function extractSuccessfulXSourceUrls(issues) {
  const urls = [];
  const seen = new Set();
  for (const issue of issues || []) {
    const body = String(issue?.body || '');
    if (!body.includes('heartopia-weather-scheduled-success:')) continue;
    for (const match of body.matchAll(/"sourceUrl":"(https:\/\/x\.com\/i\/status\/\d+)"/g)) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        urls.push(match[1]);
      }
    }
  }
  return urls;
}

async function resolveXAuthorFromOembed(sourceUrl) {
  try {
    const u = new URL('https://publish.twitter.com/oembed');
    u.searchParams.set('url', sourceUrl);
    u.searchParams.set('omit_script', 'true');
    u.searchParams.set('dnt', 'true');
    const response = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return '';
    const data = await response.json();
    const authorUrl = new URL(String(data.author_url || ''));
    if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(authorUrl.hostname.toLowerCase())) return '';
    return normalizeHandle(authorUrl.pathname.split('/').filter(Boolean)[0] || '');
  } catch {
    return '';
  }
}

async function discoverKnownXAuthors() {
  const authors = new Set(SEED_KNOWN_X_AUTHORS.map(normalizeHandle));
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO_FULL_NAME}/issues?state=closed&per_page=50&sort=created&direction=desc`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'heartopia-weather-discovery' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return [...authors].filter(Boolean).slice(0, 5);
    const issues = await response.json();
    const sourceUrls = extractSuccessfulXSourceUrls(issues).slice(0, 8);
    const resolved = await Promise.all(sourceUrls.map(resolveXAuthorFromOembed));
    for (const handle of resolved) if (handle) authors.add(handle);
  } catch {
    // Fail soft: the static seed list remains available.
  }
  return [...authors].filter(Boolean).slice(0, 5);
}

export function candidateRelevance(text, targetDate, slot = '') {
  const s = normalizeSearchText(text);
  const hasGame = s.includes('ハートピア') || s.includes('heartopia');
  const hasWeather = s.includes('天気') || s.includes('weather') || s.includes('予報') || s.includes('forecast');
  const dateMatched = targetDateTokens(targetDate).some((token) => s.includes(token));
  const forecastMatched = s.includes('天気予報') || s.includes('今日の天気') || s.includes('weather forecast');
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

export function isSlotContextFallback({ sourceType, discoverySource, searchQuery, text }, targetDate, slot = '') {
  if (sourceType !== 'x' || discoverySource !== 'yahoo-realtime' || !slot) return false;
  const queryRelevance = candidateRelevance(searchQuery, targetDate, slot);
  if (!queryRelevance.relevant || !queryRelevance.startSlotMatched) return false;
  const postRelevance = candidateRelevance(text, targetDate, slot);
  return postRelevance.dateMatched && firstExplicitHour(text) === expectedStartSlotFor(slot);
}

function providerUrl(provider, query) {
  const q = encodeURIComponent(query);
  if (provider === 'google') return `https://www.google.com/search?hl=ja&num=50&q=${q}`;
  if (provider === 'bing') return `https://www.bing.com/search?q=${q}`;
  if (provider === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${q}`;
  if (provider === 'yahoo-web') return `https://search.yahoo.co.jp/search?p=${q}`;
  if (provider === 'yahoo-realtime') return `https://search.yahoo.co.jp/realtime/search?p=${q}`;
  throw new Error(`Unknown provider ${provider}`);
}

async function collectFromPage(page, provider, query, targetDate, slot = '', limit = 40, knownAuthors = SEED_KNOWN_X_AUTHORS) {
  const url = providerUrl(provider, query);
  const result = { provider, query, url, status: 'ok', error: null, linksSeen: 0, candidates: [] };
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
      const queryAuthor = knownAuthors.map(normalizeHandle).find((handle) =>
        handle && normalizeSearchText(query).includes(`x.com/${handle}/status`)
      ) || '';
      const sourceAuthor = normalizeHandle(normalized.sourceAuthor || queryAuthor);
      const slotContextFallback = !relevance.relevant && isSlotContextFallback({
        sourceType: normalized.sourceType,
        discoverySource: provider,
        searchQuery: query,
        text: contextText
      }, targetDate, slot);
      const knownAuthorFallback = !relevance.relevant && !slotContextFallback && isKnownAuthorCandidate({
        sourceType: normalized.sourceType,
        sourceAuthor,
        sourceId: normalized.sourceId
      }, targetDate, knownAuthors);
      if (!relevance.relevant && !slotContextFallback && !knownAuthorFallback) continue;
      result.candidates.push({
        sourceUrl: normalized.url,
        sourceType: normalized.sourceType,
        sourcePlatform: normalized.sourcePlatform,
        sourceId: normalized.sourceId,
        ...(sourceAuthor ? { sourceAuthor } : {}),
        discoverySource: provider,
        searchQuery: query,
        anchorText: row.text.slice(0, 300),
        context: row.parentText.slice(0, 1000),
        relevanceScore: relevance.score,
        dateMatched: relevance.dateMatched,
        forecastMatched: relevance.forecastMatched,
        startSlotMatched: relevance.startSlotMatched,
        strictTextRelevant: relevance.relevant,
        slotContextFallback,
        knownAuthorFallback
      });
      if (result.candidates.length >= limit) break;
    }
  } catch (err) {
    result.status = 'failed';
    result.error = String(err?.message || err).slice(0, 500);
  }
  return result;
}

async function collectKnownAuthorProfile(page, handle, targetDate, slot = '', limit = 8) {
  const normalizedHandle = normalizeHandle(handle);
  const result = {
    provider: 'x-profile',
    query: `@${normalizedHandle}`,
    url: `https://x.com/${normalizedHandle}`,
    status: 'ok',
    error: null,
    linksSeen: 0,
    candidates: []
  };
  if (!normalizedHandle) return result;
  try {
    await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1800);
    const rows = await page.locator('a[href*="/status/"]').evaluateAll((els) => els.slice(0, 200).map((a) => ({
      href: a.href || '',
      text: (a.innerText || a.textContent || '').trim(),
      parentText: (a.parentElement?.parentElement?.innerText || a.parentElement?.innerText || '').trim().slice(0, 1200)
    })));
    result.linksSeen = rows.length;
    const seen = new Set();
    for (const row of rows) {
      const normalized = normalizeCandidateUrl(row.href);
      if (!normalized || normalized.sourceType !== 'x') continue;
      const sourceAuthor = normalizeHandle(normalized.sourceAuthor);
      if (sourceAuthor !== normalizedHandle) continue;
      if (seen.has(normalized.url)) continue;
      seen.add(normalized.url);
      if (!isKnownAuthorCandidate({ sourceType: 'x', sourceAuthor, sourceId: normalized.sourceId }, targetDate, [normalizedHandle])) continue;
      const contextText = `${row.text} ${row.parentText}`;
      const relevance = candidateRelevance(contextText, targetDate, slot);
      result.candidates.push({
        sourceUrl: normalized.url,
        sourceType: 'x',
        sourcePlatform: 'x',
        sourceId: normalized.sourceId,
        sourceAuthor,
        discoverySource: 'x-profile',
        searchQuery: `@${normalizedHandle} public profile`,
        anchorText: row.text.slice(0, 300),
        context: row.parentText.slice(0, 1000),
        relevanceScore: Math.max(relevance.score, 6),
        dateMatched: true,
        forecastMatched: relevance.forecastMatched,
        startSlotMatched: relevance.startSlotMatched,
        strictTextRelevant: relevance.relevant,
        slotContextFallback: false,
        knownAuthorFallback: true
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
    Number(Boolean(b.knownAuthorFallback)) - Number(Boolean(a.knownAuthorFallback)) ||
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
  const providerCap = Math.max(3, Math.ceil(limit / 3));
  const platformCap = Math.max(4, Math.ceil(limit * 0.5));
  const add = (candidate) => {
    if (selectedUrls.has(candidate.sourceUrl)) return false;
    selected.push(candidate);
    selectedUrls.add(candidate.sourceUrl);
    providerCounts.set(candidate.discoverySource, (providerCounts.get(candidate.discoverySource) || 0) + 1);
    const platform = candidate.sourcePlatform || candidate.sourceType || 'web';
    platformCounts.set(platform, (platformCounts.get(platform) || 0) + 1);
    return true;
  };

  // Search route and destination platform diversify the pool only. They do not
  // determine truth: date/game/weather relevance ranks candidates, and later
  // stages must verify the actual in-game weather UI image.
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const platform = candidate.sourcePlatform || candidate.sourceType || 'web';
    if ((providerCounts.get(candidate.discoverySource) || 0) >= providerCap) continue;
    if ((platformCounts.get(platform) || 0) >= platformCap) continue;
    add(candidate);
  }
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
      record.slotContextFallback = Boolean(record.slotContextFallback || c.slotContextFallback);
      record.knownAuthorFallback = Boolean(record.knownAuthorFallback || c.knownAuthorFallback);
      if (!record.sourceAuthor && c.sourceAuthor) record.sourceAuthor = normalizeHandle(c.sourceAuthor);
    }
  }
  const relevant = [...merged.values()].filter((candidate) => {
    const strict = candidateRelevance(`${candidate.anchorText || ''} ${candidate.context || ''}`, targetDate, slot).relevant;
    return strict || candidate.slotContextFallback === true || candidate.knownAuthorFallback === true;
  });
  return selectDiversifiedCandidates(relevant, limit);
}

export async function discover(targetDate, slot = '') {
  const queries = buildQueries(targetDate, slot);
  const knownAuthors = await discoverKnownXAuthors();
  const knownQueries = buildKnownAuthorQueries(targetDate, slot, knownAuthors);
  // Multiple discovery routes are intentionally retained. Google and known
  // public X profiles are fail-soft helpers; CAPTCHA/login walls are never bypassed.
  const providers = ['google', 'bing', 'duckduckgo', 'yahoo-web', 'yahoo-realtime'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await context.newPage();
  const attempts = [];
  try {
    for (const provider of providers) {
      let providerQueries;
      if (provider === 'yahoo-realtime') {
        providerQueries = [queries[0], queries[1], 'ハートピア 天気'];
      } else if (provider === 'google' || provider === 'yahoo-web') {
        providerQueries = [...queries, ...knownQueries];
      } else {
        providerQueries = queries;
      }
      for (const query of providerQueries) {
        attempts.push(await collectFromPage(page, provider, query, targetDate, slot, 40, knownAuthors));
      }
    }
    for (const handle of knownAuthors) {
      attempts.push(await collectKnownAuthorProfile(page, handle, targetDate, slot));
    }
  } finally {
    await browser.close();
  }

  const candidates = mergeAndRankCandidates(attempts, targetDate, 24, slot);
  return {
    schemaVersion: 3,
    responseType: 'weather-public-discovery',
    targetDate,
    generatedAt: new Date().toISOString(),
    knownAuthors,
    attempts: attempts.map(({ provider, query, status, error, linksSeen, candidates }) => ({ provider, query, status, error, linksSeen, candidateCount: candidates.length })),
    candidates
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { targetDate, out, slot } = parseArgs(process.argv.slice(2));
  const result = await discover(targetDate, slot);
  await fs.writeFile(out, `${JSON.stringify(result)}\n`, 'utf8');
  console.log(JSON.stringify({
    candidateCount: result.candidates.length,
    knownAuthors: result.knownAuthors,
    candidates: result.candidates.map((candidate) => ({
      sourceUrl: candidate.sourceUrl,
      sourceType: candidate.sourceType,
      sourcePlatform: candidate.sourcePlatform,
      relevanceScore: candidate.relevanceScore,
      dateMatched: candidate.dateMatched,
      startSlotMatched: candidate.startSlotMatched,
      strictTextRelevant: candidate.strictTextRelevant,
      slotContextFallback: candidate.slotContextFallback,
      knownAuthorFallback: candidate.knownAuthorFallback,
      sourceAuthor: candidate.sourceAuthor || '',
      discoverySource: candidate.discoverySource,
      discoveryCount: candidate.discoveries?.length || 0
    })),
    attempts: result.attempts
  }));
}
