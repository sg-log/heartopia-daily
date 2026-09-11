const POST_KEY_PROPERTY = "POST_KEY";
const ADMIN_KEY_PROPERTY = "ADMIN_KEY";
const DISCORD_WEBHOOK_URL_PROPERTY = "DISCORD_WEBHOOK_URL";
const HEARTOPIA_DAILY_URL = "https://sg-log.github.io/heartopia-daily/";
const SHEET_NAME = "weather_reports";
const OLD_WEEK_HEADERS = ["week1", "week2", "week3", "week4", "week5"];
const WEEK_HEADERS = ["week1", "week2", "week3", "week4", "week5", "week6", "week7"];
const OLD_HEADERS = [
  "id", "date", "startSlot", "slot0", "slot1", "slot2", "slot3", "slot4"
].concat(OLD_WEEK_HEADERS, ["memo", "status", "投稿者", "createdAt", "approvedAt"]);
const HEADERS = [
  "id", "date", "startSlot", "slot0", "slot1", "slot2", "slot3", "slot4"
].concat(WEEK_HEADERS, ["memo", "status", "投稿者", "createdAt", "approvedAt"]);
const GIFT_SHEET_NAME = "gift_codes";
const WEATHER_EVIDENCE_HEADERS = ["sourceUrl", "sourceImageUrls", "sourceType", "retrievedAt", "evidenceStatus", "evidenceImages"];
const WEATHER_EVIDENCE_FOLDER_PROPERTY = "WEATHER_EVIDENCE_FOLDER_ID";
const GIFT_HEADERS = [
  "id", "code", "reward", "expiresAt", "sourceUrl", "memo", "status", "createdAt", "updatedAt"
];
const NOTICE_SHEET_NAME = "site_notice";
const NOTICE_HEADERS = ["noticeDate", "noticeText", "updatedAt"];
const ACCESS_SHEET_NAME = "access";
const ACCESS_HEADERS = ["date", "count"];
const ACCESS_TIME_ZONE = "Asia/Tokyo";
const MAX_POST_BODY_BYTES = 64 * 1024;
const LOCK_TIMEOUT_MS = 10000;
const VALID_WEATHER_VALUES = ["晴", "雨", "流星群", "虹", "猛暑", "雪", "桜"];
const VALID_START_SLOTS = ["00", "06", "12", "18"];
const TEXT_LIMITS = {
  id: 200,
  memo: 1000,
  author: 100,
  code: 100,
  reward: 1000,
  expiresAt: 40,
  sourceUrl: 1000,
  noticeText: 1000,
  xPostUrl: 1000
};

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action === "pending") {
      return json_({ ok: false, error: "pending はPOSTで取得してください" });
    }
    if (action === "approved") {
      return json_({ ok: true, reports: listByStatus_("approved").map(publicWeatherItem_) });
    }
    if (action === "getGiftCodes") {
      return json_({ ok: true, codes: listGiftCodes_(false).map(publicGiftItem_) });
    }
    if (action === "getSiteNotice") {
      return json_({ ok: true, notice: publicNoticeItem_(getSiteNotice_()) });
    }
    return json_({ ok: false, error: "unknown action" });
  } catch (error) {
    return json_({ ok: false, error: safeErrorMessage_(error) });
  }
}

function doPost(e) {
  try {
    const body = parseBody_(e);
    const action = String(body.action || "");
    if (action === "recordAccess") return recordAccess_();
    if (action === "getAccessStats") return getAccessStats_(body);
    if (action === "submit") return submit_(body);
    if (action === "weatherEvidence") return getWeatherEvidence_(body);
    if (action === "pending") {
      requireKey_(body.adminKey, adminKey_(), "管理キー");
      return json_({ ok: true, reports: listByStatus_("pending") });
    }
    if (action === "approved") {
      requireKey_(body.adminKey, adminKey_(), "管理キー");
      return json_({ ok: true, reports: listByStatus_("approved") });
    }
    if (action === "getGiftCodes") {
      requireKey_(body.adminKey, adminKey_(), "管理キー");
      return json_({ ok: true, codes: listGiftCodes_(true) });
    }
    if (action === "saveApproved") return saveApproved_(body);
    if (action === "approve") return changeStatus_(body, "approved");
    if (action === "reject") return changeStatus_(body, "rejected");
    if (action === "saveGiftCode" || action === "updateGiftCode") return saveGiftCode_(body);
    if (action === "saveSiteNotice") return saveSiteNotice_(body);
    if (action === "xPostOembed") return xPostOembed_(body);
    return json_({ ok: false, error: "unknown action" });
  } catch (error) {
    return json_({ ok: false, error: safeErrorMessage_(error) });
  }
}

function publicWeatherItem_(item) {
  return {
    date: item.date,
    startSlot: item.startSlot,
    slots: item.slots || {},
    weeks: item.weeks || {},
    memo: String(item.memo || "")
  };
}

function publicGiftItem_(item) {
  return {
    code: item.code,
    reward: item.reward,
    expiresAt: item.expiresAt,
    sourceUrl: item.sourceUrl,
    memo: item.memo,
    status: item.status
  };
}

function publicNoticeItem_(item) {
  return {
    noticeDate: item.noticeDate,
    noticeText: item.noticeText
  };
}

function recordAccess_() {
  return withScriptLock_(function() {
    const date = todayAccessDate_();
    const sheet = getAccessSheet_();
    const values = sheet.getDataRange().getValues();
    const dateColumn = ACCESS_HEADERS.indexOf("date");
    const countColumn = ACCESS_HEADERS.indexOf("count");

    for (let i = 1; i < values.length; i++) {
      if (formatAccessDateValue_(values[i][dateColumn]) !== date) continue;
      const nextCount = accessCountValue_(values[i][countColumn]) + 1;
      sheet.getRange(i + 1, countColumn + 1).setValue(nextCount);
      SpreadsheetApp.flush();
      return json_({ ok: true, date: date });
    }

    const row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
    sheet.getRange(row, dateColumn + 1).setNumberFormat("@");
    sheet.getRange(row, 1, 1, ACCESS_HEADERS.length).setValues([[date, 1]]);
    SpreadsheetApp.flush();
    return json_({ ok: true, date: date });
  });
}

