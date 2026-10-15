import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractAppsScriptUrl } from "./gift-discord-poll.mjs";

const OFFICIAL_X_HANDLES = ["myheartopia", "Heartopia_JP"];
const USER_AGENT = "heartopia-daily-gift-x-backup/1.0 (+https://github.com/sg-log/heartopia-daily)";

function unique(values) {
  return [...new Set(values)];
}

export function normalizeTimelineHtml(value) {
  return String(value || "")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003A/gi, ":")
    .replace(/\\\//g, "/");
}

export function extractStatusIdsFromHtml(html, handle) {
  const source = normalizeTimelineHtml(html);
  const escaped = String(handle || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp("https?://(?:www\\.)?(?:x|twitter)\\.com/" + escaped + "/status/(\\d{15,25})", "ig"),
    new RegExp("href=[\\\"\']/"+ escaped + "/status/(\\d{15,25})", "ig")
  ];
  const ids = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) ids.push(match[1]);
  }
  return unique(ids).sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return a === b ? 0 : (a > b ? -1 : 1);
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

export function extractTweetTextFromOembedHtml(html) {
  const match = String(html || "").match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return "";
  return decodeHtml(
    match[1]
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
      .replace(/<[^>]+>/g, "")
  ).replace(/\n{3,}/g, "\n\n").trim();
}

export function isOfficialXAuthorUrl(value, handle) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && ["twitter.com", "www.twitter.com", "x.com", "www.x.com"].includes(url.hostname.toLowerCase())
      && url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase() === String(handle || "").toLowerCase();
  } catch {
    return false;
  }
}

function looksLikeGiftText(text) {
  return /Gift\s*Code\s*:|ギフト\s*コード\s*[:：]/i.test(String(text || ""));
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    }
  });
  const text = await response.text();
  return { response, text };
}

async function discoverFromSyndication(fetchImpl, handle) {
  const url = "https://syndication.twitter.com/srv/timeline-profile/screen-name/" + encodeURIComponent(handle);
  try {
    const { response, text } = await fetchText(fetchImpl, url);
    if (!response.ok) return { source: "syndication", handle, ok: false, status: response.status, ids: [] };
    return { source: "syndication", handle, ok: true, status: response.status, ids: extractStatusIdsFromHtml(text, handle) };
  } catch (error) {
    return { source: "syndication", handle, ok: false, status: 0, ids: [], error: String(error?.message || error).slice(0, 240) };
  }
}

async function discoverFromSearch(fetchImpl, handle, provider = 'bing') {
  const keyword = String(handle).toLowerCase() === 'heartopia_jp' ? '"ギフトコード"' : '"Gift Code"';
  const query = `site:x.com/${handle}/status ${keyword}`;
  const url = provider === 'yahoo-web'
    ? "https://search.yahoo.co.jp/search?p=" + encodeURIComponent(query)
    : "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=20";
  try {
    const { response, text } = await fetchText(fetchImpl, url);
    if (!response.ok) return { source: provider, handle, ok: false, status: response.status, ids: [] };
    return { source: provider, handle, ok: true, status: response.status, ids: extractStatusIdsFromHtml(text, handle) };
  } catch (error) {
    return { source: provider, handle, ok: false, status: 0, ids: [], error: String(error?.message || error).slice(0, 240) };
  }
}

async function fetchOfficialPost(fetchImpl, handle, statusId, includeIncomplete = false) {
  const sourceUrl = `https://x.com/${handle}/status/${statusId}`;
  const endpoint = new URL("https://publish.twitter.com/oembed");
  endpoint.searchParams.set("url", sourceUrl);
  endpoint.searchParams.set("omit_script", "true");
  endpoint.searchParams.set("dnt", "true");

  try {
    const response = await fetchImpl(endpoint, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!isOfficialXAuthorUrl(data?.author_url, handle)) return null;
    const text = extractTweetTextFromOembedHtml(data?.html || "");
    // oEmbed can shorten long announcements before their redemption deadline.
    // Do not import a partial post as if the deadline were absent.
    const incomplete = /(?:…|\.{3})\s*$/.test(text);
    if (!text || !looksLikeGiftText(text) || (incomplete && !includeIncomplete)) return null;
    return { statusId, sourceUrl, text, handle, incomplete };
  } catch {
    return null;
  }
}

export function shouldRunXBackup(mode, now = new Date()) {
  if (String(mode || "") === "test") return true;
  return now.getUTCMinutes() % 15 < 5;
}

const LISTING_URLS = ['https://heartopiaguide.com/codes/', 'https://www.heartodex.com/en/codes/'];

