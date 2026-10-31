function normalizeGiftAnnouncementText_(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/~~/g, "")
    .replace(/ギフト\s*コード\s*内容\s*[:：]/g, "Rewards:")
    .replace(/ギフト\s*コード\s*[:：]/gi, "Gift Code:")
    .replace(/(?:報酬内容|報酬)\s*[:：]/g, "Rewards:")
    .replace(/(?:交換期限|受取期限|有効期限)\s*[:：]/g, "Redemption Deadline:")
    .replace(/Rewards?\s+includes?\s*:/ig, "Rewards:");
}

function giftRewardSegmentsBeforeCode_(text) {
  const lines = String(text || "").split("\n");
  let codeIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Gift\s*Code\s*:/i.test(lines[i])) {
      codeIndex = i;
      break;
    }
  }
  if (codeIndex < 0) return [];

  const segments = [];
  const start = Math.max(0, codeIndex - 10);
  for (let i = start; i < codeIndex; i++) {
    const line = String(lines[i] || "").trim();
    const match = line.match(/^(.+?)\s*[×xX*]\s*(\d+)\s*$/);
    if (!match) continue;
    const name = String(match[1] || "")
      .trim()
      .replace(/^[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]+/, "")
      .trim();
    const count = String(match[2] || "").trim();
    if (name && count) segments.push(name + "×" + count);
  }
  return segments;
}

function looksLikeDiscordGiftAnnouncement_(text) {
  const source = normalizeGiftAnnouncementText_(text);
  const hasCode = /(?:^|\n)[^\n]*Gift\s*Code\s*:/i.test(source);
  if (!hasCode) return false;
  if (/(?:^|\n)\s*[^\n]*Rewards?\s*:/i.test(source)) return true;
  return (giftLabeledRewardSegments_(source) || []).length > 0 || giftRewardSegmentsBeforeCode_(source).length > 0;
}

function giftLabeledRewardSegments_(text) {
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].trim().replace(/^[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]+/, "");
    if (!/^Rewards?\s*:?\s*$/i.test(label)) continue;
    const segments = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (/(?:Gift\s*Code|Redemption\s*Deadline|Valid\s*Until)\s*:/i.test(line)) return segments;
      // Never publish just the valid prefix of an ambiguous reward list.
      if (!/^.+?\s*[×xX*]\s*\d+\s*$/.test(line) || segments.length >= 25) return [];
      segments.push(line);
    }
    return segments;
  }
  return null;
}

function discordGiftMessageText_(message) {
  const parts = [];
  const content = String(message && message.content || "").trim();
  if (content) parts.push(content);

  const embeds = message && Array.isArray(message.embeds) ? message.embeds : [];
  embeds.forEach(function(embed) {
    if (embed && embed.title) parts.push(String(embed.title));
    if (embed && embed.description) parts.push(String(embed.description));
    const fields = embed && Array.isArray(embed.fields) ? embed.fields : [];
    fields.forEach(function(field) {
      if (field && field.name) parts.push(String(field.name));
      if (field && field.value) parts.push(String(field.value));
    });
  });
  return parts.join("\n").trim();
}

function parseDiscordGiftAnnouncement_(text, options) {
  const source = normalizeGiftAnnouncementText_(text);
  const codeMatch = source.match(/(?:^|\n)[^\n]*Gift\s*Code\s*:\s*`?([A-Za-z0-9][A-Za-z0-9_-]{5,99})`?/i);
  if (!codeMatch) return { ok: false, error: "Gift Codeを1件に確定できません" };

  const codeMatches = [];
  const codePattern = /(?:^|\n)[^\n]*Gift\s*Code\s*:\s*`?([A-Za-z0-9][A-Za-z0-9_-]{5,99})`?/ig;
  let codeScan;
  while ((codeScan = codePattern.exec(source))) codeMatches.push(codeScan[1]);
  const uniqueCodes = Array.from(new Set(codeMatches));
  if (uniqueCodes.length !== 1) return { ok: false, error: "Gift Code候補が複数あります" };

  let rewardLine = lineValueAfterLabel_(source, /Rewards?/i);
  if (!rewardLine) {
    const labeledRewards = giftLabeledRewardSegments_(source);
    if (labeledRewards !== null) {
      if (!labeledRewards.length) return { ok: false, error: "Rewardsの形式を安全に解析できません" };
      rewardLine = labeledRewards.join(", ");
    }
  }
  if (!rewardLine) {
    const contextualRewards = giftRewardSegmentsBeforeCode_(source);
    rewardLine = contextualRewards.join(", ");
  }
  if (!rewardLine) return { ok: false, error: "Rewardsを読み取れません" };

  const rewardMap = options && options.rewardNameMap ? options.rewardNameMap : DEFAULT_GIFT_REWARD_NAME_MAP;
  const rewards = parseDiscordGiftRewards_(rewardLine, rewardMap);
  if (!rewards.ok) return rewards;

  const deadlineLine = lineValueAfterLabel_(source, /Redemption\s*Deadline/i);
  const expiresAt = deadlineLine ? parseDiscordGiftDeadline_(deadlineLine) : "";

  return {
    ok: true,
    code: uniqueCodes[0],
    reward: rewards.localized.join("\n"),
    rawReward: rewards.raw.join("\n"),
    unresolvedRewardNames: rewards.unresolvedRewardNames,
    expiresAt: expiresAt
  };
}

