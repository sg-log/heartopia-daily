import fs from 'node:fs';

function replaceOnce(text, needle, replacement, label) {
  const first = text.indexOf(needle);
  if (first < 0) throw new Error(`Missing patch target: ${label}`);
  if (text.indexOf(needle, first + needle.length) >= 0) throw new Error(`Patch target is not unique: ${label}`);
  return text.slice(0, first) + replacement + text.slice(first + needle.length);
}

const indexPath = 'index.html';
let index = fs.readFileSync(indexPath, 'utf8');

const dailyNeedle = `        <div class="adminTabPanel active" data-admin-panel="daily" role="tabpanel">\n          <div class="card s12">\n            <h2>天気を登録</h2>`;
const dailyReplacement = `        <div class="adminTabPanel active" data-admin-panel="daily" role="tabpanel">\n          <div class="card s12">\n            <h2>天気自動更新</h2>\n            <p class="small">ネット上の最新候補を探す自動更新を手動で起動します。同じ対象日・同じ便が成功済みなら重複実行しません。</p>\n            <div class="row">\n              <div><label for="weatherAutomationDate">対象日</label><input id="weatherAutomationDate" type="date"></div>\n              <div>\n                <label for="weatherAutomationSlot">便</label>\n                <select id="weatherAutomationSlot">\n                  <option value="morning">朝便</option>\n                  <option value="evening">夜便</option>\n                </select>\n              </div>\n            </div>\n            <div class="buttons"><button type="button" id="runWeatherAutomationBtn">今すぐ実行</button></div>\n            <div id="weatherAutomationStatus" class="status"></div>\n          </div>\n\n          <div class="card s12">\n            <h2>天気を登録</h2>`;
index = replaceOnce(index, dailyNeedle, dailyReplacement, 'admin daily weather card');

const idsNeedle = `  "weatherAdminKey","refreshPendingWeatherBtn","pendingWeatherStatus","pendingWeatherReports",`;
const idsReplacement = `  "weatherAutomationDate","weatherAutomationSlot","runWeatherAutomationBtn","weatherAutomationStatus",\n  "weatherAdminKey","refreshPendingWeatherBtn","pendingWeatherStatus","pendingWeatherReports",`;
index = replaceOnce(index, idsNeedle, idsReplacement, 'admin trigger element ids');

const functionNeedle = `async function fetchPendingWeatherReports(){`;
const functionReplacement = `function jstHourValue(date = new Date()){\n  const parts = new Intl.DateTimeFormat("en-US", {\n    timeZone:"Asia/Tokyo",\n    hour:"2-digit",\n    hour12:false\n  }).formatToParts(date);\n  return Number(parts.find(part => part.type === "hour")?.value || 0);\n}\n\nasync function runWeatherAutomation(){\n  if(!WEATHER_API_URL){\n    E.weatherAutomationStatus.textContent = "天気自動更新APIは未設定です。";\n    return;\n  }\n  if(!adminKeyValue()){\n    E.weatherAutomationStatus.textContent = "管理キーを入力してください。";\n    return;\n  }\n  const targetDate = normalizeApiDate(E.weatherAutomationDate.value);\n  const slot = E.weatherAutomationSlot.value;\n  if(!/^20\\d{2}-\\d{2}-\\d{2}$/.test(targetDate)){\n    E.weatherAutomationStatus.textContent = "対象日を入力してください。";\n    return;\n  }\n  if(!["morning","evening"].includes(slot)){\n    E.weatherAutomationStatus.textContent = "朝便か夜便を選んでください。";\n    return;\n  }\n  E.runWeatherAutomationBtn.disabled = true;\n  E.weatherAutomationStatus.textContent = "自動更新の起動要求を送っています…";\n  try{\n    const result = await apiPost({\n      action:"requestWeatherAutomation",\n      adminKey:adminKeyValue(),\n      targetDate,\n      slot\n    });\n    if(result.ok === false) throw new Error(result.error || "起動できませんでした");\n    E.weatherAutomationStatus.textContent = targetDate + " " + (slot === "morning" ? "朝便" : "夜便") + "を起動しました。結果はDiscordまたは未承認の天気報告で確認できます。";\n    toast("天気自動更新を起動しました");\n  }catch(error){\n    E.weatherAutomationStatus.textContent = "起動できませんでした：" + error.message;\n  }finally{\n    E.runWeatherAutomationBtn.disabled = false;\n  }\n}\n\nasync function fetchPendingWeatherReports(){`;
index = replaceOnce(index, functionNeedle, functionReplacement, 'manual automation function');

const initDateNeedle = `  E.quickWeatherDate.value = E.targetDate.value;`;
const initDateReplacement = `  E.quickWeatherDate.value = E.targetDate.value;\n  E.weatherAutomationDate.value = jstDateValue();\n  E.weatherAutomationSlot.value = jstHourValue() < 13 ? "morning" : "evening";`;
index = replaceOnce(index, initDateNeedle, initDateReplacement, 'manual automation defaults');

const bindNeedle = `  E.saveQuickWeatherBtn.onclick = saveQuickWeather;`;
const bindReplacement = `  E.saveQuickWeatherBtn.onclick = saveQuickWeather;\n  E.runWeatherAutomationBtn.onclick = runWeatherAutomation;`;
index = replaceOnce(index, bindNeedle, bindReplacement, 'manual automation click binding');
fs.writeFileSync(indexPath, index, 'utf8');

