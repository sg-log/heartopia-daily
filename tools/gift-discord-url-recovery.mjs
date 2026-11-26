import fs from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { compareSnowflakes, extractAppsScriptUrl } from "./gift-discord-poll.mjs";
import { fetchOfficialPost } from "./gift-x-backup.mjs";

const parser = vm.createContext({ Utilities: {
  formatDate: date => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 16)
}});
for (const file of ["gift-code-config.gs", "gift-code-parser.gs"])
  vm.runInContext(fs.readFileSync(new URL("../apps-script/" + file, import.meta.url), "utf8"), parser);
const API = "https://discord.com/api/v10";
const MAX_URLS = 3;

export function officialGiftUrls(content) {
  const found = [];
  for (const match of String(content || "").matchAll(/https:\/\/[^\s<>]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[)\]）。，、]+$/, ""));
      if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase()) ||
          url.username || url.password || url.port) continue;
      const path = url.pathname.match(/^\/(Heartopia_JP|myheartopia)\/status\/(\d{15,25})\/?$/i);
      if (!path) continue;
      const handle = /^Heartopia_JP$/i.test(path[1]) ? "Heartopia_JP" : "myheartopia";
      found.push("https://x.com/" + handle + "/status/" + path[2]);
    } catch { /* Ignore malformed or nonofficial links. */ }
  }
  return [...new Set(found)];
}

export function recoveryMessages(messages, allowedUsers, cursor = "") {
  return messages.filter(message => /^\d{15,25}$/.test(String(message.id || "")) &&
    (!cursor || compareSnowflakes(message.id, cursor) > 0) &&
    allowedUsers.includes(String(message.author?.id || "")) && !message.author?.bot &&
    !message.webhook_id && !message.message_snapshots?.length &&
    (message.type == null || [0, 19].includes(message.type)) && officialGiftUrls(message.content).length)
    .sort((a, b) => compareSnowflakes(a.id, b.id));
}

async function json(response) {
  if (!response.ok) throw Error("Recovery HTTP " + response.status);
  const result = await response.json();
  if (result?.ok === false) throw Error("Recovery API rejected request");
  return result;
}

async function privateFeedbackTarget(fetchFn, webhookUrl, guildId) {
  if (!webhookUrl) return null;
  try {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.username || url.password || url.port ||
        !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname) || url.search || url.hash) return null;
    const response = await fetchFn(webhookUrl, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const metadata = await response.json();
    if (String(metadata.guild_id || "") !== guildId || !/^\d{15,25}$/.test(String(metadata.channel_id || ""))) return null;
    return { url: webhookUrl, channelId: String(metadata.channel_id) };
  } catch { return null; }
}

async function sendRecoveryFeedback(fetchFn, target, content) {
  if (!target) return false;
  try {
    const response = await fetchFn(target.url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        content, allowed_mentions: { parse: [] }, flags: 4 }) });
    return response.ok;
  } catch { return false; }
}

