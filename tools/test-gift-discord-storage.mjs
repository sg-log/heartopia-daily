import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";

test('public API and gift cards never expose private Discord source links', () => {
  const api = fs.readFileSync(new URL('../apps-script/weather-api.gs', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(api.slice(api.indexOf('function publicGiftItem_'), api.indexOf('function publicNoticeItem_')), context);
  vm.runInContext(html.slice(html.indexOf('function giftSourceUrl('), html.indexOf('function giftClaimKey(')), context);
  for (const url of ['https://discord.com/channels/111/222/333', 'https://discordapp.com/channels/111/222/333', 'https://discord.gg/private', 'https://example.com']) {
    assert.equal(context.publicGiftItem_({ sourceUrl: url }).sourceUrl, '');
    assert.equal(context.giftSourceUrl(url), '');
  }
  const official = 'https://x.com/Heartopia_JP/status/2106957555713085600';
  assert.equal(context.publicGiftItem_({ sourceUrl: official }).sourceUrl, official);
  assert.equal(context.giftSourceUrl(official), official);
});


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
    adminKey_: () => 'test-admin-key',
    postKey_: () => 'test-post-key',
    requireKey_: (actual, expected) => { if(actual !== expected) throw Error('管理キーが違います'); },
    json_: value => value,
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
  const reviewRows = [["id", "code", "reason", "sourceUrl", "listingUrls", "excerpt", "status", "createdAt", "notifiedAt"]];
  context.getGiftReviewSheet_ = () => ({
    getDataRange: () => ({ getValues: () => reviewRows.map(row => row.slice()) }),
    appendRow: row => reviewRows.push(row.slice()),
    getRange: (index, column = 1) => ({ setValues: values => { reviewRows[index - 1] = values[0].slice(); },
      setValue: value => { reviewRows[index - 1][column - 1] = value; } })
  });
  let nextId = 0;
  context.Utilities.getUuid = () => 'test-uuid-' + (++nextId);
  return { context, properties, rows, events, reviewRows };
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

test('a parser revision silently recovers skipped history once without rewinding the cursor or unhiding codes', () => {
  const h = makeHarness([['hidden-id','hidden123','願い星×3','2099-10-01T00:59','https://example.com/manual','manual','hidden','','']]);
  const cursor = '923456789012345678';
  h.properties.set('DISCORD_GIFT_LAST_MESSAGE_ID', cursor);
  const message = (id,code) => ({id,channel_id:'123456789012345678',webhook_id:'323456789012345678',
    content:`Wishing star ×3\nGift Code: ${code}\nRedemption Deadline: 2099/10/01 00:59`});
  const batch = {channelId:'123456789012345678',guildId:'223456789012345678',latestMessageId:cursor,
    historyRevision:'gift-formats-20261015',messages:[message('723456789012345678','missed123'),message('823456789012345678','hidden123')]};
  const first = h.context.processDiscordGiftBatch_(batch);
  assert.equal(first.historyReplayed, true);
  assert.equal(first.historyRecovered, 1);
  assert.equal(first.counts.created, 1);
  assert.equal(h.rows.length, 3);
  assert.equal(h.rows[1][6], 'hidden');
  assert.equal(h.properties.get('DISCORD_GIFT_LAST_MESSAGE_ID'), cursor);
  assert.deepEqual(h.events.notifications, []);
  assert.deepEqual(h.events.notices, []);
  assert.deepEqual(h.events.reviewFetches, []);
  const again = h.context.processDiscordGiftBatch_(batch);
  assert.equal(again.historyReplayed, false);
  assert.equal(again.counts.created, 0);
  assert.equal(h.rows.length, 3);
});

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

test('multiline Japanese official announcement creates once through the normal notification path', () => {
  const h=makeHarness();
  const post={statusId:'2199234567890123456',sourceUrl:'https://x.com/Heartopia_JP/status/2199234567890123456',
    text:'ギフトコード：season123\nギフトコード内容：\nかぼちゃの種 ×10\nツルツルオーク ×2\n良質木材 ×5\n良質肥料 ×10\n有効期限：2099年12月01日 00:59（UTC+9）まで'};
  const first=h.context.processOfficialXGiftBatch_({posts:[post]});
  assert.equal(first.counts.created,1);
  assert.equal(h.rows[1][2],'かぼちゃの種×10\nツルツルオーク×2\n良質木材×5\n良質肥料×10');
  assert.equal(h.rows[1][3],'2099-12-01T00:59');
  assert.deepEqual(h.events.notifications,['season123']);
  const second=h.context.processOfficialXGiftBatch_({posts:[post]});
  assert.equal(second.counts.created,0);
  assert.equal(h.rows.length,2);
  assert.deepEqual(h.events.notifications,['season123']);
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

test('missing codes stay private, retry delivery until acknowledged, and resolve after registration', () => {
  const h = makeHarness();
  const batch = { reconcile: true, reviewCandidates: [{ code: 'missing123', reason: '期限未確認',
    sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600',
    listingUrls: ['https://heartopiaguide.com/codes/'], excerpt: 'ギフトコード：missing123…' }] };
  const first = h.context.processOfficialXGiftBatch_(batch);
  assert.equal(first.reviews.length, 1);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.events.notifications, []);
  assert.equal(h.context.processOfficialXGiftBatch_(batch).reviews[0].id, first.reviews[0].id);
  const ack = h.context.processOfficialXGiftBatch_({ reconcile: true, ackReviewIds: [first.reviews[0].id] });
  assert.equal(ack.reviews.length, 0);
  assert.equal(h.context.processOfficialXGiftBatch_(batch).reviews.length, 0);
  assert.equal(h.reviewRows.length, 2);
  h.context.saveAutomatedGiftCode_(candidate({ code: 'missing123' }), { silent: true });
  h.context.processOfficialXGiftBatch_({ reconcile: true });
  assert.equal(h.reviewRows[1][6], 'resolved');
});

test('reconciliation respects hidden codes and rejects untrusted review links', () => {
  const h = makeHarness([['h', 'hidden123', '願い星×3', '', '', '', 'hidden', '', '']]);
  const result = h.context.processOfficialXGiftBatch_({ reconcile: true, reviewCandidates: [
    { code: 'hidden123', listingUrls: ['https://www.heartodex.com/en/codes/'] },
    { code: 'unsafe123', sourceUrl: 'https://example.com/post', listingUrls: ['https://example.com/'] }
  ] });
  assert.equal(result.reviews.length, 0);
  assert.equal(h.rows[1][6], 'hidden');
  assert.deepEqual(h.events.notifications, []);
});

test('official X announcements without a readable deadline never become active codes', () => {
  const h = makeHarness();
  const result = h.context.processOfficialXGiftBatch_({ reconcile: true, posts: [{
    statusId: '2106957555713085600', sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600',
    text: '願い星 ×3\nギフトコード：partial123\nさらに受け取ろう…'
  }] });
  assert.equal(result.counts.created, 0);
  assert.equal(result.reviews.length, 0);
  assert.equal(h.rows.length, 1);
});

test('official expiry times convert UTC offsets to JST and reject invalid dates', () => {
  const h = makeHarness();
  assert.equal(h.context.parseDiscordGiftDeadline_('2026/12/03 10:59 (UTC-5)'), '2026-12-04T00:59');
  assert.equal(h.context.parseDiscordGiftDeadline_('2026/12/04 00:59 (UTC+9)'), '2026-12-04T00:59');
  assert.equal(h.context.parseDiscordGiftDeadline_('2026/12/03 15:59 (UTC)'), '2026-12-04T00:59');
  assert.equal(h.context.parseDiscordGiftDeadline_('2026/02/30 00:59 (UTC+9)'), '');
});

test('the same code arriving through X and Discord sends only one friend notification', () => {
  const h = makeHarness();
  const text = 'Rewards: Dye ×2\nGift Code: shared123\nRedemption Deadline: 2099/10/01 00:59';
  h.context.processOfficialXGiftBatch_({ posts: [{ statusId: '2106957555713085600',
    sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600', text }] });
  h.context.processDiscordGiftMessage_({ id: '923456789012345678', webhook_id: '323456789012345678', content: text },
    { channelId: '123456789012345678', guildId: '223456789012345678' }, { silent: false });
  assert.deepEqual(h.events.notifications, ['shared123']);
  assert.equal(h.rows.length, 2);
});

test('a conflict with complete manual data stays unchanged without a missing-code alert', () => {
  const h = makeHarness([['manual', 'conflict123', '手動の報酬', '2099-10-01T00:59', '', '手動', 'active', '', '']]);
  const result = h.context.processOfficialXGiftBatch_({ reconcile: true, posts: [{ statusId: '2106957555713085600',
    sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600',
    text: 'Rewards: Dye ×2\nGift Code: conflict123\nRedemption Deadline: 2099/10/01 00:59' }] });
  assert.equal(result.counts.conflict, 1);
  assert.equal(result.reviews.length, 0);
  assert.equal(h.rows[1][2], '手動の報酬');
  assert.deepEqual(h.events.notifications, []);
});

test('old unlisted X posts and already registered codes never create review notifications', () => {
  const h = makeHarness([['old', 'known123', '願い星×3', '', '', '', 'active', '', '']]);
  const result = h.context.processOfficialXGiftBatch_({ reconcile: true, reviewCandidates: [
    { code: 'older123', sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600', listingUrls: [] },
    { code: 'known123', listingUrls: ['https://heartopiaguide.com/codes/'] },
    { code: 'missing123', listingUrls: ['https://heartopiaguide.com/codes/'] }
  ] });
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].code, 'missing123');
  assert.equal(h.reviewRows.length, 2);
});

function addPendingReview(h, code = 'review123') {
  return h.context.processOfficialXGiftBatch_({ reconcile: true, reviewCandidates: [{ code,
    sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600', listingUrls: ['https://heartopiaguide.com/codes/'],
    excerpt: `願い星 ×3\nギフトコード：${code}\n受け取ろう…`, deadlineHint: '2099-12-03 10:59 (UTC-5)' }] }).reviews[0];
}

test('admin review keeps delivered candidates visible and pre-fills unverified expiry hints', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  h.context.processOfficialXGiftBatch_({ reconcile: true, ackReviewIds: [review.id] });
  const result = h.context.getGiftReviews_({ adminKey: 'test-admin-key' });
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].reward, '願い星×3');
  assert.equal(result.reviews[0].expiresAt, '2099-12-04T00:59');
  assert.equal(result.reviews[0].expiryNeedsConfirmation, true);
  assert.equal(h.rows.length, 1);
});

test('admin approval registers the queued code once and sends one friend notification', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  const body = { adminKey: 'test-admin-key', id: review.id, decision: 'approve', confirmed: true,
    code: 'untrusted-override', reward: '願い星×3', expiresAt: '2099-12-04T00:59' };
  assert.equal(h.context.decideGiftReview_(body).mode, 'created');
  assert.equal(h.context.decideGiftReview_(body).mode, 'already_processed');
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[1][1], 'review123');
  assert.equal(h.reviewRows[1][6], 'approved');
  assert.deepEqual(h.events.notifications, ['review123']);
});

test('approval requires explicit confirmation and complete valid fields; rejection stays private', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  const body = { id: review.id, decision: 'approve', reward: '願い星×3', expiresAt: '2099-12-04T00:59' };
  assert.throws(() => h.context.processGiftReviewDecision_(body), /確認/);
  assert.throws(() => h.context.processGiftReviewDecision_({ ...body, confirmed: true, expiresAt: '' }), /交換期限/);
  assert.throws(() => h.context.processGiftReviewDecision_({ ...body, confirmed: true, expiresAt: '2099-02-30T00:59' }), /交換期限/);
  assert.equal(h.context.processGiftReviewDecision_({ id: review.id, decision: 'reject' }).mode, 'rejected');
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.events.notifications, []);
});

