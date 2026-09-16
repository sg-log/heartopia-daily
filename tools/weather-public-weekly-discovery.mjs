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
  const [year, month, day] = targetDate.split('-').map(Number);
  return [
    `ハートピア 週間天気 ${month}月${day}日`,
    `ハートピア 週間予報 ${month}月${day}日`,
    `Heartopia weekly weather forecast ${targetDate}`,
    'ハートピア 週間天気',
    'ハートピア 5日 天気'
  ];
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function weeklyRelevance(text, targetDate) {
  const s = normalizeText(text);
  const hasGame = s.includes('ハートピア') || s.includes('heartopia');
  const hasWeather = s.includes('天気') || s.includes('weather') || s.includes('予報') || s.includes('forecast');
  const hasWeekly = s.includes('週間') || s.includes('weekly') || s.includes('week forecast') || s.includes('5日') || s.includes('五日') || s.includes('7日') || s.includes('七日');
  const dateMatched = targetDateTokens(targetDate).some(token => s.includes(token));
  let score = 0;
  if (hasGame) score += 4;
  if (hasWeather) score += 4;
  if (hasWeekly) score += 5;
  if (dateMatched) score += 5;
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
        const hasGame = normalized.includes('ハートピア') || normalized.includes('heartopia');
        const hasWeather = normalized.includes('天気') || normalized.includes('weather') || normalized.includes('予報') || normalized.includes('forecast');
        const hasWeekly = normalized.includes('週間') || normalized.includes('weekly') || normalized.includes('5日') || normalized.includes('7日');
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
      if (!normalized) continue;
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
      if (!candidate.sourceUrl) continue;
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
      const providerQueries = provider === 'yahoo-realtime' ? [queries[0], queries[3], queries[4]] : queries.slice(0, 3);
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
