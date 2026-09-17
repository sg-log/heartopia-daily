import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { inspectWeeklyScreenshot } from './weather-weekly-screenshot-review.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('unsupportedEvidenceType');
}

export async function createVerifiedPanelCapture({ captureDir, targetDate, repoRoot = path.resolve('.') }) {
  const weekly = await inspectWeeklyScreenshot({ captureDir, targetDate, repoRoot });
  const rect = weekly?.diagnostics?.embeddedPanel;
  const source = weekly?.selectedImage;
  if (!weekly?.ready || !rect || !source?.file || !source?.captureSha256) {
    return { ready: false, reason: 'verifiedPanelNotLocated', weekly };
  }

  const sourcePath = path.join(captureDir, source.file);
  const sourceBytes = await readFile(sourcePath);
  if (sha256(sourceBytes) !== source.captureSha256) {
    return { ready: false, reason: 'verifiedPanelSourceHashMismatch', weekly };
  }
  const sourceMime = mimeFromBytes(sourceBytes);
  if (source.mimeType && sourceMime !== source.mimeType) {
    return { ready: false, reason: 'verifiedPanelSourceMimeMismatch', weekly };
  }

  const panelFile = 'verified-weather-panel.jpg';
  const panelPath = path.join(captureDir, panelFile);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 2200, height: 5200 } });
    await page.setContent(`<style>html,body{margin:0;padding:0}</style><img id="src" src="data:${sourceMime};base64,${sourceBytes.toString('base64')}" style="display:block">`);
    await page.locator('#src').waitFor({ state: 'visible' });
    await page.screenshot({
      path: panelPath,
      type: 'jpeg',
      quality: 95,
      animations: 'disabled',
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
    });
  } finally {
    await browser.close();
  }

  const panelBytes = await readFile(panelPath);
  const panelSha256 = sha256(panelBytes);
  const originalCapture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8'));
  const captureFile = 'verified-panel-capture.json';
  const derivedCapture = {
    status: 'captured',
    adapter: 'verified-panel',
    sourceUrl: originalCapture.sourceUrl,
    finalUrl: originalCapture.finalUrl || originalCapture.sourceUrl,
    sourceType: originalCapture.sourceType,
    sourceId: originalCapture.sourceId || null,
    capturedAt: originalCapture.capturedAt || new Date().toISOString(),
    postContent: originalCapture.postContent || { file: 'post-content.txt' },
    rawMedia: [{
      file: panelFile,
      mimeType: 'image/jpeg',
      byteSize: panelBytes.length,
      sha256: panelSha256,
      sourceScope: 'verified-game-ui-crop',
      derivedFrom: source.file,
      derivedFromSha256: source.captureSha256,
      crop: rect
    }],
    evidence: {
      file: panelFile,
      mimeType: 'image/jpeg',
      byteSize: panelBytes.length,
      sha256: panelSha256,
      kind: 'verified-game-ui-crop',
      derivedFrom: source.file,
      derivedFromSha256: source.captureSha256,
      crop: rect
    }
  };
  await writeFile(path.join(captureDir, captureFile), `${JSON.stringify(derivedCapture, null, 2)}\n`, 'utf8');

  return {
    ready: true,
    captureFile,
    selectedImage: { file: panelFile, mimeType: 'image/jpeg', captureSha256: panelSha256 },
    sourceImage: source,
    crop: rect,
    weekly
  };
}