test('approval can publish without a friend Discord notification', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  const result = h.context.processGiftReviewDecision_({ id: review.id, decision: 'approve', confirmed: true,
    reward: '願い星×3', expiresAt: '2099-12-04T00:59', notifyDiscord: false });
  assert.equal(result.mode, 'created');
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.events.notifications, []);
  assert.equal(h.context.processGiftReviewDecision_({ id: review.id, decision: 'approve', confirmed: true }).mode, 'already_processed');
  assert.deepEqual(h.events.notifications, []);
});

test('partial Japanese official posts localize registered codes without changing deadlines or notifying again', () => {
  const h = makeHarness();
  const old = 'https://x.com/myheartopia/status/2106957555415032211';
  h.rows.push(['registered', 'review123', 'Wishing star×3', '2099-12-04T00:59', old, '', 'active', 'before', 'before']);
  const sourceUrl = 'https://x.com/Heartopia_JP/status/2106957555713085600';
  h.context.processOfficialXGiftBatch_({ posts: [{ statusId: '2106957555713085600', sourceUrl,
    text: '願い星×3\nギフトコード：review123\n受け取ろう…' }] });
  assert.equal(h.rows[1][2], '願い星×3');
  assert.equal(h.rows[1][3], '2099-12-04T00:59');
  assert.equal(h.rows[1][4], sourceUrl);
  assert.deepEqual(h.events.notifications, []);
  h.context.saveAutomatedGiftCode_(candidate({ code: 'review123', sourceUrl: old, reward: 'Wishing star×3', expiresAt: '2099-12-04T00:59' }));
  assert.equal(h.rows[1][2], '願い星×3');
  assert.equal(h.rows[1][4], sourceUrl);
});

