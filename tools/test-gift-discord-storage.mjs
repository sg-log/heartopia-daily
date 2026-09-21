import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = [
  "../apps-script/gift-code-config.gs",
  "../apps-script/gift-code-parser.gs",
  "../apps-script/gift-code-storage.gs"
].map(path => fs.readFileSync(new URL(path, import.meta.url), "utf8")).join("\n\n");

function makeHarness(initialRows = []) {
  const properties = new Map();
  const headers = ["id", "code", "reward", "expiresAt", "sourceUrl", "memo", "status", "createdAt", "updatedAt"];
  const rows = [headers.slice(), ...initialRows.map(row => row.slice())];
  const events = { notices: [], notifications: [], reviewFetches: [] };

  const scriptProperties = {
    getProperty(key) { return properties.has(key) ? properties.get(key) : null; },
    setProperty(key, value) { properties.set(key, String(value)); },
    deleteProperty(key) { properties.delete(key); }
  };

  const sheet = {
    getDataRange() {
      return { getValues: () => rows.map(row => row.slice()) };
    },
    appendRow(row) {
      rows.push(row.slice());
    },
    getRange(rowIndex, columnIndex, _rowCount, _columnCount) {
      return {
        setValues(values) {
          rows[rowIndex - 1] = values[0].slice();
        },
        setValue(value) {
          rows[rowIndex - 1][columnIndex - 1] = value;
        }
      };
    }
  };

  const context = {
    console,
    GIFT_HEADERS: headers,
    TEXT_LIMITS: {
      code: 100,
      reward: 1000,
      expiresAt: 40,
      sourceUrl: 1000,
      memo: 1000
    },
    DISCORD_WEBHOOK_URL_PROPERTY: "DISCORD_WEBHOOK_URL",
    PropertiesService: { getScriptProperties: () => scriptProperties },
    Logger: { log() {} },
    Utilities: {
      getUuid: () => "uuid-" + (rows.length + 1),
      formatDate(date, _tz, pattern) {
        if (pattern === "yyyy-MM-dd'T'HH:mm") {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
          }).formatToParts(date).reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
          }, {});
          return parts.year + "-" + parts.month + "-" + parts.day + "T" + parts.hour + ":" + parts.minute;
        }
        return "";
      }
    },
    UrlFetchApp: {
      fetch(_url, options) {
        events.reviewFetches.push(options);
        return { getResponseCode: () => 204 };
      }
    },
    validateGiftCodeForWrite_: value => String(value || "").trim(),
    safeSheetText_: value => String(value || ""),
    limitText_: value => String(value || ""),
    validateGiftExpiresForWrite_: value => String(value || "").trim(),
    validateHttpUrl_: value => String(value || "").trim(),
    normalizeGiftStatus_: value => ["active", "expired", "hidden"].includes(String(value || "").toLowerCase())
      ? String(value).toLowerCase()
      : "active",
    formatDateTimeValue_: value => String(value || "").slice(0, 16),
    plainSheetText_: value => String(value || ""),
    withScriptLock_: callback => callback(),
    getGiftSheet_: () => sheet,
    giftRow_(item) {
      return headers.map(key => item[key] == null ? "" : item[key]);
    },
    saveAutoGiftNotice_(mode) {
      events.notices.push(mode);
    },
    notifyDiscordGiftCode_(item) {
      events.notifications.push(item.code);
      return { notified: true };
    },
    sanitizeDiscordText_: value => String(value || ""),
    sanitizeDiscordUrl_: value => String(value || ""),
    pad2_: value => String(value).padStart(2, "0")
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, properties, rows, events };
}

function candidate(overrides = {}) {
  return {
    code: "r8a4k6p5q3m1",
    reward: "願い星×3\n染色剤×2\n無垢な蛍石×1",
    rawReward: "Wishing star×3\nDye×2\nFlawless Fluorite×1",
    expiresAt: "2099-10-01T00:59",
    sourceUrl: "https://discord.com/channels/1/2/3",
    memo: "",
    status: "active",
    ...overrides
  };
}

test("creates a new active gift code and emits normal site/Discord notifications", () => {
  const h = makeHarness();
  const result = h.context.saveAutomatedGiftCode_(candidate(), { silent: false });

  assert.equal(result.mode, "created");
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[1][1], "r8a4k6p5q3m1");
  assert.equal(h.rows[1][2], "願い星×3\n染色剤×2\n無垢な蛍石×1");
  assert.deepEqual(h.events.notices, ["created"]);
  assert.deepEqual(h.events.notifications, ["r8a4k6p5q3m1"]);
});

test("same code and data is idempotent and does not notify twice", () => {
  const h = makeHarness();
  h.context.saveAutomatedGiftCode_(candidate(), { silent: false });
  h.events.notices.length = 0;
  h.events.notifications.length = 0;

  const result = h.context.saveAutomatedGiftCode_(candidate(), { silent: false });

  assert.equal(result.mode, "duplicate");
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.events.notices, []);
  assert.deepEqual(h.events.notifications, []);
});