function getAccessStats_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  const today = todayAccessDate_();
  const values = withScriptLock_(function() {
    const sheet = getAccessSheet_();
    SpreadsheetApp.flush();
    return sheet.getDataRange().getValues();
  });
  const dateColumn = ACCESS_HEADERS.indexOf("date");
  const countColumn = ACCESS_HEADERS.indexOf("count");
  const counts = {};
  let total = 0;

  for (let i = 1; i < values.length; i++) {
    const date = formatAccessDateValue_(values[i][dateColumn]);
    if (!date) continue;
    const count = accessCountValue_(values[i][countColumn]);
    counts[date] = (counts[date] || 0) + count;
    total += count;
  }

  const days = [];
  for (let offset = -13; offset <= 0; offset++) {
    const date = addAccessDays_(today, offset);
    days.push({ date: date, count: counts[date] || 0 });
  }

  const recent7Days = [];
  for (let offset = -6; offset <= 0; offset++) {
    const date = addAccessDays_(today, offset);
    recent7Days.push(counts[date] || 0);
  }
  const recent7 = recent7Days.reduce(function(sum, count) { return sum + count; }, 0);
  const yesterday = addAccessDays_(today, -1);

  return json_({
    ok: true,
    stats: {
      today: counts[today] || 0,
      yesterday: counts[yesterday] || 0,
      sevenDayAverage: Math.round((recent7 / 7) * 10) / 10,
      recent7: recent7,
      total: total,
      days: days
    }
  });
}

function submit_(body) {
  requireKey_(body.postKey, postKey_(), "投稿キー");
  if (!body.date) throw new Error("日付がありません");

  const startSlot = validateStartSlotForWrite_(body.startSlot);
  const slots = normalizeSlotsForWrite_(body);
  const weeks = normalizeWeeksForWrite_(body);
  const date = validateDateForWrite_(body.date);
  const now = new Date().toISOString();
  const memo = safeSheetText_(limitText_(body.memo, TEXT_LIMITS.memo, "メモ"));
  const author = safeSheetText_(limitText_(body.author || body["投稿者"], TEXT_LIMITS.author, "投稿者"));
  const sourceUrl = weatherEvidenceUrl_(body.sourceUrl, false);
  const sourceImageUrls = weatherImageUrls_(body.sourceImageUrls);
  const evidence = validateWeatherEvidence_(body.evidenceImages);
  const sourceType = safeSheetText_(limitText_(body.sourceType, 40, "sourceType"));
  const retrievedAt = body.retrievedAt ? weatherEvidenceTime_(body.retrievedAt) : "";
  if (evidence && (!sourceUrl || !sourceType || !retrievedAt)) throw new Error("Evidence provenance required");
  if (evidence && Object.keys(body).some(function(k) { return /cookie|credential|authorization|localpath|filepath|adminKey/i.test(k); })) throw new Error("Forbidden evidence fields");
  const row = [
    Utilities.getUuid(),
    date,
    startSlot,
    encodeSlot_(slots.slot0),
    encodeSlot_(slots.slot1),
    encodeSlot_(slots.slot2),
    encodeSlot_(slots.slot3),
    encodeSlot_(slots.slot4)
  ].concat(WEEK_HEADERS.map(function(key) {
    return encodeSlot_(weeks[key]);
  }), [
    memo,
    "pending",
    author,
    now,
    ""
  ]);
  withScriptLock_(function() {
    const sheet = getWeatherEvidenceSheet_();
    let file = null;
    try {
      let references = [];
      if (evidence) {
        const folder = weatherEvidenceFolder_();
        file = folder.createFile(Utilities.newBlob(evidence.bytes, evidence.meta.mimeType, row[0] + (evidence.meta.mimeType === "image/png" ? ".png" : ".jpg")));
        requirePrivateEvidence_(file);
        references = [Object.assign({fileId:file.getId()}, evidence.meta)];
      }
      sheet.appendRow(row.concat([sourceUrl, JSON.stringify(sourceImageUrls), sourceType, retrievedAt, file ? "saved" : "missing", JSON.stringify(references)]));
    } catch (_) {
      if (file) {
        // appendRow may have committed before reporting an error. Remove only this UUID.
        try {
          const values = sheet.getDataRange().getValues();
          for (let i = values.length - 1; i > 0; i--) {
            if (String(values[i][0]) === row[0]) sheet.deleteRow(i + 1);
          }
        } catch (_) { throw new Error("Pending rollback uncertain; evidence retained. Administrator inspection required. Do not retry."); }
        try { file.setTrashed(true); }
        catch (_) { throw new Error("Evidence cleanup failed; administrator inspection required. Do not retry."); }
      }
      throw new Error("Evidence/pending save failed; no automatic retry. Check pending before retrying.");
    }
  });
  return json_({ ok: true, id: row[0], status: "pending" });
}

function saveApproved_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  if (!body.date) throw new Error("日付がありません");

  const date = validateDateForWrite_(body.date);

  const startSlot = validateStartSlotForWrite_(body.startSlot);
  const slots = normalizeSlotsForWrite_(body);
  const weeks = normalizeWeeksForWrite_(body);
  const now = new Date().toISOString();
  const memo = safeSheetText_(limitText_(body.memo, TEXT_LIMITS.memo, "メモ"));
  const author = safeSheetText_(limitText_(body.author || body["投稿者"] || "管理者", TEXT_LIMITS.author, "投稿者"));
  return withScriptLock_(function() {
    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    const idColumn = HEADERS.indexOf("id");
    const dateColumn = HEADERS.indexOf("date");
    const statusColumn = HEADERS.indexOf("status");
    let updated = 0;

    for (let i = 1; i < values.length; i++) {
      if (formatDateValue(values[i][dateColumn]) !== date) continue;
      if (String(values[i][statusColumn]) !== "approved") continue;

      const row = approvedRow_({
        id: String(values[i][idColumn] || Utilities.getUuid()),
        date: date,
        startSlot: startSlot,
        slots: slots,
        weeks: weeks,
        memo: memo,
        author: author,
        createdAt: String(values[i][HEADERS.indexOf("createdAt")] || now),
        approvedAt: now
      });
      sheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([row]);
      updated++;
    }

    if (updated > 0) {
      return json_({ ok: true, status: "approved", mode: "updated", updated: updated });
    }

    const row = approvedRow_({
      id: Utilities.getUuid(),
      date: date,
      startSlot: startSlot,
      slots: slots,
      weeks: weeks,
      memo: memo,
      author: author,
      createdAt: now,
      approvedAt: now
    });
    sheet.appendRow(row);
    return json_({ ok: true, id: row[0], status: "approved", mode: "created" });
  });
}

