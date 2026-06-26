const POST_KEY = "kuma82";
const ADMIN_KEY = "Kuma29";
const SHEET_NAME = "weather_reports";
const HEADERS = [
  "id", "date", "startSlot", "slot0", "slot1", "slot2", "slot3", "slot4",
  "week1", "week2", "week3", "week4", "week5",
  "memo", "status", "投稿者", "createdAt", "approvedAt"
];

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action === "pending") {
      requireKey_((e.parameter || {}).adminKey, ADMIN_KEY, "管理キー");
      return json_({ ok: true, reports: listByStatus_("pending") });
    }
    if (action === "approved") {
      return json_({ ok: true, reports: listByStatus_("approved") });
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
    if (action === "approve") return changeStatus_(body, "approved");
    if (action === "reject") return changeStatus_(body, "rejected");
    return json_({ ok: false, error: "unknown action" });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function submit_(body) {
  requireKey_(body.postKey, POST_KEY, "投稿キー");
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

function changeStatus_(body, status) {
  requireKey_(body.adminKey, ADMIN_KEY, "管理キー");
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
  const text = String(value || "18").replace("時", "").trim();
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

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
