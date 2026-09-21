import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindReviewEnvelope } from './weather-deterministic-review.mjs';
import { inspectDirectPanelCapture } from './weather-direct-panel-review.mjs';
import { createVerifiedPanelCapture } from './weather-verified-panel-crop.mjs';

const START_SLOTS = ['00', '06', '12', '18'];

export function extractTimedMeteorIntervals(text) {
  const out = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/：/g, ':').replace(/[〜～]/g, '~');
    if (!/(?:流星雨|流星群|meteor\s*shower)/i.test(line)) continue;
    const interval = line.match(/^(翌\s*)?(\d{1,2}):(\d{2})\s*[~\-]\s*(翌\s*)?(\d{1,2}):(\d{2})/i);
    if (interval) {
      const startHour = Number(interval[2]), startMinutePart = Number(interval[3]);
      const endHour = Number(interval[5]), endMinutePart = Number(interval[6]);
      if (startHour > 23 || endHour > 23 || startMinutePart > 59 || endMinutePart > 59) continue;
      let startDay = interval[1] ? 1 : 0;
      let endDay = interval[4] ? 1 : startDay;
      const startClock = startHour * 60 + startMinutePart;
      const endClock = endHour * 60 + endMinutePart;
      if (endDay === startDay && endClock < startClock) endDay += 1;
      out.push({
        startMinute: startDay * 1440 + startClock,
        endMinute: endDay * 1440 + endClock,
        weather: '流星群',
        sourceLine: rawLine.trim()
      });
      continue;
    }

    // Natural posts often say only "18:00〜流星雨です". Treat that as an
    // exact slot hint, not an open-ended interval, so it can corroborate or
    // conflict with the 18:00 icon without spilling into the next 6-hour slot.
    const point = line.match(/^(翌\s*)?(\d{1,2}):(\d{2})\s*[~\-]\s*.*(?:流星雨|流星群|meteor\s*shower)/i);
    if (!point) continue;
    const hour = Number(point[2]), minutePart = Number(point[3]);
    if (hour > 23 || minutePart > 59) continue;
    const day = point[1] ? 1 : 0;
    const absoluteMinute = day * 1440 + hour * 60 + minutePart;
    out.push({
      startMinute: absoluteMinute,
      endMinute: absoluteMinute,
      weather: '流星群',
      sourceLine: rawLine.trim()
    });
  }
  return out;
}

export function applyTimedSpecialWeatherHints(result, postText) {
  if (!result?.ready || result.interpretation?.ready !== true) return result;
  const startSlot = String(result.interpretation.startSlot || '');
  if (!START_SLOTS.includes(startSlot)) return result;
  const hints = extractTimedMeteorIntervals(postText);
  if (!hints.length) return result;
  const clone = typeof structuredClone === 'function' ? structuredClone(result) : JSON.parse(JSON.stringify(result));
  const baseMinutes = Number(startSlot) * 60;
  const corrections = [];
  for (let index = 0; index < clone.interpretation.slots.length; index += 1) {
    const absoluteMinute = baseMinutes + index * 360;
    const hint = hints.find(item => absoluteMinute >= item.startMinute && absoluteMinute <= item.endMinute);
    if (!hint) continue;
    const slot = clone.interpretation.slots[index];
    const previous = Array.isArray(slot.weather) ? [...slot.weather] : [];
    if (previous.includes(hint.weather)) {
      slot.description = ((slot.description || '') + ' 投稿本文の時刻付き特殊天気と一致。').trim();
      corrections.push({ slot: slot.slot, previous, weather: hint.weather, sourceLine: hint.sourceLine, action:'confirmed' });
      continue;
    }
    clone.ready = false;
    clone.interpretation.ready = false;
    clone.interpretation.confidence = 'low';
    clone.interpretation.unresolved = [...(clone.interpretation.unresolved || []), `画像と投稿本文の天気が競合: ${slot.slot}`];
    clone.diagnostics = { ...(clone.diagnostics || {}), textWeatherHints: hints, textWeatherConflicts: [{ slot:slot.slot, imageWeather:previous, textWeather:hint.weather, sourceLine:hint.sourceLine }] };
    return clone;
  }
  if (!corrections.length) return result;
  clone.interpretation.summary = ((clone.interpretation.summary || '') + ' 投稿本文の時刻付き特殊天気を照合。').trim();
  clone.diagnostics = { ...(clone.diagnostics || {}), textWeatherHints: hints, textWeatherCorrections: corrections };
  return clone;
}

