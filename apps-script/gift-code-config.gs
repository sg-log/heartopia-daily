const DISCORD_GIFT_BOT_TOKEN_PROPERTY = "DISCORD_GIFT_BOT_TOKEN";
const DISCORD_GIFT_CHANNEL_ID_PROPERTY = "DISCORD_GIFT_CHANNEL_ID";
const DISCORD_GIFT_GUILD_ID_PROPERTY = "DISCORD_GIFT_GUILD_ID";
const DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY = "DISCORD_GIFT_SOURCE_WEBHOOK_ID";
const DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY = "DISCORD_GIFT_LAST_MESSAGE_ID";
const DISCORD_GIFT_REVIEW_WEBHOOK_URL_PROPERTY = "DISCORD_GIFT_REVIEW_WEBHOOK_URL";
const GIFT_REWARD_NAME_MAP_PROPERTY = "GIFT_REWARD_NAME_MAP";
const GIFT_CODE_SCHEDULER_TRIGGER_FUNCTION = "runGiftCodeScheduler";
const GIFT_CODE_SCHEDULER_INTERVAL_MINUTES = 5;
const DISCORD_GIFT_API_BASE = "https://discord.com/api/v10";
const DISCORD_GIFT_BOOTSTRAP_LIMIT = 50;
const DISCORD_GIFT_POLL_LIMIT = 100;
const DISCORD_GIFT_TIME_ZONE = "Asia/Tokyo";
const DISCORD_GIFT_AUTO_MEMO = "公式Discord自動取得";

const DEFAULT_GIFT_REWARD_NAME_MAP = {
  "Wishing star": "願い星",
  "Dye": "染色剤",
  "Flawless Fluorite": "無垢な蛍石"
};

function installGiftCodeScheduler() {
  uninstallGiftCodeScheduler();
  ScriptApp.newTrigger(GIFT_CODE_SCHEDULER_TRIGGER_FUNCTION)
    .timeBased()
    .everyMinutes(GIFT_CODE_SCHEDULER_INTERVAL_MINUTES)
    .create();
  return getGiftCodeAutomationStatus();
}

function uninstallGiftCodeScheduler() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === GIFT_CODE_SCHEDULER_TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function getGiftCodeAutomationStatus() {
  const props = PropertiesService.getScriptProperties();
  const token = String(props.getProperty(DISCORD_GIFT_BOT_TOKEN_PROPERTY) || "").trim();
  const channelId = String(props.getProperty(DISCORD_GIFT_CHANNEL_ID_PROPERTY) || "").trim();
  return {
    installed: ScriptApp.getProjectTriggers().some(function(trigger) {
      return trigger.getHandlerFunction() === GIFT_CODE_SCHEDULER_TRIGGER_FUNCTION;
    }),
    configured: Boolean(token && channelId),
    channelId: channelId,
    guildId: String(props.getProperty(DISCORD_GIFT_GUILD_ID_PROPERTY) || "").trim(),
    sourceWebhookId: String(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY) || "").trim(),
    lastMessageId: String(props.getProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY) || "").trim(),
    intervalMinutes: GIFT_CODE_SCHEDULER_INTERVAL_MINUTES
  };
}

function resetGiftCodeAutomationCursor() {
  PropertiesService.getScriptProperties().deleteProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY);
  return getGiftCodeAutomationStatus();
}

function resetGiftCodeAutomationSourceWebhook() {
  PropertiesService.getScriptProperties().deleteProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY);
  return getGiftCodeAutomationStatus();
}

function testGiftCodeDiscordConnection() {
  const config = resolveDiscordGiftGuildId_(giftDiscordConfig_());
  const messages = fetchDiscordGiftMessages_(config, "", 5);
  return {
    ok: true,
    channelId: config.channelId,
    count: messages.length,
    latestMessageId: messages.length ? String(messages[0].id || "") : "",
    latestHasContent: messages.length ? Boolean(discordGiftMessageText_(messages[0])) : false
  };
}

