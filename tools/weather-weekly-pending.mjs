import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateWeeklyReviewRecord } from './weather-weekly-review.mjs';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function firstDiscovery(value) { return Array.isArray(value) ? value[0] : value; }
function findSingle(root, name) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) found.push(full);
    }
  };
  walk(root);
  if (found.length !== 1) throw new Error(`Artifact must contain exactly one ${name}.`);
  return found[0];
}
function detectMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return '';
}
function validHttpUrl(text) {
  try {
    const u = new URL(text);
    return ['http:','https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  } catch { return false; }
}

export function prepareWeeklyPendingPreview({ review, artifactDirectory, downloadedArtifact }) {
  const normalized = validateWeeklyReviewRecord(review);
  for (const key of ['runId','id','name']) {
    if (String(normalized.artifact[key]) !== String(downloadedArtifact[key])) throw new Error(`Downloaded artifact ${key} does not match review binding.`);
  }
  const root = path.resolve(artifactDirectory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Downloaded evidence artifact is missing.');
  const capturePath = findSingle(root, 'capture.json');
  const evidenceDir = path.dirname(capturePath);
  const discoveryPath = path.join(evidenceDir, 'discovery-candidate.json');
  if (!fs.existsSync(discoveryPath)) throw new Error('Downloaded artifact is missing discovery-candidate.json.');
  const capture = readJson(capturePath);
  const discovery = firstDiscovery(readJson(discoveryPath));
  if (capture.status !== 'captured' || !Array.isArray(capture.rawMedia)) throw new Error('Captured raw media metadata is required for weekly review.');
  if (!discovery || discovery.retrievalStatus !== 'confirmed' || !Array.isArray(discovery.retrievalHistory) || discovery.retrievalHistory.length < 1) throw new Error('Confirmed discovery metadata is required.');
  if (!validHttpUrl(String(discovery.sourceUrl || ''))) throw new Error('Discovery source URL is invalid.');

  const selected = normalized.selectedReviewImage;
  const matches = capture.rawMedia.filter((item) =>
    String(item.file) === selected.file && String(item.mimeType) === selected.mimeType &&
    String(item.sha256) === selected.captureSha256 && Number(item.byteSize) > 0 && Number(item.byteSize) <= 524288
  );
  if (matches.length !== 1) throw new Error('Selected weekly review image does not exactly match capture raw-media metadata.');
  const media = matches[0];
  const evidencePath = path.join(evidenceDir, selected.file);
  if (!fs.existsSync(evidencePath)) throw new Error('Selected weekly review image is missing from artifact.');
  const bytes = fs.readFileSync(evidencePath);
  if (bytes.length !== Number(media.byteSize) || bytes.length > 524288) throw new Error('Selected weekly evidence byte size changed.');
  const digest = sha256(bytes);
  if (digest !== selected.captureSha256 || digest !== selected.reviewStoredSha256 || digest !== String(media.sha256)) throw new Error('Selected weekly evidence SHA-256 mismatch.');
  const mimeType = detectMime(bytes);
  if (!mimeType || mimeType !== selected.mimeType) throw new Error('Selected weekly evidence MIME signature mismatch.');

  const retrieval = discovery.retrievalHistory.at(-1);
  const sourceImageUrls = [];
  if (typeof media.url === 'string' && validHttpUrl(media.url)) sourceImageUrls.push(media.url);
  const weeks = Object.fromEntries(normalized.interpretation.days.map((day, index) => [`week${index + 1}`, [...day.weather]]));
  const capturedAt = String(capture.capturedAt || capture.evidence?.capturedAt || retrieval.retrievedAt || '');
  if (!/^20\d{2}-\d{2}-\d{2}T/.test(capturedAt)) throw new Error('Capture timestamp is missing.');
  const retrievedAt = String(retrieval.retrievedAt || '');
  if (!/^20\d{2}-\d{2}-\d{2}T/.test(retrievedAt)) throw new Error('Discovery retrieval timestamp is missing.');
  const sourceType = String(discovery.sourceType || '').trim();
  if (!sourceType || sourceType.length > 40) throw new Error('Discovery sourceType is missing or invalid.');

  return {
    status: 'prepared',
    baseDate: normalized.interpretation.baseDate,
    weeks,
    summary: normalized.interpretation.summary,
    sourceUrl: String(discovery.sourceUrl),
    sourceImageUrls,
    sourceType,
    retrievedAt,
    artifact: { ...normalized.artifact },
    evidence: {
      localPath: evidencePath,
      mimeType,
      byteSize: bytes.length,
      sha256: digest,
      kind: 'original',
      capturedAt
    },
    reviewScope: 'weekly-private-review-url-visual',
    reviewerBinding: {
      reviewStoredSha256: selected.reviewStoredSha256,
      workDisplayBytesCryptographicallyVerified: false
    }
  };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}
function appendOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}
function main() {
  const reviewPath = argValue('--review');
  const artifactDirectory = argValue('--artifact-dir');
  const outputPath = argValue('--output');
  if (!reviewPath || !artifactDirectory || !outputPath) throw new Error('Required: --review --artifact-dir --output');
  const preview = prepareWeeklyPendingPreview({
    review: readJson(reviewPath),
    artifactDirectory,
    downloadedArtifact: {
      runId: argValue('--artifact-run-id'), id: argValue('--artifact-id'), name: argValue('--artifact-name')
    }
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(preview, null, 2)}\n`, 'utf8');
  appendOutput('capture_sha256', preview.evidence.sha256);
  appendOutput('review_storage_sha256', preview.reviewerBinding.reviewStoredSha256);
  appendOutput('review_scope', preview.reviewScope);
  appendOutput('evidence_path', preview.evidence.localPath);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
