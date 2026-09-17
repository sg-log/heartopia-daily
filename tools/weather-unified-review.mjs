import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindReviewEnvelope, inspectCapture } from './weather-deterministic-review.mjs';
import { inspectDirectPanelCapture } from './weather-direct-panel-review.mjs';
import { inspectWeeklyScreenshot } from './weather-weekly-screenshot-review.mjs';
import { inspectWeeklyAcrossCapturedMedia, recoverDailyFromImageAndPost } from './weather-evidence-recovery.mjs';

const START_SLOTS = ['00', '06', '12', '18'];

export function inferStartSlotFromMappings(mappings) {
  const normalized = [];
  for (const mapping of mappings || []) {
    const values = Array.from({ length: 5 }, (_, index) => {
      const raw = String(mapping?.[index] || '').trim();
      if (!raw) return '';
      const value = raw.padStart(2, '0').slice(-2);
      return START_SLOTS.includes(value) ? value : '';
    });
    if (values.filter(Boolean).length >= 2) normalized.push(values);
  }
  if (!normalized.length) return null;

  const merged = Array(5).fill('');
  for (let index = 0; index < 5; index += 1) {
    const seen = [...new Set(normalized.map(values => values[index]).filter(Boolean))];
    if (seen.length === 1) merged[index] = seen[0];
  }
  if (merged.filter(Boolean).length >= 2) normalized.push(merged);

  let best = null;
  for (const mapped of normalized) {
    const observed = mapped.filter(Boolean).length;
    const matches = [];
    for (const startSlot of START_SLOTS) {
      const startIndex = START_SLOTS.indexOf(startSlot);
      const expected = Array.from({ length: 5 }, (_, index) => START_SLOTS[(startIndex + index) % START_SLOTS.length]);
      let mismatch = false;
      for (let index = 0; index < 5; index += 1) {
        if (mapped[index] && mapped[index] !== expected[index]) mismatch = true;
      }
      if (!mismatch) matches.push({ startSlot, expected });
    }
    if (matches.length !== 1) continue;
    const candidate = { ...matches[0], mapped, observed };
    if (!best || candidate.observed > best.observed) best = candidate;
  }
  return best;
}

export function extractTimedMeteorIntervals(text) {
  const out = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/：/g, ':').replace(/[〜～]/g, '~');
    if (!/(?:流星雨|流星群|meteor\s*shower)/i.test(line)) continue;
    const match = line.match(/^(翌\s*)?(\d{1,2}):(\d{2})\s*[~\-]\s*(翌\s*)?(\d{1,2}):(\d{2})/i);
    if (!match) continue;
    const startHour = Number(match[2]), startMinutePart = Number(match[3]);
    const endHour = Number(match[5]), endMinutePart = Number(match[6]);
    if (startHour > 23 || endHour > 23 || startMinutePart > 59 || endMinutePart > 59) continue;
    let startDay = match[1] ? 1 : 0;
    let endDay = match[4] ? 1 : startDay;
    const startClock = startHour * 60 + startMinutePart;
    const endClock = endHour * 60 + endMinutePart;
    if (endDay === startDay && endClock < startClock) endDay += 1;
    out.push({
      startMinute: startDay * 1440 + startClock,
      endMinute: endDay * 1440 + endClock,
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
    slot.weather = [hint.weather];
    slot.confidence = 'high';
    slot.description = ((slot.description || '') + ' 投稿本文の時刻付き「流星雨/流星群」と照合。').trim();
    corrections.push({ slot: slot.slot, previous, weather: hint.weather, sourceLine: hint.sourceLine });
  }
  if (!corrections.length) return result;
  clone.interpretation.summary = ((clone.interpretation.summary || '') + ' 投稿本文の時刻付き特殊天気を照合。').trim();
  clone.diagnostics = { ...(clone.diagnostics || {}), textWeatherHints: hints, textWeatherCorrections: corrections };
  return clone;
}

