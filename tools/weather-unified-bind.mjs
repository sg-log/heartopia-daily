import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindReviewEnvelope } from './weather-deterministic-review.mjs';

function normalizeReviewedImages(draft, fallbackImage) {
  const source = Array.isArray(draft?.reviewedImages) && draft.reviewedImages.length
    ? draft.reviewedImages
    : [fallbackImage];
  if (source.length < 1 || source.length > 4) throw new Error('invalidReviewedImages');
  const seen = new Set();
  const normalized = source.map((image) => {
    const file = String(image?.file || '');
    const mimeType = String(image?.mimeType || '');
    const captureSha256 = String(image?.captureSha256 || '');
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(file)) throw new Error('invalidReviewedImages');
    if (!['image/jpeg', 'image/png'].includes(mimeType)) throw new Error('invalidReviewedImages');
    if (!/^[a-f0-9]{64}$/.test(captureSha256)) throw new Error('invalidReviewedImages');
    const key = `${file}\n${captureSha256}`;
    if (seen.has(key)) throw new Error('invalidReviewedImages');
    seen.add(key);
    return { file, mimeType, captureSha256 };
  });
  const pendingEvidenceFile = String(draft?.pendingEvidenceFile || fallbackImage?.file || '');
  if (!normalized.some(image => image.file === pendingEvidenceFile)) throw new Error('invalidPendingEvidenceFile');
  return { reviewedImages: normalized, pendingEvidenceFile };
}

export function buildUnifiedBindings(draft, artifact) {
  if (!draft?.ready || draft.interpretation?.ready !== true) throw new Error('unifiedReviewNotReady');
  const weeklyDays = draft.interpretation?.weeklyDays;
  if (!Array.isArray(weeklyDays) || weeklyDays.length < 5 || weeklyDays.length > 7) throw new Error('unifiedWeeklyNotReady');
  for (const day of weeklyDays) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(day?.date || '')) || day?.visible !== true || day?.confidence !== 'high' ||
      !Array.isArray(day?.weather) || day.weather.length < 1 || day.weather.length > 4) throw new Error('unifiedWeeklyNotReady');
  }

  const baseEnvelope = bindReviewEnvelope(draft, artifact);
  const bindings = normalizeReviewedImages(draft, baseEnvelope.reviewedImages[0]);
  const fullEnvelope = {
    ...baseEnvelope,
    reviewedImages: bindings.reviewedImages,
    pendingEvidenceFile: bindings.pendingEvidenceFile
  };
  const { weeklyDays: _weeklyDays, ...dailyInterpretation } = fullEnvelope.interpretation;
  const bridgeEnvelope = { ...fullEnvelope, interpretation: dailyInterpretation };
  return { fullEnvelope, bridgeEnvelope };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error('invalidArguments');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.draft || !args.output || !args['artifact-run-id'] || !args['artifact-id'] || !args['artifact-name']) throw new Error('invalidArguments');
  const draft = JSON.parse(await readFile(path.resolve(args.draft), 'utf8'));
  const bindings = buildUnifiedBindings(draft, {
    runId: args['artifact-run-id'],
    id: args['artifact-id'],
    name: args['artifact-name']
  });
  await writeFile(path.resolve(args.output), `${JSON.stringify(bindings.fullEnvelope, null, 2)}\n`, 'utf8');
  const base64 = Buffer.from(JSON.stringify(bindings.bridgeEnvelope), 'utf8').toString('base64');
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `review_payload_base64=${base64}\nweekly_count=${bindings.fullEnvelope.interpretation.weeklyDays.length}\n`, { encoding:'utf8', flag:'a' });
  }
  process.stdout.write(`${JSON.stringify({ready:true,artifactId:bindings.fullEnvelope.artifact.id,reviewedImageCount:bindings.fullEnvelope.reviewedImages.length,weeklyCount:bindings.fullEnvelope.interpretation.weeklyDays.length})}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`Unified weather bind failed: ${error.message}\n`); process.exitCode = 1; });
}
