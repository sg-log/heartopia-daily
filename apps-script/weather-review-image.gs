const WEATHER_REVIEW_TOKEN_PREFIX = "WEATHER_REVIEW_TOKEN_";
const WEATHER_REVIEW_TTL_MS = 15 * 60 * 1000;

function createWeatherReviewImage_(body) {
  try { requireKey_(body.postKey, postKey_(), "投稿キー"); }
  catch (_) { throw weatherSubmitFailure_("postAuthFailed", "postAuth"); }
  const bodyKeys = ["action", "postKey", "artifact", "image"];
  if (!body || Object.keys(body).sort().join("\n") !== bodyKeys.sort().join("\n") ||
      body.action !== "weatherReviewImage" || !body.artifact || !body.image) {
    throw weatherSubmitFailure_("invalidEvidencePayload", "payloadValidation");
  }
  const artifact = body.artifact;
  if (Object.keys(artifact).sort().join("\n") !== ["id", "name", "runId"].sort().join("\n") ||
      typeof artifact.runId !== "string" || !/^[1-9][0-9]{0,19}$/.test(artifact.runId) ||
      typeof artifact.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(artifact.id) ||
      typeof artifact.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifact.name)) {
    throw weatherSubmitFailure_("invalidEvidencePayload", "payloadValidation");
  }
  const image = body.image;
  const imageKeys = ["bodyBase64", "byteSize", "capturedAt", "file", "mimeType", "sha256"];
  if (Object.keys(image).sort().join("\n") !== imageKeys.sort().join("\n") ||
      typeof image.file !== "string" || !/^raw-media-[0-3]\.(?:jpg|png)$/.test(image.file) ||
      (image.mimeType === "image/jpeg" ? !/\.jpg$/.test(image.file) :
        image.mimeType === "image/png" ? !/\.png$/.test(image.file) : true)) {
    throw weatherSubmitFailure_("invalidEvidencePayload", "payloadValidation");
  }
  const evidence = validateWeatherEvidence_([{
    mimeType: image.mimeType,
    byteSize: image.byteSize,
    sha256: image.sha256,
    kind: "original",
    capturedAt: image.capturedAt,
    bodyBase64: image.bodyBase64
  }]);
  if (!evidence || evidence.meta.sha256 !== image.sha256) {
    throw weatherSubmitFailure_("sha256Mismatch", "sha256Validation");
  }

  return withScriptLock_(function() {
    const folder = weatherEvidenceFolder_();
    cleanupExpiredWeatherReviewImages_(folder, Date.now());
    let file = null;
    let tokenProperty = "";
    try {
      const extension = evidence.meta.mimeType === "image/png" ? ".png" : ".jpg";
      file = folder.createFile(Utilities.newBlob(
        evidence.bytes,
        evidence.meta.mimeType,
        "weather-review-" + Utilities.getUuid() + extension
      ));
      requirePrivateEvidence_(file);
      if (!weatherReviewFileBelongsToFolder_(file, folder)) throw new Error("Review image folder mismatch");

      const storedBlob = file.getBlob();
      const storedBytes = storedBlob.getBytes();
      const storedSha256 = evidenceHash_(storedBytes);
      validateWeatherEvidence_([{
        mimeType: evidence.meta.mimeType,
        byteSize: storedBytes.length,
        sha256: storedSha256,
        kind: "original",
        capturedAt: evidence.meta.capturedAt,
        bodyBase64: Utilities.base64Encode(storedBytes)
      }]);
      if (storedBytes.length !== evidence.meta.byteSize || storedSha256 !== evidence.meta.sha256) {
        throw weatherSubmitFailure_("sha256Mismatch", "sha256Validation");
      }

      const token = newWeatherReviewToken_();
      const expiresAtMs = Date.now() + WEATHER_REVIEW_TTL_MS;
      const tokenRecord = {
        fileId: file.getId(),
        mimeType: evidence.meta.mimeType,
        byteSize: evidence.meta.byteSize,
        sha256: evidence.meta.sha256,
        expiresAtMs: expiresAtMs
      };
      tokenProperty = weatherReviewTokenProperty_(token);
      PropertiesService.getScriptProperties().setProperty(tokenProperty, JSON.stringify(tokenRecord));
      const serviceUrl = ScriptApp.getService().getUrl();
      if (typeof serviceUrl !== "string" || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(?:exec|dev)$/.test(serviceUrl)) {
        throw new Error("Review web app is not deployed");
      }
      return json_({
        ok: true,
        artifact: { runId: artifact.runId, id: artifact.id, name: artifact.name },
        mediaFile: image.file,
        mimeType: evidence.meta.mimeType,
        byteSize: evidence.meta.byteSize,
        captureSha256: evidence.meta.sha256,
        reviewStoredSha256: storedSha256,
        reviewUrl: serviceUrl + "?reviewToken=" + encodeURIComponent(token),
        expiresAt: new Date(expiresAtMs).toISOString()
      });
    } catch (error) {
      if (tokenProperty) {
        try { PropertiesService.getScriptProperties().deleteProperty(tokenProperty); } catch (_) {}
      }
      if (file) {
        try { file.setTrashed(true); } catch (_) {}
      }
      if (weatherSubmitFailureCode_(error)) throw error;
      throw weatherSubmitFailure_("driveSaveError", "driveSave");
    }
  });
}