export function extractListingCandidates(html, listingUrl) {
  const guide = listingUrl === LISTING_URLS[0];
  if (!LISTING_URLS.includes(listingUrl)) return [];
  const active = String(html).split(guide ? /Expired Codes\s*\(/i : /<!--\s*Expired Codes Section\s*-->/i)[0];
  const pattern = guide ? /<code\b[^>]*>\s*([A-Za-z0-9_-]{6,100})\s*<\/code>/g : /data-code="([A-Za-z0-9_-]{6,100})"/g;
  const matches = [...active.matchAll(pattern)].slice(0, 20);
  return matches.map((match, index) => {
    const block = active.slice(match.index, matches[index + 1]?.index ?? active.length);
    const urls = [...block.matchAll(/https:\/\/x\.com\/(?:myheartopia|Heartopia_JP)\/status\/\d{15,25}/gi)].map(item => item[0]);
    const plain = decodeHtml(block.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' '));
    const deadlineHint = guide ? (plain.match(/Expires:\s*(20\d{2}[-/]\d{2}[-/]\d{2}\s+\d{1,2}:\d{2}\s*\(UTC[+-]\d{1,2}\))/i)?.[1] || '') : '';
    return { code: match[1], listingUrls: [listingUrl], officialUrls: unique(urls).slice(0, 2), deadlineHint };
  });
}

export async function reconcileGiftListings({ fetchImpl = globalThis.fetch, knownCodes = [] } = {}) {
  const deadline = Date.now() + 45000;
  const diagnostics = [];
  const candidates = new Map();
  for (const url of LISTING_URLS) {
    try {
      const { response, text } = await fetchText(fetchImpl, url);
      const found = response.ok ? extractListingCandidates(text, url) : [];
      diagnostics.push({ source: 'code-list', url, status: response.status, candidates: found.length, ok: response.ok && found.length > 0 });
      for (const item of found) {
        const current = candidates.get(item.code) || { code: item.code, listingUrls: [], officialUrls: [] };
        current.listingUrls = unique([...current.listingUrls, ...item.listingUrls]);
        current.officialUrls = unique([...current.officialUrls, ...item.officialUrls]);
        current.deadlineHint ||= item.deadlineHint;
        candidates.set(item.code, current);
      }
    } catch { diagnostics.push({ source: 'code-list', url, ok: false }); }
  }
  const reviews = [], posts = [];
  for (const item of [...candidates.values()].slice(0, 20)) {
    if (knownCodes.some(row => row.code === item.code)) continue;
    let confirmed = false, excerpt = '';
    for (const url of item.officialUrls.slice(0, 2)) {
      if (Date.now() >= deadline) break;
      const match = new URL(url).pathname.match(/^\/([^/]+)\/status\/(\d+)$/);
      const post = await fetchOfficialPost(fetchImpl, match[1], match[2], true);
      // A listing's link can point to a different announcement: bind the exact code.
      const code = post?.text.normalize('NFKC').match(/(?:Gift\s*Code|ギフト\s*コード)\s*:\s*`?([A-Za-z0-9_-]{6,100})/i)?.[1];
      if (!post || code !== item.code) continue;
      excerpt = post.text.slice(0, 1000);
      if (!post.incomplete && /(?:Redemption\s*Deadline|交換期限|受取期限|有効期限)\s*[:：]/i.test(post.text)) {
        posts.push(post); confirmed = true; break;
      }
    }
    if (!confirmed) reviews.push({ code: item.code, sourceUrl: item.officialUrls[0] || '', listingUrls: item.listingUrls,
      excerpt, deadlineHint: item.deadlineHint || '', reason: excerpt ? '公式本文が省略され、交換期限まで確認できません。' : '公開一覧で未登録候補を検出しましたが、公式本文を確認できません。' });
  }
  return { posts, reviews, diagnostics, activeCandidates: candidates.size };
}

export async function notifyGiftReviews({ fetchImpl, webhookUrl, reviews, acknowledge }) {
  const pending = (reviews || []).slice(0, 3);
  if (!pending.length) return { notified: 0 };
  if (!webhookUrl) return { notified: 0, pending: pending.length, warning: 'Personal review webhook is missing' };
  const url = new URL(webhookUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || !/^\/api\/webhooks\/\d+\//.test(url.pathname)) throw Error('Invalid personal review webhook');
  const content = ['🎁 未登録ギフトコードの確認待ち',
    '管理画面で内容を確認して承認してください。',
    ...pending.map(item => [
      `コード：${item.code}`, String(item.reason).slice(0, 150),
      `<https://sg-log.github.io/heartopia-daily/?admin=1&giftReview=${encodeURIComponent(item.id)}#pendingGiftReviews>`
    ].join('\n'))].join('\n\n');
  const response = await fetchImpl(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 }) });
  if (!response.ok) throw Error('Personal gift review notification failed (HTTP ' + response.status + ')');
  for (const item of pending) await acknowledge(item.id);
  return { notified: pending.length, messages: 1 };
}

