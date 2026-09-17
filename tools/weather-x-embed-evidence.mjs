import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  WeatherCloudError,
  assertPublicHostname,
  rankEvidenceImages
} from "./weather-cloud-url-evidence.mjs";
import { collectXPublicMedia, downloadXPublicMedia } from "./weather-x-raw-media.mjs";

const MAX_EVIDENCE_BYTES = 512 * 1024;
const X_POST_HOSTS = new Set([
  "x.com", "www.x.com", "mobile.x.com",
  "twitter.com", "www.twitter.com", "mobile.twitter.com"
]);
const EMBED_HOSTS = new Set([
  "platform.twitter.com",
  "cdn.syndication.twimg.com",
  "syndication.twitter.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "video.twimg.com"
]);

export function parseXPostUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new WeatherCloudError("invalidXPostUrl"); }
  const host = url.hostname.toLowerCase();
  const match = url.pathname.match(/^\/(?:[A-Za-z0-9_]+\/status|i\/status|i\/web\/status)\/([0-9]+)(?:\/(?:photo|video)\/[0-9]+)?\/?$/);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !X_POST_HOSTS.has(host) || !match) {
    throw new WeatherCloudError("invalidXPostUrl");
  }
  url.hash = "";
  return { sourceUrl: url.href, sourceId: match[1], normalizedUrl: `https://x.com/i/status/${match[1]}` };
}

export function getOfficialPathwayName(value) {
  let url;
  try { url = new URL(value); } catch { return ""; }
  if (url.hostname === "publish.twitter.com" && url.pathname === "/oembed") return "oembed";
  if (url.hostname === "platform.twitter.com" && url.pathname === "/widgets.js") return "widgetsJs";
  if (url.hostname === "platform.twitter.com" && url.pathname.startsWith("/embed/")) return "embedFrame";
  if ((url.hostname === "cdn.syndication.twimg.com" || url.hostname === "syndication.twitter.com") &&
      url.pathname.includes("tweet")) return "syndication";
  if (url.hostname === "pbs.twimg.com") return "media";
  return "";
}

export function chooseEmbedEvidence(images) {
  const selected = rankEvidenceImages(images)[0];
  return selected ? { kind: "image-screenshot", selected } : { kind: "embed-screenshot", selected: null };
}