function uniqueReviewedImages(images) {
  const seen = new Set();
  const out = [];
  for (const image of images || []) {
    if (!image?.file || !image?.mimeType || !image?.captureSha256) continue;
    const key = `${image.file}\n${image.captureSha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: String(image.file), mimeType: String(image.mimeType), captureSha256: String(image.captureSha256) });
  }
  return out;
}

export function combineDailyWeeklyReviews(daily, weekly, directFailure = null) {
  if (!daily?.ready || daily.interpretation?.ready !== true || !daily.selectedImage) return null;
  if (!weekly?.ready || weekly.interpretation?.ready !== true || !weekly.selectedImage) return null;
  if (String(daily.targetDate || '') !== String(weekly.targetDate || '')) return null;
  const days = weekly.interpretation.days;
  if (!Array.isArray(days) || days.length < 5 || days.length > 7) return null;
  if (days.some(day => day?.visible !== true || day?.confidence !== 'high' || !Array.isArray(day?.weather) || !day.weather.length)) return null;

  const reviewedImages = uniqueReviewedImages([daily.selectedImage, weekly.selectedImage]);
  if (!reviewedImages.length || reviewedImages.length > 4) return null;
  const primary = reviewedImages.find(image => image.file === daily.selectedImage.file && image.captureSha256 === daily.selectedImage.captureSha256) || reviewedImages[0];
  const summary = `${String(daily.interpretation.summary || '').trim()} 週間欄は同じ公開投稿の取得済み証拠画像から別途判読。`.trim();

  return {
    schemaVersion: 2,
    ready: true,
    targetDate: daily.targetDate,
    selectedImage: primary,
    reviewedImages,
    pendingEvidenceFile: primary.file,
    interpretation: {
      ...daily.interpretation,
      weeklyDays: days,
      confidence: 'high',
      summary,
      unresolved: []
    },
    diagnostics: {
      mode: 'split-daily-weekly-evidence',
      directAttempt: directFailure?.diagnostics || null,
      daily: daily.diagnostics || null,
      weekly: weekly.diagnostics || null,
      reviewedImages
    }
  };
}

export async function inspectUnifiedCapture({ captureDir, targetDate, repoRoot = path.resolve('.') }) {
  const direct = await inspectDirectPanelCapture({ captureDir, targetDate, repoRoot });
  let postText = '';
  try { postText = await readFile(path.join(captureDir, 'post-content.txt'), 'utf8'); } catch {}
  if (direct?.ready) return applyTimedSpecialWeatherHints(direct, postText);

  let daily = null;
  let weekly = null;
  try { daily = await inspectCapture({ captureDir, targetDate, repoRoot }); } catch (error) {
    daily = { ready:false, diagnostics:{ reason:'dailyFallbackError', message:String(error?.message || error) } };
  }
  if (!daily?.ready) {
    try { daily = await recoverDailyFromImageAndPost({ daily, captureDir, targetDate, postText }); } catch (error) {
      daily = { ...daily, diagnostics:{ ...(daily?.diagnostics || {}), recoveryError:String(error?.message || error) } };
    }
  }

  try { weekly = await inspectWeeklyScreenshot({ captureDir, targetDate, repoRoot }); } catch (error) {
    weekly = { ready:false, diagnostics:{ reason:'weeklyFallbackError', message:String(error?.message || error) } };
  }
  if (!weekly?.ready) {
    try { weekly = await inspectWeeklyAcrossCapturedMedia({ captureDir, targetDate, repoRoot, currentWeekly: weekly }); } catch (error) {
      weekly = { ...weekly, diagnostics:{ ...(weekly?.diagnostics || {}), rawMediaRecoveryError:String(error?.message || error) } };
    }
  }

  const combined = combineDailyWeeklyReviews(daily, weekly, direct);
  if (combined) return applyTimedSpecialWeatherHints(combined, postText);

  return {
    ...direct,
    diagnostics: {
      ...(direct?.diagnostics || {}),
      splitFallback: {
        dailyReady: daily?.ready === true,
        weeklyReady: weekly?.ready === true,
        daily: daily?.diagnostics || null,
        weekly: weekly?.diagnostics || null
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
