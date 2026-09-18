(function(root, factory){
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  root.WeatherScreenshotCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";

  const START_SLOTS = ["00", "06", "12", "18"];

  function expectedSlots(startSlot){
    const startIndex = START_SLOTS.indexOf(startSlot);
    if(startIndex < 0) return [];
    return Array.from({length:5}, (_, index) => START_SLOTS[(startIndex + index) % START_SLOTS.length]);
  }

  // Keep this in lockstep with weather-direct-daily-panel-review.mjs.
  function inferStartSlot(mapped, minimumObserved=3){
    const values = Array.isArray(mapped) ? mapped : [];
    const observed = values.filter(value => START_SLOTS.includes(value)).length;
    if(observed < minimumObserved) return null;
    const matches = START_SLOTS.map(startSlot => ({startSlot, expected:expectedSlots(startSlot)}))
      .filter(candidate => values.every((value, index) => !START_SLOTS.includes(value) || value === candidate.expected[index]));
    return matches.length === 1 ? {...matches[0], mapped:[...values], observed} : null;
  }

  // Manual screenshot crops include more of the purple in-game panel than the
  // scheduled-review crops. Purple is therefore diagnostic only; a meteor
  // result must be backed by a strong meteor template match.
  function resolveDailyScore(score={}){
    const metrics = score.metrics || {};
    const warm = Number(metrics.warm) || 0;
    const cyan = Number(metrics.cyan) || 0;
    const red = Number(metrics.red) || 0;
    const bestScore = Number(score.bestScore) || 0;
    const margin = Number(score.margin) || 0;
    const templateStrong = bestScore >= .43 && margin >= .008;
    const meteorTemplateStrong = score.bestValue === "流星群"
      && bestScore >= .46
      && margin >= .02;
    let value = score.bestValue || "";
    let heuristic = "";
    if(red >= .04 && cyan >= .12){ value = "虹"; heuristic = "虹色比率"; }
    else if(cyan >= .58 && warm < .02){ value = "雨"; heuristic = "シアン比率"; }
    else if(meteorTemplateStrong){ value = "流星群"; heuristic = "流星群テンプレート照合"; }
    else if(value === "流星群"){
      value = warm >= .025 ? "晴" : "";
      heuristic = value ? "暖色比率" : "";
    }
    else if(value === "晴" && templateStrong){ value = "晴"; heuristic = "晴テンプレート照合"; }
    else if(warm >= .025 && value !== "猛暑"){ value = "晴"; heuristic = "暖色比率"; }
    const high = Boolean(value) && (templateStrong
      || warm >= .025
      || (cyan >= .58 && warm < .02)
      || (red >= .04 && cyan >= .12));
    return {value:high ? value : "", suggestedValue:value, high, heuristic};
  }

  // Keep this in lockstep with resolveWeekly in weather-direct-panel-review.mjs.
  function resolveWeeklyScore(score={}){
    const metrics = score.metrics || {};
    const warm = Number(metrics.warm) || 0;
    const yellowOrange = Number(metrics.yellowOrange) || 0;
    const cyan = Number(metrics.cyan) || 0;
    const red = Number(metrics.red) || 0;
    const palePurple = Number(metrics.palePurple) || 0;
    const bestScore = Number(score.bestScore) || 0;
    const margin = Number(score.margin) || 0;
    let value = score.bestValue || "";
    let heuristic = "";
    if(red >= .04 && cyan >= .12){ value = "虹"; heuristic = "虹色比率"; }
    else if(palePurple >= .02 && warm >= .02 && cyan < .12){ value = "流星群"; heuristic = "淡紫色・暖色比率"; }
    else if(cyan >= .60 && warm < .02){ value = "雨"; heuristic = "シアン比率"; }
    else if(value !== "猛暑" && value !== "流星群" && warm > .04 && yellowOrange > .15 && cyan < .35){ value = "晴"; heuristic = "暖色比率"; }
    const high = Boolean(heuristic) || (bestScore >= .50 && margin >= .025);
    return {value:high ? value : "", suggestedValue:value, high, heuristic};
  }

  function selectPanelCandidate(candidates){
    const confirmed = (Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate && candidate.structureConfirmed === true && Number(candidate.dailyHighCount) >= 2);
    confirmed.sort((a,b) => (
      Number(b.dailyHighCount) - Number(a.dailyHighCount)
      || Number(b.structureScore || 0) - Number(a.structureScore || 0)
      || Number(b.dailyScore || 0) - Number(a.dailyScore || 0)
    ));
    return confirmed[0] || null;
  }

  function candidateItem(score, index, kind, resolver){
    const resolved = resolver(score || {});
    return {
      kind,
      key:kind === "slot" ? `slot${index}` : `week${index + 1}`,
      value:resolved.value,
      bestValue:score?.bestValue || "",
      bestScore:Number(score?.bestScore) || 0,
      secondValue:score?.secondValue || "",
      secondScore:Number(score?.secondScore) || 0,
      margin:Number(score?.margin) || 0,
      metrics:score?.metrics || {},
      confidence:resolved.high ? "自動判定" : "未判定",
      reason:resolved.high ? (resolved.heuristic || "テンプレート照合") : "本番基準を満たしません",
      box:score?.box || null
    };
  }

  function buildManualReview({panelConfirmed, dailyScores, weeklyPanelConfirmed=false, weeklyScores, mappedTimes}={}){
    if(panelConfirmed !== true){
      return {panelConfirmed:false, startSlot:"", slots:[], weeks:[]};
    }
    const inferred = inferStartSlot(mappedTimes, 3);
    const slots = Array.from({length:5}, (_, index) => candidateItem(dailyScores?.[index], index, "slot", resolveDailyScore));
    const resolvedWeeks = Array.isArray(weeklyScores)
      ? weeklyScores.slice(0,5).map((score,index) => candidateItem(score,index,"week",resolveWeeklyScore))
      : [];
    // Weekly is all-or-nothing: an unverified or partially read weekly UI must not
    // be turned into inferred values.
    const weeks = weeklyPanelConfirmed === true
      && resolvedWeeks.length === 5
      && resolvedWeeks.every(item => item.value)
      ? resolvedWeeks
      : [];
    return {
      panelConfirmed:true,
      startSlot:inferred?.startSlot || "",
      startSlotObserved:inferred?.observed || 0,
      slots,
      weeks
    };
  }

  return {
    START_SLOTS,
    expectedSlots,
    inferStartSlot,
    resolveDailyScore,
    resolveWeeklyScore,
    selectPanelCandidate,
    buildManualReview
  };
});