test('Japanese evidence replaces English pending evidence without new alerts or publishing partial data', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  h.reviewRows[1][3] = 'https://x.com/myheartopia/status/2106957555415032211';
  h.reviewRows[1][8] = 'already-delivered';
  h.reviewRows[1][10] = JSON.stringify({ fileId: 'old-private-english-image' });
  const sourceUrl = 'https://x.com/Heartopia_JP/status/2106957555713085600';
  h.context.processOfficialXGiftBatch_({ posts: [{ statusId: '2106957555713085600', sourceUrl,
    text: '願い星×3\nギフトコード：review123\n受け取ろう…' }], reconcile: true });
  assert.equal(h.rows.length, 1);
  assert.equal(h.reviewRows[1][0], review.id);
  assert.equal(h.reviewRows[1][3], sourceUrl);
  assert.equal(h.reviewRows[1][8], 'already-delivered');
  assert.equal(h.reviewRows[1][10], '');
  assert.equal(h.context.giftReviewEvidenceRequests_()[0].sourceUrl, sourceUrl);
  assert.deepEqual(h.events.notifications, []);
});

test('friend notifications contain only the announcement, escaped code and gift page with previews suppressed', () => {
  const h = makeHarness();
  const api = fs.readFileSync(new URL('../apps-script/weather-api.gs', import.meta.url), 'utf8');
  h.context.HEARTOPIA_DAILY_URL = 'https://sg-log.github.io/heartopia-daily/';
  h.context.formatDiscordGiftExpiry_ = text => text;
  h.properties.set('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/test-only');
  vm.runInContext(api.slice(api.indexOf('function notifyDiscordGiftCode_'), api.indexOf('function sanitizeDiscordText_')), h.context);
  const privateUrl = 'https://discord.com/channels/111/222/333';
  const official = 'https://x.com/Heartopia_JP/status/2106957555713085600';
  for (const sourceUrl of [privateUrl, official]) {
    const result = h.context.notifyDiscordGiftCode_(candidate({ code: 'p7k5a3n9r2m8', sourceUrl }));
    assert.equal(result.notified, true);
    const payload = JSON.parse(h.events.reviewFetches.at(-1).payload);
    assert.equal(payload.content, '🎁 新しいギフトコードを追加しました！\n\nコード：`p7k5a3n9r2m8`\n\nhttps://sg-log.github.io/heartopia-daily/codes.html');
    assert.equal(payload.flags, 4);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  }
  h.context.notifyDiscordGiftCode_(candidate({ code: 'abc`123' }));
  assert.ok(JSON.parse(h.events.reviewFetches.at(-1).payload).content.includes('コード：`abc123`'));
});

