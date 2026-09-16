import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { inspectCapture, bindReviewEnvelope } from './weather-deterministic-review.mjs';

const TARGET_ASPECT = 497 / 661;
const CROP_VARIANTS = [
  { left: .44, top: .11, height: .75 },
  { left: .43, top: .11, height: .75 },
  { left: .45, top: .11, height: .75 },
  { left: .44, top: .10, height: .75 },
  { left: .44, top: .12, height: .75 },
  { left: .43, top: .10, height: .78 },
  { left: .45, top: .10, height: .78 },
  { left: .42, top: .09, height: .78 }
];

function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function normalizeRightColumn(page, bytes, mimeType, variant) {
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const result = await page.evaluate(async ({ dataUrl, variant, targetAspect }) => {
    const image = await new Promise((resolve, reject) => {
      const item = new Image(); item.onload = () => resolve(item); item.onerror = reject; item.src = dataUrl;
    });
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    const x = Math.max(0, Math.min(sourceWidth - 120, Math.round(sourceWidth * variant.left)));
    const y = Math.max(0, Math.round(sourceHeight * variant.top));
    const cropHeight = Math.min(sourceHeight - y, Math.round(sourceHeight * variant.height));
    const cropWidth = sourceWidth - x;
    if (cropWidth < 120 || cropHeight < 160) return null;
    const outHeight = cropHeight;
    const outWidth = Math.round(outHeight * targetAspect);
    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;
    canvas.getContext('2d').drawImage(image, x, y, cropWidth, cropHeight, 0, 0, outWidth, outHeight);
    return {
      base64: canvas.toDataURL('image/jpeg', .96).split(',')[1],
      sourceRect: { x, y, width: cropWidth, height: cropHeight },
      normalizedSize: { width: outWidth, height: outHeight }
    };
  }, { dataUrl, variant, targetAspect: TARGET_ASPECT });
  return result ? { ...result, bytes: Buffer.from(result.base64, 'base64') } : null;
}

export async function inspectDailyCapture({ captureDir, targetDate, repoRoot = '.' }) {
  const baseline = await inspectCapture({ captureDir, targetDate, repoRoot });
  if (baseline?.ready === true) return baseline;

  const capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8'));
  if (capture?.status !== 'captured' || !Array.isArray(capture.rawMedia) || !capture.rawMedia.length) return baseline;
  const postFile = capture.postContent?.file || 'post-content.txt';
  const postText = await readFile(path.join(captureDir, postFile), 'utf8');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'heartopia-weather-daily-'));
  const browser = await chromium.launch({ headless: true });
  const diagnostics = [];

  try {
    const page = await browser.newPage();
    for (const media of capture.rawMedia.slice(0, 4)) {
      const originalPath = path.join(captureDir, String(media.file || ''));
      let originalBytes;
      try { originalBytes = await readFile(originalPath); } catch { continue; }
      let originalMime;
      try { originalMime = mimeFromBytes(originalBytes); } catch { continue; }
      if (originalMime !== media.mimeType || sha256(originalBytes) !== media.sha256) continue;

      for (let variantIndex = 0; variantIndex < CROP_VARIANTS.length; variantIndex += 1) {
        const normalized = await normalizeRightColumn(page, originalBytes, originalMime, CROP_VARIANTS[variantIndex]);
        if (!normalized) continue;
        const workDir = path.join(tempRoot, `${String(media.file).replace(/[^A-Za-z0-9._-]/g, '_')}-${variantIndex}`);
        await mkdir(workDir, { recursive: true });
        const normalizedFile = 'raw-media-0.jpg';
        await writeFile(path.join(workDir, normalizedFile), normalized.bytes);
        await writeFile(path.join(workDir, 'post-content.txt'), postText, 'utf8');
        const normalizedSha = sha256(normalized.bytes);
        const syntheticCapture = {
          status: 'captured',
          sourceUrl: capture.sourceUrl,
          finalUrl: capture.finalUrl || capture.sourceUrl,
          sourceType: capture.sourceType,
          sourceId: capture.sourceId,
          capturedAt: capture.capturedAt,
          postContent: { file: 'post-content.txt' },
          rawMedia: [{
            url: media.url,
            file: normalizedFile,
            mimeType: 'image/jpeg',
            byteSize: normalized.bytes.length,
            sha256: normalizedSha
          }],
          evidence: {
            file: normalizedFile,
            mimeType: 'image/jpeg',
            byteSize: normalized.bytes.length,
            sha256: normalizedSha,
            kind: 'screenshot',
            capturedAt: capture.capturedAt
          }
        };
        await writeFile(path.join(workDir, 'capture.json'), `${JSON.stringify(syntheticCapture, null, 2)}\n`, 'utf8');
        const review = await inspectCapture({ captureDir: workDir, targetDate, repoRoot });
        diagnostics.push({
          file: media.file,
          variantIndex,
          sourceRect: normalized.sourceRect,
          normalizedSize: normalized.normalizedSize,
          ready: review.ready,
          interpretation: review.interpretation,
          diagnostics: review.diagnostics
        });
        if (review?.ready !== true) continue;
        return {
          ...review,
          selectedImage: {
            file: media.file,
            mimeType: media.mimeType,
            captureSha256: media.sha256
          },
          diagnostics: {
            mode: 'normalized-right-weather-column',
            selectedOriginal: media.file,
            selectedVariant: variantIndex,
            sourceRect: normalized.sourceRect,
            normalizedSize: normalized.normalizedSize,
            attempts: diagnostics
          }
        };
      }
    }
  } finally {
    await browser.close();
    await rm(tempRoot, { recursive: true, force: true });
  }

  return {
    ...baseline,
    diagnostics: { baseline: baseline?.diagnostics, normalizedAttempts: diagnostics }
  };
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('invalidArguments');
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'inspect') {
    if (!args['capture-dir'] || !args['target-date'] || !args.output) throw new Error('invalidArguments');
    const result = await inspectDailyCapture({
      captureDir: path.resolve(args['capture-dir']),
      targetDate: args['target-date'],
      repoRoot: path.resolve(args['repo-root'] || '.')
    });
    await writeFile(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ready: result.ready, selectedImage: result.selectedImage?.file || '', startSlot: result.interpretation?.startSlot || '' })}\n`);
    if (!result.ready) process.exitCode = 2;
    return;
  }
  if (args.mode === 'bind') {
    if (!args.draft || !args.output || !args['artifact-run-id'] || !args['artifact-id'] || !args['artifact-name']) throw new Error('invalidArguments');
    const draft = JSON.parse(await readFile(path.resolve(args.draft), 'utf8'));
    if (!draft?.ready) throw new Error('dailyReviewNotReady');
    const envelope = bindReviewEnvelope(draft, {
      runId: args['artifact-run-id'],
      id: args['artifact-id'],
      name: args['artifact-name']
    });
    const base64 = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    await writeFile(path.resolve(args.output), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `review_payload_base64=${base64}\n`, { encoding: 'utf8', flag: 'a' });
    process.stdout.write(`${JSON.stringify({ ready: true, artifactId: envelope.artifact.id, pendingEvidenceFile: envelope.pendingEvidenceFile })}\n`);
    return;
  }
  throw new Error('invalidArguments');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`Daily normalized weather review failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
