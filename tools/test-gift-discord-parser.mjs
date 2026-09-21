import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = [
  "../apps-script/gift-code-config.gs",
  "../apps-script/gift-code-parser.gs",
  "../apps-script/gift-code-storage.gs"
].map(path => fs.readFileSync(new URL(path, import.meta.url), "utf8")).join("\n\n");

const context = {
  console,
  pad2_: value => String(value).padStart(2, "0"),
  Utilities: {
    formatDate(date, _tz, _pattern) {
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
  }
};
vm.createContext(context);
vm.runInContext(source, context);

test("parses current Heartopia Discord announcement and localizes verified reward names", () => {
  const text = [
    "🎁Rewards: Wishing star ×3, Dye ×2, Flawless Fluorite ×1",
    "🔑Gift Code: r8a4k6p5q3m1",
    "⏰Redemption Deadline: 2026年10月1日 0:59"
  ].join("\n");

  const result = context.parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: {
      "Wishing star": "願い星",
      "Dye": "染色剤",
      "Flawless Fluorite": "無垢な蛍石"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "r8a4k6p5q3m1");
  assert.equal(result.reward, "願い星×3\n染色剤×2\n無垢な蛍石×1");
  assert.equal(result.rawReward, "Wishing star×3\nDye×2\nFlawless Fluorite×1");
  assert.equal(result.expiresAt, "2026-10-01T00:59");
  assert.deepEqual(Array.from(result.unresolvedRewardNames), []);
});

test("parses Discord timestamp token into JST", () => {
  const unixSeconds = Math.floor(Date.UTC(2026, 8, 30, 15, 59, 0) / 1000);
  const text = [
    "🎁 Rewards: Wishing star x3",
    "🔑 Gift Code: abcdef123456",
    "⏰ Redemption Deadline: <t:" + unixSeconds + ":F>"
  ].join("\n");

  const result = context.parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: { "Wishing star": "願い星" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.expiresAt, "2026-10-01T00:59");
});

test("keeps unknown reward in English instead of guessing Japanese", () => {
  const text = [
    "Rewards: Mystery Token ×5, Dye ×2",
    "Gift Code: z9y8x7w6",
    "Redemption Deadline: 2026/10/02 12:30"
  ].join("\n");

  const result = context.parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: { "Dye": "染色剤" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.reward, "Mystery Token×5\n染色剤×2");
  assert.deepEqual(Array.from(result.unresolvedRewardNames), ["Mystery Token"]);
});

test("fails closed on multiple gift codes", () => {
  const text = [
    "Rewards: Dye ×2",
    "Gift Code: abcdef123",
    "Gift Code: ghijkl456"
  ].join("\n");

  const result = context.parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: { "Dye": "染色剤" }
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /複数/);
});

test("fails closed when reward format is ambiguous", () => {
  const text = [
    "Rewards: Dye, Flawless Fluorite ×1",
    "Gift Code: abcdef123"
  ].join("\n");

  const result = context.parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: {}
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Rewards/);
});

test("detects announcement markers without matching the site's Japanese Discord notification", () => {
  assert.equal(context.looksLikeDiscordGiftAnnouncement_(
    "🎁Rewards: Dye ×2\n🔑Gift Code: abcdef123"
  ), true);

  assert.equal(context.looksLikeDiscordGiftAnnouncement_(
    "🎁 新しいギフトコードを追加しました！\nコード：abcdef123\n報酬：染色剤×2"
  ), false);
});

test("accepts Discord markdown around labels and inline-code gift code", () => {
  const text = [
    "🎁**Rewards:** Wishing star ×3, Dye ×2",
    "🔑**Gift Code:** r8a4k6p5q3m1",
    "⏰**Redemption Deadline:** <t:1790809140:F>"
  ].join("\n");

  const result = context.parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: {
      "Wishing star": "願い星",
      "Dye": "染色剤"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "r8a4k6p5q3m1");
  assert.equal(result.reward, "願い星×3\n染色剤×2");
});


test("parses announcement-channel freebies list without a Rewards label", () => {
  const text = [
    "Freebies are ready, don't forget to claim them:",
    "🌟 Wishing star ×3",
    "🎨 Dye ×2",
    "💎 Flawless Fluorite ×1",
    "",
    "🎁 Gift Code: p5m1k9q6a2r7",
    "Redemption Deadline: 2026年10月1日 0:59"
  ].join("\n");

  assert.equal(context.looksLikeDiscordGiftAnnouncement_(text), true);
  const result = context.parseDiscordGiftAnnouncement_(text, {
    rewardNameMap: {
      "Wishing star": "願い星",
      "Dye": "染色剤",
      "Flawless Fluorite": "無垢な蛍石"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, "p5m1k9q6a2r7");
  assert.equal(result.reward, "願い星×3\n染色剤×2\n無垢な蛍石×1");
  assert.equal(result.expiresAt, "2026-10-01T00:59");
});

test("accepts Japanese official reward labels without marking Japanese names unresolved", () => {
  const text = [
    "報酬：願い星 ×3、染色剤 ×2、無垢な蛍石 ×1",
    "ギフトコード：jpcode123",
    "交換期限：2026年10月1日 0:59"
  ].join("\n");

  const result = context.parseDiscordGiftAnnouncement_(text, { rewardNameMap: {} });
  assert.equal(result.ok, true);
  assert.equal(result.reward, "願い星×3\n染色剤×2\n無垢な蛍石×1");
  assert.deepEqual(Array.from(result.unresolvedRewardNames), []);
});

test("sorts Discord snowflakes without bigint", () => {
  const ids = ["210", "9", "1000", "99", "010"].sort(context.compareDiscordSnowflakes_);
  assert.deepEqual(Array.from(ids), ["9", "010", "99", "210", "1000"]);
});
