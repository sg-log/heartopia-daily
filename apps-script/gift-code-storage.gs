function giftSourceWebhookIds_() {
  const props = PropertiesService.getScriptProperties();
  const result = [];
  const add = function(value) {
    const id = String(value || "").trim();
    if (/^\d{15,25}$/.test(id) && result.indexOf(id) < 0) result.push(id);
  };

  add(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY));
  const raw = String(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_IDS_PROPERTY) || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) parsed.forEach(add);
    } catch (_) {
      raw.split(/[\s,]+/).forEach(add);
    }
  }
  return result.slice(0, 8);
}

function rememberGiftSourceWebhookId_(value) {
  const id = String(value || "").trim();
  if (!/^\d{15,25}$/.test(id)) return giftSourceWebhookIds_();

  const props = PropertiesService.getScriptProperties();
  const ids = giftSourceWebhookIds_();
  if (ids.indexOf(id) < 0) ids.push(id);
  const bounded = ids.slice(-8);
  props.setProperty(DISCORD_GIFT_SOURCE_WEBHOOK_IDS_PROPERTY, JSON.stringify(bounded));
  if (!String(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY) || "").trim()) {
    props.setProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY, id);
  }
  return bounded;
}

function isAutoGiftMemo_(memo) {
  const text = String(memo || "").trim();
  return /^(?:投稿文から下書き|スクショ確認あり|公式Discord自動取得|公式X自動取得)(?:\s*\/\s*日本語名未確認:.*)?$/i.test(text);
}

function isAutomatedGiftSourceUrl_(value) {
  const text = String(value || "").trim();
  return /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/i.test(text)
    || /^https:\/\/x\.com\/(?:myheartopia|Heartopia_JP)\/status\/\d+(?:\?.*)?$/i.test(text);
}

function clearGeneratedGiftMemos() {
  return withScriptLock_(function() {
    const sheet = getGiftSheet_();
    const values = sheet.getDataRange().getValues();
    const memoColumn = GIFT_HEADERS.indexOf("memo");
    if (memoColumn < 0 || values.length <= 1) return { cleared: 0 };

    let cleared = 0;
    for (let i = 1; i < values.length; i++) {
      const memo = plainSheetText_(values[i][memoColumn]).trim();
      if (!isAutoGiftMemo_(memo)) continue;
      sheet.getRange(i + 1, memoColumn + 1).setValue("");
      cleared++;
    }
    return { cleared: cleared };
  });
}

function ingestDiscordGiftBatch_(body) {
  requireKey_(body.postKey, postKey_(), "投稿キー");
  const result = processDiscordGiftBatch_(body || {});
  return json_(Object.assign({ ok: true }, result));
}

function ingestOfficialXGiftBatch_(body) {
  requireKey_(body.postKey, postKey_(), "投稿キー");
  const result = processOfficialXGiftBatch_(body || {});
  return json_(Object.assign({ ok: true }, result));
}

function processOfficialXGiftBatch_(body) {
  const posts = Array.isArray(body.posts) ? body.posts.slice(0, 20) : [];
  const reviewCandidates = Array.isArray(body.reviewCandidates) ? body.reviewCandidates.slice(0, 20) : [];
  const counts = {
    created: 0,
    updated: 0,
    duplicate: 0,
    conflict: 0,
    review: 0,
    ignored: 0
  };

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i] || {};
    const statusId = String(post.statusId || "").trim();
    const sourceUrl = String(post.sourceUrl || "").trim();
    const text = String(post.text || "").trim();

    const match = sourceUrl.match(/^https:\/\/x\.com\/(myheartopia|Heartopia_JP)\/status\/(\d{15,25})(?:\?.*)?$/i);
    if (!/^\d{15,25}$/.test(statusId) || !match || match[2] !== statusId || !text || text.length > 12000) {
      counts.ignored++;
      continue;
    }

    if (!looksLikeDiscordGiftAnnouncement_(text)) {
      if (/Gift\s*Code\s*:|ギフト\s*コード\s*[:：]/i.test(text)) counts.review++;
      else counts.ignored++;
      continue;
    }

    const parsed = parseDiscordGiftAnnouncement_(text, {
      rewardNameMap: giftRewardNameMap_()
    });
    if (!parsed.ok || !parsed.expiresAt || /(?:…|\.{3})\s*$/.test(text)) {
      counts.review++;
      if (parsed.code) reviewCandidates.push({ code: parsed.code, sourceUrl: sourceUrl, listingUrls: [],
        excerpt: text.slice(0, 1000), reason: "公式投稿の報酬・交換期限を完全に確認できません。" });
      Logger.log("Official X gift review required: " + (parsed.error || "交換期限未確認") + " " + sourceUrl);
      continue;
    }

    const candidate = {
      code: parsed.code,
      reward: parsed.reward,
      rawReward: parsed.rawReward,
      expiresAt: parsed.expiresAt,
      sourceUrl: sourceUrl,
      memo: "",
      status: giftStatusFromExpiry_(parsed.expiresAt)
    };

    const result = saveAutomatedGiftCode_(candidate, { silent: false });
    const mode = String(result && result.mode || "ignored");
    if (Object.prototype.hasOwnProperty.call(counts, mode)) counts[mode]++;
    else counts.ignored++;
    if (mode === "conflict") {
      reviewCandidates.push({ code: parsed.code, sourceUrl: sourceUrl, listingUrls: [], excerpt: text.slice(0, 1000),
        reason: result.reason || "既存データと一致しません。" });
      Logger.log("Official X gift conflict: " + sourceUrl + " " + String(result.reason || ""));
    }
  }

  return {
    receivedCandidates: posts.length,
    counts: counts,
    reviews: body.reconcile ? reconcileGiftReviews_(reviewCandidates, body.ackReviewIds) : []
  };
}

function getGiftReviewSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName("gift_code_reviews");
  if (!sheet) {
    sheet = spreadsheet.insertSheet("gift_code_reviews");
    sheet.appendRow(["id", "code", "reason", "sourceUrl", "listingUrls", "excerpt", "status", "createdAt", "notifiedAt"]);
  }
  return sheet;
}

function reconcileGiftReviews_(candidates, acknowledgements) {
  return withScriptLock_(function() {
    const sheet = getGiftReviewSheet_();
    const rows = sheet.getDataRange().getValues();
    const gifts = getGiftSheet_().getDataRange().getValues();
    const byCode = {};
    gifts.slice(1).forEach(function(row) { byCode[String(row[GIFT_HEADERS.indexOf("code")])] = row; });
    const now = new Date().toISOString();
    const ack = Array.isArray(acknowledgements) ? acknowledgements.slice(0, 10).map(String) : [];
    (candidates || []).slice(0, 40).forEach(function(item) {
      const code = String(item.code || "");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,99}$/.test(code)) return;
      const source = String(item.sourceUrl || "");
      const official = /^https:\/\/x\.com\/(?:myheartopia|Heartopia_JP)\/status\/\d{15,25}$/i.test(source);
      const listings = (Array.isArray(item.listingUrls) ? item.listingUrls : []).filter(function(url) {
        return ["https://heartopiaguide.com/codes/", "https://www.heartodex.com/en/codes/"].indexOf(url) >= 0;
      });
      if ((!official && source) || (!official && !listings.length)) return;
      // Search can return years of old X posts; only current active-list misses alert.
      if (!listings.length || byCode[code]) return;
      if (rows.slice(1).some(function(row) { return String(row[1]) === code; })) return;
      const row = [Utilities.getUuid(), code, safeSheetText_(String(item.reason || "公式情報の確認が必要です。").slice(0, 300)),
        source, JSON.stringify(listings.slice(0, 2)), safeSheetText_(String(item.excerpt || "").slice(0, 1000)), "pending", now, ""];
      sheet.appendRow(row);
      rows.push(row);
    });
    const pending = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const gift = byCode[String(row[1])];
      // A deliberate hide is final; do not expose it as a fresh missing-code alert.
      const legacy = !JSON.parse(String(row[4] || "[]")).length;
      const resolved = Boolean(gift) || legacy;
      let changed = false;
      if (resolved && row[6] !== "resolved") { row[6] = "resolved"; changed = true; }
      if (ack.indexOf(String(row[0])) >= 0 && !row[8]) { row[8] = now; changed = true; }
      if (changed) sheet.getRange(i + 1, 1, 1, 9).setValues([row]);
      if (row[6] === "pending" && !row[8] && pending.length < 10) {
        pending.push({ id: String(row[0]), code: String(row[1]), reason: plainSheetText_(row[2]), sourceUrl: String(row[3]),
          listingUrls: JSON.parse(String(row[4] || "[]")) });
      }
    }
    return pending;
  });
}