function approvedRow_(item) {
  return [
    item.id,
    item.date,
    item.startSlot,
    encodeSlot_(item.slots.slot0),
    encodeSlot_(item.slots.slot1),
    encodeSlot_(item.slots.slot2),
    encodeSlot_(item.slots.slot3),
    encodeSlot_(item.slots.slot4)
  ].concat(WEEK_HEADERS.map(function(key) {
    return encodeSlot_(item.weeks[key]);
  }), [
    item.memo,
    "approved",
    item.author,
    item.createdAt,
    item.approvedAt
  ]);
}

function changeStatus_(body, status) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  if (!body.id) throw new Error("idがありません");
  const targetId = limitText_(body.id, TEXT_LIMITS.id, "id");

  return withScriptLock_(function() {
    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    const idColumn = HEADERS.indexOf("id");
    const statusColumn = HEADERS.indexOf("status") + 1;
    const approvedAtColumn = HEADERS.indexOf("approvedAt") + 1;

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idColumn]) !== targetId) continue;
      sheet.getRange(i + 1, statusColumn).setValue(status);
      sheet.getRange(i + 1, approvedAtColumn).setValue(status === "approved" ? new Date().toISOString() : "");
      return json_({ ok: true, id: targetId, status: status });
    }
    throw new Error("対象の報告が見つかりません");
  });
}

function listByStatus_(status) {
  const values = getSheet_().getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(String);
  return values.slice(1).filter(function(row) {
    return normalizeStatusText_(row[headers.indexOf("status")]) === status;
  }).map(function(row) {
    const item = {};
    headers.forEach(function(header, index) {
      item[header] = row[index] == null ? "" : row[index];
    });
    item.memo = plainSheetText_(item.memo);
    // Old rows have neither field; malformed optional evidence must not hide reports.
    try { item.sourceUrl = weatherEvidenceUrl_(item.sourceUrl, false); } catch (_) { item.sourceUrl = ""; }
    try { item.sourceImageUrls = weatherImageUrls_(item.sourceImageUrls); } catch (_) { item.sourceImageUrls = []; }
    try {
      const refs = JSON.parse(item.evidenceImages || "[]");
      item.evidenceImages = Array.isArray(refs) ? refs.slice(0,1).map(function(ref) {
        return {kind:ref.kind, capturedAt:ref.capturedAt, mimeType:ref.mimeType, sha256:ref.sha256, byteSize:ref.byteSize};
      }) : [];
    } catch (_) { item.evidenceImages = []; }
    item.evidenceStatus = item.evidenceStatus || "missing";
    item.date = formatDateValue(item.date);
    item.startSlot = normalizeStartSlot_(item.startSlot);
    item.slots = {
      slot0: decodeSlot_(item.slot0),
      slot1: decodeSlot_(item.slot1),
      slot2: decodeSlot_(item.slot2),
      slot3: decodeSlot_(item.slot3),
      slot4: decodeSlot_(item.slot4)
    };
    item.weeks = {};
    WEEK_HEADERS.forEach(function(key) {
      item.weeks[key] = decodeSlot_(item[key]);
    });
    return item;
  });
}

function saveGiftCode_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  const code = validateGiftCodeForWrite_(body.code);
  if (!code) throw new Error("コードがありません");

  const now = new Date().toISOString();
  const targetId = limitText_(body.id, TEXT_LIMITS.id, "id").trim();
  const item = {
    id: targetId || Utilities.getUuid(),
    code: code,
    reward: safeSheetText_(limitText_(body.reward, TEXT_LIMITS.reward, "報酬").trim()),
    expiresAt: validateGiftExpiresForWrite_(body.expiresAt),
    sourceUrl: safeSheetText_(validateHttpUrl_(body.sourceUrl, "sourceUrl", TEXT_LIMITS.sourceUrl)),
    memo: safeSheetText_(limitText_(body.memo, TEXT_LIMITS.memo, "メモ").trim()),
    status: normalizeGiftStatus_(body.status),
    createdAt: now,
    updatedAt: now
  };

  const saveResult = withScriptLock_(function() {
    const sheet = getGiftSheet_();
    const values = sheet.getDataRange().getValues();
    const idColumn = GIFT_HEADERS.indexOf("id");
    const codeColumn = GIFT_HEADERS.indexOf("code");

    for (let i = 1; i < values.length; i++) {
      const rowId = String(values[i][idColumn] || "");
      const rowCode = String(values[i][codeColumn] || "");
      if ((targetId && rowId === targetId) || rowCode === code) {
        item.id = rowId || item.id;
        item.createdAt = String(values[i][GIFT_HEADERS.indexOf("createdAt")] || now);
        sheet.getRange(i + 1, 1, 1, GIFT_HEADERS.length).setValues([giftRow_(item)]);
        saveAutoGiftNotice_("updated", true);
        return { mode: "updated", item: item };
      }
    }

    sheet.appendRow(giftRow_(item));
    saveAutoGiftNotice_("created", true);
    return { mode: "created", item: item };
  });
  if (saveResult.mode === "updated") {
    return json_({ ok: true, mode: "updated", code: saveResult.item });
  }
  const notifyResult = item.status === "active"
    ? notifyDiscordGiftCode_(item)
    : { notified: false };
  const response = { ok: true, mode: "created", code: saveResult.item, discordNotified: Boolean(notifyResult.notified) };
  if (notifyResult.warning) {
    response.discordWarning = notifyResult.warning;
  }
  return json_(response);
}