export async function discoverOfficialXGiftPosts(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const handles = options.handles || OFFICIAL_X_HANDLES;
  const maxPostsPerHandle = Math.max(1, Math.min(12, Number(options.maxPostsPerHandle) || 8));
  const diagnostics = [];
  const posts = [];
  const incompletePosts = [];

  for (const handle of handles) {
    const primary = await discoverFromSyndication(fetchImpl, handle);
    diagnostics.push(primary);
    let ids = primary.ids || [];
    if (!ids.length) {
      const fallback = await discoverFromSearch(fetchImpl, handle);
      diagnostics.push(fallback);
      ids = fallback.ids || [];
    }
    if (!ids.length) {
      const fallback = await discoverFromSearch(fetchImpl, handle, 'yahoo-web');
      diagnostics.push(fallback);
      ids = fallback.ids || [];
    }

    const fetched = await Promise.all(ids.slice(0, maxPostsPerHandle).map(statusId => fetchOfficialPost(fetchImpl, handle, statusId, true)));
    for (const post of fetched) {
      if (post?.incomplete) incompletePosts.push(post);
      else if (post) posts.push(post);
    }
  }

  const byId = new Map();
  for (const post of posts) if (!byId.has(post.statusId)) byId.set(post.statusId, post);
  return { posts: [...byId.values()], incompletePosts, diagnostics };
}

export async function runGiftXBackup(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const postKey = String(options.postKey || "").trim();
  const mode = String(options.mode || "poll").trim();
  const repoRoot = options.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const force = options.force === true;

  if (!["poll", "test"].includes(mode)) throw new Error("GIFT_POLL_MODE must be poll or test.");
  if (!force && !shouldRunXBackup(mode, options.now || new Date())) {
    return { ok: true, mode, skipped: "interval", posts: 0, diagnostics: [] };
  }

  const discovery = await discoverOfficialXGiftPosts({ fetchImpl, handles: options.handles });
  let reconciliation;
  let apiUrl;
  if (options.reconcile) {
    apiUrl = extractAppsScriptUrl(fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'));
    const response = await fetchImpl(apiUrl + '?action=getGiftCodes');
    const known = await response.json();
    if (!response.ok || !known.ok || !Array.isArray(known.codes)) throw Error('Gift inventory could not be read');
    reconciliation = await reconcileGiftListings({ fetchImpl, knownCodes: known.codes });
    discovery.posts = [...new Map([...discovery.posts, ...reconciliation.posts].map(post => [post.statusId, post])).values()];
    discovery.diagnostics.push(...reconciliation.diagnostics);
  }
  if (mode === "test") {
    return {
      ok: true,
      mode,
      posts: discovery.posts.length,
      candidates: discovery.posts.map(post => ({ sourceUrl: post.sourceUrl, statusId: post.statusId })),
      reconciliation,
      diagnostics: discovery.diagnostics
    };
  }

  if (!postKey) throw new Error("WEATHER_POST_KEY is missing.");
  if (!discovery.posts.length && !options.reconcile) {
    return { ok: true, mode, posts: 0, diagnostics: discovery.diagnostics };
  }

  apiUrl ||= extractAppsScriptUrl(fs.readFileSync(path.join(repoRoot, "index.html"), "utf8"));
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "ingestOfficialXGiftBatch",
      postKey,
      reconcile: Boolean(options.reconcile),
      reviewCandidates: (reconciliation?.reviews || []).slice(0, 20),
      posts: discovery.posts.map(post => ({
        statusId: post.statusId,
        sourceUrl: post.sourceUrl,
        text: post.text
      }))
    })
  });
  const bodyText = await response.text();
  let data;
  try { data = JSON.parse(bodyText || "{}"); }
  catch { throw new Error("Heartopia Daily X gift ingest returned non-JSON (HTTP " + response.status + ")."); }
  if (!response.ok || data?.ok !== true) {
    throw new Error("Heartopia Daily X gift ingest rejected the batch: " + String(data?.error || response.status));
  }

  const notification = await notifyGiftReviews({ fetchImpl, webhookUrl: options.reviewWebhookUrl, reviews: data.reviews,
    acknowledge: async id => {
      const ack = await fetchImpl(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ingestOfficialXGiftBatch', postKey, reconcile: true, ackReviewIds: [id] }) });
      const result = await ack.json();
      if (!ack.ok || !result.ok) throw Error('Gift review delivery acknowledgement failed');
    } });

  return {
    ok: true,
    mode,
    posts: discovery.posts.length,
    ingest: data,
    notification,
    reconciliation: reconciliation && { activeCandidates: reconciliation.activeCandidates, reviewCandidates: reconciliation.reviews.length,
      availableSources: reconciliation.diagnostics.filter(item => item.ok).length },
    diagnostics: discovery.diagnostics
  };
}

