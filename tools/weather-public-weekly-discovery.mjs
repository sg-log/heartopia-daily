import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { normalizeCandidateUrl, targetDateTokens, selectDiversifiedCandidates } from './weather-public-discovery.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(args['--target-date'] || '')) throw new Error('Invalid --target-date');
  if (!args['--out']) throw new Error('Missing --out');
  return { targetDate: args['--target-date'], out: args['--out'] };
}

export function buildWeeklyQueries(targetDate) {
  const [, month, day] = targetDate.split('-').map(Number);
  return [
    `ハートピアスローライフ 週間予報 ${month}月${day}日`,
    `ハートピア 週間天気 ${month}月${day}日`,
    `Heartopia weekly weather forecast ${targetDate}`,
    'ハートピアスローライフ 週間予報',
    'Heartopia 7 day weather forecast'
  ];
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function hasGameContext(s) {
  if (s.includes('ハートピアスローライフ') || s.includes('#ハートピア') || s.includes('heartopia')) return true;
  if (!s.includes('ハートピア')) return false;
  return ['ゲーム','攻略','オーク','蛍石','流星群','ギフトコード','イベント','スローライフ','npc'].some(token => s.includes(token));
}

function hasExplicitWeeklyForecast(s) {
  return s.includes('週間天気') || s.includes('週間予報') || s.includes('週間の天気') ||
    s.includes('weekly weather') || s.includes('weekly forecast') || s.includes('week forecast') ||
    /7日(?:間)?(?:の)?(?:天気|予報)/.test(s) || /7[ -]?day (?:weather|forecast)/.test(s);
}

export function weeklyRelevance(text, targetDate) {
  const s = normalizeText(text);
  const hasGame = hasGameContext(s);
  const hasWeather = s.includes('天気') || s.includes('weather') || s.includes('予報') || s.includes('forecast');
  const hasWeekly = hasExplicitWeeklyForecast(s);
  const dateMatched = targetDateTokens(targetDate).some(token => s.includes(token));
  let score = 0;
  if (hasGame) score += 6;
  if (hasWeather) score += 4;
  if (hasWeekly) score += 7;
  if (dateMatched) score += 6;
  return { relevant: hasGame && hasWeather && hasWeekly, dateMatched, weeklyMatched: hasWeekly, score };
}

function providerUrl(provider, query) {
  const q = encodeURIComponent(query);
  if (provider === 'bing') return `https://www.bing.com/search?q=${q}`;
  if (provider === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${q}`;
  if (provider === 'yahoo-web') return `https://search.yahoo.co.jp/search?p=${q}`;
  if (provider === 'yahoo-realtime') return `https://search.yahoo.co.jp/realtime/search?p=${q}`;
  throw new Error(`Unknown provider ${provider}`);
}

function isKnownRealWorldWeatherPage(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'tenki.jp' || host.endsWith('.tenki.jp') ||
      host === 'weathernews.jp' || host.endsWith('.weathernews.jp') ||
      host === 'mapion.co.jp' || host.endsWith('.mapion.co.jp') ||
      host === 'toshin.com' || host.endsWith('.toshin.com');
  } catch { return false; }
}

async function collectFromPage(page, provider, query, targetDate, limit = 50) {
  const url = providerUrl(provider, query);
  const result = { provider, query, url, status: 'ok', error: null, linksSeen: 0, candidates: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const rows = await page.locator('a[href]').evaluateAll(els => els.slice(0, 350).map(a => {
      const anchorText = (a.innerText || a.textContent || '').trim();
      let node = a.parentElement;
      let bestText = (node?.innerText || '').trim();
      for (let depth = 0; depth < 9 && node; depth += 1) {
        const candidateText = (node.innerText || '').trim();
        const normalized = candidateText.replace(/\s+/g, ' ').toLowerCase();
        const hasGame = normalized.includes('ハートピアスローライフ') || normalized.includes('#ハートピア') || normalized.includes('heartopia') ||
          (normalized.includes('ハートピア') && ['ゲーム','攻略','流星群','ギフトコード','オーク','蛍石'].some(token => normalized.includes(token)));
        const hasWeather = normalized.includes('天気') || normalized.includes('weather') || normalized.includes('予報') || normalized.includes('forecast');
        const hasWeekly = normalized.includes('週間天気') || normalized.includes('週間予報') || normalized.includes('weekly weather') || normalized.includes('weekly forecast') || /7日(?:間)?(?:の)?(?:天気|予報)/.test(normalized) || /7[ -]?day (?:weather|forecast)/.test(normalized);
        if (candidateText.length > bestText.length && candidateText.length <= 1800) bestText = candidateText;
        if (candidateText.length >= 40 && candidateText.length <= 1800 && hasGame && hasWeather && hasWeekly) {
          bestText = candidateText;
          break;
        }
        node = node.parentElement;
      }
      return { href: a.href || '', text: anchorText, parentText: bestText.slice(0, 1500) };
    }));
    result.linksSeen = rows.length;
    for (const row of rows) {
      const normalized = normalizeCandidateUrl(row.href);
      if (!normalized || isKnownRealWorldWeatherPage(normalized.url)) continue;
      const contextText = `${row.text} ${row.parentText}`;
      const relevance = weeklyRelevance(contextText, targetDate);
      if (!relevance.relevant) continue;
      result.candidates.push({
        sourceUrl: normalized.url,
        sourceType: normalized.sourceType,
        sourceId: normalized.sourceId,
        discoverySource: provider,
        searchQuery: query,
        anchorText: row.text.slice(0, 300),
        context: row.parentText.slice(0, 1200),
        relevanceScore: relevance.score,
        dateMatched: relevance.dateMatched,
        weeklyMatched: relevance.weeklyMatched
      });
      if (result.candidates.length >= limit) break;
    }
  } catch (error) {
    result.status = 'failed';
    result.error = String(error?.message || error).slice(0, 500);
  }
  return result;
}

export function mergeWeeklyCandidates(attempts, targetDate, limit = 24) {
  const merged = new Map();
  for (const attempt of attempts || []) {
    for (const candidate of attempt.candidates || []) {
      if (!candidate.sourceUrl || isKnownRealWorldWeatherPage(candidate.sourceUrl)) continue;
      if (!merged.has(candidate.sourceUrl)) merged.set(candidate.sourceUrl, { ...candidate, discoveries: [] });
      const record = merged.get(candidate.sourceUrl);
      record.discoveries.push({ discoverySource: candidate.discoverySource, searchQuery: candidate.searchQuery });
      const relevance = weeklyRelevance(`${record.anchorText || ''} ${record.context || ''}`, targetDate);
      record.relevanceScore = Math.max(Number(record.relevanceScore || 0), relevance.score);
      record.dateMatched = Boolean(record.dateMatched || relevance.dateMatched);
      record.weeklyMatched = Boolean(record.weeklyMatched || relevance.weeklyMatched);
    }
  }
  const ranked = [...merged.values()]
    .filter(candidate => weeklyRelevance(`${candidate.anchorText || ''} ${candidate.context || ''}`, targetDate).relevant)
    .sort((a, b) =>
      Number(Boolean(b.dateMatched)) - Number(Boolean(a.dateMatched)) ||
      Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0) ||
      b.discoveries.length - a.discoveries.length ||
      String(a.sourceUrl).localeCompare(String(b.sourceUrl))
    );
  return selectDiversifiedCandidates(ranked, limit);
}