function processDiscordGiftBatch_(body) {
  const props = PropertiesService.getScriptProperties();
  const configuredChannelId = String(props.getProperty(DISCORD_GIFT_CHANNEL_ID_PROPERTY) || "").trim();
  const channelId = String(body.channelId || "").trim();
  const guildId = String(body.guildId || "").trim();
  const latestMessageId = String(body.latestMessageId || "").trim();
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, DISCORD_GIFT_POLL_LIMIT) : [];

  if (!/^\d{15,25}$/.test(channelId)) throw new Error("DiscordチャンネルIDが不正です");
  if (configuredChannelId && channelId !== configuredChannelId) throw new Error("DiscordチャンネルIDが設定値と一致しません");
  if (!/^\d{15,25}$/.test(guildId)) throw new Error("DiscordサーバーIDが不正です");
  if (!/^\d{15,25}$/.test(latestMessageId)) throw new Error("Discord最新メッセージIDが不正です");

  props.setProperty(DISCORD_GIFT_GUILD_ID_PROPERTY, guildId);
  const cursorBefore = String(props.getProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY) || "").trim();
  const bootstrap = !cursorBefore;
  const historyRevision = /^[A-Za-z0-9._-]{1,64}$/.test(String(body.historyRevision || ""))
    ? String(body.historyRevision) : "";
  const replayHistory = Boolean(historyRevision && props.getProperty("DISCORD_GIFT_HISTORY_REVISION") !== historyRevision);
  let historyRecovered = 0;
  let cursor = cursorBefore;
  const counts = {
    created: 0,
    updated: 0,
    duplicate: 0,
    conflict: 0,
    review: 0,
    ignored: 0
  };
  const config = {
    channelId: channelId,
    guildId: guildId,
    sourceWebhookId: String(props.getProperty(DISCORD_GIFT_SOURCE_WEBHOOK_ID_PROPERTY) || "").trim()
  };

  messages.sort(function(a, b) {
    return compareDiscordSnowflakes_(String(a && a.id || ""), String(b && b.id || ""));
  });

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] || {};
    const messageId = String(message.id || "").trim();
    const messageChannelId = String(message.channel_id || "").trim();
    if (!/^\d{15,25}$/.test(messageId)) continue;
    if (messageChannelId && messageChannelId !== channelId) continue;
    const previouslyScanned = Boolean(cursor && compareDiscordSnowflakes_(messageId, cursor) <= 0);
    if (previouslyScanned && !replayHistory) continue;

    message.channel_id = channelId;
    message.guild_id = guildId;
    const handled = processDiscordGiftMessage_(message, config, { silent: bootstrap || previouslyScanned });
    const mode = String(handled && handled.mode || "ignored");
    if (Object.prototype.hasOwnProperty.call(counts, mode)) counts[mode]++;
    else counts.ignored++;

    if (previouslyScanned && mode === "created") historyRecovered++;
    if (handled && handled.advanceCursor && (!cursor || compareDiscordSnowflakes_(messageId, cursor) > 0)) cursor = messageId;
  }

  if (!cursor || compareDiscordSnowflakes_(latestMessageId, cursor) > 0) cursor = latestMessageId;
  props.setProperty(DISCORD_GIFT_LAST_MESSAGE_ID_PROPERTY, cursor);
  if (historyRevision) props.setProperty("DISCORD_GIFT_HISTORY_REVISION", historyRevision);

  return {
    bootstrap: bootstrap,
    historyReplayed: replayHistory,
    historyRecovered: historyRecovered,
    receivedCandidates: messages.length,
    lastMessageId: cursor,
    counts: counts
  };
}

function processDiscordGiftMessage_(message, config, options) {
  const silent = Boolean(options && options.silent);
  const text = discordGiftMessageText_(message);
  if (!text || !looksLikeDiscordGiftAnnouncement_(text)) {
    return { advanceCursor: true, mode: "ignored" };
  }

  if (!message.webhook_id) {
    if (!silent) notifyGiftCodeReview_(message, config, "ギフト形式の投稿ですがWebhook投稿ではありません");
    return { advanceCursor: true, mode: "review" };
  }

  const currentWebhookId = String(message.webhook_id || "").trim();
  const parsed = parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: giftRewardNameMap_()
  });
  if (!parsed.ok) {
    if (!silent) notifyGiftCodeReview_(message, config, parsed.error || "ギフトコードを安全に解析できませんでした");
    return { advanceCursor: true, mode: "review" };
  }

  // The dedicated receiving channel may follow more than one official
  // announcement channel. Learn each successfully parsed follower webhook
  // instead of pinning the automation to the first one forever.
  rememberGiftSourceWebhookId_(currentWebhookId);

  const candidate = {
    code: parsed.code,
    reward: parsed.reward,
    rawReward: parsed.rawReward,
    expiresAt: parsed.expiresAt,
    sourceUrl: discordGiftMessageUrl_(message, config),
    memo: "",
    status: giftStatusFromExpiry_(parsed.expiresAt)
  };

  const result = saveAutomatedGiftCode_(candidate, { silent: silent });
  if (result.mode === "conflict" && !silent) {
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
    memo: safeSheetText_(limitText_(candidate.memo || "", TEXT_LIMITS.memo, "メモ").trim()),
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
        || isAutoGiftMemo_(existingMemo)
        || isAutomatedGiftSourceUrl_(existingSource);
      const expiryConflict = existingExpiry && incoming.expiresAt && existingExpiry !== incoming.expiresAt;
      const rewardConflict = existingReward && incoming.reward && existingReward !== incoming.reward && !rewardAutoManaged;

      if (expiryConflict || rewardConflict) {
        return {
          mode: "conflict",
          reason: "既存の手動データと公式自動取得データが一致しません",
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