export async function captureGiftReviewScreenshot(request, options = {}) {
  const match = String(request.sourceUrl).match(/^https:\/\/x\.com\/(myheartopia|Heartopia_JP)\/status\/(\d{15,25})$/i);
  if (!match || !/^[A-Za-z0-9][A-Za-z0-9_-]{5,99}$/.test(String(request.code))) throw Error('Invalid evidence source');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const endpoint = new URL('https://publish.twitter.com/oembed');
  endpoint.searchParams.set('url', request.sourceUrl); endpoint.searchParams.set('omit_script', 'true'); endpoint.searchParams.set('dnt', 'true');
  const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('Official embed unavailable');
  const embed = await response.json();
  const code = extractTweetTextFromOembedHtml(embed.html).normalize('NFKC').match(/(?:Gift\s*Code|ギフト\s*コード)\s*:\s*`?([A-Za-z0-9_-]{6,100})/i)?.[1];
  if (!isOfficialXAuthorUrl(embed.author_url, match[1]) || code !== request.code) throw Error('Evidence code mismatch');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, ...(options.channel ? { channel: options.channel } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 620, height: 1400 }, locale: 'ja-JP', serviceWorkers: 'block' });
    const hosts = new Set(['platform.twitter.com', 'cdn.syndication.twimg.com', 'syndication.twitter.com', 'pbs.twimg.com', 'abs.twimg.com', 'abs-0.twimg.com', 'video.twimg.com']);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.protocol === 'https:' && hosts.has(url.hostname) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.setContent(`<html lang="ja"><meta charset="utf-8"><body>${embed.html}<script async src="https://platform.twitter.com/widgets.js"></script></body></html>`, { waitUntil: 'domcontentloaded' });
    const iframe = page.locator('iframe[id^="twitter-widget-"]').first();
    await iframe.waitFor({ state: 'visible', timeout: 25000 });
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.locator('a[href*="/status/' + match[2] + '"]').first().waitFor({ state: 'attached', timeout: 15000 });
    await frame.waitForTimeout(1500);
    if (!(await frame.locator('body').innerText()).includes(request.code)) throw Error('Evidence text not confirmed');
    const bytes = await iframe.screenshot({ type: 'jpeg', quality: 75, animations: 'disabled' });
    if (!bytes.length || bytes.length > 524288) throw Error('Evidence size exceeded');
    return { mimeType: 'image/jpeg', byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      kind: 'screenshot', capturedAt: new Date().toISOString(), bodyBase64: bytes.toString('base64') };
  } finally { await browser.close(); }
}

async function capturePendingGiftEvidence() {
  const postKey = String(process.env.WEATHER_POST_KEY || '');
  if (!postKey) throw Error('WEATHER_POST_KEY is missing');
  const planPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'heartopia-gift-evidence.json');
  const requests = JSON.parse(fs.readFileSync(planPath, 'utf8')).slice(0, 2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const apiUrl = extractAppsScriptUrl(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  const results = [];
  for (const request of requests) {
    let image;
    try { image = await captureGiftReviewScreenshot(request, { channel: process.env.GIFT_EVIDENCE_BROWSER || 'chrome' }); }
    catch { /* Persist the failure so every poll does not retry the same blocked post. */ }
    const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'saveGiftReviewEvidence', postKey, reviewId: request.id, sourceUrl: request.sourceUrl,
        ...(image ? { image } : { failed: true }) }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error('Private gift evidence save failed');
    results.push({ id: request.id, status: result.status });
  }
  return { ok: true, captures: results };
}

async function main() {
  if (process.env.GIFT_CAPTURE_ONLY === '1') {
    process.stdout.write(JSON.stringify(await capturePendingGiftEvidence()) + '\n'); return;
  }
  const result = await runGiftXBackup({
    postKey: process.env.WEATHER_POST_KEY,
    mode: process.env.GIFT_POLL_MODE || "poll",
    force: process.env.GIFT_X_FORCE === "1",
    reconcile: true,
    reviewWebhookUrl: process.env.WEATHER_DC_WEBHOOK_URL
  });
  const requests = result.ingest?.evidenceRequests || [];
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'evidence_needed=' + String(requests.length > 0) + '\n');
    if (requests.length) fs.writeFileSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'heartopia-gift-evidence.json'), JSON.stringify(requests));
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