test("manual hidden state is preserved during automated refresh", () => {
  const h = makeHarness([[
    "id-1",
    "r8a4k6p5q3m1",
    "願い星×3\n染色剤×2\n無垢な蛍石×1",
    "2099-10-01T00:59",
    "https://discord.com/channels/1/2/3",
    "手動メモ",
    "hidden",
    "2026-09-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z"
  ]]);

  const result = h.context.saveAutomatedGiftCode_(candidate(), { silent: false });

  assert.equal(result.item.status, "hidden");
  assert.equal(h.rows[1][6], "hidden");
});

test("conflicting manual reward is fail-closed and not overwritten", () => {
  const h = makeHarness([[
    "id-1",
    "r8a4k6p5q3m1",
    "手動で確認した別報酬×1",
    "2099-10-01T00:59",
    "https://example.com/manual",
    "手動確認",
    "active",
    "2026-09-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z"
  ]]);

  const result = h.context.saveAutomatedGiftCode_(candidate(), { silent: false });

  assert.equal(result.mode, "conflict");
  assert.equal(h.rows[1][2], "手動で確認した別報酬×1");
  assert.equal(h.rows[1][4], "https://example.com/manual");
  assert.deepEqual(h.events.notices, []);
});

test("bootstrap processing is silent while still importing a valid forwarded message", () => {
  const h = makeHarness();
  const message = {
    id: "100",
    channel_id: "2",
    guild_id: "1",
    webhook_id: "323456789012345678",
    content: [
      "🎁Rewards: Wishing star ×3, Dye ×2, Flawless Fluorite ×1",
      "🔑Gift Code: r8a4k6p5q3m1",
      "⏰Redemption Deadline: 2099年10月1日 0:59"
    ].join("\n"),
    embeds: []
  };

  const result = h.context.processDiscordGiftMessage_(
    message,
    { channelId: "2", guildId: "1", sourceWebhookId: "" },
    { silent: true }
  );

  assert.equal(result.mode, "created");
  assert.equal(h.rows.length, 2);
  assert.equal(h.properties.get("DISCORD_GIFT_SOURCE_WEBHOOK_ID"), "323456789012345678");
  assert.deepEqual(h.events.notices, []);
  assert.deepEqual(h.events.notifications, []);
  assert.deepEqual(h.events.reviewFetches, []);
});

test("unknown reward name is kept in English and marked for later official-name review", () => {
  const h = makeHarness();
  const message = {
    id: "101",
    channel_id: "2",
    guild_id: "1",
    webhook_id: "323456789012345678",
    content: [
      "Rewards: Mystery Token ×5, Dye ×2",
      "Gift Code: z9y8x7w6",
      "Redemption Deadline: 2099/10/02 12:30"
    ].join("\n"),
    embeds: []
  };

  const result = h.context.processDiscordGiftMessage_(
    message,
    { channelId: "2", guildId: "1", sourceWebhookId: "" },
    { silent: false }
  );

  assert.equal(result.mode, "created");
  assert.equal(h.rows[1][2], "Mystery Token×5\n染色剤×2");
  assert.equal(h.rows[1][5], "");
});


test("GitHub batch bootstrap imports candidates silently and advances to latest message", () => {
  const h = makeHarness();
  h.properties.set("DISCORD_GIFT_CHANNEL_ID", "123456789012345678");
  const result = h.context.processDiscordGiftBatch_({
    channelId: "123456789012345678",
    guildId: "223456789012345678",
    latestMessageId: "923456789012345678",
    messages: [{
      id: "823456789012345678",
      channel_id: "123456789012345678",
      webhook_id: "323456789012345678",
      content: [
        "Rewards: Wishing star ×3, Dye ×2",
        "Gift Code: bootstrap123",
        "Redemption Deadline: 2099/10/01 00:59"
      ].join("\n"),
      embeds: []
    }]
  });

  assert.equal(result.bootstrap, true);
  assert.equal(result.counts.created, 1);
  assert.equal(result.lastMessageId, "923456789012345678");
  assert.equal(h.properties.get("DISCORD_GIFT_LAST_MESSAGE_ID"), "923456789012345678");
  assert.deepEqual(h.events.notices, []);
  assert.deepEqual(h.events.notifications, []);
});