function lineValueAfterLabel_(text, labelPattern) {
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(new RegExp(labelPattern.source + "\\s*:\\s*(.+)$", labelPattern.flags));
    if (match) return String(match[1] || "").trim();
  }
  return "";
}

function parseDiscordGiftRewards_(line, rewardNameMap) {
  const segments = String(line || "").split(/\s*[,，、]\s*/).map(function(part) {
    return part.trim();
  }).filter(Boolean);
  if (!segments.length) return { ok: false, error: "Rewardsが空です" };

  const normalizedMap = {};
  Object.keys(rewardNameMap || {}).forEach(function(key) {
    normalizedMap[String(key).trim().toLowerCase()] = String(rewardNameMap[key] || "").trim();
  });

  const raw = [];
  const localized = [];
  const unresolved = [];
  for (let i = 0; i < segments.length; i++) {
    const match = segments[i].match(/^(.+?)\s*[×xX*]\s*(\d+)\s*$/);
    if (!match) return { ok: false, error: "Rewardsの形式を安全に解析できません: " + segments[i] };
    const sourceName = String(match[1] || "")
      .trim()
      .replace(/^[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]+/, "")
      .trim();
    const count = String(match[2] || "").trim();
    if (!sourceName || !count) return { ok: false, error: "Rewardsの形式が不正です" };

    const japaneseName = normalizedMap[sourceName.toLowerCase()] || "";
    const alreadyJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(sourceName);
    raw.push(sourceName + "×" + count);
    localized.push((japaneseName || sourceName) + "×" + count);
    if (!japaneseName && !alreadyJapanese) unresolved.push(sourceName);
  }

  return {
    ok: true,
    raw: raw,
    localized: localized,
    unresolvedRewardNames: Array.from(new Set(unresolved))
  };
}

function parseDiscordGiftDeadline_(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text) return "";

  const discordTimestamp = text.match(/<t:(\d{9,12})(?::[tTdDfFR])?>/);
  if (discordTimestamp) {
    const seconds = Number(discordTimestamp[1]);
    if (!Number.isFinite(seconds)) return "";
    return Utilities.formatDate(new Date(seconds * 1000), DISCORD_GIFT_TIME_ZONE, "yyyy-MM-dd'T'HH:mm");
  }

  let match = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*[^\d\n]*)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (match) return giftDeadlineInJst_(match, text);

  match = text.match(/(20\d{2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s+[^\d\n]*)?\s+(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (match) return giftDeadlineInJst_(match, text);

  return "";
}

function giftDeadlineInJst_(parts, text) {
  const values = parts.slice(1, 6).map(Number);
  const local = new Date(Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4]));
  if (local.getUTCFullYear() !== values[0] || local.getUTCMonth() !== values[1] - 1 || local.getUTCDate() !== values[2]
      || local.getUTCHours() !== values[3] || local.getUTCMinutes() !== values[4]) return "";
  const zone = text.match(/UTC\s*([+-])\s*(\d{1,2})(?::(\d{2}))?/i);
  if (zone && (Number(zone[2]) > 14 || Number(zone[3] || 0) > 59)) return "";
  const offset = zone ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3] || 0))
    : (/\bUTC\b/i.test(text) ? 0 : 9 * 60);
  return Utilities.formatDate(new Date(local.getTime() - offset * 60000), DISCORD_GIFT_TIME_ZONE, "yyyy-MM-dd'T'HH:mm");
}

function giftRewardNameMap_() {
  const result = {};
  Object.keys(DEFAULT_GIFT_REWARD_NAME_MAP).forEach(function(key) {
    result[key] = DEFAULT_GIFT_REWARD_NAME_MAP[key];
  });

  const raw = String(PropertiesService.getScriptProperties().getProperty(GIFT_REWARD_NAME_MAP_PROPERTY) || "").trim();
  if (!raw) return result;
  try {
    const custom = JSON.parse(raw);
    if (!custom || Array.isArray(custom) || typeof custom !== "object") return result;
    Object.keys(custom).forEach(function(key) {
      const source = String(key || "").trim();
      const target = String(custom[key] || "").trim();
      if (source && target) result[source] = target;
    });
  } catch (error) {
    Logger.log("GIFT_REWARD_NAME_MAP is invalid JSON: " + error.message);
  }
  return result;
}