function notifyDiscordGiftCode_(item) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty(DISCORD_WEBHOOK_URL_PROPERTY);
  if (!webhookUrl) return { notified: false };

  try {
    const lines = [
      "🎁 新しいギフトコードを追加しました！",
      "",
      "コード：" + inlineDiscordCode_(item.code)
    ];
    if (item.reward) {
      lines.push("報酬：", sanitizeDiscordText_(item.reward));
    }
    if (item.expiresAt) {
      lines.push("", "期限：" + formatDiscordGiftExpiry_(item.expiresAt));
    }
    if (item.sourceUrl) {
      lines.push("", "元ポスト：" + sanitizeDiscordUrl_(item.sourceUrl));
    }
    lines.push("", "Heartopia Daily：", HEARTOPIA_DAILY_URL);

    const response = UrlFetchApp.fetch(webhookUrl, {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      payload: JSON.stringify({
        content: lines.join("\n"),
        allowed_mentions: { parse: [] }
      })
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      return { notified: false, warning: "Discord通知に失敗しました" };
    }
    return { notified: true };
  } catch (error) {
    return { notified: false, warning: "Discord通知に失敗しました" };
  }
}

function inlineDiscordCode_(value) {
  return "`" + String(value || "").replace(/`/g, "") + "`";
}

function sanitizeDiscordText_(value) {
  return String(value || "")
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@&?\d+>/g, "")
    .trim();
}

function sanitizeDiscordUrl_(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function formatDiscordGiftExpiry_(value) {
  const text = String(value || "").trim();
  const normalized = formatDateTimeValue_(text);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (match) return match[1] + "/" + match[2] + "/" + match[3] + " " + match[4] + ":" + match[5];
  return sanitizeDiscordText_(text);
}

function xPostOembed_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  const sourceUrl = normalizeXPostUrl_(limitText_(body.url, TEXT_LIMITS.xPostUrl, "投稿URL"));
  if (!sourceUrl) throw new Error("対応しているX/Twitter投稿URLではありません");

  const endpoint = "https://publish.x.com/oembed"
    + "?url=" + encodeURIComponent(sourceUrl)
    + "&omit_script=true&dnt=true&lang=ja";
  const response = UrlFetchApp.fetch(endpoint, {
    method: "get",
    muteHttpExceptions: true,
    followRedirects: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    return json_({ ok: false, error: "投稿本文を取得できませんでした。スクショまたは投稿文を使用してください。" });
  }

  let data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (error) {
    return json_({ ok: false, error: "投稿本文を取得できませんでした。スクショまたは投稿文を使用してください。" });
  }
  const text = textFromOembedHtml_(String(data.html || ""));
  if (!text) {
    return json_({ ok: false, error: "投稿本文を取得できませんでした。スクショまたは投稿文を使用してください。" });
  }
  return json_({ ok: true, text: text, sourceUrl: sourceUrl });
}

function normalizeXPostUrl_(value) {
  const text = String(value || "").trim();
  const match = text.match(/^https:\/\/(x\.com|twitter\.com)\/([A-Za-z0-9_]{1,20})\/status\/(\d+)(?:[/?#].*)?$/i);
  if (!match) return "";
  return "https://" + match[1].toLowerCase() + "/" + match[2] + "/status/" + match[3];
}

function textFromOembedHtml_(html) {
  const blockquoteMatch = html.match(/<blockquote\b[\s\S]*?<\/blockquote>/i);
  const blockquote = blockquoteMatch ? blockquoteMatch[0] : html;
  const paragraphMatch = blockquote.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!paragraphMatch) return "";
  return decodeHtmlEntities_(paragraphMatch[1]
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/a>/gi, "")
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map(function(line) { return line.trim(); })
    .join("\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities_(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    times: "×"
  };
  return String(text || "")
    .replace(/&#(\d+);/g, function(_, code) {
      return String.fromCharCode(Number(code));
    })
    .replace(/&#x([0-9a-f]+);/gi, function(_, code) {
      return String.fromCharCode(parseInt(code, 16));
    })
    .replace(/&([a-z]+);/gi, function(_, name) {
      return Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : "";
    });
}

function listGiftCodes_(includeHidden) {
  const values = getGiftSheet_().getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(String);
  return values.slice(1).map(function(row) {
    const item = {};
    headers.forEach(function(header, index) {
      item[header] = row[index] == null ? "" : row[index];
    });
    item.status = normalizeGiftStatus_(item.status);
    item.reward = plainSheetText_(item.reward);
    item.sourceUrl = plainSheetText_(item.sourceUrl);
    item.memo = plainSheetText_(item.memo);
    item.expiresAt = formatDateTimeValue_(item.expiresAt);
    item.createdAt = item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt || "");
    item.updatedAt = item.updatedAt instanceof Date ? item.updatedAt.toISOString() : String(item.updatedAt || "");
    return item;
  }).filter(function(item) {
    return item.code && (includeHidden || item.status !== "hidden");
  });
}

function giftRow_(item) {
  return [
    item.id,
    item.code,
    item.reward,
    item.expiresAt,
    item.sourceUrl,
    item.memo,
    item.status,
    item.createdAt,
    item.updatedAt
  ];
}

function normalizeGiftStatus_(value) {
  const status = String(value || "active").trim().toLowerCase();
  return ["active", "expired", "hidden"].indexOf(status) >= 0 ? status : "active";
}

function formatDateTimeValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
  }
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.slice(0, 16);
  const date = formatDateValue(text);
  const time = text.match(/(\d{1,2})[:：](\d{2})/);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date + "T" + pad2_(time ? time[1] : 23) + ":" + pad2_(time ? time[2] : 59);
  }
  return text;
}

function getSiteNotice_() {
  const values = getNoticeSheet_().getDataRange().getValues();
  if (values.length < 2) return { noticeDate: "", noticeText: "", updatedAt: "" };

  const manual = noticeItemFromRow_(values[1] || []);
  if (manual.noticeText) return manual;
  return noticeItemFromRow_(values[2] || []);
}

