import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "heartopia-daily-gift-code-bot/1.0 (+https://github.com/sg-log/heartopia-daily)";

export function compareSnowflakes(a, b) {
  const left = String(a || "").replace(/^0+/, "");
  const right = String(b || "").replace(/^0+/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function discordMessageText(message) {
  const parts = [];
  const content = String(message?.content || "").trim();
  if (content) parts.push(content);
  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    if (embed?.title) parts.push(String(embed.title));
    if (embed?.description) parts.push(String(embed.description));
    const fields = Array.isArray(embed?.fields) ? embed.fields : [];
    for (const field of fields) {
      if (field?.name) parts.push(String(field.name));
      if (field?.value) parts.push(String(field.value));
    }
  }
  return parts.join("\n").trim();
}

export function looksLikeGiftAnnouncement(text) {
  const source = String(text || "");
  return /(?:^|\n)\s*[^\n]*Rewards?\s*:/i.test(source)
    && /(?:^|\n)\s*[^\n]*Gift\s*Code\s*:/i.test(source);
}

export function compactDiscordMessage(message, guildId, channelId) {
  const embeds = (Array.isArray(message?.embeds) ? message.embeds : []).slice(0, 10).map(embed => ({
    title: String(embed?.title || "").slice(0, 512),
    description: String(embed?.description || "").slice(0, 4096),
    fields: (Array.isArray(embed?.fields) ? embed.fields : []).slice(0, 25).map(field => ({
      name: String(field?.name || "").slice(0, 256),
      value: String(field?.value || "").slice(0, 1024)
    }))
  }));
  return {
    id: String(message?.id || ""),
    channel_id: String(channelId || message?.channel_id || ""),
    guild_id: String(guildId || message?.guild_id || ""),
    webhook_id: String(message?.webhook_id || ""),
    content: String(message?.content || "").slice(0, 10000),
    embeds
  };
}

export function extractAppsScriptUrl(html) {
  const match = String(html || "").match(/const\s+WEATHER_API_URL\s*=\s*["'](https:\/\/script\.google\.com\/macros\/s\/[^"']+\/exec)["']/);
  if (!match) throw new Error("Heartopia Daily API URL was not found in index.html.");
  return match[1];
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    throw new Error(label + " returned non-JSON (HTTP " + response.status + ").");
  }
  if (!response.ok) {
    throw new Error(label + " failed (HTTP " + response.status + "): " + String(data?.message || data?.error || "unknown error"));
  }
  return data;
}

export async function runGiftDiscordPoll(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const token = String(options.token || "").trim();
  const channelId = String(options.channelId || "").trim();
  const postKey = String(options.postKey || "").trim();
  const mode = String(options.mode || "poll").trim();
  const repoRoot = options.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (!token) throw new Error("DISCORD_GIFT_BOT_TOKEN is missing.");
  if (!/^\d{15,25}$/.test(channelId)) throw new Error("DISCORD_GIFT_CHANNEL_ID is invalid.");
  if (!["poll", "test"].includes(mode)) throw new Error("GIFT_POLL_MODE must be poll or test.");

  const discordHeaders = {
    Authorization: "Bot " + token,
    Accept: "application/json",
    "User-Agent": USER_AGENT
  };

  const channelResponse = await fetchImpl(DISCORD_API_BASE + "/channels/" + encodeURIComponent(channelId), {
    headers: discordHeaders
  });
  const channel = await readJsonResponse(channelResponse, "Discord channel lookup");
  const guildId = String(channel?.guild_id || "").trim();
  if (!/^\d{15,25}$/.test(guildId)) throw new Error("Discord guild id was not returned.");

  const limit = mode === "test" ? 5 : 100;
  const messagesResponse = await fetchImpl(
    DISCORD_API_BASE + "/channels/" + encodeURIComponent(channelId) + "/messages?limit=" + limit,
    { headers: discordHeaders }
  );
  const messages = await readJsonResponse(messagesResponse, "Discord message lookup");
  if (!Array.isArray(messages)) throw new Error("Discord messages response was not an array.");

  const validIds = messages.map(message => String(message?.id || "")).filter(id => /^\d{15,25}$/.test(id));
  validIds.sort(compareSnowflakes);
  const latestMessageId = validIds.length ? validIds[validIds.length - 1] : "";

  const candidates = messages
    .filter(message => looksLikeGiftAnnouncement(discordMessageText(message)))
    .map(message => compactDiscordMessage(message, guildId, channelId));

  if (mode === "test") {
    return {
      ok: true,
      mode: "test",
      guildId,
      messageCount: messages.length,
      candidateCount: candidates.length,
      latestMessageId
    };
  }

  if (!postKey) throw new Error("WEATHER_POST_KEY is missing.");
  if (!latestMessageId) {
    return {
      ok: true,
      mode: "poll",
      guildId,
      messageCount: 0,
      candidateCount: 0,
      skipped: "empty-channel"
    };
  }

  const indexHtml = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const apiUrl = extractAppsScriptUrl(indexHtml);
  const apiResponse = await fetchImpl(apiUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "ingestDiscordGiftBatch",
      postKey,
      channelId,
      guildId,
      latestMessageId,
      messages: candidates
    })
  });
  const apiResult = await readJsonResponse(apiResponse, "Heartopia Daily gift ingest");
  if (apiResult?.ok !== true) {
    throw new Error("Heartopia Daily gift ingest rejected the batch: " + String(apiResult?.error || "unknown error"));
  }

  return {
    ok: true,
    mode: "poll",
    guildId,
    messageCount: messages.length,
    candidateCount: candidates.length,
    ingest: apiResult
  };
}

async function main() {
  const result = await runGiftDiscordPoll({
    token: process.env.DISCORD_GIFT_BOT_TOKEN,
    channelId: process.env.DISCORD_GIFT_CHANNEL_ID,
    postKey: process.env.WEATHER_POST_KEY,
    mode: process.env.GIFT_POLL_MODE || "poll"
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
