const POST_KEY_PROPERTY = "POST_KEY";
const ADMIN_KEY_PROPERTY = "ADMIN_KEY";
const SHEET_NAME = "weather_reports";
const HEADERS = [
  "id", "date", "startSlot", "slot0", "slot1", "slot2", "slot3", "slot4",
  "week1", "week2", "week3", "week4", "week5",
  "memo", "status", "投稿者", "createdAt", "approvedAt"
];
const GIFT_SHEET_NAME = "gift_codes";
const GIFT_HEADERS = [
  "id", "code", "reward", "expiresAt", "sourceUrl", "memo", "status", "createdAt", "updatedAt"
];
const NOTICE_SHEET_NAME = "site_notice";
const NOTICE_HEADERS = ["noticeDate", "noticeText", "updatedAt"];

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action === "pending") {
      return json_({ ok: false, error: "pending はPOSTで取得してください" });
    }
    if (action === "approved") {
      return json_({ ok: true, reports: listByStatus_("approved") });
    }
    if (action === "getGiftCodes") {
      return json_({ ok: true, codes: listGiftCodes_(false) });
    }
    if (action === "getSiteNotice") {
      return json_({ ok: true, notice: getSiteNotice_() });
    }
    return json_({ ok: false, error: "unknown action" });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function doPost(e) {
  try {
    const body = parseBody_(e);
    const action = String(body.action || "");
    if (action === "submit") return submit_(body);
    if (action === "pending") {
      requireKey_(body.adminKey, adminKey_(), "管理キー");
      return json_({ ok: true, reports: listByStatus_("pending") });
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
    return json_({ ok: false, error: "unknown action" });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function submit_(body) {
  requireKey_(body.postKey, postKey_(), "投稿キー");
  if (!body.date) throw new Error("日付がありません");

  const startSlot = normalizeStartSlot_(body.startSlot);
  const slots = normalizeSlots_(body);
  const weeks = normalizeWeeks_(body);
  const date = formatDateValue(body.date);
  if (!date) throw new Error("日付の形式が正しくありません");
  const now = new Date().toISOString();
  const row = [
    Utilities.getUuid(),
    date,
    startSlot,
    encodeSlot_(slots.slot0),
    encodeSlot_(slots.slot1),
    encodeSlot_(slots.slot2),
    encodeSlot_(slots.slot3),
    encodeSlot_(slots.slot4),
    encodeSlot_(weeks.week1),
    encodeSlot_(weeks.week2),
    encodeSlot_(weeks.week3),
    encodeSlot_(weeks.week4),
    encodeSlot_(weeks.week5),
    String(body.memo || ""),
    "pending",
    String(body.author || body["投稿者"] || ""),
    now,
    ""
  ];
  getSheet_().appendRow(row);
  return json_({ ok: true, id: row[0], status: "pending" });
}

function saveApproved_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  if (!body.date) throw new Error("日付がありません");

  const date = formatDateValue(body.date);
  if (!date) throw new Error("日付の形式が正しくありません");

  const startSlot = normalizeStartSlot_(body.startSlot);
  const slots = normalizeSlots_(body);
  const weeks = normalizeWeeks_(body);
  const now = new Date().toISOString();
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
      memo: String(body.memo || ""),
      author: String(body.author || body["投稿者"] || "管理者"),
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
    memo: String(body.memo || ""),
    author: String(body.author || body["投稿者"] || "管理者"),
    createdAt: now,
    approvedAt: now
  });
  sheet.appendRow(row);
  return json_({ ok: true, id: row[0], status: "approved", mode: "created" });
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
    encodeSlot_(item.slots.slot4),
    encodeSlot_(item.weeks.week1),
    encodeSlot_(item.weeks.week2),
    encodeSlot_(item.weeks.week3),
    encodeSlot_(item.weeks.week4),
    encodeSlot_(item.weeks.week5),
    item.memo,
    "approved",
    item.author,
    item.createdAt,
    item.approvedAt
  ];
}

function changeStatus_(body, status) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  if (!body.id) throw new Error("idがありません");

  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const idColumn = HEADERS.indexOf("id");
  const statusColumn = HEADERS.indexOf("status") + 1;
  const approvedAtColumn = HEADERS.indexOf("approvedAt") + 1;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idColumn]) !== String(body.id)) continue;
    sheet.getRange(i + 1, statusColumn).setValue(status);
    sheet.getRange(i + 1, approvedAtColumn).setValue(status === "approved" ? new Date().toISOString() : "");
    return json_({ ok: true, id: body.id, status: status });
  }
  throw new Error("対象の報告が見つかりません");
}

function listByStatus_(status) {
  const values = getSheet_().getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(String);
  return values.slice(1).filter(function(row) {
    return String(row[headers.indexOf("status")]) === status;
  }).map(function(row) {
    const item = {};
    headers.forEach(function(header, index) {
      item[header] = row[index] == null ? "" : row[index];
    });
    item.date = formatDateValue(item.date);
    item.startSlot = normalizeStartSlot_(item.startSlot);
    item.slots = {
      slot0: decodeSlot_(item.slot0),
      slot1: decodeSlot_(item.slot1),
      slot2: decodeSlot_(item.slot2),
      slot3: decodeSlot_(item.slot3),
      slot4: decodeSlot_(item.slot4)
    };
    item.weeks = {
      week1: decodeSlot_(item.week1),
      week2: decodeSlot_(item.week2),
      week3: decodeSlot_(item.week3),
      week4: decodeSlot_(item.week4),
      week5: decodeSlot_(item.week5)
    };
    return item;
  });
}

