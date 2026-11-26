import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HEADER = "<!-- HEARTOPIA_GIFT_CHAT_REQUEST_V1\n";
const FOOTER = "\n-->";
const RESULT = "<!-- HEARTOPIA_GIFT_CHAT_RESULT_V1\n";
const shape = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("|") === keys.slice().sort().join("|");

export function validateItem(input) {
  if (!shape(input, ["code", "reward", "expiresAt", "sourceUrl", "sourceType"])) throw Error("Invalid gift fields");
  for (const key of Object.keys(input)) if (typeof input[key] !== "string") throw Error("Gift fields must be text");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,99}$/.test(input.code) || !input.reward.trim() || input.reward.length > 1000)
    throw Error("Invalid gift code or reward");
  const date = new Date(input.expiresAt + ":00Z");
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.expiresAt) || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 16) !== input.expiresAt) throw Error("Invalid JST deadline");
  const official = /^https:\/\/x\.com\/(?:myheartopia|Heartopia_JP)\/status\/\d{15,25}$/i.test(input.sourceUrl);
  if (!["official-post", "official-screenshot"].includes(input.sourceType) ||
      (input.sourceUrl && !official) || (input.sourceType === "official-post" && !official)) throw Error("Official evidence required");
  return { code: input.code, reward: input.reward.trim(), expiresAt: input.expiresAt,
    sourceUrl: input.sourceUrl, sourceType: input.sourceType };
}

export function requestBody(request) {
  return HEADER + JSON.stringify(request) + FOOTER;
}

export function parseRequest(issue) {
  const body = String(issue?.body || "");
  if (issue?.pull_request || !body.startsWith(HEADER) || !body.endsWith(FOOTER) || body.length > 5000)
    throw Error("Invalid gift request envelope");
  const data = JSON.parse(body.slice(HEADER.length, -FOOTER.length));
  if (data?.v !== 1 || !["read", "save"].includes(data.type)) throw Error("Invalid gift request");
  const fields = data.type === "read" ? ["v", "type", "item"] : ["v", "type", "item", "readAt", "confirmed"];
  if (!shape(data, fields)) throw Error("Unexpected gift request fields");
  const item = validateItem(data.item);
  if (issue.title !== "Heartopia gift chat " + data.type.toUpperCase() + " " + item.code) throw Error("Gift title mismatch");
  if (data.type === "save") {
    const age = Date.now() - Date.parse(data.readAt);
    if (data.confirmed !== true || typeof data.readAt !== "string" || !Number.isFinite(age) ||
        age < -60000 || age > 30 * 60000) throw Error("Approval requires a comparison from the last 30 minutes");
  }
  return { ...data, item };
}

async function decode(response) {
  if (!response.ok) throw Error("Gift API HTTP " + response.status);
  const result = await response.json();
  if (result?.ok !== true) throw Error("Gift API rejected the request");
  return result;
}

async function readLive(apiUrl, code, fetchFn) {
  const response = await fetchFn(apiUrl + "?action=getGiftCodes", { redirect: "follow",
    signal: AbortSignal.timeout(45000), cache: "no-store" });
  const data = await decode(response);
  if (!Array.isArray(data.codes) || data.codes.length > 5000) throw Error("Invalid gift inventory");
  const found = data.codes.filter(row => row.code === code);
  if (found.length > 1) throw Error("Duplicate stored gift code");
  const row = found[0];
  return row ? Object.fromEntries(["code", "reward", "expiresAt", "sourceUrl", "status"].map(key => [key, String(row[key] || "")])) : null;
}

function matches(stored, item) {
  return stored && stored.code === item.code && stored.reward === item.reward
    && stored.expiresAt === item.expiresAt && stored.sourceUrl === item.sourceUrl && stored.status === "active";
}

export async function runRequest(request, { apiUrl, fetchFn = fetch, adminKey = "" }) {
  const item = validateItem(request.item);
  const existing = await readLive(apiUrl, item.code, fetchFn);
  const checkedAt = new Date().toISOString();
  if (request.type === "read") return { ok: true, type: "read", checkedAt, item, existing,
    status: existing ? "already-registered" : "missing" };
  if (request.type !== "save" || request.confirmed !== true) throw Error("Explicit gift approval required");
  const age = Date.now() - Date.parse(request.readAt);
  if (!Number.isFinite(age) || age < -60000 || age > 30 * 60000) throw Error("Gift comparison expired");
  if (existing) return { ok: matches(existing, item), type: "save", status: "already-registered",
    verified: Boolean(matches(existing, item)), code: item.code, existing };
  if (!adminKey) throw Error("GitHub Actions WEATHER_ADMIN_KEY is missing");
  const result = await decode(await fetchFn(apiUrl, { method: "POST", redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: AbortSignal.timeout(45000),
    body: JSON.stringify({ action: "saveGiftCodeFromChat", adminKey, confirmed: true, item }) }));
  const stored = await readLive(apiUrl, item.code, fetchFn);
  const verified = Boolean(matches(stored, item));
  return { ok: verified, type: "save", status: verified ? result.mode === "created" ? "saved" : "already-registered" : "verify-failed",
    verified, code: item.code, stored, discordNotified: Boolean(result.discordNotified),
    notificationWarning: Boolean(result.discordWarning) };
}

export async function runEvent(event, env, fetchFn = fetch) {
  const owner = String(env.GITHUB_REPOSITORY_OWNER || ""), repo = String(env.GITHUB_REPOSITORY || "");
  if (!owner || repo !== owner + "/heartopia-daily" || event?.action !== "opened" ||
      event?.issue?.user?.login !== owner || event.issue.pull_request ||
      !/^Heartopia gift chat (READ|SAVE) [A-Za-z0-9][A-Za-z0-9_-]{5,99}$/.test(event.issue.title || "")) return { ignored: true };
  const number = event.issue.number;
  if (!Number.isInteger(number) || number < 1) throw Error("Invalid issue number");
  const html = await fs.readFile(new URL("../index.html", import.meta.url), "utf8");
  const apiUrl = html.match(/const\s+WEATHER_API_URL\s*=\s*["'](https:\/\/script\.google\.com\/macros\/s\/[^"']+\/exec)["']/)?.[1];
  if (!apiUrl) throw Error("Gift API URL missing");
  let data;
  try { data = await runRequest(parseRequest(event.issue), { apiUrl, fetchFn, adminKey: env.WEATHER_ADMIN_KEY || "" }); }
  catch { data = { ok: false, type: "error", message: "処理に失敗しました。保存完了とは扱わず、最新データを再確認してください。" }; }
  if (!env.GITHUB_TOKEN) throw Error("Issue result token missing");
  const response = await fetchFn("https://api.github.com/repos/" + repo + "/issues/" + number + "/comments", {
    method: "POST", headers: { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json",
      "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ body: (data.ok ? "✅ " : "❌ ") + "ギフトコードの処理結果\n\n" + RESULT + JSON.stringify(data) + FOOTER }),
    signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error("Could not post gift result");
  if (!data.ok) throw Error("Gift chat operation failed. See issue result.");
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runEvent(JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8")), process.env);
}
