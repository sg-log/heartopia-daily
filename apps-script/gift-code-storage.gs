function processDiscordGiftMessage_(message, config, options) {
  const text = discordGiftMessageText_(message);
  if (!text || !looksLikeDiscordGiftAnnouncement_(text)) {
    return { advanceCursor: true, mode: "ignored" };
  }

  if (!message.webhook_id) {
    notifyGiftCodeReview_(message, config, "ギフト形式の投稿ですがWebhook投稿ではありません");
    return { advanceCursor: true, mode: "review" };
  }

  const props = PropertiesService.getScriptProperties();
  let sourceWebhookId = String(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY) || config.sourceWebhookId || "").trim();
  const currentWebhookId = String(message.webhook_id || "").trim();
  if (sourceWebhookId && currentWebhookId !== sourceWebhookId) {
    return { advanceCursor: true, mode: "ignored-webhook" };
  }

  const parsed = parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: giftRewardNameMap_()
  });
  if (!parsed.ok) {
    notifyGiftCodeReview_(message, config, parsed.error || "ギフトコードを安全に解析できませんでした");
    return { advanceCursor: true, mode: "review" };
  }

  if (!sourceWebhookId) {
    props.setProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY, currentWebhookId);
    sourceWebhookId = currentWebhookId;
  }

  const candidate = {
    code: parsed.code,
    reward: parsed.reward,
    rawReward: parsed.rawReward,
    expiresAt: parsed.expiresAt,
    sourceUrl: discordGiftMessageUrl_(message, config),
    memo: parsed.unresolvedRewardNames.length
      ? DISCORD_GIFT_AUTO_MEMO + " / 日本語名未確認: " + parsed.unresolvedRewardNames.join(", ")
      : DISCORD_GIFT_AUTO_MEMO,
    status: giftStatusFromExpiry_(parsed.expiresAt)
  };

  const result = saveAutomatedGiftCode_(candidate, { silent: Boolean(options && options.silent) });
  if (result.mode === "conflict") {
    notifyGiftCodeReview_(message, config, result.reason || "既存データと内容が一致しないため自動更新しませんでした");
  }
  return { advanceCursor: true, mode: result.mode, code: candidate.code };
}

