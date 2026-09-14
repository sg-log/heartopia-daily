import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { detectEvidenceMime, inspectEvidenceBytes } from "./weather-evidence-inspect.mjs";

const png = await readFile(new URL("../assets/weather-templates/sun-day.png", import.meta.url));

test("detects the supported evidence signatures", () => {
  assert.equal(detectEvidenceMime(png), "image/png");
  assert.equal(detectEvidenceMime(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), "image/jpeg");
  assert.throws(() => detectEvidenceMime(Buffer.from("<svg/>")), /unsupportedEvidenceType/);
});

test("decodes an evidence image in Chromium and reports its exact hash", async () => {
  const result = await inspectEvidenceBytes(png);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.byteSize, png.length);
  assert.ok(result.width > 0 && result.height > 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("rejects oversized evidence before starting Chromium", async () => {
  await assert.rejects(inspectEvidenceBytes(Buffer.alloc(512 * 1024 + 1)), /invalidEvidenceSize/);
});
