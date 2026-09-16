import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindReviewEnvelope } from './weather-deterministic-review.mjs';

export function buildUnifiedBindings(draft, artifact) {
  if (!draft?.ready || draft.interpretation?.ready !== true) throw new Error('unifiedReviewNotReady');
  const weeklyDays = draft.interpretation?.weeklyDays;
  if (!Array.isArray(weeklyDays) || weeklyDays.length < 5 || weeklyDays.length > 7) throw new Error('unifiedWeeklyNotReady');
  for (const day of weeklyDays) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(day?.date || '')) || day?.visible !== true || day?.confidence !== 'high' ||
      !Array.isArray(day?.weather) || day.weather.length < 1 || day.weather.length > 4) throw new Error('unifiedWeeklyNotReady');
  }

  const fullEnvelope = bindReviewEnvelope(draft, artifact);
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
  process.stdout.write(`${JSON.stringify({ready:true,artifactId:bindings.fullEnvelope.artifact.id,weeklyCount:bindings.fullEnvelope.interpretation.weeklyDays.length})}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`Unified weather bind failed: ${error.message}\n`); process.exitCode = 1; });
}
