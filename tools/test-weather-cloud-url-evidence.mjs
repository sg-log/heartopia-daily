import assert from "node:assert/strict";
import test from "node:test";

import {
  WeatherCloudError,
  assertPublicHostname,
  detectAccessBarrier,
  isPublicIpAddress,
  rankEvidenceImages,
  validateSourceUrl
} from "./weather-cloud-url-evidence.mjs";

test("accepts source-agnostic public HTTPS URLs", () => {
  assert.equal(validateSourceUrl("https://example.org/weather?id=7#image").href, "https://example.org/weather?id=7");
  assert.equal(validateSourceUrl("https://x.com/account/status/123").hostname, "x.com");
});

test("rejects credentials, non-HTTPS and local destinations", () => {
  for (const value of [
    "http://example.org/weather",
    "https://user:secret@example.org/weather",
    "https://localhost/weather",
    "https://127.0.0.1/weather",
    "https://service.internal/weather"
  ]) {
    assert.throws(() => validateSourceUrl(value), WeatherCloudError);
  }
});

test("classifies public and private IP addresses", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  for (const value of ["127.0.0.1", "10.0.0.1", "169.254.1.2", "192.168.1.2", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isPublicIpAddress(value), false, value);
  }
});

test("DNS guard rejects any private answer", async () => {
  await assert.rejects(
    assertPublicHostname("example.org", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.4" }]),
    /nonPublicHost/
  );
  await assert.doesNotReject(
    assertPublicHostname("example.org", async () => [{ address: "93.184.216.34" }])
  );
});

test("ranks large visible content over avatars and hidden images", () => {
  const ranked = rankEvidenceImages([
    { index: 0, alt: "profile avatar", width: 400, height: 400, naturalWidth: 800, naturalHeight: 800, visible: true, inViewport: true },
    { index: 1, alt: "weather panel", width: 640, height: 360, naturalWidth: 1280, naturalHeight: 720, visible: true, inViewport: true },
    { index: 2, alt: "hidden", width: 900, height: 600, naturalWidth: 900, naturalHeight: 600, visible: false, inViewport: true }
  ]);
  assert.equal(ranked[0].index, 1);
});

test("detects login and CAPTCHA barriers without bypassing them", () => {
  assert.equal(detectAccessBarrier({ finalUrl: "https://example.org/login", title: "Sign in", bodyText: "" }), "loginWall");
  assert.equal(detectAccessBarrier({ finalUrl: "https://example.org/post/1", title: "Check", bodyText: "Verify you are human" }), "challengeWall");
  assert.equal(detectAccessBarrier({ finalUrl: "https://example.org/post/1", title: "Weather", bodyText: "Public post" }), "");
});