function runGiftCodeScheduler() {
  const config = resolveDiscordGiftGuildId_(giftDiscordConfig_());
  const props = PropertiesService.getScriptProperties();
  let cursor = String(props.getProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY) || "").trim();
  const bootstrap = !cursor;
  const messages = fetchDiscordGiftMessages_(
    config,
    cursor,
    bootstrap ? DISCORD_GIFT_BOOTSTRAP_LIMIT : DISCORD_GIFT_POLL_LIMIT
  );

  if (!messages.length) return;

  messages.sort(function(a, b) {
    return compareDiscordSnowflakes_(String(a.id || ""), String(b.id || ""));
  });

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const messageId = String(message.id || "").trim();
    if (!messageId) continue;

    const handled = processDiscordGiftMessage_(message, config, { silent: bootstrap });
    if (handled.advanceCursor) {
      props.setProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY, messageId);
      cursor = messageId;
    }
  }

  Logger.log("Gift code scheduler processed " + messages.length + " Discord message(s).");
}

function giftDiscordConfig_() {
  const props = PropertiesService.getScriptProperties();
  const token = String(props.getProperty(DISCORD_GIFT_BOT_TOKEN_PROPERTY) || "").trim();
  const channelId = String(props.getProperty(DISCORD_GIFT_CHANNEL_ID_PROPERTY) || "").trim();
  if (!token) throw new Error("DISCORD_GIFT_BOT_TOKEN が未設定です");
  if (!/^\d{15,25}$/.test(channelId)) throw new Error("DISCORD_GIFT_CHANNEL_ID が未設定または不正です");
  return {
    token: token,
    channelId: channelId,
    guildId: String(props.getProperty(DISCORD_GIFT_GUILD_ID_PROPERTY) || "").trim(),
    sourceWebhookId: String(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY) || "").trim()
  };
}

function resolveDiscordGiftGuildId_(config) {
  if (config.guildId) return config;

  const endpoint = DISCORD_GIFT_API_BASE + "/channels/" + encodeURIComponent(config.channelId);
  const response = UrlFetchApp.fetch(endpoint, {
    method: "get",
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bot " + config.token,
      Accept: "application/json",
      "User-Agent": "heartopia-daily-gift-code-bot"
    }
  });
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error("Discordチャンネル情報の取得に失敗しました（HTTP " + status + "）。");
  }

  const channel = JSON.parse(response.getContentText() || "{}");
  const guildId = String(channel.guild_id || "").trim();
  if (!guildId) throw new Error("DiscordサーバーIDを取得できませんでした");
  PropertiesService.getScriptProperties().setProperty(DISCORD_GIFT_GUILD_ID_PROPERTY, guildId);
  config.guildId = guildId;
  return config;
}

function fetchDiscordGiftMessages_(config, afterMessageId, limit) {
  const cappedLimit = Math.max(1, Math.min(100, Number(limit) || DISCORD_GIFT_POLL_LIMIT));
  let endpoint = DISCORD_GIFT_API_BASE + "/channels/" + encodeURIComponent(config.channelId) + "/messages?limit=" + cappedLimit;
  if (afterMessageId) endpoint += "&after=" + encodeURIComponent(afterMessageId);

  const response = UrlFetchApp.fetch(endpoint, {
    method: "get",
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bot " + config.token,
      Accept: "application/json",
      "User-Agent": "heartopia-daily-gift-code-bot"
    }
  });
  const status = response.getResponseCode();
  if (status !== 200) {
    let detail = "";
    try {
      const body = JSON.parse(response.getContentText() || "{}");
      detail = body && body.message ? " " + String(body.message) : "";
    } catch (_) {}
    throw new Error("Discordメッセージ取得に失敗しました（HTTP " + status + "）。" + detail);
  }

  const data = JSON.parse(response.getContentText() || "[]");
  if (!Array.isArray(data)) throw new Error("Discord APIの応答形式が不正です");
  return data;
}

function compareDiscordSnowflakes_(a, b) {
  const left = String(a || "").replace(/^0+/, "");
  const right = String(b || "").replace(/^0+/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
