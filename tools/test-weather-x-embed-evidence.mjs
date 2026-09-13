import assert from "node:assert/strict";
import test from "node:test";

import { WeatherCloudError } from "./weather-cloud-url-evidence.mjs";
import { getOfficialPathwayName, parseXPostUrl } from "./weather-x-embed-evidence.mjs";

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