function weatherReviewImageOutput_(e) {
  try {
    const parameters = (e && e.parameter) || {};
    if (Object.keys(parameters).length !== 1 || !Object.prototype.hasOwnProperty.call(parameters, "reviewToken")) {
      return unavailableWeatherReviewImage_();
    }
    const token = String(parameters.reviewToken || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return unavailableWeatherReviewImage_();
    const properties = PropertiesService.getScriptProperties();
    const propertyName = weatherReviewTokenProperty_(token);
    const value = properties.getProperty(propertyName);
    if (!value) return unavailableWeatherReviewImage_();
    let record;
    try { record = JSON.parse(value); } catch (_) { return unavailableWeatherReviewImage_(); }
    if (!validWeatherReviewTokenRecord_(record)) return unavailableWeatherReviewImage_();
    const now = Date.now();
    if (record.expiresAtMs <= now) {
      withScriptLock_(function() { cleanupExpiredWeatherReviewImages_(weatherEvidenceFolder_(), now); });
      return unavailableWeatherReviewImage_();
    }

    const folder = weatherEvidenceFolder_();
    const file = DriveApp.getFileById(record.fileId);
    requirePrivateEvidence_(file);
    if (file.isTrashed() || !weatherReviewFileBelongsToFolder_(file, folder)) return unavailableWeatherReviewImage_();
    const bytes = file.getBlob().getBytes();
    const actualSha256 = evidenceHash_(bytes);
    if (bytes.length !== record.byteSize || actualSha256 !== record.sha256) {
      properties.deleteProperty(propertyName);
      try { file.setTrashed(true); } catch (_) {}
      return unavailableWeatherReviewImage_();
    }
    validateWeatherEvidence_([{
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      sha256: record.sha256,
      kind: "original",
      capturedAt: new Date(now).toISOString(),
      bodyBase64: Utilities.base64Encode(bytes)
    }]);
    const remainingMs = Math.max(1, record.expiresAtMs - now);
    const dataUrl = "data:" + record.mimeType + ";base64," + Utilities.base64Encode(bytes);
    const html = "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<meta http-equiv=\"Cache-Control\" content=\"no-store,no-cache,must-revalidate\">" +
      "<title>Heartopia weather review</title><style>html,body{margin:0;background:#111;color:#fff;height:100%;}" +
      "main{min-height:100%;display:grid;place-items:center}img{display:block;max-width:100%;max-height:100vh;object-fit:contain}</style></head>" +
      "<body><main><img alt=\"Heartopia weather review image\" referrerpolicy=\"no-referrer\" src=\"" + dataUrl + "\"></main>" +
      "<script>setTimeout(function(){document.body.innerHTML='<main>Review image unavailable.</main>'}," + remainingMs + ")</script>" +
      "</body></html>";
    return HtmlService.createHtmlOutput(html).setTitle("Heartopia weather review");
  } catch (_) {
    return unavailableWeatherReviewImage_();
  }
}

function newWeatherReviewToken_() {
  const seed = Utilities.getUuid() + ":" + Date.now() + ":" + Utilities.getUuid();
  const signature = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(seed).getBytes(),
    Utilities.newBlob(postKey_()).getBytes()
  );
  return Utilities.base64EncodeWebSafe(signature).replace(/=+$/, "");
}

function weatherReviewTokenProperty_(token) {
  return WEATHER_REVIEW_TOKEN_PREFIX + evidenceHash_(Utilities.newBlob(token).getBytes());
}

function validWeatherReviewTokenRecord_(record) {
  return record && Object.keys(record).sort().join("\n") ===
      ["byteSize", "expiresAtMs", "fileId", "mimeType", "sha256"].sort().join("\n") &&
    typeof record.fileId === "string" && /^[A-Za-z0-9_-]{10,}$/.test(record.fileId) &&
    ["image/png", "image/jpeg"].indexOf(record.mimeType) >= 0 &&
    Number.isInteger(record.byteSize) && record.byteSize > 0 && record.byteSize <= 524288 &&
    typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256) &&
    Number.isFinite(record.expiresAtMs);
}

function cleanupExpiredWeatherReviewImages_(folder, now) {
  const properties = PropertiesService.getScriptProperties();
  const all = properties.getProperties();
  Object.keys(all).filter(function(name) { return name.indexOf(WEATHER_REVIEW_TOKEN_PREFIX) === 0; }).forEach(function(name) {
    let record = null;
    try { record = JSON.parse(all[name]); } catch (_) {}
    if (record && validWeatherReviewTokenRecord_(record) && record.expiresAtMs > now) return;
    properties.deleteProperty(name);
    if (!record || typeof record.fileId !== "string") return;
    try {
      const file = DriveApp.getFileById(record.fileId);
      if (!file.isTrashed() && weatherReviewFileBelongsToFolder_(file, folder)) file.setTrashed(true);
    } catch (_) {}
  });
}

function weatherReviewFileBelongsToFolder_(file, folder) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) return true;
  }
  return false;
}

function unavailableWeatherReviewImage_() {
  return HtmlService.createHtmlOutput(
    "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<meta http-equiv=\"Cache-Control\" content=\"no-store,no-cache,must-revalidate\"><title>Review image unavailable</title></head>" +
    "<body><main><p>Review image unavailable.</p></main></body></html>"
  ).setTitle("Review image unavailable");
}