const appsPath = 'apps-script/weather-api.gs';
let apps = fs.readFileSync(appsPath, 'utf8');
const constNeedle = `const DISCORD_WEBHOOK_URL_PROPERTY = "DISCORD_WEBHOOK_URL";`;
const constReplacement = `const DISCORD_WEBHOOK_URL_PROPERTY = "DISCORD_WEBHOOK_URL";\nconst GITHUB_ACTIONS_TOKEN_PROPERTY = "GITHUB_ACTIONS_TOKEN";\nconst GITHUB_REPOSITORY = "sg-log/heartopia-daily";\nconst GITHUB_WEATHER_WORKFLOW = "weather-scheduled-run.yml";`;
apps = replaceOnce(apps, constNeedle, constReplacement, 'Apps Script GitHub constants');

const actionNeedle = `    if (action === "getAccessStats") return getAccessStats_(body);`;
const actionReplacement = `    if (action === "getAccessStats") return getAccessStats_(body);\n    if (action === "requestWeatherAutomation") return requestWeatherAutomation_(body);`;
apps = replaceOnce(apps, actionNeedle, actionReplacement, 'Apps Script dispatch action');

const publicNeedle = `function publicWeatherItem_(item) {`;
const publicReplacement = `function requestWeatherAutomation_(body) {\n  requireKey_(body.adminKey, adminKey_(), "管理キー");\n  const targetDate = validateDateForWrite_(body.targetDate);\n  const slot = String(body.slot || "").trim();\n  if (["morning", "evening"].indexOf(slot) < 0) throw new Error("便が不正です");\n\n  const token = String(PropertiesService.getScriptProperties().getProperty(GITHUB_ACTIONS_TOKEN_PROPERTY) || "").trim();\n  if (!token) return json_({ ok:false, error:"GitHub連携が未設定です。", failureCode:"githubAutomationNotConfigured" });\n\n  const endpoint = "https://api.github.com/repos/" + GITHUB_REPOSITORY + "/actions/workflows/" + encodeURIComponent(GITHUB_WEATHER_WORKFLOW) + "/dispatches";\n  const response = UrlFetchApp.fetch(endpoint, {\n    method:"post",\n    muteHttpExceptions:true,\n    contentType:"application/json",\n    headers:{\n      Authorization:"Bearer " + token,\n      Accept:"application/vnd.github+json",\n      "X-GitHub-Api-Version":"2022-11-28",\n      "User-Agent":"heartopia-daily-apps-script"\n    },\n    payload:JSON.stringify({\n      ref:"main",\n      inputs:{ slot:slot, target_date:targetDate }\n    })\n  });\n  const status = response.getResponseCode();\n  if (status !== 204) {\n    Logger.log("GitHub weather workflow dispatch failed: HTTP " + status);\n    return json_({ ok:false, error:"GitHub Actionsを起動できませんでした（HTTP " + status + "）。", failureCode:"githubAutomationDispatchFailed" });\n  }\n  return json_({ ok:true, status:"accepted", targetDate:targetDate, slot:slot });\n}\n\nfunction publicWeatherItem_(item) {`;
apps = replaceOnce(apps, publicNeedle, publicReplacement, 'Apps Script dispatch implementation');
fs.writeFileSync(appsPath, apps, 'utf8');

const workflowPath = '.github/workflows/weather-scheduled-run.yml';
let workflow = fs.readFileSync(workflowPath, 'utf8');
const workflowInputNeedle = `        default: auto\n`;
const workflowInputReplacement = `        default: auto\n      target_date:\n        description: 'JST target date (YYYY-MM-DD); blank means today'\n        required: false\n        type: string\n        default: ''\n`;
workflow = replaceOnce(workflow, workflowInputNeedle, workflowInputReplacement, 'workflow target date input');

const manualEnvNeedle = `          MANUAL_SLOT: ${{ inputs.slot }}`;
const manualEnvReplacement = `          MANUAL_SLOT: ${{ inputs.slot }}\n          MANUAL_TARGET_DATE: ${{ inputs.target_date }}`;
workflow = replaceOnce(workflow, manualEnvNeedle, manualEnvReplacement, 'workflow manual date env');

const manualValidationNeedle = `            if ($slot -notin @('morning','evening')) { throw 'Invalid manual slot.' }\n          }`;
const manualValidationReplacement = `            if ($slot -notin @('morning','evening')) { throw 'Invalid manual slot.' }\n            $manualTargetDate = [string]$env:MANUAL_TARGET_DATE\n            if (-not [string]::IsNullOrWhiteSpace($manualTargetDate)) {\n              try { [void][datetime]::ParseExact($manualTargetDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }\n              catch { throw 'Invalid manual target date.' }\n              $targetDate = $manualTargetDate\n            }\n          }`;
workflow = replaceOnce(workflow, manualValidationNeedle, manualValidationReplacement, 'workflow manual target date validation');
fs.writeFileSync(workflowPath, workflow, 'utf8');

console.log('Applied weather admin trigger patch.');