function saveSiteNotice_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  const now = new Date().toISOString();
  const item = {
    noticeDate: body.noticeDate ? validateDateForWrite_(body.noticeDate) : "",
    noticeText: safeSheetText_(limitText_(body.noticeText, TEXT_LIMITS.noticeText, "お知らせ").trim()),
    updatedAt: now
  };

  return withScriptLock_(function() {
    const sheet = getNoticeSheet_();
    const row = noticeRow_(item);
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, 1, NOTICE_HEADERS.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    return json_({ ok: true, notice: item });
  });
}

function noticeRow_(item) {
  return [item.noticeDate, item.noticeText, item.updatedAt];
}

function noticeItemFromRow_(row) {
  return {
    noticeDate: formatDateValue(row[NOTICE_HEADERS.indexOf("noticeDate")]),
    noticeText: plainSheetText_(row[NOTICE_HEADERS.indexOf("noticeText")]),
    updatedAt: row[NOTICE_HEADERS.indexOf("updatedAt")] instanceof Date
      ? row[NOTICE_HEADERS.indexOf("updatedAt")].toISOString()
      : String(row[NOTICE_HEADERS.indexOf("updatedAt")] || "")
  };
}

function saveAutoGiftNotice_(mode, alreadyLocked) {
  if (!alreadyLocked) {
    return withScriptLock_(function() {
      return saveAutoGiftNoticeBody_(mode);
    });
  }
  return saveAutoGiftNoticeBody_(mode);
}

function saveAutoGiftNoticeBody_(mode) {
  const sheet = getNoticeSheet_();
  const values = sheet.getDataRange().getValues();
  const manual = noticeItemFromRow_(values[1] || []);
  const now = new Date();
  const date = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const text = mode === "updated"
    ? "ギフトコードを更新しました。上の「ギフコ」から確認できます。"
    : "新しいギフトコードを追加しました。上の「ギフコ」から確認できます。";
  const item = {
    noticeDate: date,
    noticeText: text,
    updatedAt: now.toISOString()
  };

  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, 1, NOTICE_HEADERS.length).setValues([noticeRow_({
      noticeDate: "",
      noticeText: "",
      updatedAt: ""
    })]);
  }
  sheet.getRange(3, 1, 1, NOTICE_HEADERS.length).setValues([noticeRow_(item)]);
  return manual.noticeText ? manual : item;
}

function formatDateValue(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }

  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  let match = text.match(/^(20\d{2})\s*[年\/.-]\s*(\d{1,2})\s*[月\/.-]\s*(\d{1,2})\s*日?/);
  if (match) return match[1] + "-" + pad2_(match[2]) + "-" + pad2_(match[3]);
  match = text.match(/^(\d{1,2})\s*[月\/.-]\s*(\d{1,2})\s*日?/);
  if (match) {
    const now = new Date();
    return Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy") + "-" + pad2_(match[1]) + "-" + pad2_(match[2]);
  }

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return text;
}

function pad2_(value) {
  return String(value).padStart(2, "0");
}

function normalizeStatusText_(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStartSlot_(value) {
  const text = String(value == null || value === "" ? "18" : value).replace("時", "").trim();
  const normalized = text.length === 1 ? "0" + text : text;
  return ["00", "06", "12", "18"].indexOf(normalized) >= 0 ? normalized : "18";
}

function normalizeSlots_(body) {
  const source = body.slots || {};
  if (["slot0", "slot1", "slot2", "slot3", "slot4"].some(function(key) { return source[key] != null; })) {
    return {
      slot0: normalizeSlotList_(source.slot0),
      slot1: normalizeSlotList_(source.slot1),
      slot2: normalizeSlotList_(source.slot2),
      slot3: normalizeSlotList_(source.slot3),
      slot4: normalizeSlotList_(source.slot4)
    };
  }

  if (["slot0", "slot1", "slot2", "slot3", "slot4"].some(function(key) { return body[key] != null; })) {
    return {
      slot0: normalizeSlotList_(body.slot0),
      slot1: normalizeSlotList_(body.slot1),
      slot2: normalizeSlotList_(body.slot2),
      slot3: normalizeSlotList_(body.slot3),
      slot4: normalizeSlotList_(body.slot4)
    };
  }

  const old = body.weatherSlots || {};
  return {
    slot0: normalizeSlotList_(old.t18a),
    slot1: normalizeSlotList_(old.t00),
    slot2: normalizeSlotList_(old.t06),
    slot3: normalizeSlotList_(old.t12),
    slot4: normalizeSlotList_(old.t18b)
  };
}

function normalizeWeeks_(body) {
  const source = body.weeks || {};
  if (WEEK_HEADERS.some(function(key) { return source[key] != null; })) {
    const weeks = {};
    WEEK_HEADERS.forEach(function(key) {
      weeks[key] = normalizeSlotList_(source[key]);
    });
    return weeks;
  }
  const weeks = {};
  WEEK_HEADERS.forEach(function(key) {
    weeks[key] = normalizeSlotList_(body[key]);
  });
  return weeks;
}

function normalizeSlotsForWrite_(body) {
  const source = body.slots || {};
  if (["slot0", "slot1", "slot2", "slot3", "slot4"].some(function(key) { return source[key] != null; })) {
    return {
      slot0: validateSlotListForWrite_(source.slot0, "slot0"),
      slot1: validateSlotListForWrite_(source.slot1, "slot1"),
      slot2: validateSlotListForWrite_(source.slot2, "slot2"),
      slot3: validateSlotListForWrite_(source.slot3, "slot3"),
      slot4: validateSlotListForWrite_(source.slot4, "slot4")
    };
  }
  const old = body.weatherSlots || {};
  if (["t18a", "t00", "t06", "t12", "t18b"].some(function(key) { return old[key] != null; })) {
    return {
      slot0: validateSlotListForWrite_(old.t18a, "slot0"),
      slot1: validateSlotListForWrite_(old.t00, "slot1"),
      slot2: validateSlotListForWrite_(old.t06, "slot2"),
      slot3: validateSlotListForWrite_(old.t12, "slot3"),
      slot4: validateSlotListForWrite_(old.t18b, "slot4")
    };
  }
  return {
    slot0: validateSlotListForWrite_(body.slot0, "slot0"),
    slot1: validateSlotListForWrite_(body.slot1, "slot1"),
    slot2: validateSlotListForWrite_(body.slot2, "slot2"),
    slot3: validateSlotListForWrite_(body.slot3, "slot3"),
    slot4: validateSlotListForWrite_(body.slot4, "slot4")
  };
}

function normalizeWeeksForWrite_(body) {
  const source = body.weeks || {};
  const weeks = {};
  WEEK_HEADERS.forEach(function(key) {
    weeks[key] = validateSlotListForWrite_(source[key] != null ? source[key] : body[key], key);
  });
  return weeks;
}

function validateSlotListForWrite_(value, label) {
  const list = slotListFromValue_(value);
  if (list.length > 4) throw new Error(label + "の天気が多すぎます");
  const result = [];
  list.forEach(function(item) {
    const text = String(item || "").trim();
    if (!text || text === "—" || text === "-") return;
    if (VALID_WEATHER_VALUES.indexOf(text) < 0) {
      throw new Error(label + "に未対応の天気があります");
    }
    if (result.indexOf(text) < 0) result.push(text);
  });
  return result;
}

function slotListFromValue_(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    return String(value).split(/[・,、/]/);
  }
}