export async function runGiftUrlRecovery({ token, channelId, postKey, mode = "poll", allowedUserIds = [],
  feedbackMode = "none", reviewWebhookUrl = "", fetchImpl = fetch, apiUrl } = {}) {
  if (!token || !/^\d{15,25}$/.test(String(channelId || "")) || !["poll", "test"].includes(mode))
    throw Error("Invalid Discord URL recovery configuration");
  if (!["personal", "none"].includes(feedbackMode)) throw Error("Invalid recovery feedback setting");
  const headers = { Authorization: "Bot " + token, Accept: "application/json" };
  const options = { headers, signal: AbortSignal.timeout(15000) };
  const channel = await json(await fetchImpl(API + "/channels/" + channelId, options));
  const guildId = String(channel.guild_id || "");
  if (!/^\d{15,25}$/.test(guildId)) throw Error("Invalid recovery guild");
  const guild = await json(await fetchImpl(API + "/guilds/" + guildId, options));
  if (!/^\d{15,25}$/.test(String(guild.owner_id || ""))) throw Error("Guild owner could not be verified");
  const allowed = allowedUserIds.length ? allowedUserIds : [String(guild.owner_id)];
  if (allowed.some(id => !/^\d{15,25}$/.test(id))) throw Error("Invalid recovery user configuration");
  const messages = await json(await fetchImpl(API + "/channels/" + channelId + "/messages?limit=100", options));
  if (!Array.isArray(messages)) throw Error("Invalid recovery message history");
  const feedbackTarget = feedbackMode === "personal" ? await privateFeedbackTarget(fetchImpl, reviewWebhookUrl, guildId) : null;
  if (mode === "test") return { ok: true, mode, candidateMessages: recoveryMessages(messages, allowed).length,
    feedbackReady: Boolean(feedbackTarget), feedbackChannelId: feedbackTarget?.channelId || "", writes: 0 };
  if (!postKey) throw Error("Recovery post key missing");
  apiUrl ||= extractAppsScriptUrl(fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const stateCall = async data => {
    const result = await json(await fetchImpl(apiUrl, { method: "POST", redirect: "follow",
      signal: AbortSignal.timeout(45000), headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "giftUrlRecoveryState", postKey, channelId, ...data }) }));
    if (result.ok !== true) throw Error("Invalid recovery state response");
    return result;
  };
  const state = await stateCall({ phase: "read" });
  if (!state.initialized) {
    const ids = messages.map(message => String(message.id || "")).filter(id => /^\d{15,25}$/.test(id)).sort(compareSnowflakes);
    await stateCall({ phase: "initialize", messageId: ids.at(-1) || "" });
    return { ok: true, status: "initialized", recovered: 0 };
  }
  const message = recoveryMessages(messages, allowed, state.cursor)[0];
  if (!message) return { ok: true, status: "no-new-urls", recovered: 0 };
  const urls = officialGiftUrls(message.content);
  const attempts = state.failedMessageId === message.id ? Number(state.attempts || 0) : 0;
  let notified = state.failedMessageId === message.id && state.notified === true;
  let outcome = "review";
  let recovered = 0;
  let feedbackWarning = false;
  if (attempts < 3 && urls.length <= MAX_URLS) {
    try {
      const posts = [];
      const expected = [];
      for (const url of urls) {
        const [, handle, , statusId] = new URL(url).pathname.split("/");
        const post = await fetchOfficialPost(fetchImpl, handle, statusId, true);
        if (!post || post.incomplete) throw Error("Official post unavailable or incomplete");
        const parsed = parser.parseDiscordGiftAnnouncement_(post.text);
        if (!parsed.ok || !parsed.expiresAt) throw Error("Gift details are incomplete");
        posts.push({ statusId, sourceUrl: url, text: post.text }); expected.push(parsed);
      }
      const ingest = await json(await fetchImpl(apiUrl, { method: "POST", redirect: "follow",
        signal: AbortSignal.timeout(45000), headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ingestOfficialXGiftBatch", postKey, posts }) }));
      if (ingest.ok !== true || ingest.counts?.review || ingest.counts?.conflict || ingest.counts?.ignored)
        throw Error("Gift ingestion needs review");
      const live = await json(await fetchImpl(apiUrl + "?action=getGiftCodes", {
        redirect: "follow", signal: AbortSignal.timeout(45000), cache: "no-store" }));
      if (live.ok !== true || !Array.isArray(live.codes) || !expected.every(item => live.codes.some(row =>
        row.code === item.code && row.reward === item.reward && row.expiresAt === item.expiresAt)))
        throw Error("Gift public verification failed");
      recovered = Number(ingest.counts?.created || 0);
      outcome = "done";
      if (feedbackMode === "personal") feedbackWarning = !await sendRecoveryFeedback(fetchImpl, feedbackTarget,
        "🎁 ギフトコードの登録内容を確認しました。\n" + expected.map(item => item.code).join("\n") +
        "\n新規追加：" + recovered + "件（登録済みは再追加しません）");
    } catch { outcome = "retry"; }
  }
  if (outcome !== "done") {
    if (feedbackMode === "personal" && !notified) {
      notified = await sendRecoveryFeedback(fetchImpl, feedbackTarget,
        "🎁 貼り付けたギフトコードURLの確認が必要です。\n公式本文・報酬・期限の取得、登録内容との一致、または公開データの再取得を確認できませんでした。\n自動確認は最大3回行います。解決しない場合は公式投稿のスクショを添えて相談してください。\n" +
        urls.slice(0, MAX_URLS).map(url => "<" + url + ">").join("\n"));
      feedbackWarning = !notified;
    }
    outcome = attempts + 1 >= 3 ? "review" : "retry";
  }
  await stateCall({ phase: "record", messageId: message.id, status: outcome, notified });
  return { ok: outcome === "done", status: outcome, recovered, processedMessageId: message.id,
    feedbackWarning, feedbackSkipped: feedbackMode === "none" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runGiftUrlRecovery({ token: process.env.DISCORD_GIFT_BOT_TOKEN,
      channelId: process.env.DISCORD_GIFT_CHANNEL_ID, postKey: process.env.WEATHER_POST_KEY,
      mode: process.env.GIFT_POLL_MODE || "poll", feedbackMode: process.env.GIFT_URL_RECOVERY_FEEDBACK || "none",
      reviewWebhookUrl: process.env.WEATHER_DC_WEBHOOK_URL,
      allowedUserIds: String(process.env.DISCORD_GIFT_URL_USER_IDS || "").split(",").map(id => id.trim()).filter(Boolean) });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) console.error("::warning::Gift URL recovery requires review.");
    if (result.feedbackWarning) console.error("::warning::Recovery feedback was not delivered; the destination must be in the same server as the receiving channel.");
  } catch {
    console.error("Gift URL recovery failed. Normal Discord/X polling runs separately.");
    process.exitCode = 1;
  }
}
