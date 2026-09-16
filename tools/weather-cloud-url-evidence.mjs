import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_EVIDENCE_BYTES = 512 * 1024;
const ALLOWED_NON_NETWORK_PROTOCOLS = new Set(["about:", "blob:", "data:"]);
const ALLOWED_NETWORK_PROTOCOLS = new Set(["http:", "https:"]);

export class WeatherCloudError extends Error {
  constructor(code) {
    super(`WEATHER_CLOUD:${code}`);
    this.code = code;
  }
}

export function isPublicIpAddress(value) {
  const address = String(value || "").split("%")[0].toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    if (address === "::" || address === "::1") return false;
    if (/^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address)) return false;
    if (address.startsWith("2001:db8:")) return false;
    if (address.startsWith("::ffff:")) return isPublicIpAddress(address.slice(7));
    return true;
  }
  return false;
}

export function validateSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new WeatherCloudError("invalidUrl"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new WeatherCloudError("invalidUrl");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") || isIP(hostname)) {
    throw new WeatherCloudError("nonPublicUrl");
  }
  url.hash = "";
  return url;
}

export async function assertPublicHostname(hostname, resolver = lookup) {
  const clean = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (!clean.includes(".") || clean.endsWith(".local") || clean.endsWith(".internal") || isIP(clean)) throw new WeatherCloudError("nonPublicHost");
  let addresses;
  try { addresses = await resolver(clean, { all: true, verbatim: true }); } catch { throw new WeatherCloudError("dnsLookupFailed"); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new WeatherCloudError("nonPublicHost");
}

export function rankEvidenceImages(images) {
  return images
    .filter((image) => image.visible && image.width >= 280 && image.height >= 160 && image.naturalWidth >= 300 && image.naturalHeight >= 180)
    .map((image) => {
      const label = String(image.alt || "").toLowerCase();
      const decorativePenalty = /(avatar|profile|emoji|icon|logo|アバター|プロフィール)/.test(label) ? 1_000_000 : 0;
      const viewportBonus = image.inViewport ? 100_000 : 0;
      return { ...image, score: image.width * image.height + viewportBonus - decorativePenalty };
    })
    .sort((a, b) => b.score - a.score);
}

export function detectAccessBarrier({ finalUrl = "", title = "", bodyText = "" }) {
  const combined = `${title}\n${bodyText}`.toLowerCase();
  const pathName = (() => { try { return new URL(finalUrl).pathname.toLowerCase(); } catch { return ""; } })();
  if (/(^|\/)(login|signin|challenge|checkpoint|account)(\/|$)/.test(pathName)) return "loginWall";
  if (/(captcha|verify you are human|checking your browser|ロボットではない|人間であることを確認)/i.test(combined)) return "challengeWall";
  return "";
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
  return { sourceUrl: validateSourceUrl(values.url), outputDir: path.resolve(values["output-dir"]) };
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function captureEvidence({ sourceUrl, outputDir }) {
  const { chromium } = await import("playwright");
  await mkdir(outputDir, { recursive: true });
  const directPagePath = path.join(outputDir, "direct-page.png");
  const evidencePath = path.join(outputDir, "evidence.jpg");
  const contentPath = path.join(outputDir, "post-content.txt");
  const reportPath = path.join(outputDir, "capture.json");
  const capturedAt = new Date().toISOString();
  const checkedHosts = new Map();
  const browser = await chromium.launch({ headless: true });
  const browserVersion = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`,
    extraHTTPHeaders: { "Accept-Language": "ja,en-US;q=0.9,en;q=0.8" },
    colorScheme: "light",
    ignoreHTTPSErrors: false
  });
  const page = await context.newPage();
  let finalUrl = sourceUrl.href;
  let title = "";
  let httpStatus = 0;

  const checkHost = async (hostname) => {
    const key = hostname.toLowerCase();
    if (!checkedHosts.has(key)) checkedHosts.set(key, assertPublicHostname(key));
    return checkedHosts.get(key);
  };

  await context.route("**/*", async (route) => {
    let requestUrl;
    try { requestUrl = new URL(route.request().url()); } catch { await route.abort("blockedbyclient"); return; }
    if (ALLOWED_NON_NETWORK_PROTOCOLS.has(requestUrl.protocol)) { await route.continue(); return; }
    if (!ALLOWED_NETWORK_PROTOCOLS.has(requestUrl.protocol) || requestUrl.username || requestUrl.password) {
      await route.abort("blockedbyclient");
      return;
    }
    try {
      await checkHost(requestUrl.hostname.replace(/^\[|\]$/g, ""));
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });

  try {
    await assertPublicHostname(sourceUrl.hostname);
    const response = await page.goto(sourceUrl.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    httpStatus = response?.status() || 0;
    if (!response || httpStatus < 200 || httpStatus >= 400) throw new WeatherCloudError("pageLoadFailed");
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    finalUrl = page.url();
    title = await page.title();
    const final = validateSourceUrl(finalUrl);
    await assertPublicHostname(final.hostname);
    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const barrier = detectAccessBarrier({ finalUrl, title, bodyText: bodyText.slice(0, 12_000) });
    if (barrier) throw new WeatherCloudError(barrier);

    await writeFile(contentPath, `${bodyText.trim()}\n`, { encoding: "utf8", flag: "wx" });
    await page.screenshot({ path: directPagePath, fullPage: false, animations: "disabled" });
    const images = await page.locator("img").evaluateAll((nodes) => nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        index,
        alt: node.getAttribute("alt") || "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        naturalWidth: node.naturalWidth || 0,
        naturalHeight: node.naturalHeight || 0,
        visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0,
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      };
    }));
    const ranked = rankEvidenceImages(images);
    if (!ranked.length) throw new WeatherCloudError("evidenceImageNotFound");
    const selected = ranked[0];
    const image = page.locator("img").nth(selected.index);
    await image.scrollIntoViewIfNeeded();
    await image.screenshot({ path: evidencePath, type: "jpeg", quality: 88, animations: "disabled" });
    let evidenceSize = (await stat(evidencePath)).size;
    if (evidenceSize > MAX_EVIDENCE_BYTES) {
      await image.screenshot({ path: evidencePath, type: "jpeg", quality: 70, animations: "disabled" });
      evidenceSize = (await stat(evidencePath)).size;
    }
    if (evidenceSize > MAX_EVIDENCE_BYTES) throw new WeatherCloudError("evidenceTooLarge");
    const evidenceSha256 = await sha256File(evidencePath);

    const report = {
      status: "captured",
      adapter: "public-url",
      sourceUrl: sourceUrl.href,
      finalUrl,
      sourceType: "web",
      title,
      httpStatus,
      capturedAt,
      postContent: { file: "post-content.txt" },
      directPage: { file: "direct-page.png" },
      rawMedia: [{
        url: finalUrl,
        file: "evidence.jpg",
        mimeType: "image/jpeg",
        byteSize: evidenceSize,
        sha256: evidenceSha256
      }],
      evidence: {
        file: "evidence.jpg",
        mimeType: "image/jpeg",
        byteSize: evidenceSize,
        sha256: evidenceSha256,
        kind: "screenshot",
        capturedAt,
        renderedWidth: selected.width,
        renderedHeight: selected.height,
        naturalWidth: selected.naturalWidth,
        naturalHeight: selected.naturalHeight
      }
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    await page.screenshot({ path: directPagePath, fullPage: false, animations: "disabled" }).catch(() => {});
    const code = error instanceof WeatherCloudError ? error.code : "captureFailed";
    const report = { status: "failed", sourceUrl: sourceUrl.href, finalUrl, sourceType: "web", title, httpStatus, capturedAt, failureCode: code };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
    throw new WeatherCloudError(code);
  } finally {
    await browser.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  await captureEvidence(parseArguments(argv));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const code = error instanceof WeatherCloudError ? error.code : "captureFailed";
    process.stderr.write(`WEATHER_CLOUD:${code}\n`);
    process.exitCode = 1;
  });
}
