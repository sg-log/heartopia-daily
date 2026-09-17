const WEATHER_SCHEDULER_TRIGGER_FUNCTION = "runWeatherScheduler";
const WEATHER_SCHEDULER_INTERVAL_MINUTES = 5;
const WEATHER_SCHEDULER_TIME_ZONE = "Asia/Tokyo";
const WEATHER_SCHEDULER_ATTEMPT_PROPERTIES = {
  morningPrimary: "WEATHER_SCHEDULER_MORNING_PRIMARY_DATE",
  morningRetry: "WEATHER_SCHEDULER_MORNING_RETRY_DATE",
  eveningPrimary: "WEATHER_SCHEDULER_EVENING_PRIMARY_DATE",
  eveningRetry: "WEATHER_SCHEDULER_EVENING_RETRY_DATE",
  test20260917_2220: "WEATHER_SCHEDULER_TEST_20260917_2220"
};

/**
 * One-time setup. Creates a five-minute heartbeat that wakes the real GitHub
 * weather workflow around 07:00/07:10 and 19:00/19:10 JST.
 */
function installWeatherScheduler() {
  uninstallWeatherScheduler();
  ScriptApp.newTrigger(WEATHER_SCHEDULER_TRIGGER_FUNCTION)
    .timeBased()
    .everyMinutes(WEATHER_SCHEDULER_INTERVAL_MINUTES)
    .create();
  return getWeatherSchedulerStatus();
}

function uninstallWeatherScheduler() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === WEATHER_SCHEDULER_TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function getWeatherSchedulerStatus() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  return {
    installed: ScriptApp.getProjectTriggers().some(function(trigger) {
      return trigger.getHandlerFunction() === WEATHER_SCHEDULER_TRIGGER_FUNCTION;
    }),
    nowJst: Utilities.formatDate(now, WEATHER_SCHEDULER_TIME_ZONE, "yyyy-MM-dd HH:mm:ss"),
    morningPrimary: String(props.getProperty(WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.morningPrimary) || ""),
    morningRetry: String(props.getProperty(WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.morningRetry) || ""),
    eveningPrimary: String(props.getProperty(WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.eveningPrimary) || ""),
    eveningRetry: String(props.getProperty(WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.eveningRetry) || ""),
    test20260917_2220: String(props.getProperty(WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.test20260917_2220) || "")
  };
}

/**
 * Trigger entry point. It intentionally dispatches at most one attempt per
 * heartbeat. If Apps Script itself wakes late, the next heartbeat catches the
 * missed primary/retry attempt instead of permanently missing that slot.
 */
function runWeatherScheduler() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;

  try {
    const now = new Date();
    const date = Utilities.formatDate(now, WEATHER_SCHEDULER_TIME_ZONE, "yyyy-MM-dd");
    const hour = Number(Utilities.formatDate(now, WEATHER_SCHEDULER_TIME_ZONE, "H"));
    const minute = Number(Utilities.formatDate(now, WEATHER_SCHEDULER_TIME_ZONE, "m"));
    const minuteOfDay = hour * 60 + minute;
    const attempt = nextWeatherSchedulerAttempt_(date, minuteOfDay);
    if (!attempt) return;

    const result = dispatchWeatherAutomationFromScheduler_(date, attempt.slot, attempt.kind);
    if (!result.ok) {
      Logger.log("Weather scheduler dispatch failed: " + JSON.stringify(result));
      return;
    }

    PropertiesService.getScriptProperties().setProperty(attempt.propertyName, date);
    Logger.log("Weather scheduler dispatched " + attempt.name + " for " + date + ".");
  } finally {
    lock.releaseLock();
  }
}

function nextWeatherSchedulerAttempt_(date, minuteOfDay) {
  const props = PropertiesService.getScriptProperties();

  // One-time production-path acceptance test. It uses the normal five-minute
  // Apps Script heartbeat and the real evening workflow, but can fire only on
  // 2026-09-17 and only once. Remove after the acceptance run.
  if (
    date === "2026-09-17" &&
    minuteOfDay >= 22 * 60 + 20 &&
    String(props.getProperty(WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.test20260917_2220) || "") !== date
  ) {
    return {
      name: "acceptance-test-20260917-2220",
      kind: "retry",
      slot: "evening",
      dueMinute: 22 * 60 + 20,
      propertyName: WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.test20260917_2220
    };
  }

  const attempts = minuteOfDay < 19 * 60
    ? [
        {
          name: "morning-primary",
          kind: "primary",
          slot: "morning",
          dueMinute: 7 * 60,
          propertyName: WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.morningPrimary
        },
        {
          name: "morning-retry",
          kind: "retry",
          slot: "morning",
          dueMinute: 7 * 60 + 10,
          propertyName: WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.morningRetry
        }
      ]
    : [
        {
          name: "evening-primary",
          kind: "primary",
          slot: "evening",
          dueMinute: 19 * 60,
          propertyName: WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.eveningPrimary
        },
        {
          name: "evening-retry",
          kind: "retry",
          slot: "evening",
          dueMinute: 19 * 60 + 10,
          propertyName: WEATHER_SCHEDULER_ATTEMPT_PROPERTIES.eveningRetry
        }
      ];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (minuteOfDay < attempt.dueMinute) continue;
    if (String(props.getProperty(attempt.propertyName) || "") === date) continue;
    return attempt;
  }
  return null;
}

function dispatchWeatherAutomationFromScheduler_(targetDate, slot, attemptKind) {
  const token = String(PropertiesService.getScriptProperties().getProperty(GITHUB_ACTIONS_TOKEN_PROPERTY) || "").trim();
  if (!token) {
    return { ok:false, error:"GitHub連携が未設定です。", failureCode:"githubAutomationNotConfigured" };
  }

  const kind = String(attemptKind || "").trim();
  if (["primary", "retry"].indexOf(kind) < 0) {
    return { ok:false, error:"天気自動更新の試行種別が不正です。", failureCode:"githubAutomationAttemptInvalid" };
  }

  const endpoint = "https://api.github.com/repos/" + GITHUB_REPOSITORY + "/actions/workflows/" + encodeURIComponent(GITHUB_WEATHER_WORKFLOW) + "/dispatches";
  const response = UrlFetchApp.fetch(endpoint, {
    method:"post",
    muteHttpExceptions:true,
    contentType:"application/json",
    headers:{
      Authorization:"Bearer " + token,
      Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"heartopia-daily-apps-script-scheduler"
    },
    payload:JSON.stringify({
      ref:"main",
      inputs:{
        slot:slot,
        target_date:targetDate,
        trigger_origin:"apps-script",
        attempt_kind:kind
      }
    })
  });

  const status = response.getResponseCode();
  if (status !== 204) {
    return {
      ok:false,
      error:"GitHub Actionsを起動できませんでした（HTTP " + status + "）。",
      failureCode:"githubAutomationDispatchFailed",
      httpStatus:status
    };
  }
  return { ok:true, status:"accepted", targetDate:targetDate, slot:slot, attemptKind:kind };
}
