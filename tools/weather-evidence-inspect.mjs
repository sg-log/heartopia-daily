import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const MAX_BYTES = 512 * 1024;
const MAX_PIXELS = 16_000_000;

export function detectEvidenceMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  throw new Error("unsupportedEvidenceType");
}

export async function inspectEvidenceBytes(bytes, chromiumImpl = chromium) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw new Error("invalidEvidenceSize");
  const mimeType = detectEvidenceMime(bytes);
  const browser = await chromiumImpl.launch({ headless: true });
  let dimensions;
  try {
    const page = await browser.newPage();
    dimensions = await page.evaluate(async ({ mimeType, bodyBase64 }) => {
      const image = new Image();
      image.src = `data:${mimeType};base64,${bodyBase64}`;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, { mimeType, bodyBase64: bytes.toString("base64") });
  } finally {
    await browser.close();
  }
  if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) ||
      dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > MAX_PIXELS) {
    throw new Error("invalidEvidenceDimensions");
  }
  return {
    mimeType,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: dimensions.width,
    height: dimensions.height
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--path" || !args[1]) throw new Error("invalidArguments");
  const result = await inspectEvidenceBytes(await readFile(args[1]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    process.stderr.write("Evidence inspection failed.\n");
    process.exitCode = 1;
  });
}
