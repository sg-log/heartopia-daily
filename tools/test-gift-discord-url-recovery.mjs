import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { officialGiftUrls, recoveryMessages, runGiftUrlRecovery } from "./gift-discord-url-recovery.mjs";

const owner = "800000000000000001", channel = "800000000000000002", guild = "800000000000000003";
const messageId = "800000000000000004";
const ids = ["2124714562960163281", "2125786636747444525"];
const urls = ids.map(id => "https://x.com/Heartopia_JP/status/" + id);
const texts = JSON.parse(fs.readFileSync(new URL("../actual-post-fixtures.json", import.meta.url), "utf8"));
const expected = [
  { code: "a5n7k2q8r4m1", reward: "願い星×3\nマーメイドの魚寄せ装置×3\n肥料×10", expiresAt: "2026-12-04T00:59" },
  { code: "GRATEFUL11", reward: "月の水晶×10", expiresAt: "2026-12-24T12:00" }
];
const apiUrl = "https://script.google.com/macros/s/test/exec";
const webhook = "https://discord.com/api/webhooks/800000000000000005/test-token";
const feedbackChannel = "800000000000000006";
function message(overrides = {}) {
  return { id: messageId, author: { id: owner, bot: false }, content: urls[1] + "?a=test&s=20", ...overrides };
}
function harness(options = {}) {
  const h = { state: { initialized: true, cursor: "", attempts: 0, ...options.state },
    messages: options.messages || [message()], codes: options.codes || [], ingests: [], notices: [],
    stateWrites: [], officialReads: 0, guildOwner: owner };
  h.fetchImpl = async (input, init = {}) => {
    const url = String(input), target = new URL(url);
    if (url.startsWith("https://discord.com/api/v10/")) {
      assert.equal(init.headers.Authorization, "Bot test-token");
      assert.notEqual(init.method,"POST");
      if (target.pathname === "/api/v10/channels/" + channel) return Response.json({ guild_id: guild });
      if (target.pathname === "/api/v10/guilds/" + guild) return Response.json({ owner_id: h.guildOwner });
      if (target.pathname.endsWith("/messages")) return Response.json(h.messages);
    }
    if(url===webhook){
      assert.equal(init.headers?.Authorization,undefined);
      if(init.method==="POST"){
        assert.equal(options.foreignWebhook,undefined,"must never send to a different server");
        h.notices.push(JSON.parse(init.body));
        return new Response(null,{status:options.notifyFails?403:204});
      }
      return Response.json({guild_id:options.foreignWebhook?"900000000000000001":guild,
        channel_id:feedbackChannel,token:"must-not-be-logged"});
    }
    if (target.hostname === "publish.twitter.com") {
      assert.equal(init.headers?.Authorization, undefined);
      h.officialReads++;
      if (options.blocked) return new Response("", { status: 403 });
      const id = new URL(target.searchParams.get("url")).pathname.split("/").at(-1);
      const index = ids.indexOf(id);
      return Response.json({ author_url: options.wrongAuthor ? "https://x.com/fake" : "https://x.com/Heartopia_JP",
        html: "<p>" + (options.truncated ? "Gift Code: GRATEFUL11\nRewards: Dye ×2…" : texts[index]).replaceAll("\n", "<br>") + "</p>" });
    }
    if (url === apiUrl + "?action=getGiftCodes")
      return Response.json({ ok: true, codes: options.verifyFails ? [] : h.codes });
    if (url === apiUrl) {
      const body = JSON.parse(init.body);
      assert.equal(body.postKey, "post-key");
      if (body.action === "giftUrlRecoveryState") {
        assert.equal(body.channelId, channel);
        if (options.oldGas) return Response.json({ ok: false, error: "unknown action" });
        if (body.phase === "read") return Response.json({ ok: true, ...h.state });
        h.stateWrites.push(body);
        if (body.phase === "initialize") h.state = { initialized: true, cursor: body.messageId };
        else if (body.status === "retry") h.state = { ...h.state, failedMessageId: body.messageId,
          attempts: (h.state.failedMessageId === body.messageId ? h.state.attempts : 0) + 1, notified: body.notified };
        else h.state = { initialized: true, cursor: body.messageId, attempts: 0 };
        return Response.json({ ok: true });
      }
      assert.equal(body.action, "ingestOfficialXGiftBatch");
      h.ingests.push(body);
      if (options.conflict) return Response.json({ ok: true, counts: { conflict: 1 } });
      let created = 0;
      for (const post of body.posts) {
        const index = ids.indexOf(post.statusId), code = expected[index];
        assert.equal(post.sourceUrl, urls[index]);
        if (!h.codes.some(row => row.code === code.code)) { h.codes.push({ ...code }); created++; }
      }
      return Response.json({ ok: true, counts: { created, duplicate: body.posts.length - created } });
    }
    throw Error("Unexpected request");
  };
  h.run = extra => runGiftUrlRecovery({ token: "test-token", channelId: channel, postKey: "post-key",
    apiUrl, feedbackMode: "personal", reviewWebhookUrl:webhook, fetchImpl: h.fetchImpl, ...extra });
  return h;
}
test("official link extraction strips tracking, normalizes Twitter, deduplicates and rejects foreign origins", () => {
  assert.deepEqual(officialGiftUrls(urls[1] + "?a=1&s=20\n<" + urls[1] + ">\nhttps://twitter.com/myheartopia/status/" + ids[0]),
    [urls[1], "https://x.com/myheartopia/status/" + ids[0]]);
  for (const url of [
    "https://x.com.fake/Heartopia_JP/status/" + ids[1], "https://x.com/fake/status/" + ids[1],
    "https://x.com@evil.test/Heartopia_JP/status/" + ids[1], "https://x.com/Heartopia_JP/status/" + ids[1] + "/photo/1",
    "http://x.com/Heartopia_JP/status/" + ids[1], "https://x.com:1234/Heartopia_JP/status/" + ids[1]
  ]) assert.deepEqual(officialGiftUrls(url), []);
});
test("only direct allowed-user messages are accepted, in snowflake order and past the independent cursor", () => {
  const rows = [message(), message({ id: "800000000000000005", author: { id: "900000000000000000" } }),
    message({ webhook_id: "800000000000000006" }), message({ author: { id: owner, bot: true } }),
    message({ message_snapshots: [{}] })];
  assert.equal(recoveryMessages(rows, [owner]).length, 1);
  assert.equal(recoveryMessages(rows, [owner], messageId).length, 0);
});
test("owner-posted URL reaches the existing importer, verifies public data and is not processed twice", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, "done"); assert.equal(result.recovered, 1);
  assert.equal(h.ingests[0].posts[0].statusId, ids[1]); assert.equal(h.state.cursor, messageId);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].message_reference, undefined);
  assert.equal((await h.run()).status, "no-new-urls"); assert.equal(h.ingests.length, 1);
});
test("initial activation records its start without replaying old pasted links", async () => {
  const h = harness({ state: { initialized: false } });
  assert.equal((await h.run()).status, "initialized");
  assert.equal(h.state.cursor, messageId); assert.equal(h.officialReads, 0); assert.equal(h.ingests.length, 0);
});
test("first activation of an empty channel still allows its first later pasted link", async () => {
  const h = harness({ state: { initialized: false }, messages: [] });
  await h.run();
  h.messages.push(message());
  assert.equal((await h.run()).status, "done");
});
test("test mode has no state writes, gift writes, official fetches or notifications", async () => {
  const h = harness();
  const result = await h.run({ mode: "test" });
  assert.equal(result.candidateMessages, 1);
  assert.equal(h.stateWrites.length + h.ingests.length + h.notices.length + h.officialReads, 0);
});
test("existing codes and two official links in one message are idempotent", async () => {
  const h = harness({ messages: [message({ content: urls.join("\n") })], codes: [{ ...expected[0] }] });
  const result = await h.run();
  assert.equal(result.status, "done"); assert.equal(result.recovered, 1); assert.equal(h.codes.length, 2);
});
test("foreign authors or webhook messages cannot initiate imports", async () => {
  for (const msg of [message({ author: { id: "900000000000000000" } }), message({ webhook_id: owner })]) {
    const h = harness({ messages: [msg] });
    assert.equal((await h.run()).status, "no-new-urls"); assert.equal(h.officialReads + h.ingests.length, 0);
  }
});
test("blocked X posts retry at most three times and notify only once before advancing", async () => {
  const h = harness({ blocked: true });
  assert.equal((await h.run()).status, "retry");
  assert.equal((await h.run()).status, "retry");
  assert.equal((await h.run()).status, "review");
  assert.equal(h.officialReads, 3); assert.equal(h.notices.length, 1); assert.equal(h.ingests.length, 0);
  assert.deepEqual(h.notices[0].allowed_mentions, { parse: [] });
  assert.equal((await h.run()).status, "no-new-urls");
});
test("wrong author, partial body, conflicting data or failed public readback cannot report done", async () => {
  for (const option of [{ wrongAuthor: true }, { truncated: true }, { conflict: true }, { verifyFails: true }]) {
    const h = harness(option);
    assert.equal((await h.run()).status, "retry");
    assert.equal(h.state.cursor, ""); assert.equal(h.notices.length, 1);
  }
});
test("state API must be deployed before recovery can write any gifts", async () => {
  const h = harness({ oldGas: true });
  await assert.rejects(h.run());
  assert.equal(h.ingests.length + h.officialReads + h.notices.length, 0);
});
test("a failed personal notification is retried and not marked delivered", async () => {
  const h = harness({ blocked: true, notifyFails: true });
  await h.run();
  assert.equal(h.state.notified, false);
  await h.run(); assert.equal(h.notices.length, 2);
});

