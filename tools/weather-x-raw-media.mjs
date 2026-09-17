import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WeatherCloudError, assertPublicHostname } from "./weather-cloud-url-evidence.mjs";

export const MAX_RAW_MEDIA_BYTES = 512 * 1024;
const X_MEDIA_HOST = "pbs.twimg.com";
const X_MEDIA_PATH = /^\/(?:media|ext_tw_video_thumb|tweet_video_thumb)\/[A-Za-z0-9._~%-]+$/;
const ALLOWED_FORMATS = new Set(["jpg", "jpeg", "png", "webp"]);
const ALLOWED_NAMES = new Set(["thumb", "small", "medium", "large", "orig"]);
const DYNAMIC_SIZE_NAME = /^\d{2,4}x\d{2,4}$/;

export function parseXPublicMediaUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new WeatherCloudError("invalidXMediaUrl");
  }
  let url;
  try { url = new URL(value); } catch { throw new WeatherCloudError("invalidXMediaUrl"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      url.hostname.toLowerCase() !== X_MEDIA_HOST || !X_MEDIA_PATH.test(url.pathname)) {
    throw new WeatherCloudError("invalidXMediaUrl");
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "format" && key !== "name") || new Set(keys).size !== keys.length) {
    throw new WeatherCloudError("invalidXMediaUrl");
  }
  const format = url.searchParams.get("format");
  const name = url.searchParams.get("name");
  if (format && !ALLOWED_FORMATS.has(format.toLowerCase())) throw new WeatherCloudError("invalidXMediaUrl");
  if (name && !ALLOWED_NAMES.has(name.toLowerCase()) && !DYNAMIC_SIZE_NAME.test(name)) throw new WeatherCloudError("invalidXMediaUrl");
  if (format && format.toLowerCase() === "webp") url.searchParams.set("format", "jpg");
  // X embeds often expose transient square thumbnail names such as 360x360.
  // Re-request the same public media id with X's documented non-cropping "small"
  // rendition so the weather panel is not clipped before review.
  if (name && DYNAMIC_SIZE_NAME.test(name)) url.searchParams.set("name", "small");
  return url;
}

export function collectXPublicMedia(images) {
  const result = [];
  const seen = new Set();
  const visibleImages = images
    .filter((image) => image.visible && image.naturalWidth > 0 && image.naturalHeight > 0)
    .sort((first, second) => first.index - second.index);
  for (const image of visibleImages) {
    try {
      const url = parseXPublicMediaUrl(image.url);
      if (!seen.has(url.href)) {
        seen.add(url.href);
        result.push({ ...image, url: url.href });
      }
    } catch {
      // Non-media images such as avatars remain eligible for the legacy screenshot only.
    }
  }
  return result.slice(0, 4);
}

function sniffMimeType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  throw new WeatherCloudError("xMediaInvalidImage");
}

export async function downloadXPublicMedia(mediaUrl, {
  fetchImpl = fetch,
  hostnameVerifier = assertPublicHostname,
  timeoutMs = 30_000
} = {}) {
  const url = parseXPublicMediaUrl(mediaUrl);
  await hostnameVerifier(url.hostname);
  let response;
  try {
    response = await fetchImpl(url.href, {
      redirect: "manual",
      headers: {
        Accept: "image/png,image/jpeg",
        "Cache-Control": "no-cache"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error instanceof WeatherCloudError) throw error;
    throw new WeatherCloudError("xMediaDownloadFailed");
  }
  if (!response || response.status !== 200 || response.type === "opaqueredirect" || response.headers.get("location")) {
    throw new WeatherCloudError("xMediaDownloadFailed");
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RAW_MEDIA_BYTES) throw new WeatherCloudError("xMediaTooLarge");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RAW_MEDIA_BYTES) throw new WeatherCloudError("xMediaTooLarge");
  const mimeType = sniffMimeType(bytes);
  const responseMime = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (responseMime !== mimeType) throw new WeatherCloudError("xMediaMimeMismatch");
  return {
    url: url.href,
    mimeType,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes
  };
}

export async function saveXPublicMedia(mediaUrl, outputPath, options) {
  const media = await downloadXPublicMedia(mediaUrl, options);
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, media.bytes, { flag: "wx" });
  return { url: media.url, mimeType: media.mimeType, byteSize: media.byteSize, sha256: media.sha256 };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || index + 1 >= argv.length) throw new WeatherCloudError("invalidArguments");
    values[name.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!values.url || !values.output) throw new WeatherCloudError("invalidArguments");
  return { url: values.url, output: values.output };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const result = await saveXPublicMedia(args.url, args.output);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const code = error instanceof WeatherCloudError ? error.code : "xMediaDownloadFailed";
    process.stderr.write(`WEATHER_X_MEDIA:${code}\n`);
    process.exitCode = 1;
  });
}
