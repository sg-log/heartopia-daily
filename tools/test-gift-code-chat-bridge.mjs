import test from "node:test";
import assert from "node:assert/strict";
import { parseRequest, requestBody, runRequest, runEvent } from "./gift-code-chat-bridge.mjs";

const item = { code: "GRATEFUL11", reward: "月の水晶×10", expiresAt: "2026-12-24T12:00",
  sourceUrl: "https://x.com/Heartopia_JP/status/2125786636747444525", sourceType: "official-post" };
const apiUrl = "https://script.google.com/macros/s/test/exec";
const issue = data => ({ title: "Heartopia gift chat " + data.type.toUpperCase() + " " + data.item.code, body: requestBody(data) });
const save = () => ({ v: 1, type: "save", item, readAt: new Date().toISOString(), confirmed: true });
function harness(initial = [], { persist = true, race = false, warning = false } = {}) {
  const state = { rows: initial, writes: [], reads: 0 };
  state.fetchFn = async (url, options = {}) => {
    if (!options.method || options.method === "GET") {
      state.reads++;
      assert.equal(url, apiUrl + "?action=getGiftCodes");
      return Response.json({ ok: true, codes: state.rows });
    }
    assert.equal(url, apiUrl);
    const body = JSON.parse(options.body); state.writes.push(body);
    assert.equal(body.action, "saveGiftCodeFromChat");
    assert.equal(body.confirmed, true);
    if (persist) state.rows = [{ ...body.item, status: "active" }];
    return Response.json({ ok: true, mode: race ? "already_registered" : "created",
      discordNotified: !race && !warning, ...(warning ? { discordWarning: "test warning" } : {}) });
  };
  return state;
}
test("read validates exact official gift fields and performs no writes", async () => {
  const request = parseRequest(issue({ v: 1, type: "read", item }));
  const h = harness();
  const result = await runRequest(request, { apiUrl, fetchFn: h.fetchFn });
  assert.equal(result.status, "missing"); assert.equal(h.writes.length, 0);
  assert.equal(result.item.reward, "月の水晶×10");
});
test("save requires an explicit recent approval and rejects malformed evidence", () => {
  for (const data of [
    { ...save(), confirmed: false },
    { ...save(), readAt: new Date(Date.now() - 31 * 60000).toISOString() },
    { ...save(), item: { ...item, expiresAt: "2026-02-30T12:00" } },
    { ...save(), item: { ...item, sourceUrl: "https://x.com/fake/status/2125786636747444525" } },
    { ...save(), extra: "unexpected" }
  ]) assert.throws(() => parseRequest(issue(data)));
});
test("approved save uses the dedicated add-only API and verifies public data again", async () => {
  const h = harness();
  const result = await runRequest(parseRequest(issue(save())), { apiUrl, fetchFn: h.fetchFn, adminKey: "secret" });
  assert.equal(result.status, "saved"); assert.equal(result.verified, true);
  assert.equal(h.writes.length, 1); assert.equal(h.reads, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  const again = await runRequest(save(), { apiUrl, fetchFn: h.fetchFn, adminKey: "secret" });
  assert.equal(again.status, "already-registered"); assert.equal(h.writes.length, 1);
});
test("registered conflicting data is never overwritten", async () => {
  const h = harness([{ ...item, reward: "別の報酬", status: "active" }]);
  const result = await runRequest(save(), { apiUrl, fetchFn: h.fetchFn, adminKey: "secret" });
  assert.equal(result.ok, false); assert.equal(h.writes.length, 0);
});
test("failed readback cannot report completion; notification failure is separate from save success", async () => {
  const failed = harness([], { persist: false });
  const result = await runRequest(save(), { apiUrl, fetchFn: failed.fetchFn, adminKey: "secret" });
  assert.equal(result.verified, false); assert.equal(result.status, "verify-failed");
  const warning = harness([], { warning: true });
  const success = await runRequest(save(), { apiUrl, fetchFn: warning.fetchFn, adminKey: "secret" });
  assert.equal(success.verified, true); assert.equal(success.notificationWarning, true);
});
test("another issue author cannot trigger a read, save or result comment", async () => {
  const result = await runEvent({ action: "opened", issue: { ...issue(save()), user: { login: "stranger" }, number: 1 } },
    { GITHUB_REPOSITORY_OWNER: "sg-log", GITHUB_REPOSITORY: "sg-log/heartopia-daily" },
    () => { throw Error("must not access network"); });
  assert.equal(result.ignored, true);
});
