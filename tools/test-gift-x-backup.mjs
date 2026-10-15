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

test('uses public Yahoo search when syndication is rate-limited and Bing has no status links', async () => {
  const id='2099234567890123456';
  const result=await discoverOfficialXGiftPosts({handles:['myheartopia'],fetchImpl:async url=>{
    const value=String(url);
    if(value.includes('syndication.twitter.com'))return new Response('',{status:429});
    if(value.includes('bing.com'))return new Response('<html></html>');
    if(value.includes('search.yahoo.co.jp'))return new Response(`<a href="https://x.com/myheartopia/status/${id}">official</a>`);
    if(value.includes('publish.twitter.com/oembed'))return new Response(JSON.stringify({author_url:'https://x.com/myheartopia',html:'<p>Wishing star ×3<br>Gift Code: backup123</p>'}),{headers:{'content-type':'application/json'}});
    throw Error('unexpected request');
  }});
  assert.equal(result.posts.length,1);
  assert.equal(result.posts[0].statusId,id);
  assert.ok(result.diagnostics.some(item=>item.source==='yahoo-web'&&item.ids.includes(id)));
});

test('does not ingest an oEmbed announcement truncated before its deadline', async () => {
  const result=await discoverOfficialXGiftPosts({handles:['myheartopia'],fetchImpl:async url=>{
    if(String(url).includes('timeline-profile'))return new Response('<a href="https://x.com/myheartopia/status/2099234567890123456">post</a>');
    return new Response(JSON.stringify({author_url:'https://x.com/myheartopia',html:'<p>Wishing star ×3<br>Gift Code: partial123<br>Redemption Deadline:…</p>'}),{headers:{'content-type':'application/json'}});
  }});
  assert.equal(result.posts.length,0);
});

test('discovers Japanese official gift announcements when only Japanese search finds them', async () => {
  const id = '2106957555713085600';
  const result = await discoverOfficialXGiftPosts({ handles: ['Heartopia_JP'], fetchImpl: async url => {
    const target = new URL(url);
    if (target.hostname === 'syndication.twitter.com') return new Response('', { status: 429 });
    if (target.hostname === 'www.bing.com') return new Response('<html></html>');
    if (target.hostname === 'search.yahoo.co.jp') {
      return new Response(target.searchParams.get('p').includes('ギフトコード')
        ? `<a href="https://x.com/Heartopia_JP/status/${id}">公式</a>` : '<html></html>');
    }
    if (target.hostname === 'publish.twitter.com') return new Response(JSON.stringify({
      author_url: 'https://x.com/Heartopia_JP',
      html: '<p>願い星 ×3<br>ギフトコード：r2q7a4m9k3n6<br>交換期限：2099年12月4日 0:59</p>'
    }), { headers: { 'content-type': 'application/json' } });
    throw Error('unexpected request');
  }});
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].statusId, id);
  assert.match(result.posts[0].text, /ギフトコード：r2q7a4m9k3n6/);
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
