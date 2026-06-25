const POST_KEY = "CHANGE_ME_POST_KEY";
const ADMIN_KEY = "CHANGE_ME_ADMIN_KEY";
const SHEET_NAME = "weather_reports";
const HEADERS = [
  "id", "date", "t18a", "t00", "t06", "t12", "t18b",
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

  const slots = body.weatherSlots || {};
  const now = new Date().toISOString();
  const row = [
    Utilities.getUuid(),
    String(body.date),
    encodeSlot_(slots.t18a),
    encodeSlot_(slots.t00),
    encodeSlot_(slots.t06),
    encodeSlot_(slots.t12),
    encodeSlot_(slots.t18b),
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
    if (item.date instanceof Date) {
      item.date = Utilities.formatDate(item.date, Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else {
      item.date = String(item.date || "");
    }
    item.weatherSlots = {
      t18a: decodeSlot_(item.t18a),
      t00: decodeSlot_(item.t00),
      t06: decodeSlot_(item.t06),
      t12: decodeSlot_(item.t12),
      t18b: decodeSlot_(item.t18b)
    };
    return item;
  });
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
  const text = e && e.postData && e.postData.contents;
  if (text) return JSON.parse(text);
  return (e && e.parameter) || {};
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
