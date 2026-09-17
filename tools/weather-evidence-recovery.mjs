import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectWeeklyScreenshot } from './weather-weekly-screenshot-review.mjs';

const START_SLOTS = ['00', '06', '12', '18'];
const MIN_VISUAL_SCORE = 0.58;
const MIN_VISUAL_MARGIN = 0.10;

function normalizeWeatherWord(value) {
  const text = String(value || '').trim();
  if (/^(?:晴|晴れ|晴天)$/.test(text)) return '晴';
  if (/^(?:雨|雨天)$/.test(text)) return '雨';
  if (/^(?:流星雨|流星群)$/.test(text)) return '流星群';
  if (/^虹$/.test(text)) return '虹';
  if (/^猛暑$/.test(text)) return '猛暑';
  return '';
}

export function extractFullDayWeatherIntervals(postText) {
  const out = [];
  const lines = String(postText || '').replace(/\r/g, '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/：/g, ':').replace(/[〜～]/g, '~');
    const match = line.match(/^(\d{1,2}):(\d{2})\s*[~\-]\s*翌\s*(\d{1,2}):(\d{2})\s*([^\s#]+)/);
    if (!match) continue;
    const sh = Number(match[1]), sm = Number(match[2]), eh = Number(match[3]), em = Number(match[4]);
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) continue;
    const weather = normalizeWeatherWord(match[5]);
    if (!weather) continue;
    const startMinute = sh * 60 + sm;
    const endMinute = 1440 + eh * 60 + em;
    if (endMinute - startMinute + 1 !== 1440) continue;
    if (sm !== 0 || !START_SLOTS.includes(String(sh).padStart(2, '0'))) continue;
    out.push({ startSlot: String(sh).padStart(2, '0'), weather, sourceLine: rawLine.trim() });
  }
  return out;
}

function chooseVisualDailyAttempt(daily) {
  const attempts = Array.isArray(daily?.diagnostics?.ocrAttempts) ? daily.diagnostics.ocrAttempts : [];
  const usable = attempts.filter(attempt => {
    const slots = Array.isArray(attempt?.slots) ? attempt.slots : [];
    return attempt?.okCount === 5 && slots.length === 5 && slots.every(slot =>
      normalizeWeatherWord(slot?.value) && Number(slot?.bestScore) >= MIN_VISUAL_SCORE && Number(slot?.margin) >= MIN_VISUAL_MARGIN
    );
  });
  usable.sort((a, b) =>
    Number(b.highCount || 0) - Number(a.highCount || 0) ||
    Number(b.minMargin || 0) - Number(a.minMargin || 0) ||
    Number(b.avg || 0) - Number(a.avg || 0)
  );
  return usable[0] || null;
}

export async function recoverDailyFromImageAndPost({ daily, captureDir, targetDate, postText }) {
  if (daily?.ready) return daily;
  const visual = chooseVisualDailyAttempt(daily);
  if (!visual) return daily;

  const visualWeather = visual.slots.map(slot => normalizeWeatherWord(slot.value));
  const uniqueWeather = [...new Set(visualWeather)];
  if (uniqueWeather.length !== 1) return daily;

  const interval = extractFullDayWeatherIntervals(postText).find(item => item.weather === uniqueWeather[0]);
  if (!interval) return daily;

  let capture;
  try { capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8')); } catch { return daily; }
  const media = (capture.rawMedia || []).find(item => String(item?.file || '') === String(visual.file || ''));
  if (!media?.file || !media?.mimeType || !/^[a-f0-9]{64}$/i.test(String(media.sha256 || ''))) return daily;

  const slots = visual.slots.map((slot, index) => ({
    slot: `slot${index}`,
    visible: true,
    weather: [normalizeWeatherWord(slot.value)],
    confidence: 'high',
    description: `ゲーム内UI画像テンプレート判定 score=${Number(slot.bestScore).toFixed(3)} margin=${Number(slot.margin).toFixed(3)}。投稿本文は開始時刻と同一天気の補佐照合のみ。`
  }));

  return {
    schemaVersion: 1,
    ready: true,
    targetDate,
    selectedImage: { file: media.file, mimeType: media.mimeType, captureSha256: media.sha256 },
    interpretation: {
      ready: true,
      observedDate: targetDate,
      startSlot: interval.startSlot,
      slots,
      confidence: 'high',
      summary: `ゲーム内UI画像で5枠の天気を判定し、画像OCRで欠けた開始時刻だけを投稿本文の24時間表記「${interval.sourceLine}」で補佐確認。天気値は本文から上書きしていません。`,
      unresolved: []
    },
    diagnostics: {
      ...(daily?.diagnostics || {}),
      recoveryMode: 'image-weather-plus-text-start-slot',
      visualAttempt: visual,
      textInterval: interval
    }
  };
}

export async function inspectWeeklyAcrossCapturedMedia({ captureDir, targetDate, repoRoot, currentWeekly = null }) {
  if (currentWeekly?.ready) return currentWeekly;
  let capture;
  let postText;
  try {
    capture = JSON.parse(await readFile(path.join(captureDir, 'capture.json'), 'utf8'));
    postText = await readFile(path.join(captureDir, capture.postContent?.file || 'post-content.txt'), 'utf8');
  } catch {
    return currentWeekly;
  }

  const attempts = [];
  for (const media of (capture.rawMedia || []).slice(0, 4)) {
    if (!media?.file || !media?.mimeType || !/^[a-f0-9]{64}$/i.test(String(media.sha256 || ''))) continue;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'heartopia-weekly-'));
    try {
      await copyFile(path.join(captureDir, media.file), path.join(tempDir, media.file));
      await writeFile(path.join(tempDir, 'post-content.txt'), postText, 'utf8');
      await writeFile(path.join(tempDir, 'capture.json'), JSON.stringify({
        status: 'captured',
        postContent: { file: 'post-content.txt' },
        evidence: { file: media.file, mimeType: media.mimeType, sha256: media.sha256 }
      }), 'utf8');
      const result = await inspectWeeklyScreenshot({ captureDir: tempDir, targetDate, repoRoot });
      attempts.push({ file: media.file, ready: result?.ready === true, reason: result?.reason || result?.diagnostics?.reason || '' });
      if (result?.ready) {
        return {
          ...result,
          diagnostics: {
            ...(result.diagnostics || {}),
            recoveryMode: 'weekly-from-raw-media',
            rawMediaAttempts: attempts
          }
        };
      }
    } catch (error) {
      attempts.push({ file: media.file, ready: false, reason: String(error?.message || error) });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  if (!currentWeekly) return { ready: false, diagnostics: { reason: 'weeklyRawMediaNotReady', rawMediaAttempts: attempts } };
  return {
    ...currentWeekly,
    diagnostics: {
      ...(currentWeekly.diagnostics || {}),
      rawMediaAttempts: attempts
    }
  };
}