function giftStatusFromExpiry_(expiresAt) {
  const text = String(expiresAt || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return "active";
  const nowJst = Utilities.formatDate(new Date(), DISCORD_GIFT_TIME_ZONE, "yyyy-MM-dd'T'HH:mm");
  return text < nowJst ? "expired" : "active";
}

function saveAutomatedGiftCode_(candidate, options) {
  const code = validateGiftCodeForWrite_(candidate.code);
  if (!code) throw new Error("コードがありません");

  const silent = Boolean(options && options.silent);
  const now = new Date().toISOString();
  const incoming = {
    id: Utilities.getUuid(),
    code: code,
    reward: safeSheetText_(limitText_(candidate.reward, TEXT_LIMITS.reward, "報酬").trim()),
    rawReward: String(candidate.rawReward || "").trim(),
    expiresAt: validateGiftExpiresForWrite_(candidate.expiresAt),
    sourceUrl: safeSheetText_(validateHttpUrl_(candidate.sourceUrl, "sourceUrl", TEXT_LIMITS.sourceUrl)),
    memo: safeSheetText_(limitText_(candidate.memo || DISCORD_GIFT_AUTO_MEMO, TEXT_LIMITS.memo, "メモ").trim()),
    status: normalizeGiftStatus_(candidate.status),
    createdAt: now,
    updatedAt: now
  };

  const result = withScriptLock_(function() {
    const sheet = getGiftSheet_();
    const values = sheet.getDataRange().getValues();
    const idColumn = GIFT_HEADERS.indexOf("id");
    const codeColumn = GIFT_HEADERS.indexOf("code");
    const rewardColumn = GIFT_HEADERS.indexOf("reward");
    const expiryColumn = GIFT_HEADERS.indexOf("expiresAt");
    const sourceColumn = GIFT_HEADERS.indexOf("sourceUrl");
    const memoColumn = GIFT_HEADERS.indexOf("memo");
    const statusColumn = GIFT_HEADERS.indexOf("status");
    const createdColumn = GIFT_HEADERS.indexOf("createdAt");

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][codeColumn] || "") !== code) continue;

      const existingReward = plainSheetText_(values[i][rewardColumn]).trim();
      const existingExpiry = formatDateTimeValue_(values[i][expiryColumn]);
      const existingSource = plainSheetText_(values[i][sourceColumn]).trim();
      const existingMemo = plainSheetText_(values[i][memoColumn]).trim();
      const existingStatus = normalizeGiftStatus_(values[i][statusColumn]);

      const rewardAutoManaged = !existingReward
        || existingReward === incoming.rawReward
        || existingMemo.indexOf(DISCORD_GIFT_AUTO_MEMO) >= 0;
      const expiryConflict = existingExpiry && incoming.expiresAt && existingExpiry !== incoming.expiresAt;
      const rewardConflict = existingReward && incoming.reward && existingReward !== incoming.reward && !rewardAutoManaged;

      if (expiryConflict || rewardConflict) {
        return {
          mode: "conflict",
          reason: "既存の手動データとDiscord公式データが一致しません",
          item: null
        };
      }

      const nextItem = {
        id: String(values[i][idColumn] || Utilities.getUuid()),
        code: code,
        reward: rewardAutoManaged && incoming.reward ? incoming.reward : existingReward,
        expiresAt: existingExpiry || incoming.expiresAt,
        sourceUrl: existingSource || incoming.sourceUrl,
        memo: existingMemo || incoming.memo,
        status: existingStatus === "hidden" ? "hidden" : incoming.status,
        createdAt: values[i][createdColumn] instanceof Date
          ? values[i][createdColumn].toISOString()
          : String(values[i][createdColumn] || now),
        updatedAt: now
      };

      const changed = nextItem.reward !== existingReward
        || nextItem.expiresAt !== existingExpiry
        || nextItem.sourceUrl !== existingSource
        || nextItem.memo !== existingMemo
        || nextItem.status !== existingStatus;
      if (!changed) return { mode: "duplicate", item: nextItem };

      sheet.getRange(i + 1, 1, 1, GIFT_HEADERS.length).setValues([giftRow_(nextItem)]);
      if (!silent) saveAutoGiftNotice_("updated", true);
      return { mode: "updated", item: nextItem };
    }

    const newItem = {
      id: incoming.id,
      code: incoming.code,
      reward: incoming.reward,
      expiresAt: incoming.expiresAt,
      sourceUrl: incoming.sourceUrl,
      memo: incoming.memo,
      status: incoming.status,
      createdAt: incoming.createdAt,
      updatedAt: incoming.updatedAt
    };
    sheet.appendRow(giftRow_(newItem));
    if (!silent) saveAutoGiftNotice_("created", true);
    return { mode: "created", item: newItem };
  });

  if (!silent && result.mode === "created" && result.item && result.item.status === "active") {
    const notifyResult = notifyDiscordGiftCode_(result.item);
    if (notifyResult.warning) Logger.log(notifyResult.warning);
  }
  return result;
}

function discordGiftMessageUrl_(message, config) {
  const guildId = String(message && message.guild_id || config.guildId || "").trim();
  const channelId = String(message && message.channel_id || config.channelId || "").trim();
  const messageId = String(message && message.id || "").trim();
  if (!guildId || !channelId || !messageId) return "";
  return "https://discord.com/channels/" + guildId + "/" + channelId + "/" + messageId;
}

function notifyGiftCodeReview_(message, config, reason) {
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = String(
    props.getProperty(DISCORD_GIFT_REVIEW_WEBHOOK_URL_PROPERTY)
    || props.getProperty(DISCORD_WEBHOOK_URL_PROPERTY)
    || ""
  ).trim();

  const sourceUrl = discordGiftMessageUrl_(message, config);
  const logText = "Gift code review required: " + String(reason || "不明") + (sourceUrl ? " " + sourceUrl : "");
  Logger.log(logText);
  if (!webhookUrl) return;

  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      payload: JSON.stringify({
        content: [
          "🎁 ギフトコード自動取得で確認が必要です。",
          "理由：" + sanitizeDiscordText_(reason || "不明"),
          sourceUrl ? "投稿：" + sanitizeDiscordUrl_(sourceUrl) : ""
        ].filter(Boolean).join("\n"),
        allowed_mentions: { parse: [] }
      })
    });
  } catch (error) {
    Logger.log("Gift code review notification failed: " + error.message);
  }
}
