import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindReviewEnvelope } from './weather-deterministic-review.mjs';

function assertSingleImageDraft(draft) {
  if (Array.isArray(draft?.reviewedImages)) {
    if (draft.reviewedImages.length !== 1) throw new Error('splitReviewedImagesNotSupported');
    const [reviewed] = draft.reviewedImages;
    if (String(reviewed?.file || '') !== String(draft.selectedImage?.file || '') ||
      String(reviewed?.captureSha256 || '') !== String(draft.selectedImage?.captureSha256 || '')) {
      throw new Error('splitReviewedImagesNotSupported');
    }
  }
  if (draft?.pendingEvidenceFile && String(draft.pendingEvidenceFile) !== String(draft.selectedImage?.file || '')) {
    throw new Error('splitReviewedImagesNotSupported');
  }
}

export function buildUnifiedBindings(draft, artifact) {
  if (!draft?.ready || draft.interpretation?.ready !== true) throw new Error('unifiedReviewNotReady');
  assertSingleImageDraft(draft);
  const weeklyDays = Array.isArray(draft.interpretation?.weeklyDays) ? draft.interpretation.weeklyDays : [];
  if (weeklyDays.length > 0 && (weeklyDays.length < 5 || weeklyDays.length > 7)) throw new Error('unifiedWeeklyNotReady');
  for (const day of weeklyDays) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(day?.date || '')) || day?.visible !== true || day?.confidence !== 'high' ||
      !Array.isArray(day?.weather) || day.weather.length < 1 || day.weather.length > 4) throw new Error('unifiedWeeklyNotReady');
  }

  let fullEnvelope = bindReviewEnvelope(draft, artifact);
  if (draft.sources && typeof draft.sources === 'object') {
    fullEnvelope = { ...fullEnvelope, sources: draft.sources };
  }
  const { weeklyDays: _weeklyDays, ...dailyInterpretation } = fullEnvelope.interpretation;
  const bridgeEnvelope = { ...fullEnvelope, interpretation: dailyInterpretation };
  return { fullEnvelope, bridgeEnvelope, weeklyCount: weeklyDays.length };
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
    await writeFile(process.env.GITHUB_OUTPUT, `review_payload_base64=${base64}\nweekly_count=${bindings.weeklyCount}\n`, { encoding:'utf8', flag:'a' });
  }
  process.stdout.write(`${JSON.stringify({ready:true,artifactId:bindings.fullEnvelope.artifact.id,reviewedImageCount:bindings.fullEnvelope.reviewedImages.length,weeklyCount:bindings.weeklyCount})}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`Unified weather bind failed: ${error.message}\n`); process.exitCode = 1; });
}
