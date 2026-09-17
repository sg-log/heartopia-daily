import { chromium } from 'playwright';
import fs from 'node:fs/promises';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(args['--target-date'] || '')) throw new Error('Invalid --target-date');
  if (!args['--out']) throw new Error('Missing --out');
  return { targetDate: args['--target-date'], out: args['--out'] };
}

function sourcePlatformForHost(host) {
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

    // The weather finder is WEB-first. X/Twitter and Yahoo! realtime are
    // deliberately not candidate sources; even if a normal search engine
    // surfaces them, fail closed here instead of sending them downstream.
    if (
      host === 'x.com' || host === 'www.x.com' ||
      host === 'twitter.com' || host === 'www.twitter.com' ||
      host === 't.co' || host === 'pic.x.com'
    ) return null;

    if (host.endsWith('search.yahoo.co.jp')) return null;
    if (host.endsWith('bing.com') || host.endsWith('duckduckgo.com')) return null;

    u.hash = '';
    return {
      url: u.toString(),
      sourceType: 'web',
      sourcePlatform: sourcePlatformForHost(host),
      sourceId: null
    };
  }
  return null;
}

export function buildQueries(targetDate) {
  const [, month, day] = targetDate.split('-').map(Number);
  return [
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

export function candidateRelevance(text, targetDate) {
  const s = normalizeSearchText(text);
  const hasGame = s.includes('ハートピア') || s.includes('heartopia');
  const hasWeather = s.includes('天気') || s.includes('weather') || s.includes('予報') || s.includes('forecast');
  const dateMatched = targetDateTokens(targetDate).some((token) => s.includes(token));
  const forecastMatched = s.includes('天気予報') || s.includes('今日の天気') || s.includes('weather forecast');
  let score = 0;
  if (hasGame) score += 4;
  if (hasWeather) score += 4;
  if (dateMatched) score += 5;
  if (forecastMatched) score += 2;
  return { relevant: hasGame && hasWeather, dateMatched, forecastMatched, score };
}

function providerUrl(provider, query) {
  const q = encodeURIComponent(query);
  if (provider === 'bing') return `https://www.bing.com/search?q=${q}`;
  if (provider === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${q}`;
  if (provider === 'yahoo-web') return `https://search.yahoo.co.jp/search?p=${q}`;
  throw new Error(`Unknown provider ${provider}`);
}

async function collectFromPage(page, provider, query, targetDate, limit = 40) {
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
      const relevance = candidateRelevance(contextText, targetDate);
      if (!relevance.relevant) continue;
      result.candidates.push({
        sourceUrl: normalized.url,
        sourceType: normalized.sourceType,
        sourcePlatform: normalized.sourcePlatform,
        sourceId: normalized.sourceId,
        discoverySource: provider,
        searchQuery: query,
        anchorText: row.text.slice(0, 300),
        context: row.parentText.slice(0, 1000),
        relevanceScore: relevance.score,
        dateMatched: relevance.dateMatched,
        forecastMatched: relevance.forecastMatched
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
    const platform = candidate.sourcePlatform || 'web';
    platformCounts.set(platform, (platformCounts.get(platform) || 0) + 1);
    return true;
  };

  // Diversify by ordinary web search provider and destination platform.
  // Relevance/date evidence still controls ranking; no platform is preferred.
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const platform = candidate.sourcePlatform || 'web';
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

export function mergeAndRankCandidates(attempts, targetDate, limit = 24) {
  const merged = new Map();
  for (const attempt of attempts || []) {
    for (const c of attempt.candidates || []) {
      const key = c.sourceUrl;
      if (!key) continue;
      if (!merged.has(key)) merged.set(key, { ...c, discoveries: [] });
      const record = merged.get(key);
      record.discoveries.push({ discoverySource: c.discoverySource, searchQuery: c.searchQuery });
      const relevance = candidateRelevance(`${record.anchorText || ''} ${record.context || ''}`, targetDate);
      record.relevanceScore = Math.max(Number(record.relevanceScore || 0), relevance.score);
      record.dateMatched = Boolean(record.dateMatched || relevance.dateMatched);
      record.forecastMatched = Boolean(record.forecastMatched || relevance.forecastMatched);
    }
  }
  const relevant = [...merged.values()].filter((candidate) =>
    candidateRelevance(`${candidate.anchorText || ''} ${candidate.context || ''}`, targetDate).relevant
  );
  return selectDiversifiedCandidates(relevant, limit);
}

export async function discover(targetDate) {
  const queries = buildQueries(targetDate);
  // Ordinary web search only. Do not call Yahoo! realtime and do not search X directly.
  const providers = ['bing', 'duckduckgo', 'yahoo-web'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await context.newPage();
  const attempts = [];
  try {
    for (const provider of providers) {
      for (const query of queries) attempts.push(await collectFromPage(page, provider, query, targetDate));
    }
  } finally {
    await browser.close();
  }

  const candidates = mergeAndRankCandidates(attempts, targetDate, 24);
  return {
    schemaVersion: 2,
    responseType: 'weather-public-web-discovery',
    targetDate,
    generatedAt: new Date().toISOString(),
    attempts: attempts.map(({ provider, query, status, error, linksSeen, candidates }) => ({ provider, query, status, error, linksSeen, candidateCount: candidates.length })),
    candidates
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { targetDate, out } = parseArgs(process.argv.slice(2));
  const result = await discover(targetDate);
  await fs.writeFile(out, `${JSON.stringify(result)}\n`, 'utf8');
  console.log(JSON.stringify({
    candidateCount: result.candidates.length,
    candidates: result.candidates.map((candidate) => ({
      sourceUrl: candidate.sourceUrl,
      sourceType: candidate.sourceType,
      sourcePlatform: candidate.sourcePlatform,
      relevanceScore: candidate.relevanceScore,
      dateMatched: candidate.dateMatched,
      discoverySource: candidate.discoverySource,
      discoveryCount: candidate.discoveries?.length || 0
    })),
    attempts: result.attempts
  }));
}
