import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  discoverOfficialXGiftPosts,
  extractStatusIdsFromHtml,
  extractTweetTextFromOembedHtml,
  isOfficialXAuthorUrl,
  runGiftXBackup,
  shouldRunXBackup
} from "./gift-x-backup.mjs";

test("extracts official status ids from syndication-style escaped HTML", () => {
  const html = [
    'https:\\/\\/twitter.com\\/myheartopia\\/status\\/2099234567890123456',
    '<a href="/myheartopia/status/2098234567890123456">post</a>'
  ].join("\n");
  assert.deepEqual(
    extractStatusIdsFromHtml(html, "myheartopia"),
    ["2099234567890123456", "2098234567890123456"]
  );
});

test("extracts tweet text from official oEmbed HTML", () => {
  const html = '<blockquote><p lang="en">Freebies are ready!<br>Gift Code: abc12345<br>Wishing star ×3 <a href="https://t.co/a">pic</a></p></blockquote>';
  assert.equal(
    extractTweetTextFromOembedHtml(html),
    "Freebies are ready!\nGift Code: abc12345\nWishing star ×3 "
      .trim()
  );
});

test("accepts only the exact official X author URL", () => {
  assert.equal(isOfficialXAuthorUrl("https://twitter.com/MyHeartopia", "myheartopia"), true);
  assert.equal(isOfficialXAuthorUrl("https://x.com/Heartopia_JP/", "Heartopia_JP"), true);
  assert.equal(isOfficialXAuthorUrl("https://x.com/fakeheartopia", "myheartopia"), false);
});

test("poll interval checks X about once per fifteen minutes while test mode always checks", () => {
  assert.equal(shouldRunXBackup("test", new Date("2026-09-21T04:11:00Z")), true);
  assert.equal(shouldRunXBackup("poll", new Date("2026-09-21T04:02:00Z")), true);
  assert.equal(shouldRunXBackup("poll", new Date("2026-09-21T04:07:00Z")), false);
});

test("discovers a gift post through syndication then verifies it with official oEmbed", async () => {
  const statusId = "2099234567890123456";
  const fetchImpl = async url => {
    const target = String(url);
    if (target.includes("timeline-profile/screen-name/myheartopia")) {
      return new Response(
        '<a href="https://twitter.com/myheartopia/status/' + statusId + '">latest</a>',
        { status: 200, headers: { "content-type": "text/html" } }
      );
    }
    if (target.includes("publish.twitter.com/oembed")) {
      return new Response(JSON.stringify({
        author_url: "https://twitter.com/MyHeartopia",
        html: '<blockquote><p lang="en">Freebies are ready:<br>Wishing star ×3<br>Dye ×2<br>Gift Code: xgift123<br>Redemption Deadline: 2099/10/01 00:59</p></blockquote>'
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected fetch " + target);
  };

  const result = await discoverOfficialXGiftPosts({
    fetchImpl,
    handles: ["myheartopia"],
    maxPostsPerHandle: 3
  });

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].statusId, statusId);
  assert.equal(result.posts[0].sourceUrl, "https://x.com/myheartopia/status/" + statusId);
  assert.match(result.posts[0].text, /Gift Code: xgift123/);
});

test("poll mode forwards verified official X candidates to Apps Script", async () => {
  const statusId = "2099234567890123456";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartopia-gift-x-"));
  fs.writeFileSync(
    path.join(tempDir, "index.html"),
    '<script>const WEATHER_API_URL = "https://script.google.com/macros/s/ABC123/exec";</script>',
    "utf8"
  );

  let ingest = null;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("timeline-profile/screen-name/myheartopia")) {
      return new Response(
        '<a href="https://x.com/myheartopia/status/' + statusId + '">latest</a>',
        { status: 200 }
      );
    }
    if (target.includes("publish.twitter.com/oembed")) {
      return new Response(JSON.stringify({
        author_url: "https://x.com/myheartopia",
        html: '<blockquote><p>Rewards: Dye ×2<br>Gift Code: xgift456<br>Redemption Deadline: 2099/10/01 00:59</p></blockquote>'
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target === "https://script.google.com/macros/s/ABC123/exec") {
      ingest = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok: true, counts: { created: 1 } }), { status: 200 });
    }
    throw new Error("unexpected fetch " + target);
  };

  const result = await runGiftXBackup({
    fetchImpl,
    postKey: "fake-post-key",
    mode: "poll",
    force: true,
    handles: ["myheartopia"],
    repoRoot: tempDir
  });

  assert.equal(result.ok, true);
  assert.equal(ingest.action, "ingestOfficialXGiftBatch");
  assert.equal(ingest.posts.length, 1);
  assert.equal(ingest.posts[0].statusId, statusId);
});