function saveGiftCode_(body) {
  requireKey_(body.adminKey, adminKey_(), "管理キー");
  const code = String(body.code || "").trim();
  if (!code) throw new Error("コードがありません");

  const sheet = getGiftSheet_();
  const values = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  const idColumn = GIFT_HEADERS.indexOf("id");
  const codeColumn = GIFT_HEADERS.indexOf("code");
  const targetId = String(body.id || "").trim();
  const item = {
    id: targetId || Utilities.getUuid(),
    code: code,
    reward: String(body.reward || "").trim(),
    expiresAt: String(body.expiresAt || "").trim(),
    sourceUrl: String(body.sourceUrl || "").trim(),
    memo: String(body.memo || "").trim(),
    status: normalizeGiftStatus_(body.status),
    createdAt: now,
    updatedAt: now
  };

  for (let i = 1; i < values.length; i++) {
    const rowId = String(values[i][idColumn] || "");
    const rowCode = String(values[i][codeColumn] || "");
    if ((targetId && rowId === targetId) || (!targetId && rowCode === code)) {
      item.id = rowId || item.id;
      item.createdAt = String(values[i][GIFT_HEADERS.indexOf("createdAt")] || now);
      sheet.getRange(i + 1, 1, 1, GIFT_HEADERS.length).setValues([giftRow_(item)]);
      saveAutoGiftNotice_("updated");
      return json_({ ok: true, mode: "updated", code: item });
    }
  }

  sheet.appendRow(giftRow_(item));
  saveAutoGiftNotice_("created");
  return json_({ ok: true, mode: "created", code: item });
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
  const status = String(value || "active").trim();
  return ["active", "expired", "hidden"].indexOf(status) >= 0 ? status : "active";
}

function formatDateTimeValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
  }
  return String(value || "").trim();
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
    noticeDate: formatDateValue(body.noticeDate),
    noticeText: String(body.noticeText || "").trim(),
    updatedAt: now
  };

  const sheet = getNoticeSheet_();
  const row = noticeRow_(item);
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, 1, NOTICE_HEADERS.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return json_({ ok: true, notice: item });
}

function noticeRow_(item) {
  return [item.noticeDate, item.noticeText, item.updatedAt];
}

function noticeItemFromRow_(row) {
  return {
    noticeDate: formatDateValue(row[NOTICE_HEADERS.indexOf("noticeDate")]),
    noticeText: String(row[NOTICE_HEADERS.indexOf("noticeText")] || ""),
    updatedAt: row[NOTICE_HEADERS.indexOf("updatedAt")] instanceof Date
      ? row[NOTICE_HEADERS.indexOf("updatedAt")].toISOString()
      : String(row[NOTICE_HEADERS.indexOf("updatedAt")] || "")
  };
}

function saveAutoGiftNotice_(mode) {
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

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return text;
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
  if (["week1", "week2", "week3", "week4", "week5"].some(function(key) { return source[key] != null; })) {
    return {
      week1: normalizeSlotList_(source.week1),
      week2: normalizeSlotList_(source.week2),
      week3: normalizeSlotList_(source.week3),
      week4: normalizeSlotList_(source.week4),
      week5: normalizeSlotList_(source.week5)
    };
  }
  return {
    week1: normalizeSlotList_(body.week1),
    week2: normalizeSlotList_(body.week2),
    week3: normalizeSlotList_(body.week3),
    week4: normalizeSlotList_(body.week4),
    week5: normalizeSlotList_(body.week5)
  };
}

function normalizeSlotList_(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return parseSlotParameter_(value);
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

function parseBody_(e) {
  const parameters = (e && e.parameter) || {};
  if (parameters.action) {
    const hasNewSlots = ["slot0", "slot1", "slot2", "slot3", "slot4"].some(function(key) {
      return parameters[key] != null;
    });
    const hasOldSlots = ["t18a", "t00", "t06", "t12", "t18b"].some(function(key) {
      return parameters[key] != null;
    });
    const hasWeeks = ["week1", "week2", "week3", "week4", "week5"].some(function(key) {
      return parameters[key] != null;
    });
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
      status: String(parameters.status || ""),
      noticeDate: String(parameters.noticeDate || ""),
      noticeText: String(parameters.noticeText || ""),
      slots: hasNewSlots ? {
        slot0: parseSlotParameter_(parameters.slot0),
        slot1: parseSlotParameter_(parameters.slot1),
        slot2: parseSlotParameter_(parameters.slot2),
        slot3: parseSlotParameter_(parameters.slot3),
        slot4: parseSlotParameter_(parameters.slot4)
      } : {},
      weatherSlots: hasOldSlots ? {
        t18a: parseSlotParameter_(parameters.t18a),
        t00: parseSlotParameter_(parameters.t00),
        t06: parseSlotParameter_(parameters.t06),
        t12: parseSlotParameter_(parameters.t12),
        t18b: parseSlotParameter_(parameters.t18b)
      } : {},
      weeks: hasWeeks ? {
        week1: parseSlotParameter_(parameters.week1),
        week2: parseSlotParameter_(parameters.week2),
        week3: parseSlotParameter_(parameters.week3),
        week4: parseSlotParameter_(parameters.week4),
        week5: parseSlotParameter_(parameters.week5)
      } : {}
    };
  }

  const text = e && e.postData && e.postData.contents;
  if (text) return JSON.parse(text);
  return parameters;
}

function parseSlotParameter_(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [String(parsed)];
  } catch (error) {
    return String(value).split(/[・,、/]/).map(function(item) {
      return item.trim();
    }).filter(Boolean);
  }
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

function requireKey_(actual, expected, label) {
  if (!actual || String(actual) !== String(expected)) {
    throw new Error(label + "が違います");
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

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