function validateStartSlotForWrite_(value) {
  const text = String(value == null || value === "" ? "18" : value).replace("時", "").trim();
  const normalized = text.length === 1 ? "0" + text : text;
  if (VALID_START_SLOTS.indexOf(normalized) < 0) throw new Error("最初の時間が正しくありません");
  return normalized;
}

function validateDateForWrite_(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("日付の形式が正しくありません");
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    parsed.getFullYear() !== Number(match[1]) ||
    parsed.getMonth() + 1 !== Number(match[2]) ||
    parsed.getDate() !== Number(match[3])
  ) {
    throw new Error("日付の形式が正しくありません");
  }
  return match[1] + "-" + match[2] + "-" + match[3];
}

function validateGiftCodeForWrite_(value) {
  const text = limitText_(value, TEXT_LIMITS.code, "コード").trim();
  if (!text) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(text)) throw new Error("コードの形式が正しくありません");
  return safeSheetText_(text);
}

function validateGiftExpiresForWrite_(value) {
  const text = limitText_(value, TEXT_LIMITS.expiresAt, "期限").trim();
  if (!text) return "";
  const normalized = formatDateTimeValue_(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) throw new Error("期限の形式が正しくありません");
  return normalized;
}

function validateHttpUrl_(value, label, maxLength) {
  const text = limitText_(value, maxLength, label).trim();
  if (!text) return "";
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(text)) throw new Error(label + "の形式が正しくありません");
  return text;
}

function limitText_(value, maxLength, label) {
  const text = String(value || "");
  if (text.length > maxLength) throw new Error(label + "が長すぎます");
  return text;
}

function safeSheetText_(value) {
  const text = String(value || "");
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function plainSheetText_(value) {
  return String(value || "").replace(/^'(?=[=+\-@])/, "");
}

function normalizeSlotList_(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return parseSlotParameter_(value);
}

function migrateWeatherWeeksTo7Days() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(SHEET_NAME + " シートが見つかりません");

  const lastColumn = sheet.getLastColumn();
  const headerWidth = Math.max(lastColumn, HEADERS.length);
  const headers = sheet.getRange(1, 1, 1, headerWidth).getValues()[0].map(function(value) {
    return String(value || "");
  });

  if (headersMatch_(headers.slice(0, HEADERS.length), HEADERS)) {
    Logger.log("移行済みです。変更はありません。");
    return;
  }

  if (lastColumn !== OLD_HEADERS.length || !headersMatch_(headers.slice(0, OLD_HEADERS.length), OLD_HEADERS)) {
    throw new Error("想定外のヘッダーです。移行せず停止しました。");
  }

  const backupName = SHEET_NAME + "_backup_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
  sheet.copyTo(spreadsheet).setName(backupName);

  const rowCount = Math.max(sheet.getLastRow() - 1, 0);
  const weekStartColumn = OLD_HEADERS.indexOf("week1") + 1;
  const week5Column = OLD_HEADERS.indexOf("week5") + 1;
  const oldWeekValues = rowCount
    ? sheet.getRange(2, weekStartColumn, rowCount, OLD_WEEK_HEADERS.length).getValues()
    : [];

  sheet.insertColumnsAfter(week5Column, 2);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);

  if (rowCount) {
    const migratedWeeks = oldWeekValues.map(function(row) {
      return ["", row[0] || "", row[1] || "", row[2] || "", row[3] || "", row[4] || "", ""];
    });
    sheet.getRange(2, weekStartColumn, rowCount, WEEK_HEADERS.length).setValues(migratedWeeks);
  }

  Logger.log("週間予報7日化の移行が完了しました。処理件数: " + rowCount + " 件。バックアップ: " + backupName);
}

function headersMatch_(actual, expected) {
  if (actual.length < expected.length) return false;
  return expected.every(function(header, index) {
    return String(actual[index] || "") === header;
  });
}

function weatherEvidenceTime_(value) {
  if (typeof value !== "string" || value.length > 40 || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !isFinite(Date.parse(value))) throw new Error("Invalid evidence timestamp");
  return value;
}

function evidenceHash_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function(b) { return (b & 255).toString(16).padStart(2,"0"); }).join("");
}

