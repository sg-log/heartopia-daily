import { chromium } from 'playwright';
import fs from 'node:fs/promises';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i]] = argv[i + 1];
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(args['--target-date'] || '')) throw new Error('Invalid --target-date');
  if (!args['--out']) throw new Error('Missing --out');
  return { targetDate: args['--target-date'], out: args['--out'] };
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
    const isXHost = host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com';
    const status = u.pathname.match(/^\/(?:i\/status|[A-Za-z0-9_]+\/status)\/(\d+)(?:\/(?:photo|video)\/[1-4])?\/?$/);
    if (isXHost) {
      if (status) return { url: `https://x.com/i/status/${status[1]}`, sourceType: 'x', sourceId: status[1] };
      // Profile/search/navigation links from Yahoo Realtime are not evidence URLs.
      return null;
    }
    if (host === 't.co' || host === 'pic.x.com') return null;
    if (host.endsWith('bing.com') || host.endsWith('duckduckgo.com') || host.endsWith('search.yahoo.co.jp')) return null;
    u.hash = '';
    return { url: u.toString(), sourceType: 'web', sourceId: null };
  }
  return null;
}

export function buildQueries(targetDate) {
  const [year, month, day] = targetDate.split('-').map(Number);
  return [
    `ハートピア 天気 ${month}月${day}日`,
    `Heartopia weather ${targetDate}`,
    'ハートピア 天気'
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
  if (provider === 'yahoo-realtime') return `https://search.yahoo.co.jp/realtime/search?p=${q}`;
  throw new Error(`Unknown provider ${provider}`);
}

async function collectFromPage(page, provider, query, targetDate, limit = 25) {
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
      return {
        href: a.href || '',
        text: anchorText,
        parentText: bestText.slice(0, 1200)
      };
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

export function mergeAndRankCandidates(attempts, targetDate, limit = 12) {
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
  return [...merged.values()]
    .filter((candidate) => candidateRelevance(`${candidate.anchorText || ''} ${candidate.context || ''}`, targetDate).relevant)
    .sort((a, b) =>
      Number(Boolean(b.dateMatched)) - Number(Boolean(a.dateMatched)) ||
      Number(Boolean(b.forecastMatched)) - Number(Boolean(a.forecastMatched)) ||
      Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0) ||
      (b.sourceType === 'x') - (a.sourceType === 'x') ||
      b.discoveries.length - a.discoveries.length
    )
    .slice(0, limit);
}

export async function discover(targetDate) {
  const queries = buildQueries(targetDate);
  const providers = ['bing', 'duckduckgo', 'yahoo-web', 'yahoo-realtime'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await context.newPage();
  const attempts = [];
  try {
    for (const provider of providers) {
      const providerQueries = provider === 'yahoo-realtime' ? [queries[0], queries[2]] : queries.slice(0, 2);
      for (const query of providerQueries) attempts.push(await collectFromPage(page, provider, query, targetDate));
    }
  } finally {
    await browser.close();
  }

  const candidates = mergeAndRankCandidates(attempts, targetDate, 12);

  return {
    schemaVersion: 1,
    responseType: 'weather-public-discovery',
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
      relevanceScore: candidate.relevanceScore,
      dateMatched: candidate.dateMatched,
      discoverySource: candidate.discoverySource
    })),
    attempts: result.attempts
  }));
}
