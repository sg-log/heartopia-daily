import assert from "node:assert/strict";
import test from "node:test";

import { WeatherCloudError } from "./weather-cloud-url-evidence.mjs";
import { chooseEmbedEvidence, getOfficialPathwayName, parseXPostUrl } from "./weather-x-embed-evidence.mjs";

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