function validateWeatherEvidence_(images) {
  if (images == null) return null;
  if (!Array.isArray(images) || images.length > 1) throw new Error("At most one evidence image");
  if (!images.length) return null;
  const im = images[0];
  const keys = ["mimeType","byteSize","sha256","kind","capturedAt","bodyBase64"];
  if (!im || Object.keys(im).some(function(k) { return keys.indexOf(k) < 0; }) || keys.some(function(k) { return im[k] == null; })) throw new Error("Invalid evidence fields");
  if (["image/png","image/jpeg"].indexOf(im.mimeType) < 0 || ["original","screenshot"].indexOf(im.kind) < 0) throw new Error("Invalid evidence format");
  weatherEvidenceTime_(im.capturedAt);
  const b64 = im.bodyBase64;
  if (typeof b64 !== "string" || !b64.length || b64.length > 699052 || b64.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new Error("Invalid evidence Base64");
  const bytes = Utilities.base64Decode(b64);
  if (!bytes.length || bytes.length > 524288 || im.byteSize !== bytes.length || Utilities.base64Encode(bytes) !== b64) throw new Error("Invalid evidence size/encoding");
  const b = bytes.map(function(v) { return v & 255; });
  const png = b.length >= 45 && b.slice(0,8).join() === '137,80,78,71,13,10,26,10' && b.slice(12,16).join() === '73,72,68,82' && b.slice(-8,-4).join() === '73,69,78,68';
  const jpeg = b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255 && b[b.length-2] === 255 && b[b.length-1] === 217;
  if (!(im.mimeType === "image/png" ? png : jpeg)) throw new Error("Evidence signature mismatch");
  if (typeof im.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(im.sha256) || evidenceHash_(bytes) !== im.sha256) throw new Error("Evidence SHA-256 mismatch");
  return {bytes:bytes, meta:{kind:im.kind,capturedAt:im.capturedAt,mimeType:im.mimeType,sha256:im.sha256,byteSize:bytes.length}};
}

function requirePrivateEvidence_(item) {
  if (item.getSharingAccess() !== DriveApp.Access.PRIVATE || item.getViewers().length || item.getEditors().length) throw new Error("Evidence storage must be owner-only");
}

function weatherEvidenceFolder_() {
  const id = scriptProperty_(WEATHER_EVIDENCE_FOLDER_PROPERTY, "Evidence folder");
  const folder = DriveApp.getFolderById(id);
  requirePrivateEvidence_(folder);
  return folder;
}

function getWeatherEvidence_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  if (Object.keys(body).some(function(k) { return ["action","adminKey","reportId","imageIndex"].indexOf(k) < 0; }) || typeof body.reportId !== "string" || !body.reportId || body.reportId.length > 100 || body.imageIndex !== 0) throw new Error("Invalid evidence request");
  // No client-supplied file IDs. Only the pending row's reference can be resolved.
  const rows = getSheet_().getDataRange().getValues(), headers = rows[0];
  const row = rows.slice(1).find(function(r) { return String(r[headers.indexOf("id")]) === body.reportId && r[headers.indexOf("status")] === "pending"; });
  if (!row || row[headers.indexOf("evidenceStatus")] !== "saved") throw new Error("Pending evidence unavailable");
  try {
    const refs = JSON.parse(row[headers.indexOf("evidenceImages")]);
    if (!Array.isArray(refs) || refs.length !== 1 || !refs[0].fileId) throw new Error();
    const ref = refs[0], folder = weatherEvidenceFolder_();
    const file = DriveApp.getFileById(ref.fileId);
    requirePrivateEvidence_(file);
    const parents = file.getParents(); let belongs = false;
    while (parents.hasNext()) { if (parents.next().getId() === folder.getId()) belongs = true; }
    if (!belongs || file.isTrashed() || file.getSize() > 524288) throw new Error();
    const bytes = file.getBlob().getBytes();
    const bodyBase64 = Utilities.base64Encode(bytes);
    validateWeatherEvidence_([Object.assign({}, {kind:ref.kind,capturedAt:ref.capturedAt,mimeType:ref.mimeType,sha256:ref.sha256,byteSize:ref.byteSize}, {bodyBase64:bodyBase64})]);
    return json_({ok:true,mimeType:ref.mimeType,bodyBase64:bodyBase64});
  } catch (_) { throw new Error("Pending evidence unavailable"); }
}

function weatherEvidenceUrl_(value, image) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > 2000 ||
      !(/^https?:\/\//i).test(value) ||
      !/^https?:\/\/[^\s/@?#\\]+(?:[/?][^\s<>"'\\#]*)?$/i.test(value)) {
    throw new Error("Invalid weather evidence URL");
  }
  return value;
}

function weatherImageUrls_(value) {
  if (value == null || value === "") return [];
  if (typeof value === "string") value = JSON.parse(value);
  if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid sourceImageUrls array");
  return value.map(function(url) { return weatherEvidenceUrl_(url, true); })
    .filter(function(url, i, all) { return url && all.indexOf(url) === i; });
}

// Append optional columns only on submit. Existing reads/status updates never migrate rows.
function getWeatherEvidenceSheet_() {
  const sheet = getSheet_();
  const width = HEADERS.length + WEATHER_EVIDENCE_HEADERS.length;
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  const range = sheet.getRange(1, HEADERS.length + 1, 1, WEATHER_EVIDENCE_HEADERS.length);
  const actual = range.getValues()[0];
  if (actual.some(function(v,i) { return v && v !== WEATHER_EVIDENCE_HEADERS[i]; })) throw new Error("Weather evidence columns conflict");
  if (!headersMatch_(actual, WEATHER_EVIDENCE_HEADERS)) range.setValues([WEATHER_EVIDENCE_HEADERS]);
  return sheet;
}

function getSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

  const currentHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (HEADERS.some(function(header, index) { return String(currentHeaders[index]) !== header; })) {
    throw new Error("1行目の列名をREADME記載の順番に合わせてください");
  }
  sheet.getRange(1, HEADERS.indexOf("startSlot") + 1, Math.max(sheet.getMaxRows(), 1), 1).setNumberFormat("@");
  return sheet;
}

function getGiftSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(GIFT_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(GIFT_SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(GIFT_HEADERS);

  const currentHeaders = sheet.getRange(1, 1, 1, GIFT_HEADERS.length).getValues()[0];
  if (GIFT_HEADERS.some(function(header, index) { return String(currentHeaders[index]) !== header; })) {
    throw new Error("gift_codes 1行目の列名をREADME記載の順番に合わせてください");
  }
  sheet.getRange(1, GIFT_HEADERS.indexOf("code") + 1, Math.max(sheet.getMaxRows(), 1), 1).setNumberFormat("@");
  return sheet;
}

function getNoticeSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(NOTICE_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(NOTICE_SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(NOTICE_HEADERS);

  const currentHeaders = sheet.getRange(1, 1, 1, NOTICE_HEADERS.length).getValues()[0];
  if (NOTICE_HEADERS.some(function(header, index) { return String(currentHeaders[index]) !== header; })) {
    throw new Error("site_notice 1行目の列名をREADME記載の順番に合わせてください");
  }
  return sheet;
}

function getAccessSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(ACCESS_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(ACCESS_SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(ACCESS_HEADERS);

  const currentHeaders = sheet.getRange(1, 1, 1, ACCESS_HEADERS.length).getValues()[0];
  if (ACCESS_HEADERS.some(function(header, index) { return String(currentHeaders[index] || "") !== header; })) {
    throw new Error("access 1行目の列名を date, count の順番に合わせてください");
  }
  return sheet;
}

function todayAccessDate_() {
  return Utilities.formatDate(new Date(), ACCESS_TIME_ZONE, "yyyy-MM-dd");
}

function formatAccessDateValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, ACCESS_TIME_ZONE, "yyyy-MM-dd");
  }

  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  let match = text.match(/^(20\d{2})\s*[年\/.-]\s*(\d{1,2})\s*[月\/.-]\s*(\d{1,2})\s*日?/);
  if (match) return match[1] + "-" + pad2_(match[2]) + "-" + pad2_(match[3]);

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, ACCESS_TIME_ZONE, "yyyy-MM-dd");
  }
  return text;
}

function accessCountValue_(value) {
  const count = Number(value || 0);
  if (!isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

function addAccessDays_(date, offset) {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(offset || 0)));
  return Utilities.formatDate(value, ACCESS_TIME_ZONE, "yyyy-MM-dd");
}

function parseBody_(e) {
  const text = e && e.postData && e.postData.contents;
  if (text && text.length > 1024 * 1024) throw new Error("リクエストが大きすぎます");
  if (text && Utilities.newBlob(text).getBytes().length > MAX_POST_BODY_BYTES) {
    if (text.length > 1024 * 1024 || Utilities.newBlob(text).getBytes().length > 1024 * 1024) throw new Error("リクエストが大きすぎます");
    let large;
    try { large = JSON.parse(text); } catch (_) { throw new Error("Large request must be JSON evidence submit"); }
    if (large.action !== "submit" || !Array.isArray(large.evidenceImages) || large.evidenceImages.length !== 1) throw new Error("Large request must be evidence submit");
    return large;
  }
  const parameters = (e && e.parameter) || {};
  if (parameters.action) {
    const hasNewSlots = ["slot0", "slot1", "slot2", "slot3", "slot4"].some(function(key) {
      return parameters[key] != null;
    });
    const hasOldSlots = ["t18a", "t00", "t06", "t12", "t18b"].some(function(key) {
      return parameters[key] != null;
    });
    const hasWeeks = WEEK_HEADERS.some(function(key) {
      return parameters[key] != null;
    });
    const weeks = {};
    if (hasWeeks) {
      WEEK_HEADERS.forEach(function(key) {
        weeks[key] = String(parameters[key] || "");
      });
    }
    return {
      action: String(parameters.action || ""),
      postKey: String(parameters.postKey || ""),
      adminKey: String(parameters.adminKey || ""),
      id: String(parameters.id || ""),
      date: String(parameters.date || ""),
      startSlot: String(parameters.startSlot || ""),
      memo: String(parameters.memo || ""),
      poster: String(parameters.poster || ""),
      author: String(parameters.poster || parameters.author || parameters["投稿者"] || ""),
      code: String(parameters.code || ""),
      reward: String(parameters.reward || ""),
      expiresAt: String(parameters.expiresAt || ""),
      sourceUrl: String(parameters.sourceUrl || ""),
      sourceImageUrls: parameters.sourceImageUrls || "",
      url: String(parameters.url || ""),
      status: String(parameters.status || ""),
      noticeDate: String(parameters.noticeDate || ""),
      noticeText: String(parameters.noticeText || ""),
      slots: hasNewSlots ? {
        slot0: String(parameters.slot0 || ""),
        slot1: String(parameters.slot1 || ""),
        slot2: String(parameters.slot2 || ""),
        slot3: String(parameters.slot3 || ""),
        slot4: String(parameters.slot4 || "")
      } : {},
      weatherSlots: hasOldSlots ? {
        t18a: String(parameters.t18a || ""),
        t00: String(parameters.t00 || ""),
        t06: String(parameters.t06 || ""),
        t12: String(parameters.t12 || ""),
        t18b: String(parameters.t18b || "")
      } : {},
      weeks: hasWeeks ? weeks : {}
    };
  }

  if (text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("リクエスト形式が正しくありません");
    }
  }
  return parameters;
}

function parseSlotParameter_(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String).filter(validWeatherText_) : [String(parsed)].filter(validWeatherText_);
  } catch (error) {
    return String(value).split(/[・,、/]/).map(function(item) {
      return item.trim();
    }).filter(validWeatherText_);
  }
}

function validWeatherText_(value) {
  const text = String(value || "").trim();
  return Boolean(text && text !== "—" && text !== "-");
}

function encodeSlot_(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return JSON.stringify(list.map(String).filter(Boolean));
}

function decodeSlot_(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch (error) {
    return String(value).split(/[・,、/]/).map(function(item) { return item.trim(); }).filter(Boolean);
  }
}

function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new Error("処理が混み合っています。少し待って再試行してください");
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function requireKey_(actual, expected, label) {
  if (!actual || String(actual) !== String(expected)) {
    throw new Error("認証に失敗しました");
  }
}

function postKey_() {
  return scriptProperty_(POST_KEY_PROPERTY, "投稿キー");
}

function adminKey_() {
  return scriptProperty_(ADMIN_KEY_PROPERTY, "管理キー");
}

function scriptProperty_(name, label) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(label + "が未設定です");
  return value;
}

function safeErrorMessage_(error) {
  const message = String(error && error.message || "エラーが発生しました");
  if (/Webhook|https:\/\/discord\.com\/api\/webhooks/i.test(message)) return "外部通知処理に失敗しました";
  return message;
}

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
