function looksLikeDiscordGiftAnnouncement_(text) {
  const source = String(text || "");
  return /(?:^|\n)\s*[^\n]*Rewards?\s*:/i.test(source)
    && /(?:^|\n)\s*[^\n]*Gift\s*Code\s*:/i.test(source);
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
  const source = String(text || "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/~~/g, "");
  const codeMatch = source.match(/(?:^|\n)[^\n]*Gift\s*Code\s*:\s*`?([A-Za-z0-9][A-Za-z0-9_-]{5,99})`?/i);
  if (!codeMatch) return { ok: false, error: "Gift Codeを1件に確定できません" };

  const codeMatches = [];
  const codePattern = /(?:^|\n)[^\n]*Gift\s*Code\s*:\s*`?([A-Za-z0-9][A-Za-z0-9_-]{5,99})`?/ig;
  let codeScan;
  while ((codeScan = codePattern.exec(source))) codeMatches.push(codeScan[1]);
  const uniqueCodes = Array.from(new Set(codeMatches));
  if (uniqueCodes.length !== 1) return { ok: false, error: "Gift Code候補が複数あります" };

  const rewardLine = lineValueAfterLabel_(source, /Rewards?/i);
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
  const segments = String(line || "").split(/\s*[,，]\s*/).map(function(part) {
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
    const englishName = String(match[1] || "").trim();
    const count = String(match[2] || "").trim();
    if (!englishName || !count) return { ok: false, error: "Rewardsの形式が不正です" };

    const japaneseName = normalizedMap[englishName.toLowerCase()] || "";
    raw.push(englishName + "×" + count);
    localized.push((japaneseName || englishName) + "×" + count);
    if (!japaneseName) unresolved.push(englishName);
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
  if (match) return match[1] + "-" + pad2_(match[2]) + "-" + pad2_(match[3]) + "T" + pad2_(match[4]) + ":" + pad2_(match[5]);

  match = text.match(/(20\d{2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s+[^\d\n]*)?\s+(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (match) return match[1] + "-" + pad2_(match[2]) + "-" + pad2_(match[3]) + "T" + pad2_(match[4]) + ":" + pad2_(match[5]);

  return "";
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