function setPathway(pathways, name, httpStatus) {
  if (!name) return;
  const prior = pathways.find((item) => item.name === name);
  if (prior) prior.httpStatus = httpStatus;
  else pathways.push({ name, httpStatus });
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || index + 1 >= argv.length) throw new WeatherCloudError("invalidArguments");
    values[name.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!values.url || !values["output-dir"]) throw new WeatherCloudError("invalidArguments");
  return { post: parseXPostUrl(values.url), outputDir: path.resolve(values["output-dir"]) };
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function captureXEmbed({ post, outputDir }) {
  const { chromium } = await import("playwright");
  await mkdir(outputDir, { recursive: true });
  const directPagePath = path.join(outputDir, "direct-page.png");
  const evidencePath = path.join(outputDir, "evidence.jpg");
  const contentPath = path.join(outputDir, "post-content.txt");
  const reportPath = path.join(outputDir, "capture.json");
  const capturedAt = new Date().toISOString();
  const pathways = [];
  const observedMediaUrls = [];
  let browser;
  let page;

  try {
    const oembedUrl = new URL("https://publish.twitter.com/oembed");
    oembedUrl.searchParams.set("url", post.sourceUrl);
    oembedUrl.searchParams.set("omit_script", "true");
    oembedUrl.searchParams.set("dnt", "true");
    const oembedResponse = await fetch(oembedUrl, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    setPathway(pathways, "oembed", oembedResponse.status);
    if (!oembedResponse.ok) throw new WeatherCloudError("oembedHttpError");
    const contentType = oembedResponse.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) throw new WeatherCloudError("oembedInvalidResponse");
    const oembed = await oembedResponse.json();
    if (typeof oembed.html !== "string" || !oembed.html.includes("twitter-tweet")) {
      throw new WeatherCloudError("oembedContentMissing");
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 900, height: 1200 },
      deviceScaleFactor: 2,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      serviceWorkers: "block"
    });
    page = await context.newPage();
    const checkedHosts = new Map();
    const checkHost = async (hostname) => {
      if (!checkedHosts.has(hostname)) checkedHosts.set(hostname, assertPublicHostname(hostname));
      return checkedHosts.get(hostname);
    };
    await context.route("**/*", async (route) => {
      let requestUrl;
      try { requestUrl = new URL(route.request().url()); } catch { await route.abort("blockedbyclient"); return; }
      if (["about:", "blob:", "data:"].includes(requestUrl.protocol)) { await route.continue(); return; }
      if (requestUrl.protocol !== "https:" || !EMBED_HOSTS.has(requestUrl.hostname.toLowerCase())) {
        await route.abort("blockedbyclient");
        return;
      }
      try {
        await checkHost(requestUrl.hostname.toLowerCase());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    page.on("response", (response) => {
      setPathway(pathways, getOfficialPathwayName(response.url()), response.status());
      if (response.status() === 200 && getOfficialPathwayName(response.url()) === "media") {
        observedMediaUrls.push(response.url());
      }
    });

    const documentHtml = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>X official embed</title></head>` +
      `<body><main id="embed-root">${oembed.html}</main>` +
      `<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script></body></html>`;
    await page.setContent(documentHtml, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const iframe = page.locator('iframe[id^="twitter-widget-"]').first();
    await iframe.waitFor({ state: "visible", timeout: 30_000 });
    const iframeHandle = await iframe.elementHandle();
    const frame = await iframeHandle?.contentFrame();
    if (!frame) throw new WeatherCloudError("embedFrameMissing");
    await frame.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await frame.waitForTimeout(2_000);

    const postText = (await frame.locator("body").innerText({ timeout: 10_000 })).trim();
    const postLinks = await frame.locator('a[href*="/status/"]').evaluateAll((nodes) => nodes.map((node) => node.href));
    if (postText.length < 10 || !postLinks.some((href) => href.includes(`/status/${post.sourceId}`))) {
      throw new WeatherCloudError("embedPostNotConfirmed");
    }
    await iframe.screenshot({ path: directPagePath, animations: "disabled" });
    await writeFile(contentPath, `${postText}\n`, { encoding: "utf8", flag: "wx" });

    const imageLocator = frame.locator("img");
    const images = await imageLocator.evaluateAll((nodes) => nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        index,
        url: node.currentSrc || node.src || "",
        alt: node.getAttribute("alt") || "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        naturalWidth: node.naturalWidth || 0,
        naturalHeight: node.naturalHeight || 0,
        visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0,
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      };
    }));
    const networkMedia = observedMediaUrls.map((url, index) => ({
      index: images.length + index,
      url,
      alt: "",
      width: 1,
      height: 1,
      naturalWidth: 1,
      naturalHeight: 1,
      visible: true,
      inViewport: true
    }));
    const rawMediaCandidates = collectXPublicMedia([...images, ...networkMedia]);
    const rawMedia = [];
    for (const [index, candidate] of rawMediaCandidates.entries()) {
      const downloaded = await downloadXPublicMedia(candidate.url);
      const extension = downloaded.mimeType === "image/png" ? "png" : "jpg";
      const file = `raw-media-${index}.${extension}`;
      await writeFile(path.join(outputDir, file), downloaded.bytes, { flag: "wx" });
      rawMedia.push({
        url: downloaded.url,
        file,
        mimeType: downloaded.mimeType,
        byteSize: downloaded.byteSize,
        sha256: downloaded.sha256
      });
    }

    // Some official X embeds render the post image correctly but do not expose a
    // downloadable pbs.twimg.com URL. Keep that public rendered media as an exact
    // screenshot-backed raw candidate instead of falling back to the whole tweet.
    const evidenceChoice = chooseEmbedEvidence(images);
    if (!rawMedia.length && evidenceChoice.selected) {
      const fallbackTarget = imageLocator.nth(evidenceChoice.selected.index);
      await fallbackTarget.scrollIntoViewIfNeeded();
      const file = "raw-media-0.jpg";
      const filePath = path.join(outputDir, file);
      await fallbackTarget.screenshot({ path: filePath, type: "jpeg", quality: 92, animations: "disabled" });
      let byteSize = (await stat(filePath)).size;
      if (byteSize > MAX_EVIDENCE_BYTES) {
        await fallbackTarget.screenshot({ path: filePath, type: "jpeg", quality: 70, animations: "disabled" });
        byteSize = (await stat(filePath)).size;
      }
      if (byteSize > MAX_EVIDENCE_BYTES) throw new WeatherCloudError("evidenceTooLarge");
      rawMedia.push({
        url: post.sourceUrl,
        file,
        mimeType: "image/jpeg",
        byteSize,
        sha256: await sha256File(filePath),
        renderedFallback: true
      });
    }

    // A few X embeds paint the photo inside a link/background rather than an <img>.
    // If direct media extraction and <img> ranking both miss it, screenshot the
    // largest visible photo/video link belonging to this exact status. This keeps
    // the media itself as the bound evidence instead of forcing the whole tweet UI.
    if (!rawMedia.length) {
      const mediaLinks = frame.locator(`a[href*="/status/${post.sourceId}/photo/"], a[href*="/status/${post.sourceId}/video/"]`);
      const mediaLinkCount = Math.min(await mediaLinks.count(), 12);
      let bestIndex = -1;
      let bestArea = 0;
      for (let index = 0; index < mediaLinkCount; index += 1) {
        const box = await mediaLinks.nth(index).boundingBox().catch(() => null);
        if (!box || box.width < 180 || box.height < 120) continue;
        const area = box.width * box.height;
        if (area > bestArea) { bestArea = area; bestIndex = index; }
      }
      if (bestIndex >= 0) {
        const fallbackTarget = mediaLinks.nth(bestIndex);
        await fallbackTarget.scrollIntoViewIfNeeded();
        const file = "raw-media-0.jpg";
        const filePath = path.join(outputDir, file);
        await fallbackTarget.screenshot({ path: filePath, type: "jpeg", quality: 92, animations: "disabled" });
        let byteSize = (await stat(filePath)).size;
        if (byteSize > MAX_EVIDENCE_BYTES) {
          await fallbackTarget.screenshot({ path: filePath, type: "jpeg", quality: 70, animations: "disabled" });
          byteSize = (await stat(filePath)).size;
        }
        if (byteSize > MAX_EVIDENCE_BYTES) throw new WeatherCloudError("evidenceTooLarge");
        rawMedia.push({
          url: post.sourceUrl,
          file,
          mimeType: "image/jpeg",
          byteSize,
          sha256: await sha256File(filePath),
          renderedFallback: true,
          renderedFrom: "status-media-link"
        });
      }
    }

    let evidenceTarget;
    let evidenceDimensions;
    if (evidenceChoice.selected) {
      evidenceTarget = imageLocator.nth(evidenceChoice.selected.index);
      await evidenceTarget.scrollIntoViewIfNeeded();
      evidenceDimensions = evidenceChoice.selected;
    } else {
      const box = await iframe.boundingBox();
      if (!box || box.width < 280 || box.height < 160) throw new WeatherCloudError("embedScreenshotUnavailable");
      evidenceTarget = iframe;
      evidenceDimensions = {
        width: Math.round(box.width),
        height: Math.round(box.height),
        naturalWidth: 0,
        naturalHeight: 0
      };
    }
    await evidenceTarget.screenshot({ path: evidencePath, type: "jpeg", quality: 88, animations: "disabled" });
    let evidenceSize = (await stat(evidencePath)).size;
    if (evidenceSize > MAX_EVIDENCE_BYTES) {
      await evidenceTarget.screenshot({ path: evidencePath, type: "jpeg", quality: 70, animations: "disabled" });
      evidenceSize = (await stat(evidencePath)).size;
    }
    if (evidenceSize > MAX_EVIDENCE_BYTES) throw new WeatherCloudError("evidenceTooLarge");

    const report = {
      status: "captured",
      adapter: "x-official-embed",
      sourceUrl: post.sourceUrl,
      finalUrl: post.sourceUrl,
      sourceType: "x",
      sourceId: post.sourceId,
      capturedAt,
      pathways,
      postContent: { file: "post-content.txt" },
      directPage: { file: "direct-page.png" },
      rawMedia,
      evidence: {
        file: "evidence.jpg",
        mimeType: "image/jpeg",
        byteSize: evidenceSize,
        sha256: await sha256File(evidencePath),
        kind: evidenceChoice.kind,
        capturedAt,
        renderedWidth: evidenceDimensions.width,
        renderedHeight: evidenceDimensions.height,
        naturalWidth: evidenceDimensions.naturalWidth,
        naturalHeight: evidenceDimensions.naturalHeight
      }
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    await page?.screenshot({ path: directPagePath, fullPage: false, animations: "disabled" }).catch(() => {});
    const code = error instanceof WeatherCloudError ? error.code : "xEmbedCaptureFailed";
    const report = {
      status: "failed",
      adapter: "x-official-embed",
      sourceUrl: post.sourceUrl,
      finalUrl: post.sourceUrl,
      sourceType: "x",
      sourceId: post.sourceId,
      capturedAt,
      pathways,
      failureCode: code
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
    throw new WeatherCloudError(code);
  } finally {
    await browser?.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  await captureXEmbed(parseArguments(argv));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const code = error instanceof WeatherCloudError ? error.code : "xEmbedCaptureFailed";
    process.stderr.write(`WEATHER_X_EMBED:${code}\n`);
    process.exitCode = 1;
  });
}
