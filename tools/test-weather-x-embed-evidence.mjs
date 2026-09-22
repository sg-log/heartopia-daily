import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WeatherCloudError } from "./weather-cloud-url-evidence.mjs";
import { chooseEmbedEvidence, getOfficialPathwayName, parseXPostUrl, xStatusPublishedAt } from "./weather-x-embed-evidence.mjs";
import { collectXPublicMedia, downloadXPublicMedia, parseXPublicMediaUrl } from "./weather-x-raw-media.mjs";

test("normalizes public X post URLs without depending on account name", () => {
  const first = parseXPostUrl("https://x.com/first_account/status/2098156260520861877/photo/1?s=20#media");
  const second = parseXPostUrl("https://twitter.com/another_account/status/2098156260520861877");
  assert.equal(first.sourceId, "2098156260520861877");
  assert.equal(first.normalizedUrl, second.normalizedUrl);
});

test("rejects non-post, credentialed, and non-X URLs", () => {
  for (const value of [
    "https://x.com/example",
    "https://user:secret@x.com/example/status/123",
    "https://x.com.evil.example/example/status/123",
    "https://example.org/example/status/123"
  ]) assert.throws(() => parseXPostUrl(value), WeatherCloudError);
});

test("classifies only official public embed pathways", () => {
  assert.equal(getOfficialPathwayName("https://publish.twitter.com/oembed?url=x"), "oembed");
  assert.equal(getOfficialPathwayName("https://platform.twitter.com/widgets.js"), "widgetsJs");
  assert.equal(getOfficialPathwayName("https://platform.twitter.com/embed/Tweet.html?id=123"), "embedFrame");
  assert.equal(getOfficialPathwayName("https://cdn.syndication.twimg.com/tweet-result?id=123"), "syndication");
  assert.equal(getOfficialPathwayName("https://pbs.twimg.com/media/example.jpg"), "media");
  assert.equal(getOfficialPathwayName("https://x.com/example/status/123"), "");
});

test("uses a content image when available and the verified embed otherwise", () => {
  const image = {
    index: 2, alt: "weather", width: 500, height: 300,
    naturalWidth: 1000, naturalHeight: 600, visible: true, inViewport: true
  };
  const selected = chooseEmbedEvidence([image]);
  assert.equal(selected.kind, "image-screenshot");
  assert.equal(selected.selected.index, image.index);
  assert.deepEqual(chooseEmbedEvidence([]), { kind: "embed-screenshot", selected: null });
});

test("collects visible DOM or observed network X post media URLs and excludes avatars", () => {
  const media = collectXPublicMedia([
    { index: 0, url: "https://pbs.twimg.com/profile_images/avatar.jpg", alt: "avatar", width: 400, height: 400, naturalWidth: 400, naturalHeight: 400, visible: true, inViewport: true },
    { index: 1, url: "https://pbs.twimg.com/media/example?format=jpg&name=small", alt: "weather", width: 500, height: 300, naturalWidth: 1000, naturalHeight: 600, visible: true, inViewport: true },
    { index: 2, url: "https://example.org/media/unsafe.jpg", alt: "weather", width: 600, height: 400, naturalWidth: 1200, naturalHeight: 800, visible: true, inViewport: true },
    { index: 3, url: "https://pbs.twimg.com/media/compact?format=png&name=small", alt: "compact weather", width: 1, height: 1, naturalWidth: 1, naturalHeight: 1, visible: true, inViewport: true }
  ]);
  assert.equal(media.length, 2);
  assert.equal(media[0].index, 1);
  assert.equal(media[1].index, 3);
});

test("strictly validates original public X media URLs", () => {
  assert.equal(parseXPublicMediaUrl("https://pbs.twimg.com/media/example?format=png&name=large").hostname, "pbs.twimg.com");
  for (const value of [
    "http://pbs.twimg.com/media/example?format=jpg&name=small",
    "https://pbs.twimg.com/profile_images/avatar.jpg",
    "https://pbs.twimg.com/media/example?format=webp&name=small",
    "https://pbs.twimg.com/media/example?format=jpg&name=unknown",
    "https://pbs.twimg.com.evil.example/media/example.jpg"
  ]) assert.throws(() => parseXPublicMediaUrl(value), WeatherCloudError);
});

test("downloads exact raw media bytes and records the Actions capture SHA", async () => {
  const bytes = await readFile(new URL("../assets/weather-templates/sun-day.png", import.meta.url));
  const expectedSha = createHash("sha256").update(bytes).digest("hex");
  const result = await downloadXPublicMedia("https://pbs.twimg.com/media/example?format=png&name=small", {
    hostnameVerifier: async () => {},
    fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.length) } })
  });
  assert.equal(result.sha256, expectedSha);
  assert.deepEqual(result.bytes, bytes);
});

test("fails closed on redirects and content-type mismatches", async () => {
  const options = { hostnameVerifier: async () => {}, fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://pbs.twimg.com/media/other.jpg" } }) };
  await assert.rejects(downloadXPublicMedia("https://pbs.twimg.com/media/example.jpg", options), WeatherCloudError);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await assert.rejects(downloadXPublicMedia("https://pbs.twimg.com/media/example.jpg", {
    hostnameVerifier: async () => {},
    fetchImpl: async () => new Response(jpeg, { status: 200, headers: { "content-type": "image/png" } })
  }), WeatherCloudError);
});


test('derives X publication time from the exact status id', () => {
  assert.equal(xStatusPublishedAt('2102146260182646791'), '2026-09-21T21:21:39.073Z');
});
