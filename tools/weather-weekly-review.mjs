import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEEKLY_REVIEW_MARKER = '<!-- heartopia-weather-weekly-review-v1 -->';
export const ALLOWED_WEATHER = new Set(['晴','雨','流星群','虹','猛暑','雪','桜']);

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new Error(`${label} has unexpected or missing properties.`);
  }
}

function validIsoDate(text) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === text;
}

function addDays(text, amount) {
  const date = new Date(`${text}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0,10);
}

export function validateWeeklyReviewRecord(record) {
  exactKeys(record, ['schemaVersion','responseType','artifact','selectedReviewImage','interpretation'], 'review');
  if (record.schemaVersion !== 1 || record.responseType !== 'weather-weekly-review') throw new Error('Unsupported weekly review schema.');

  exactKeys(record.artifact, ['runId','id','name'], 'artifact');
  for (const key of ['runId','id','name']) {
    if (typeof record.artifact[key] !== 'string' || !record.artifact[key].trim()) throw new Error(`artifact.${key} is required.`);
  }
  if (!/^\d+$/.test(record.artifact.runId) || !/^\d+$/.test(record.artifact.id)) throw new Error('Artifact identifiers must be numeric strings.');
  if (!/^heartopia-weather-[A-Za-z0-9._-]+$/.test(record.artifact.name)) throw new Error('Unexpected artifact name.');

  const selected = record.selectedReviewImage;
  exactKeys(selected, ['file','mimeType','captureSha256','reviewStoredSha256','reviewUrl','expiresAt'], 'selectedReviewImage');
  if (!/^raw-media-[0-3]\.(?:jpg|png)$/.test(selected.file)) throw new Error('Weekly review must select one captured raw-media image.');
  if (!['image/jpeg','image/png'].includes(selected.mimeType)) throw new Error('Unsupported review image MIME type.');
  if (!/^[a-f0-9]{64}$/.test(selected.captureSha256) || selected.reviewStoredSha256 !== selected.captureSha256) throw new Error('Review image SHA-256 binding is invalid.');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(?:exec|dev)\?reviewToken=[A-Za-z0-9_-]{43}$/.test(selected.reviewUrl)) throw new Error('Private review URL is invalid.');
  if (!/^20\d{2}-\d{2}-\d{2}T/.test(selected.expiresAt)) throw new Error('Review URL expiry is invalid.');

  const interpretation = record.interpretation;
  exactKeys(interpretation, ['ready','baseDate','days','confidence','summary','unresolved'], 'interpretation');
  if (interpretation.ready !== true) throw new Error('Weekly interpretation must be explicitly ready.');
  if (interpretation.confidence !== 'high') throw new Error('Weekly interpretation confidence must be high.');
  if (!Array.isArray(interpretation.unresolved) || interpretation.unresolved.length !== 0) throw new Error('Weekly interpretation must have no unresolved items.');
  if (!validIsoDate(interpretation.baseDate)) throw new Error('baseDate must be an explicit yyyy-MM-dd date.');
  if (typeof interpretation.summary !== 'string' || !interpretation.summary.trim() || interpretation.summary.length > 300) throw new Error('Weekly summary is required and must be 300 characters or fewer.');
  if (!Array.isArray(interpretation.days) || interpretation.days.length !== 7) throw new Error('Exactly seven weekly forecast days are required.');

  const normalizedDays = interpretation.days.map((day, index) => {
    exactKeys(day, ['date','weather','visible','confidence','description'], `days[${index}]`);
    const expectedDate = addDays(interpretation.baseDate, index + 1);
    if (day.date !== expectedDate) throw new Error(`days[${index}].date must be ${expectedDate}; weekday-only inference is not allowed.`);
    if (day.visible !== true) throw new Error(`days[${index}] must be fully visible in the reviewed image.`);
    if (day.confidence !== 'high') throw new Error(`days[${index}] confidence must be high.`);
    if (typeof day.description !== 'string' || !day.description.trim() || day.description.length > 160) throw new Error(`days[${index}] needs a concise visual description.`);
    if (!Array.isArray(day.weather) || day.weather.length < 1 || day.weather.length > 4) throw new Error(`days[${index}] weather must contain 1-4 values.`);
    const weather = day.weather.map((value) => String(value));
    if (new Set(weather).size !== weather.length || weather.some((value) => !ALLOWED_WEATHER.has(value))) throw new Error(`days[${index}] contains an unsupported or duplicate weather value.`);
    return { date: day.date, weather, visible: true, confidence: 'high', description: day.description.trim() };
  });

  return {
    schemaVersion: 1,
    responseType: 'weather-weekly-review',
    artifact: { ...record.artifact },
    selectedReviewImage: { ...selected },
    interpretation: {
      ready: true,
      baseDate: interpretation.baseDate,
      days: normalizedDays,
      confidence: 'high',
      summary: interpretation.summary.trim(),
      unresolved: []
    }
  };
}

export function parseWeeklyReviewIssue(event) {
  if (!event || typeof event !== 'object' || !event.issue) throw new Error('GitHub issue event is required.');
  if (event.issue.title !== '[weather-weekly-review-result]') throw new Error('Unexpected Issue title.');
  if (event.issue.user?.login !== 'sg-log') throw new Error('Only the repository owner review Issue is accepted.');
  const body = String(event.issue.body || '');
  const markerIndex = body.indexOf(WEEKLY_REVIEW_MARKER);
  if (markerIndex < 0) throw new Error('Weekly review marker is missing.');
  const tail = body.slice(markerIndex + WEEKLY_REVIEW_MARKER.length);
  const match = tail.match(/^\s*```json\s*([\s\S]*?)\s*```\s*$/);
  if (!match) throw new Error('Issue body must contain only the weekly review JSON fence after the marker.');
  let parsed;
  try { parsed = JSON.parse(match[1]); } catch { throw new Error('Weekly review JSON is invalid.'); }
  return { issueNumber: Number(event.issue.number), review: validateWeeklyReviewRecord(parsed) };
}

function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

function main() {
  const [eventPath, normalizedPath] = process.argv.slice(2);
  if (!eventPath || !normalizedPath) throw new Error('Usage: node weather-weekly-review.mjs <event.json> <normalized.json>');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const { issueNumber, review } = parseWeeklyReviewIssue(event);
  fs.mkdirSync(path.dirname(path.resolve(normalizedPath)), { recursive: true });
  fs.writeFileSync(normalizedPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  appendOutput('issue_number', String(issueNumber));
  appendOutput('artifact_run_id', review.artifact.runId);
  appendOutput('artifact_id', review.artifact.id);
  appendOutput('artifact_name', review.artifact.name);
  appendOutput('evidence_sha256', review.selectedReviewImage.captureSha256);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
