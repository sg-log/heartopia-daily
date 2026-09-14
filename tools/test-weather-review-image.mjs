import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const apiSource = await readFile(new URL("../apps-script/weather-api.gs", import.meta.url), "utf8");
const reviewSource = await readFile(new URL("../apps-script/weather-review-image.gs", import.meta.url), "utf8");
const properties = new Map([
  ["POST_KEY", "test-post-key"],
  ["ADMIN_KEY", "test-admin-key"],
  ["WEATHER_EVIDENCE_FOLDER_ID", "mock-private-folder"]
]);
const files = new Map();
let uuidCounter = 0;
const folder = {
  getId: () => "mock-private-folder",
  getSharingAccess: () => "PRIVATE",
  getViewers: () => [],
  getEditors: () => [],
  createFile(blob) {
    const id = `review-file-${++uuidCounter}`;
    const file = {
      trashed: false,
      getId: () => id,
      getSharingAccess: () => "PRIVATE",
      getViewers: () => [],
      getEditors: () => [],
      getBlob: () => blob,
      getSize: () => blob.getBytes().length,
      isTrashed() { return this.trashed; },
      setTrashed(value) { this.trashed = Boolean(value); return this; },
      getParents() {
        let done = false;
        return { hasNext: () => !done, next: () => { done = true; return folder; } };
      }
    };
    files.set(id, file);
    return file;
  }
};

function blobFor(data, mimeType = "", name = "") {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return { getBytes: () => [...bytes], getContentType: () => mimeType, getName: () => name };
}

const context = vm.createContext({
  console,
  Utilities: {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    newBlob: blobFor,
    base64Decode: (value) => [...Buffer.from(value, "base64")],
    base64Encode: (value) => Buffer.from(value.map((item) => item & 255)).toString("base64"),
    base64EncodeWebSafe: (value) => Buffer.from(value.map((item) => item & 255)).toString("base64url"),
    computeDigest: (_algorithm, value) => [...createHash("sha256").update(Buffer.from(value.map((item) => item & 255))).digest()],
    computeHmacSha256Signature: (value, key) => [...createHmac("sha256", Buffer.from(key)).update(Buffer.from(value)).digest()],
    getUuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (name) => properties.get(name) ?? null,
      setProperty: (name, value) => { properties.set(name, value); },
      deleteProperty: (name) => { properties.delete(name); },
      getProperties: () => Object.fromEntries(properties)
    })
  },
  DriveApp: {
    Access: { PRIVATE: "PRIVATE" },
    getFolderById: (id) => { if (id !== folder.getId()) throw new Error("folder missing"); return folder; },
    getFileById: (id) => { if (!files.has(id)) throw new Error("file missing"); return files.get(id); }
  },
  ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/test-deployment/exec" }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: (content) => ({ content, setMimeType() { return this; } })
  },
  HtmlService: {
    createHtmlOutput: (content) => ({ content, title: "", setTitle(value) { this.title = value; return this; } })
  }
});
vm.runInContext(`${apiSource}\n${reviewSource}`, context);

const bytes = Buffer.alloc(70_000);
Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes, 0);
Buffer.from([73,72,68,82]).copy(bytes, 12);
Buffer.from([73,69,78,68,0,0,0,0]).copy(bytes, bytes.length - 8);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const request = {
  action: "weatherReviewImage",
  postKey: "test-post-key",
  artifact: { runId: "34865798800", id: "10357091608", name: "weather-x-embed-evidence-34865798800" },
  image: {
    file: "raw-media-0.png",
    mimeType: "image/png",
    byteSize: bytes.length,
    sha256,
    capturedAt: "2026-09-15T00:00:00.000Z",
    bodyBase64: bytes.toString("base64")
  }
};
context.event = { postData: { contents: JSON.stringify(request) }, parameter: {} };
const response = JSON.parse(vm.runInContext("doPost(event).content", context));
assert.equal(response.ok, true);
assert.equal(response.captureSha256, sha256);
assert.equal(response.reviewStoredSha256, sha256);
assert.match(response.reviewUrl, /^https:\/\/script\.google\.com\/macros\/s\/test-deployment\/exec\?reviewToken=[A-Za-z0-9_-]{43}$/);
assert.doesNotMatch(JSON.stringify(response), /postKey|adminKey|fileId/i);
assert.equal(files.size, 1);
assert.equal([...files.values()][0].getSharingAccess(), "PRIVATE");

const reviewToken = new URL(response.reviewUrl).searchParams.get("reviewToken");
context.reviewEvent = { parameter: { reviewToken } };
const page = vm.runInContext("doGet(reviewEvent)", context);
assert.equal(page.title, "Heartopia weather review");
assert.match(page.content, new RegExp(`data:image/png;base64,${bytes.toString("base64").slice(0, 40)}`));
assert.doesNotMatch(page.content, /postKey|adminKey|fileId|mock-private-folder/i);

context.badGetEvent = { parameter: { reviewToken, fileId: "review-file-1" } };
assert.match(vm.runInContext("doGet(badGetEvent).content", context), /Review image unavailable/);

const tokenProperty = [...properties.keys()].find((name) => name.startsWith("WEATHER_REVIEW_TOKEN_"));
const tokenRecord = JSON.parse(properties.get(tokenProperty));
tokenRecord.expiresAtMs = Date.now() - 1;
properties.set(tokenProperty, JSON.stringify(tokenRecord));
assert.match(vm.runInContext("doGet(reviewEvent).content", context), /Review image unavailable/);
assert.equal(properties.has(tokenProperty), false);
assert.equal([...files.values()][0].isTrashed(), true);

context.badAuthEvent = JSON.parse(JSON.stringify(context.event));
context.badAuthEvent.postData.contents = JSON.stringify({ ...request, postKey: "wrong" });
assert.equal(JSON.parse(vm.runInContext("doPost(badAuthEvent).content", context)).failureCode, "postAuthFailed");

context.badEvent = JSON.parse(JSON.stringify(context.event));
context.badEvent.postData.contents = JSON.stringify({ ...request, image: { ...request.image, sha256: "0".repeat(64) } });
assert.equal(JSON.parse(vm.runInContext("doPost(badEvent).content", context)).failureCode, "sha256Mismatch");

console.log("PASS: authenticated private Drive review image, capture/stored SHA, opaque 15-minute token, HTML data image, expiry cleanup");
