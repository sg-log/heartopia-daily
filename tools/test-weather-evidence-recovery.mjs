import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractFullDayWeatherIntervals, recoverDailyFromImageAndPost } from './weather-evidence-recovery.mjs';

test('extracts only explicit full-day intervals on valid Heartopia start slots', () => {
  const text = '09/17(木)\n06:00～翌05:59　晴れ\n18:00～23:59 流星雨\n07:00～翌06:59 雨';
  assert.deepEqual(extractFullDayWeatherIntervals(text), [
    { startSlot: '06', weather: '晴', sourceLine: '06:00～翌05:59　晴れ' }
  ]);
});

test('recovers only the missing start slot when five visual weather slots agree with text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weather-recovery-test-'));
  try {
    const sha = 'a'.repeat(64);
    await writeFile(path.join(dir, 'capture.json'), JSON.stringify({
      rawMedia: [{ file:'raw-media-0.jpg', mimeType:'image/jpeg', sha256:sha }]
    }), 'utf8');
    const visualSlots = Array.from({length:5}, () => ({
      value:'晴', bestScore:.64, secondValue:'虹', secondScore:.42, margin:.22, confidence:'medium'
    }));
    const daily = {
      ready:false,
      diagnostics:{
        ocrAttempts:[{
          file:'raw-media-0.jpg', okCount:5, highCount:0, minMargin:.15, avg:.64,
          slots:visualSlots,
          ocr:{startSlot:'',times:[],valid:[],attempts:[],inferred:false}
        }]
      }
    };
    const result = await recoverDailyFromImageAndPost({
      daily, captureDir:dir, targetDate:'2026-09-17', postText:'09/17(木)\n06:00～翌05:59　晴れ'
    });
    assert.equal(result.ready, true);
    assert.equal(result.interpretation.startSlot, '06');
    assert.deepEqual(result.interpretation.slots.map(slot => slot.weather), Array(5).fill(['晴']));
    assert.equal(result.selectedImage.file, 'raw-media-0.jpg');
    assert.equal(result.diagnostics.recoveryMode, 'image-weather-plus-text-start-slot');
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
});

test('does not use post text when it disagrees with the image weather', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'weather-recovery-test-'));
  try {
    const sha = 'b'.repeat(64);
    await writeFile(path.join(dir, 'capture.json'), JSON.stringify({
      rawMedia: [{ file:'raw-media-0.jpg', mimeType:'image/jpeg', sha256:sha }]
    }), 'utf8');
    const daily = {
      ready:false,
      diagnostics:{ocrAttempts:[{
        file:'raw-media-0.jpg', okCount:5, highCount:0, minMargin:.15, avg:.64,
        slots:Array.from({length:5}, () => ({value:'晴',bestScore:.64,margin:.20}))
      }]}
    };
    const result = await recoverDailyFromImageAndPost({
      daily, captureDir:dir, targetDate:'2026-09-17', postText:'06:00～翌05:59　雨'
    });
    assert.equal(result.ready, false);
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
});
