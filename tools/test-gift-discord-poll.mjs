import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compactDiscordMessage,
  extractAppsScriptUrl,
  looksLikeGiftAnnouncement,
  runGiftDiscordPoll
} from "./gift-discord-poll.mjs";

const channelId = "123456789012345678";
const guildId = "223456789012345678";

test("extracts the deployed Apps Script URL from site config", () => {
  const html = '<script>const WEATHER_API_URL = "https://script.google.com/macros/s/ABC123/exec";</script>';
  assert.equal(extractAppsScriptUrl(html), "https://script.google.com/macros/s/ABC123/exec");
});

test("gift detector also sees announcements stored in embeds", () => {
  const text = [
    "Rewards: Wishing star ×3, Dye ×2",
    "Gift Code: sample123",
    "Redemption Deadline: 2099/10/01 00:59"
  ].join("\n");
  assert.equal(looksLikeGiftAnnouncement(text), true);
  assert.equal(looksLikeGiftAnnouncement("hello"), false);
});

test("compact message keeps only fields required by Apps Script", () => {
  const compact = compactDiscordMessage({
    id: "323456789012345678",
    webhook_id: "423456789012345678",
    content: "Rewards: Dye ×2\nGift Code: sample123",
    author: { token: "must-not-copy" },
    embeds: [{ title: "Gift", fields: [{ name: "Rewards:", value: "Dye ×2" }] }]
  }, guildId, channelId);

  assert.equal(compact.channel_id, channelId);
  assert.equal(compact.guild_id, guildId);
  assert.equal(compact.author, undefined);
  assert.equal(compact.webhook_id, "423456789012345678");
});

test("test mode verifies Discord without posting to Apps Script", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/channels/" + channelId)) {
      return new Response(JSON.stringify({ id: channelId, guild_id: guildId }), { status: 200 });
    }
    if (String(url).includes("/messages?limit=5")) {
      return new Response(JSON.stringify([{
        id: "523456789012345678",
        channel_id: channelId,
        webhook_id: "623456789012345678",
        content: "Rewards: Dye ×2\nGift Code: sample123"
      }]), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };

  const result = await runGiftDiscordPoll({
    token: "fake-token",
    channelId,
    mode: "test",
    fetchImpl
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.latestMessageId, "523456789012345678");
  assert.equal(calls.length, 2);
});

test("poll mode forwards only gift candidates and the latest message cursor", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartopia-gift-poll-"));
  fs.writeFileSync(
    path.join(tempDir, "index.html"),
    '<script>const WEATHER_API_URL = "https://script.google.com/macros/s/ABC123/exec";</script>',
    "utf8"
  );

  let ingestBody = null;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/channels/" + channelId)) {
      return new Response(JSON.stringify({ id: channelId, guild_id: guildId }), { status: 200 });
    }
    if (target.includes("/messages?limit=100")) {
      return new Response(JSON.stringify([
        {
          id: "823456789012345678",
          channel_id: channelId,
          content: "ordinary message"
        },
        {
          id: "723456789012345678",
          channel_id: channelId,
          webhook_id: "923456789012345678",
          content: "Rewards: Wishing star ×3\nGift Code: sample123"
        }
      ]), { status: 200 });
    }
    if (target === "https://script.google.com/macros/s/ABC123/exec") {
      ingestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok: true, bootstrap: true }), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };

  const result = await runGiftDiscordPoll({
    token: "fake-token",
    channelId,
    postKey: "fake-post-key",
    mode: "poll",
    repoRoot: tempDir,
    fetchImpl
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageCount, 2);
  assert.equal(result.candidateCount, 1);
  assert.equal(ingestBody.action, "ingestDiscordGiftBatch");
  assert.equal(ingestBody.latestMessageId, "823456789012345678");
  assert.equal(ingestBody.messages.length, 1);
  assert.equal(ingestBody.messages[0].id, "723456789012345678");
  assert.equal(ingestBody.postKey, "fake-post-key");
});
