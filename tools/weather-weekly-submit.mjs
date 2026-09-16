import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_SLOTS = new Set(['00','06','12','18']);
const WEATHER = new Set(['晴','雨','流星群','虹','猛暑','雪','桜']);
const WEEK_KEYS = Array.from({length:7}, (_, i) => `week${i + 1}`);
const SLOT_KEYS = Array.from({length:5}, (_, i) => `slot${i}`);

function cleanWeatherArray(value, label, allowEmpty = false) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (allowEmpty && value.length === 0) return [];
  if (value.length < 1 || value.length > 4) throw new Error(`${label} must contain 1-4 weather values.`);
  const values = value.map(String);
  if (new Set(values).size !== values.length || values.some((item) => !WEATHER.has(item))) throw new Error(`${label} contains unsupported or duplicate weather values.`);
  return values;
}

export function chooseApprovedBaseline(reports, baseDate) {
  if (!Array.isArray(reports)) throw new Error('Approved API response does not contain reports.');
  const matches = reports.filter((report) => String(report?.date || '') === baseDate);
  if (!matches.length) throw new Error(`No approved hourly weather exists for ${baseDate}; weekly pending was not created.`);
  const baseline = matches.at(-1);
  const startSlot = String(baseline.startSlot || '');
  if (!START_SLOTS.has(startSlot)) throw new Error('Approved hourly baseline has an invalid startSlot.');
  const slots = {};
  for (const key of SLOT_KEYS) slots[key] = cleanWeatherArray(baseline.slots?.[key], `approved.${key}`);
  return { startSlot, slots };
}

export function buildWeeklySubmitPayload(preview, baseline, evidenceBytes) {
  if (!preview || preview.status !== 'prepared') throw new Error('Prepared weekly preview is required.');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(preview.baseDate || ''))) throw new Error('Prepared baseDate is invalid.');
  if (!Number.isInteger(preview.visibleWeekCount) || preview.visibleWeekCount < 5 || preview.visibleWeekCount > 7) throw new Error('Prepared weekly preview must contain 5-7 visible days.');
  const weeks = {};
  for (const key of WEEK_KEYS) weeks[key] = cleanWeatherArray(preview.weeks?.[key] || [], key, true);
  const populated = WEEK_KEYS.filter((key) => weeks[key].length);
  if (populated.length !== preview.visibleWeekCount || populated.some((key, index) => key !== `week${index + 1}`)) throw new Error('Weekly values must be consecutive from week1 with only unseen trailing days left empty.');
  for (const key of SLOT_KEYS) cleanWeatherArray(baseline.slots?.[key], key);
  if (!START_SLOTS.has(baseline.startSlot)) throw new Error('Baseline startSlot is invalid.');
  if (!Buffer.isBuffer(evidenceBytes) || evidenceBytes.length !== Number(preview.evidence?.byteSize)) throw new Error('Evidence bytes do not match prepared preview.');
  const memo = `週間予報自動候補。時間別5枠は${preview.baseDate}の承認済みデータを継承。画像で確認できた週間${preview.visibleWeekCount}日分のみ登録し、未表示日は空欄。${String(preview.summary || '').trim()}`;
  if (memo.length > 1000) throw new Error('Weekly pending memo exceeds 1000 characters.');
  return {
    action: 'submit',
    date: preview.baseDate,
    startSlot: baseline.startSlot,
    slots: Object.fromEntries(SLOT_KEYS.map((key) => [key, [...baseline.slots[key]]])),
    weeks,
    memo,
    sourceUrl: preview.sourceUrl,
    sourceImageUrls: Array.isArray(preview.sourceImageUrls) ? preview.sourceImageUrls : [],
    sourceType: preview.sourceType,
    retrievedAt: preview.retrievedAt,
    evidenceImages: [{
      mimeType: preview.evidence.mimeType,
      byteSize: preview.evidence.byteSize,
      sha256: preview.evidence.sha256,
      kind: preview.evidence.kind,
      capturedAt: preview.evidence.capturedAt,
      bodyBase64: evidenceBytes.toString('base64')
    }]
  };
}

export function weatherContentMatchesPayload(report, payload) {
  if (!report || String(report.date || '') !== payload.date || String(report.startSlot || '') !== payload.startSlot) return false;
  for (const key of SLOT_KEYS) if (JSON.stringify(report.slots?.[key] || []) !== JSON.stringify(payload.slots[key] || [])) return false;
  for (const key of WEEK_KEYS) if (JSON.stringify(report.weeks?.[key] || []) !== JSON.stringify(payload.weeks[key] || [])) return false;
  return true;
}

