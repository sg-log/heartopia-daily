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
    const status = u.pathname.match(/^\/(?:i\/status|[A-Za-z0-9_]+\/status)\/(\d+)(?:\/(?:photo|video)\/[1-4])?\/?$/);
    if ((host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com') && status) {
      return { url: `https://x.com/i/status/${status[1]}`, sourceType: 'x', sourceId: status[1] };
    }
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

function looksRelevant(text) {
  const s = (text || '').replace(/\s+/g, ' ').toLowerCase();
  return (s.includes('ハートピア') || s.includes('heartopia')) && (s.includes('天気') || s.includes('weather') || s.includes('予報'));
}

function providerUrl(provider, query) {
  const q = encodeURIComponent(query);
  if (provider === 'bing') return `https://www.bing.com/search?q=${q}`;
  if (provider === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${q}`;
  if (provider === 'yahoo-web') return `https://search.yahoo.co.jp/search?p=${q}`;
  if (provider === 'yahoo-realtime') return `https://search.yahoo.co.jp/realtime/search?p=${q}`;
  throw new Error(`Unknown provider ${provider}`);
}

async function collectFromPage(page, provider, query, limit = 25) {
  const url = providerUrl(provider, query);
  const result = { provider, query, url, status: 'ok', error: null, linksSeen: 0, candidates: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const rows = await page.locator('a[href]').evaluateAll((els) => els.slice(0, 300).map((a) => ({
      href: a.href || '',
      text: (a.innerText || a.textContent || '').trim(),
      parentText: (a.parentElement?.innerText || '').trim().slice(0, 600)
    })));
    result.linksSeen = rows.length;
    for (const row of rows) {
      const normalized = normalizeCandidateUrl(row.href);
      if (!normalized) continue;
      if (normalized.sourceType !== 'x' && !looksRelevant(`${row.text} ${row.parentText}`)) continue;
      result.candidates.push({
        sourceUrl: normalized.url,
        sourceType: normalized.sourceType,
        sourceId: normalized.sourceId,
        discoverySource: provider,
        searchQuery: query,
        anchorText: row.text.slice(0, 300),
        context: row.parentText.slice(0, 500)
      });
      if (result.candidates.length >= limit) break;
    }
  } catch (err) {
    result.status = 'failed';
    result.error = String(err?.message || err).slice(0, 500);
  }
  return result;
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
      for (const query of providerQueries) attempts.push(await collectFromPage(page, provider, query));
    }
  } finally {
    await browser.close();
  }

  const merged = new Map();
  for (const attempt of attempts) {
    for (const c of attempt.candidates) {
      const key = c.sourceUrl;
      if (!merged.has(key)) merged.set(key, { ...c, discoveries: [] });
      merged.get(key).discoveries.push({ discoverySource: c.discoverySource, searchQuery: c.searchQuery });
    }
  }
  const candidates = [...merged.values()]
    .sort((a, b) => (b.sourceType === 'x') - (a.sourceType === 'x') || b.discoveries.length - a.discoveries.length)
    .slice(0, 12);

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
  console.log(JSON.stringify({ candidateCount: result.candidates.length, attempts: result.attempts }));
}