test("feedback can be disabled without posting any result or failure messages", async () => {
  for (const option of [{}, {blocked:true}]) {
    const h=harness(option);
    const result=await h.run({feedbackMode:"none"});
    assert.equal(result.feedbackSkipped,true);assert.equal(h.notices.length,0);
  }
});

test("failure of the personal webhook cannot turn a verified import into a failure", async () => {
  const h=harness({notifyFails:true});
  const result=await h.run();
  assert.equal(result.status,"done");assert.equal(result.feedbackWarning,true);
  assert.equal(h.state.cursor,messageId);
});

test("a webhook belonging to another server is never used for success or failure notifications", async () => {
  for(const options of [{foreignWebhook:true},{foreignWebhook:true,blocked:true}]){
    const h=harness(options);
    const result=await h.run();
    assert.equal(result.feedbackWarning,true);assert.equal(h.notices.length,0);
    assert.equal(JSON.stringify(result).includes("test-token"),false);
  }
});

test("read-only test identifies the verified personal notification channel without sending messages", async () => {
  const h=harness();
  const result=await h.run({mode:"test"});
  assert.equal(result.feedbackChannelId,feedbackChannel);assert.equal(result.feedbackReady,true);
  assert.equal(h.notices.length+h.ingests.length+h.stateWrites.length,0);
  assert.equal(JSON.stringify(result).includes("must-not-be-logged"),false);
});