export async function inspectUnifiedCapture({ captureDir, targetDate, repoRoot = path.resolve('.') }) {
  const direct = await inspectDirectPanelCapture({ captureDir, targetDate, repoRoot });
  let postText = '';
  try { postText = await readFile(path.join(captureDir, 'post-content.txt'), 'utf8'); } catch {}
  if (direct?.ready) return applyTimedSpecialWeatherHints(direct, postText);

  let verifiedPanel = null;
  let verifiedDirect = null;
  try {
    verifiedPanel = await createVerifiedPanelCapture({ captureDir, targetDate, repoRoot });
    if (verifiedPanel?.ready) {
      verifiedDirect = await inspectDirectPanelCapture({
        captureDir, targetDate, repoRoot, captureFile: verifiedPanel.captureFile
      });
      if (verifiedDirect?.ready) {
        verifiedDirect = {
          ...verifiedDirect,
          pendingEvidenceFile: verifiedDirect.selectedImage?.file || '',
          diagnostics: {
            ...(verifiedDirect.diagnostics || {}),
            mode: 'verified-game-ui-crop',
            sourceImage: verifiedPanel.sourceImage,
            crop: verifiedPanel.crop
          }
        };
        return applyTimedSpecialWeatherHints(verifiedDirect, postText);
      }
    }
  } catch (error) {
    verifiedPanel = { ready:false, reason:'verifiedPanelPipelineError', message:String(error?.message || error) };
  }

  return {
    ...direct,
    diagnostics: {
      ...(direct?.diagnostics || {}),
      verifiedPanel: {
        ready: verifiedPanel?.ready === true,
        reason: verifiedPanel?.reason || '',
        directReady: verifiedDirect?.ready === true,
        direct: verifiedDirect?.diagnostics || null
      }
    }
  };
}

export function bindUnifiedReviewEnvelope(draft, artifact) {
  if (!draft?.ready || draft.interpretation?.ready !== true) throw new Error('unifiedReviewNotReady');
  const weeklyDays = draft.interpretation?.weeklyDays;
  if (!Array.isArray(weeklyDays) || weeklyDays.length < 5 || weeklyDays.length > 7) throw new Error('unifiedWeeklyNotReady');
  return bindReviewEnvelope(draft, artifact);
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
    const result = await inspectUnifiedCapture({
      captureDir: path.resolve(args['capture-dir']),
      targetDate: args['target-date'],
      repoRoot: path.resolve(args['repo-root'] || '.')
    });
    await writeFile(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ready: result.ready, selectedImage: result.selectedImage?.file || '', reviewedImageCount: result.reviewedImages?.length || (result.selectedImage ? 1 : 0), startSlot: result.interpretation?.startSlot || '', weeklyCount: result.interpretation?.weeklyDays?.length || 0 })}\n`);
    if (!result.ready) process.exitCode = 2;
    return;
  }

  if (args.mode === 'bind') {
    if (!args.draft || !args.output || !args['artifact-run-id'] || !args['artifact-id'] || !args['artifact-name']) throw new Error('invalidArguments');
    const draft = JSON.parse(await readFile(path.resolve(args.draft), 'utf8'));
    const envelope = bindUnifiedReviewEnvelope(draft, {
      runId: args['artifact-run-id'], id: args['artifact-id'], name: args['artifact-name']
    });
    const base64 = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    await writeFile(path.resolve(args.output), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `review_payload_base64=${base64}\n`, { encoding:'utf8', flag:'a' });
    process.stdout.write(`${JSON.stringify({ ready:true, artifactId:envelope.artifact.id, weeklyCount:envelope.interpretation.weeklyDays.length })}\n`);
    return;
  }
  throw new Error('invalidArguments');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { process.stderr.write(`Unified weather review failed: ${error.message}\n`); process.exitCode = 1; });
}