export function reportMatchesPayload(report, payload) {
  if (!weatherContentMatchesPayload(report, payload)) return false;
  if (String(report.sourceUrl || '') !== String(payload.sourceUrl || '')) return false;
  return true;
}

async function postJson(apiUrl, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(apiUrl, {
      method: 'POST', headers: {'content-type':'application/json; charset=utf-8'},
      body: JSON.stringify(payload), signal: controller.signal, redirect: 'follow'
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Weather API returned non-JSON (${response.status}).`); }
    if (!response.ok || data?.ok !== true) throw new Error(`Weather API request failed: ${String(data?.failureCode || data?.error || response.status)}`);
    return data;
  } finally { clearTimeout(timeout); }
}

function readApiUrl(indexPath) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const match = html.match(/\bconst\s+WEATHER_API_URL\s*=\s*"([^"]+)"\s*;/m);
  if (!match) throw new Error('WEATHER_API_URL was not found in index.html.');
  const url = new URL(match[1]);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('WEATHER_API_URL must be a clean HTTPS URL.');
  return url.href;
}

function argValue(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; }
function appendOutput(name, value) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8'); }

async function main() {
  const previewPath = argValue('--preview');
  const resultPath = argValue('--result');
  const indexPath = argValue('--index') || path.resolve('index.html');
  if (!previewPath || !resultPath) throw new Error('Required: --preview --result');
  const adminKey = process.env.WEATHER_ADMIN_KEY || '';
  const postKey = process.env.WEATHER_POST_KEY || '';
  if (!adminKey || !postKey) throw new Error('WEATHER_ADMIN_KEY and WEATHER_POST_KEY are required.');
  const preview = JSON.parse(fs.readFileSync(previewPath, 'utf8'));
  const apiUrl = readApiUrl(indexPath);

  const approved = await postJson(apiUrl, { action:'approved', adminKey });
  const baseline = chooseApprovedBaseline(approved.reports, preview.baseDate);
  const evidenceBytes = fs.readFileSync(preview.evidence.localPath);
  const payload = buildWeeklySubmitPayload(preview, baseline, evidenceBytes);

  const pendingBefore = await postJson(apiUrl, { action:'pending', adminKey });
  const duplicateReport = [
    ...(Array.isArray(pendingBefore.reports) ? pendingBefore.reports : []),
    ...(Array.isArray(approved.reports) ? approved.reports : [])
  ].find((report) => weatherContentMatchesPayload(report, payload));

  let reportId = '';
  let duplicate = false;
  if (duplicateReport) {
    reportId = String(duplicateReport.id || '');
    if (!reportId) throw new Error('Duplicate weather content was found without a report id.');
    duplicate = true;
  } else {
    const submitted = await postJson(apiUrl, { ...payload, postKey });
    if (submitted.status !== 'pending' || !submitted.id) throw new Error('Weekly submit did not return a pending receipt.');
    reportId = String(submitted.id);
    duplicate = Boolean(submitted.duplicate);

    const pending = await postJson(apiUrl, { action:'pending', adminKey });
    const matches = (pending.reports || []).filter((report) => String(report.id || '') === reportId);
    if (matches.length !== 1 || !reportMatchesPayload(matches[0], payload)) throw new Error('Saved weekly pending does not match the reviewed weekly payload.');
  }

  const result = {
    status: 'pending', reportId, duplicate,
    baseDate: preview.baseDate, visibleWeekCount: preview.visibleWeekCount,
    captureSha256: preview.evidence.sha256,
    reviewStorageSha256: preview.reviewerBinding?.reviewStoredSha256 || '',
    pendingEvidenceSource: 'capture-artifact', reviewScope: preview.reviewScope,
    sha256Match: preview.evidence.sha256 === preview.reviewerBinding?.reviewStoredSha256
  };
  fs.mkdirSync(path.dirname(path.resolve(resultPath)), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  appendOutput('report_id', result.reportId);
  appendOutput('duplicate', String(result.duplicate));
  appendOutput('base_date', result.baseDate);
  appendOutput('visible_week_count', String(result.visibleWeekCount));
  appendOutput('capture_sha256', result.captureSha256);
  appendOutput('review_storage_sha256', result.reviewStorageSha256);
  appendOutput('pending_evidence_source', result.pendingEvidenceSource);
  appendOutput('review_scope', result.reviewScope);
  appendOutput('sha256_match', String(result.sha256Match));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
