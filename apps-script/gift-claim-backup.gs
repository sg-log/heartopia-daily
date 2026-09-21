const GIFT_CLAIM_BACKUP_SHEET_NAME = "gift_claim_backups";
const GIFT_CLAIM_BACKUP_HEADERS = ["backupHash", "claimsJson", "createdAt", "updatedAt"];
const GIFT_CLAIM_BACKUP_MAX_CODES = 300;

function normalizeGiftClaimBackupId_(value) {
  const compact = String(value || "")
    .trim()
    .replace(/^HGD-/i, "")
    .replace(/[\s-]/g, "")
    .toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) throw new Error("復元コードが正しくありません");
  return compact;
}

function normalizeGiftClaimCodes_(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  value.slice(0, GIFT_CLAIM_BACKUP_MAX_CODES).forEach(function(item) {
    const code = String(item || "").trim();
    if (!code || code.length > TEXT_LIMITS.code || !/^[A-Za-z0-9_-]+$/.test(code)) return;
    if (result.indexOf(code) < 0) result.push(code);
  });
  return result;
}

function giftClaimBackupHash_(backupId) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    normalizeGiftClaimBackupId_(backupId),
    Utilities.Charset.UTF_8
  );
  return digest.map(function(byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return value.toString(16).padStart(2, "0");
  }).join("");
}

function getGiftClaimBackupSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(GIFT_CLAIM_BACKUP_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(GIFT_CLAIM_BACKUP_SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(GIFT_CLAIM_BACKUP_HEADERS);

  const currentHeaders = sheet.getRange(1, 1, 1, GIFT_CLAIM_BACKUP_HEADERS.length).getValues()[0];
  if (GIFT_CLAIM_BACKUP_HEADERS.some(function(header, index) {
    return String(currentHeaders[index] || "") !== header;
  })) {
    throw new Error("gift_claim_backups 1行目の列名が不正です");
  }
  sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 1), 1).setNumberFormat("@");
  return sheet;
}

function giftClaimBackupRow_(values, rowIndex) {
  const headers = values[0].map(String);
  const row = values[rowIndex] || [];
  const item = {};
  headers.forEach(function(header, index) {
    item[header] = row[index] == null ? "" : row[index];
  });
  let claims = [];
  try {
    const parsed = JSON.parse(String(item.claimsJson || "[]"));
    claims = normalizeGiftClaimCodes_(Array.isArray(parsed) ? parsed : []);
  } catch (_) {}
  return {
    rowNumber: rowIndex + 1,
    backupHash: String(item.backupHash || ""),
    claims: claims,
    createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt || ""),
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : String(item.updatedAt || "")
  };
}

function findGiftClaimBackupRow_(sheet, backupHash) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const hashColumn = values[0].map(String).indexOf("backupHash");
  if (hashColumn < 0) throw new Error("gift_claim_backups の列が不正です");
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][hashColumn] || "") === backupHash) return giftClaimBackupRow_(values, i);
  }
  return null;
}

function saveGiftClaimBackupRow_(sheet, existing, backupHash, claims) {
  const now = new Date().toISOString();
  const item = {
    backupHash: backupHash,
    claimsJson: JSON.stringify(normalizeGiftClaimCodes_(claims)),
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    updatedAt: now
  };
  const row = GIFT_CLAIM_BACKUP_HEADERS.map(function(header) { return item[header]; });
  if (existing) {
    sheet.getRange(existing.rowNumber, 1, 1, GIFT_CLAIM_BACKUP_HEADERS.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return normalizeGiftClaimCodes_(claims);
}

function syncGiftClaims_(body) {
  const backupId = normalizeGiftClaimBackupId_(body.backupId);
  const incoming = normalizeGiftClaimCodes_(body.claims);
  const backupHash = giftClaimBackupHash_(backupId);

  return withScriptLock_(function() {
    const sheet = getGiftClaimBackupSheet_();
    const existing = findGiftClaimBackupRow_(sheet, backupHash);
    const merged = [];
    (existing ? existing.claims : []).concat(incoming).forEach(function(code) {
      if (merged.indexOf(code) < 0 && merged.length < GIFT_CLAIM_BACKUP_MAX_CODES) merged.push(code);
    });
    const claims = saveGiftClaimBackupRow_(sheet, existing, backupHash, merged);
    return json_({ ok: true, claims: claims, backedUp: true });
  });
}

function setGiftClaimState_(body) {
  const backupId = normalizeGiftClaimBackupId_(body.backupId);
  const code = String(body.code || "").trim();
  if (!code || code.length > TEXT_LIMITS.code || !/^[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error("ギフトコードが正しくありません");
  }
  const claimed = body.claimed === true || String(body.claimed || "").toLowerCase() === "true";
  const backupHash = giftClaimBackupHash_(backupId);

  return withScriptLock_(function() {
    const sheet = getGiftClaimBackupSheet_();
    const existing = findGiftClaimBackupRow_(sheet, backupHash);
    const claims = existing ? existing.claims.slice() : [];
    const index = claims.indexOf(code);
    if (claimed && index < 0 && claims.length < GIFT_CLAIM_BACKUP_MAX_CODES) claims.push(code);
    if (!claimed && index >= 0) claims.splice(index, 1);
    const saved = saveGiftClaimBackupRow_(sheet, existing, backupHash, claims);
    return json_({ ok: true, code: code, claimed: claimed, claims: saved, backedUp: true });
  });
}
