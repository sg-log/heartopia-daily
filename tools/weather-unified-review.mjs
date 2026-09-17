import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindReviewEnvelope, inspectCapture } from './weather-deterministic-review.mjs';
import { inspectDirectPanelCapture } from './weather-direct-panel-review.mjs';
import { inspectWeeklyScreenshot } from './weather-weekly-screenshot-review.mjs';

const START_SLOTS = ['00', '06', '12', '18'];
const WEATHER_VALUES = ['晴', '雨', '流星群', '虹', '猛暑'];

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

function targetDateLines(text, targetDate) {
  const source = String(text || '').replace(/\r/g, '');
  if (!targetDate) return source.split('\n');
  const match = String(targetDate).match(/^20\d{2}-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const targetMonth = Number(match[1]);
  const targetDay = Number(match[2]);
  const lines = source.split('\n');
  const out = [];
  let active = false;
  let sawHeading = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^(?:20\d{2}[\/\-年]\s*)?(\d{1,2})[\/月](\d{1,2})(?:日)?(?:\([^)]*\))?/);
    if (heading) {
      sawHeading = true;
      active = Number(heading[1]) === targetMonth && Number(heading[2]) === targetDay;
    }
    if (active) out.push(rawLine);
  }
  return sawHeading ? out : [];
}

function normalizeWeatherWord(line) {
  const text = String(line || '');
  if (/(?:流星雨|流星群|meteor\s*shower)/i.test(text)) return '流星群';
  if (/猛暑/.test(text)) return '猛暑';
  if (/虹/.test(text)) return '虹';
  if (/晴/.test(text)) return '晴';
  if (/雨/.test(text)) return '雨';
  return '';
}

export function extractFullDayStartSlotHint(text, targetDate) {
  const hints = [];
  for (const rawLine of targetDateLines(text, targetDate)) {
    const line = rawLine.trim().replace(/：/g, ':').replace(/[〜～]/g, '~');
    const weather = normalizeWeatherWord(line);
    if (!weather) continue;
    const range = line.match(/(\d{1,2}):(\d{2})\s*[~\-]\s*(翌\s*)?(\d{1,2}):(\d{2})/);
    if (!range) continue;
    const startHour = Number(range[1]), startMinutePart = Number(range[2]);
    const endHour = Number(range[4]), endMinutePart = Number(range[5]);
    if (!START_SLOTS.includes(String(startHour).padStart(2, '0')) || startMinutePart !== 0 || endHour > 23 || endMinutePart > 59) continue;
    const start = startHour * 60;
    let end = endHour * 60 + endMinutePart + (range[3] ? 1440 : 0);
    if (!range[3] && end < start) end += 1440;
    if (end - start !== 1439) continue;
    hints.push({ startSlot: String(startHour).padStart(2, '0'), weather, sourceLine: rawLine.trim() });
  }
  const unique = [...new Map(hints.map(item => [`${item.startSlot}|${item.weather}`, item])).values()];
  return unique.length === 1 ? unique[0] : null;
}

export function extractTimedMeteorIntervals(text, targetDate = null) {
  const out = [];
  const lines = targetDate ? targetDateLines(text, targetDate) : String(text || '').replace(/\r/g, '').split('\n');
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
  const targetDate = String(result.targetDate || result.interpretation.observedDate || '');
  const hints = extractTimedMeteorIntervals(postText, targetDate || null);
  if (!hints.length) return result;
  const clone = typeof structuredClone === 'function' ? structuredClone(result) : JSON.parse(JSON.stringify(result));
  const baseMinutes = Number(startSlot) * 60;
  const corroborations = [];
  const conflicts = [];
  for (let index = 0; index < clone.interpretation.slots.length; index += 1) {
    const absoluteMinute = baseMinutes + index * 360;
    const hint = hints.find(item => absoluteMinute >= item.startMinute && absoluteMinute <= item.endMinute);
    if (!hint) continue;
    const slot = clone.interpretation.slots[index];
    const weather = Array.isArray(slot.weather) ? slot.weather : [];
    if (weather.includes(hint.weather)) {
      slot.description = ((slot.description || '') + ' 投稿本文の対象日ブロックにある時刻付き特殊天気と一致。').trim();
      corroborations.push({ slot: slot.slot, weather: hint.weather, sourceLine: hint.sourceLine });
    } else {
      conflicts.push({ slot: slot.slot, imageWeather: weather, textWeather: hint.weather, sourceLine: hint.sourceLine });
    }
  }
  clone.diagnostics = { ...(clone.diagnostics || {}), textWeatherHints: hints, textWeatherCorroborations: corroborations };
  if (!conflicts.length) return clone;
  clone.ready = false;
  clone.interpretation.ready = false;
  clone.interpretation.confidence = 'low';
  clone.interpretation.unresolved = [...new Set([...(clone.interpretation.unresolved || []), 'ゲーム内UI画像と投稿本文の特殊天気が一致しないため人間確認が必要です'])];
  clone.interpretation.summary = ((clone.interpretation.summary || '') + ' 投稿本文とは不一致のため自動確定を停止。').trim();
  clone.diagnostics.textWeatherConflicts = conflicts;
  return clone;
}