test("GitHub batch ignores candidates at or before the stored cursor", () => {
  const h = makeHarness();
  h.properties.set("DISCORD_GIFT_CHANNEL_ID", "123456789012345678");
  h.properties.set("DISCORD_GIFT_LAST_MESSAGE_ID", "823456789012345678");

  const result = h.context.processDiscordGiftBatch_({
    channelId: "123456789012345678",
    guildId: "223456789012345678",
    latestMessageId: "923456789012345678",
    messages: [
      {
        id: "723456789012345678",
        channel_id: "123456789012345678",
        webhook_id: "323456789012345678",
        content: "Rewards: Dye ×1\nGift Code: oldcode1",
        embeds: []
      },
      {
        id: "923456789012345678",
        channel_id: "123456789012345678",
        webhook_id: "323456789012345678",
        content: "Rewards: Dye ×2\nGift Code: newcode1",
        embeds: []
      }
    ]
  });

  assert.equal(result.bootstrap, false);
  assert.equal(result.counts.created, 1);
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[1][1], "newcode1");
  assert.deepEqual(h.events.notifications, ["newcode1"]);
});


test("learns a second valid followed-channel webhook instead of ignoring it", () => {
  const h = makeHarness();
  h.properties.set("DISCORD_GIFT_SOURCE_WEBHOOK_ID", "323456789012345678");
  h.properties.set("DISCORD_GIFT_SOURCE_WEBHOOK_IDS", JSON.stringify(["323456789012345678"]));

  const result = h.context.processDiscordGiftMessage_(
    {
      id: "923456789012345678",
      channel_id: "123456789012345678",
      guild_id: "223456789012345678",
      webhook_id: "423456789012345678",
      content: [
        "Freebies are ready, don't forget to claim them:",
        "Wishing star ×3",
        "Dye ×2",
        "Flawless Fluorite ×1",
        "Gift Code: secondhook1",
        "Redemption Deadline: 2099/10/01 00:59"
      ].join("\n"),
      embeds: []
    },
    { channelId: "123456789012345678", guildId: "223456789012345678" },
    { silent: false }
  );

  assert.equal(result.mode, "created");
  assert.deepEqual(
    JSON.parse(h.properties.get("DISCORD_GIFT_SOURCE_WEBHOOK_IDS")),
    ["323456789012345678", "423456789012345678"]
  );
  assert.equal(h.rows[1][1], "secondhook1");
});

test("official X batch creates a gift from a verified official status URL", () => {
  const h = makeHarness();
  const result = h.context.processOfficialXGiftBatch_({
    posts: [{
      statusId: "2099234567890123456",
      sourceUrl: "https://x.com/myheartopia/status/2099234567890123456",
      text: [
        "Freebies are ready, don't forget to claim them:",
        "Wishing star ×3",
        "Dye ×2",
        "Flawless Fluorite ×1",
        "Gift Code: xbackup123",
        "Redemption Deadline: 2099/10/01 00:59"
      ].join("\n")
    }]
  });

  assert.equal(result.counts.created, 1);
  assert.equal(h.rows[1][1], "xbackup123");
  assert.equal(h.rows[1][4], "https://x.com/myheartopia/status/2099234567890123456");
  assert.equal(h.rows[1][5], "");
  assert.deepEqual(h.events.notifications, ["xbackup123"]);
});

test("official X batch rejects lookalike non-official account URLs", () => {
  const h = makeHarness();
  const result = h.context.processOfficialXGiftBatch_({
    posts: [{
      statusId: "2099234567890123456",
      sourceUrl: "https://x.com/fakeheartopia/status/2099234567890123456",
      text: "Rewards: Dye ×2\nGift Code: fakecode123"
    }]
  });

  assert.equal(result.counts.ignored, 1);
  assert.equal(h.rows.length, 1);
});


test("clears only legacy auto-generated gift memos and preserves manual notes", () => {
  const h = makeHarness([
    ["id-1","code1","願い星×1","","","投稿文から下書き","active","",""],
    ["id-2","code2","願い星×1","","","スクショ確認あり","active","",""],
    ["id-3","code3","願い星×1","","","公式Discord自動取得 / 日本語名未確認: Mystery Token","active","",""],
    ["id-4","code4","願い星×1","","","友達から確認済み","active","",""]
  ]);

  const result = h.context.clearGeneratedGiftMemos();

  assert.equal(result.cleared, 3);
  assert.equal(h.rows[1][5], "");
  assert.equal(h.rows[2][5], "");
  assert.equal(h.rows[3][5], "");
  assert.equal(h.rows[4][5], "友達から確認済み");
});

test("automated source URL remains auto-managed even when memo is blank", () => {
  const h = makeHarness([[
    "id-1",
    "r8a4k6p5q3m1",
    "Wishing star×3\nDye×2\nFlawless Fluorite×1",
    "2099-10-01T00:59",
    "https://discord.com/channels/1/2/3",
    "",
    "active",
    "2026-09-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z"
  ]]);

  const result = h.context.saveAutomatedGiftCode_(candidate(), { silent: false });

  assert.notEqual(result.mode, "conflict");
  assert.equal(h.rows[1][2], "願い星×3\n染色剤×2\n無垢な蛍石×1");
  assert.equal(h.rows[1][5], "");
});