export async function discoverWeekly(targetDate) {
  const queries = buildWeeklyQueries(targetDate);
  const providers = ['bing', 'duckduckgo', 'yahoo-web', 'yahoo-realtime'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await context.newPage();
  const attempts = [];
  try {
    for (const provider of providers) {
      const providerQueries = provider === 'yahoo-realtime' ? [queries[0], queries[1], queries[3]] : queries.slice(0, 3);
      for (const query of providerQueries) attempts.push(await collectFromPage(page, provider, query, targetDate));
    }
  } finally {
    await browser.close();
  }
  const candidates = mergeWeeklyCandidates(attempts, targetDate, 24);
  return {
    schemaVersion: 1,
    responseType: 'weather-public-weekly-discovery',
    targetDate,
    generatedAt: new Date().toISOString(),
    attempts: attempts.map(({ provider, query, status, error, linksSeen, candidates }) => ({ provider, query, status, error, linksSeen, candidateCount: candidates.length })),
    candidates
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { targetDate, out } = parseArgs(process.argv.slice(2));
  const result = await discoverWeekly(targetDate);
  await fs.writeFile(out, `${JSON.stringify(result)}\n`, 'utf8');
  console.log(JSON.stringify({
    candidateCount: result.candidates.length,
    candidates: result.candidates.map(candidate => ({
      sourceUrl: candidate.sourceUrl,
      sourceType: candidate.sourceType,
      relevanceScore: candidate.relevanceScore,
      dateMatched: candidate.dateMatched,
      discoverySource: candidate.discoverySource,
      discoveryCount: candidate.discoveries?.length || 0
    })),
    attempts: result.attempts
  }));
}