export function recoverDailyImageFirstWithTextStart(daily, capture, postText, targetDate) {
  if (daily?.ready) return daily;
  const hint = extractFullDayStartSlotHint(postText, targetDate);
  if (!hint) return daily;
  const attempts = Array.isArray(daily?.diagnostics?.ocrAttempts) ? daily.diagnostics.ocrAttempts : [];
  const candidates = attempts.filter(attempt => {
    if (Number(attempt?.geometryDistance) > .03 || Number(attempt?.okCount) !== 5 || !Array.isArray(attempt?.slots) || attempt.slots.length !== 5) return false;
    return attempt.slots.every(slot => WEATHER_VALUES.includes(String(slot?.value || '')) && Number(slot?.bestScore) >= .58 && Number(slot?.margin) >= .10);
  }).sort((a, b) => {
    const avgA = a.slots.reduce((sum, slot) => sum + Number(slot.bestScore || 0), 0) / 5;
    const avgB = b.slots.reduce((sum, slot) => sum + Number(slot.bestScore || 0), 0) / 5;
    return Number(a.geometryDistance) - Number(b.geometryDistance) || avgB - avgA;
  });
  const best = candidates[0];
  if (!best) return daily;
  const imageWeather = best.slots.map(slot => String(slot.value));
  if (imageWeather.some(value => value !== hint.weather)) {
    return {
      ...daily,
      diagnostics: {
        ...(daily?.diagnostics || {}),
        textStartSlotSupplementRejected: { reason: 'imageTextWeatherConflict', imageWeather, textWeather: hint.weather, sourceLine: hint.sourceLine }
      }
    };
  }
  const media = (capture?.rawMedia || []).find(item => String(item?.file || '') === String(best.file || ''));
  if (!media?.file || !media?.mimeType || !media?.sha256) return daily;
  const slots = best.slots.map((slot, index) => ({
    slot: `slot${index}`,
    visible: true,
    weather: [String(slot.value)],
    confidence: slot.confidence === 'high' ? 'high' : 'medium',
    description: `ゲーム内UI画像テンプレート判定 score=${Number(slot.bestScore).toFixed(3)} margin=${Number(slot.margin).toFixed(3)}`
  }));
  const allHigh = slots.every(slot => slot.confidence === 'high');
  return {
    schemaVersion: 1,
    ready: true,
    targetDate,
    selectedImage: { file: String(media.file), mimeType: String(media.mimeType), captureSha256: String(media.sha256) },
    interpretation: {
      ready: true,
      observedDate: targetDate,
      startSlot: hint.startSlot,
      slots,
      confidence: allHigh ? 'high' : 'medium',
      summary: `ゲーム内UI画像から天気5枠を判読し、画像OCRで欠けた開始時刻だけ投稿本文の対象日ブロック（${hint.sourceLine}）で補完。`,
      unresolved: []
    },
    diagnostics: {
      ...(daily?.diagnostics || {}),
      mode: 'image-first-text-start-supplement',
      recoveredFromImage: { file: best.file, rect: best.rect, geometryDistance: best.geometryDistance, slotScores: best.slots },
      textStartSlotSupplement: hint
    }
  };
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
  const summary = `${String(daily.interpretation.summary || '').trim()} 週間欄は同じ公開投稿の取得済みゲーム内UI証拠画像から別途判読。`.trim();

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
      confidence: daily.interpretation.confidence === 'high' ? 'high' : 'medium',
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
  let capture = null;
  try { postText = await readFile(path.join(captureDir, 'post-content.txt'), 'utf8'); } catch {}
  try { capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8')); } catch {}
  if (direct?.ready) return applyTimedSpecialWeatherHints(direct, postText);

  let daily = null;
  let weekly = null;
  try { daily = await inspectCapture({ captureDir, targetDate, repoRoot }); } catch (error) {
    daily = { ready:false, diagnostics:{ reason:'dailyFallbackError', message:String(error?.message || error) } };
  }
  daily = recoverDailyImageFirstWithTextStart(daily, capture, postText, targetDate);
  try { weekly = await inspectWeeklyScreenshot({ captureDir, targetDate, repoRoot }); } catch (error) {
    weekly = { ready:false, diagnostics:{ reason:'weeklyFallbackError', message:String(error?.message || error) } };
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
