import fs from "node:fs";
import path from "node:path";
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
    new RegExp('href=["\\\']/' + escaped + '/status/(\\d{15,25})', "ig")
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
      .replace(/<a\\b[^>]*>[\\s\\S]*?<\\/a>/gi, "")
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

async function discoverFromSearch(fetchImpl, handle) {
  const query = `site:x.com/${handle}/status "Gift Code"`;
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=20";
  try {
    const { response, text } = await fetchText(fetchImpl, url);
    if (!response.ok) return { source: "bing", handle, ok: false, status: response.status, ids: [] };
    return { source: "bing", handle, ok: true, status: response.status, ids: extractStatusIdsFromHtml(text, handle) };
  } catch (error) {
    return { source: "bing", handle, ok: false, status: 0, ids: [], error: String(error?.message || error).slice(0, 240) };
  }
}

async function fetchOfficialPost(fetchImpl, handle, statusId) {
  const sourceUrl = `https://x.com/${handle}/status/${statusId}`;
  const endpoint = new URL("https://publish.twitter.com/oembed");
  endpoint.searchParams.set("url", sourceUrl);
  endpoint.searchParams.set("omit_script", "true");
  endpoint.searchParams.set("dnt", "true");

  try {
    const response = await fetchImpl(endpoint, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!isOfficialXAuthorUrl(data?.author_url, handle)) return null;
    const text = extractTweetTextFromOembedHtml(data?.html || "");
    if (!text || !looksLikeGiftText(text)) return null;
    return { statusId, sourceUrl, text, handle };
  } catch {
    return null;
  }
}

export function shouldRunXBackup(mode, now = new Date()) {
  if (String(mode || "") === "test") return true;
  return now.getUTCMinutes() % 15 < 5;
}

export async function discoverOfficialXGiftPosts(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const handles = options.handles || OFFICIAL_X_HANDLES;
  const maxPostsPerHandle = Math.max(1, Math.min(12, Number(options.maxPostsPerHandle) || 8));
  const diagnostics = [];
  const posts = [];

  for (const handle of handles) {
    const primary = await discoverFromSyndication(fetchImpl, handle);
    diagnostics.push(primary);
    let ids = primary.ids || [];
    if (!ids.length) {
      const fallback = await discoverFromSearch(fetchImpl, handle);
      diagnostics.push(fallback);
      ids = fallback.ids || [];
    }

    for (const statusId of ids.slice(0, maxPostsPerHandle)) {
      const post = await fetchOfficialPost(fetchImpl, handle, statusId);
      if (post) posts.push(post);
    }
  }

  const byId = new Map();
  for (const post of posts) if (!byId.has(post.statusId)) byId.set(post.statusId, post);
  return { posts: [...byId.values()], diagnostics };
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
  if (mode === "test") {
    return {
      ok: true,
      mode,
      posts: discovery.posts.length,
      candidates: discovery.posts.map(post => ({ sourceUrl: post.sourceUrl, statusId: post.statusId })),
      diagnostics: discovery.diagnostics
    };
  }

  if (!postKey) throw new Error("WEATHER_POST_KEY is missing.");
  if (!discovery.posts.length) {
    return { ok: true, mode, posts: 0, diagnostics: discovery.diagnostics };
  }

  const indexHtml = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const apiUrl = extractAppsScriptUrl(indexHtml);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "ingestOfficialXGiftBatch",
      postKey,
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

  return {
    ok: true,
    mode,
    posts: discovery.posts.length,
    ingest: data,
    diagnostics: discovery.diagnostics
  };
}

async function main() {
  const result = await runGiftXBackup({
    postKey: process.env.WEATHER_POST_KEY,
    mode: process.env.GIFT_POLL_MODE || "poll",
    force: process.env.GIFT_X_FORCE === "1"
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
