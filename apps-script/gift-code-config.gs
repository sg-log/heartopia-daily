const DISCORD_GIFT_CHANNEL_ID_PROPERTY = "DISCORD_GIFT_CHANNEL_ID";
const DISCORD_GIFT_GUILD_ID_PROPERTY = "DISCORD_GIFT_GUILD_ID";
const DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY = "DISCORD_GIFT_SOURCE_WEBHOOK_ID";
const DISCORD_GIFT_SOURCE_WEBHOOK_IDS_PROPERTY = "DISCORD_GIFT_SOURCE_WEBHOOK_IDS";
const DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY = "DISCORD_GIFT_LAST_MESSAGE_ID";
const DISCORD_GIFT_REVIEW_WEBHOOK_URL_PROPERTY = "DISCORD_GIFT_REVIEW_WEBHOOK_URL";
const GIFT_REWARD_NAME_MAP_PROPERTY = "GIFT_REWARD_NAME_MAP";
const GIFT_CODE_SCHEDULER_TRIGGER_FUNCTION = "runGiftCodeScheduler";
const GIFT_CODE_SCHEDULER_INTERVAL_MINUTES = 5;
const GIFT_CODE_WORKFLOW = "gift-code-discord-poll.yml";
const DISCORD_GIFT_POLL_LIMIT = 100;
const DISCORD_GIFT_TIME_ZONE = "Asia/Tokyo";
const DISCORD_GIFT_AUTO_MEMO = "公式Discord自動取得";
const GIFT_X_AUTO_MEMO = "公式X自動取得";

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
  const channelId = String(props.getProperty(DISCORD_GIFT_CHANNEL_ID_PROPERTY) || "").trim();
  const githubToken = String(props.getProperty(GITHUB_ACTIONS_TOKEN_PROPERTY) || "").trim();
  return {
    installed: ScriptApp.getProjectTriggers().some(function(trigger) {
      return trigger.getHandlerFunction() === GIFT_CODE_SCHEDULER_TRIGGER_FUNCTION;
    }),
    configured: Boolean(channelId && githubToken),
    channelId: channelId,
    guildId: String(props.getProperty(DISCORD_GIFT_GUILD_ID_PROPERTY) || "").trim(),
    sourceWebhookId: String(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY) || "").trim(),
    sourceWebhookIds: giftSourceWebhookIds_(),
    lastMessageId: String(props.getProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY) || "").trim(),
    intervalMinutes: GIFT_CODE_SCHEDULER_INTERVAL_MINUTES,
    transport: "github-actions"
  };
}

function resetGiftCodeAutomationCursor() {
  PropertiesService.getScriptProperties().deleteProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY);
  return getGiftCodeAutomationStatus();
}

function resetGiftCodeAutomationSourceWebhook() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY);
  props.deleteProperty(DISCORD_GIFT_SOURCE_WEBHOOK_IDS_PROPERTY);
  return getGiftCodeAutomationStatus();
}

function testGiftCodeDiscordConnection() {
  return dispatchGiftCodeWorkflow_("test");
}

function runGiftCodeScheduler() {
  const result = dispatchGiftCodeWorkflow_("poll");
  Logger.log("Gift code workflow dispatch accepted for channel " + result.channelId + ".");
  return result;
}

function dispatchGiftCodeWorkflow_(mode) {
  const normalizedMode = String(mode || "").trim();
  if (["poll", "test"].indexOf(normalizedMode) < 0) throw new Error("ギフトコード自動取得モードが不正です");

  const props = PropertiesService.getScriptProperties();
  const token = String(props.getProperty(GITHUB_ACTIONS_TOKEN_PROPERTY) || "").trim();
  const channelId = String(props.getProperty(DISCORD_GIFT_CHANNEL_ID_PROPERTY) || "").trim();
  if (!token) throw new Error("GITHUB_ACTIONS_TOKEN が未設定です");
  if (!/^\d{15,25}$/.test(channelId)) throw new Error("DISCORD_GIFT_CHANNEL_ID が未設定または不正です");

  const endpoint = "https://api.github.com/repos/" + GITHUB_REPOSITORY
    + "/actions/workflows/" + encodeURIComponent(GIFT_CODE_WORKFLOW) + "/dispatches";
  const response = UrlFetchApp.fetch(endpoint, {
    method: "post",
    muteHttpExceptions: true,
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "heartopia-daily-apps-script"
    },
    payload: JSON.stringify({
      ref: "main",
      inputs: {
        channel_id: channelId,
        mode: normalizedMode
      }
    })
  });

  const status = response.getResponseCode();
  if (status !== 204) {
    let detail = "";
    try {
      const body = JSON.parse(response.getContentText() || "{}");
      if (body && body.message) detail = " " + String(body.message);
    } catch (_) {}
    throw new Error("GitHub Actionsのギフトコード取得を起動できませんでした（HTTP " + status + "）。" + detail);
  }

  return {
    ok: true,
    status: "accepted",
    mode: normalizedMode,
    channelId: channelId
  };
}

function compareDiscordSnowflakes_(a, b) {
  const left = String(a || "").replace(/^0+/, "");
  const right = String(b || "").replace(/^0+/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