test('a queued approval cannot overwrite a code registered or hidden concurrently', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  h.rows.push(['hidden', 'review123', '手動', '', '', '', 'hidden', '', '']);
  const result = h.context.processGiftReviewDecision_({ id: review.id, decision: 'approve', confirmed: true,
    reward: '願い星×3', expiresAt: '2099-12-04T00:59' });
  assert.equal(result.mode, 'already_registered');
  assert.equal(h.rows[1][6], 'hidden');
  assert.deepEqual(h.events.notifications, []);
});

test('actual API dispatcher rejects unauthenticated review reads and decisions', () => {
  const h = makeHarness();
  const api = fs.readFileSync(new URL('../apps-script/weather-api.gs', import.meta.url), 'utf8');
  h.context.parseBody_ = event => event.body;
  h.context.safeErrorMessage_ = error => error.message;
  h.context.weatherSubmitFailureCode_ = () => null;
  h.context.weatherSubmitStage_ = () => null;
  vm.runInContext(api.slice(api.indexOf('function doPost(e)'), api.indexOf('function requestWeatherAutomation_')), h.context);
  for (const action of ['getGiftReviews', 'decideGiftReview', 'getGiftReviewEvidence']) {
    const result = h.context.doPost({ body: { action, adminKey: 'wrong' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /管理キー/);
  }
  assert.equal(h.context.doPost({ body: { action: 'saveGiftReviewEvidence', postKey: 'wrong' } }).ok, false);
  assert.equal(h.rows.length, 1);
  assert.equal(h.reviewRows.length, 1);
});

test('evidence captures target only unresolved candidates and back off after a failed capture', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  assert.equal(h.context.giftReviewEvidenceRequests_().length, 1);
  h.context.saveGiftReviewEvidence_({ postKey: 'test-post-key', reviewId: review.id,
    sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600', failed: true });
  assert.equal(h.context.giftReviewEvidenceRequests_().length, 0);
  assert.equal(h.context.getGiftReviews_({ adminKey: 'test-admin-key' }).reviews[0].evidenceStatus, 'failed');
  assert.throws(() => h.context.saveGiftReviewEvidence_({ postKey: 'wrong', reviewId: review.id, failed: true }), /管理キー/);
});

test('private screenshot reads bind the queued row, validate image bytes, and reject foreign files', () => {
  const h = makeHarness();
  const review = addPendingReview(h);
  const api = fs.readFileSync(new URL('../apps-script/weather-api.gs', import.meta.url), 'utf8');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a4lEAAAAASUVORK5CYII=', 'base64');
  h.context.Utilities.base64Encode = bytes => Buffer.from(bytes).toString('base64');
  h.context.Utilities.base64Decode = text => [...Buffer.from(text, 'base64')];
  h.context.Utilities.DigestAlgorithm = { SHA_256: 'sha256' };
  h.context.Utilities.computeDigest = (_algorithm, bytes) => [...createHash('sha256').update(Buffer.from(bytes)).digest()];
  h.context.Utilities.newBlob = bytes => ({ getBytes: () => bytes });
  h.context.weatherSubmitFailure_ = code => new Error(code);
  vm.runInContext(api.slice(api.indexOf('function weatherEvidenceTime_'), api.indexOf('function requirePrivateEvidence_')), h.context);
  let parentId = 'private-folder';
  const file = { private: true, getId: () => 'private-file', getSize: () => png.length, isTrashed: () => false, setTrashed() {},
    getBlob: () => ({ getBytes: () => [...png] }), getParents: () => { let pending = true; return {
      hasNext: () => pending, next: () => { pending = false; return { getId: () => parentId }; } }; } };
  h.context.weatherEvidenceFolder_ = () => ({ getId: () => 'private-folder', createFile: () => file });
  h.context.requirePrivateEvidence_ = value => { if (!value.private) throw Error('Evidence must be private'); };
  h.context.DriveApp = { getFileById: id => { assert.equal(id, 'private-file'); return file; } };
  const image = { mimeType: 'image/png', byteSize: png.length, sha256: createHash('sha256').update(png).digest('hex'), kind: 'screenshot',
    capturedAt: new Date().toISOString(), bodyBase64: png.toString('base64') };
  const save = { postKey: 'test-post-key', reviewId: review.id, sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085600', image };
  assert.throws(() => h.context.saveGiftReviewEvidence_({ ...save, sourceUrl: 'https://x.com/Heartopia_JP/status/2106957555713085601' }), /source mismatch/);
  assert.equal(h.context.saveGiftReviewEvidence_(save).status, 'saved');
  const read = { action: 'getGiftReviewEvidence', adminKey: 'test-admin-key', reviewId: review.id };
  assert.equal(h.context.getGiftReviewEvidence_(read).bodyBase64, image.bodyBase64);
  assert.equal(h.context.giftReviewEvidenceRequests_().length, 0);
  assert.ok(!JSON.stringify(h.context.getGiftReviews_({ adminKey: 'test-admin-key' })).includes('private-file'));
  assert.throws(() => h.context.getGiftReviewEvidence_({ ...read, fileId: 'foreign-file' }), /Invalid/);
  parentId = 'foreign-folder';
  assert.throws(() => h.context.getGiftReviewEvidence_(read), /unavailable/);
  parentId = 'private-folder'; file.private = false;
  assert.throws(() => h.context.getGiftReviewEvidence_(read), /private/);
});
