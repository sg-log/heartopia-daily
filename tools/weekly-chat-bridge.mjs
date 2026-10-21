import fs from "node:fs/promises";

const API = "https://script.google.com/macros/s/AKfycbwoPLuj0rSsennsx01-B-6UxqBjqnPieocgVLQnJMKEgRw6fZziV5ZGVA3SusjVLF3o/exec";
const WEATHER = new Set(["晴", "雨", "流星群", "虹", "猛暑", "雪", "桜"]);
const KEYS = Array.from({length: 7}, (_, i) => "week" + (i + 1));
const REQUEST_HEADER = "<!-- HEARTOPIA_WEEKLY_CHAT_REQUEST_V1\n";
const REQUEST_FOOTER = "\n-->";
const RESULT_HEADER = "<!-- HEARTOPIA_WEEKLY_CHAT_RESULT_V1 -->\n";

export function validDate(input) {
  if (typeof input !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(input)) throw Error("Invalid game date");
  const d = new Date(input + "T00:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== input) throw Error("Invalid calendar day");
  return input;
}
function plus(date, n) {
  const d = new Date(validDate(date) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function keysMatch(obj, keys) {
  return obj && typeof obj === "object" && !Array.isArray(obj) &&
    Object.keys(obj).sort().join("|") === keys.slice().sort().join("|");
}
function values(arr, max = 1) {
  if (!Array.isArray(arr) || arr.length > max || arr.some(w => !WEATHER.has(w)) ||
      new Set(arr).size !== arr.length) throw Error("Invalid stored weather");
  return arr.slice();
}
function blank() {
  return Object.fromEntries(KEYS.map(key => [key, []]));
}
function normalizedWeeks(weeks, max = 1) {
  const obj = blank();
  if (!weeks || typeof weeks !== "object" || Array.isArray(weeks)) throw Error("Invalid week data");
  for (const key of KEYS) obj[key] = values(weeks[key] || [], max);
  return obj;
}
export function parseRequest(issue) {
  if (!issue || issue.pull_request) throw Error("Not a weather update issue");
  const body = String(issue.body || "");
  if (!body.startsWith(REQUEST_HEADER) || !body.endsWith(REQUEST_FOOTER) || body.length > 8500)
    throw Error("Invalid chat request envelope");
  let data;
  try { data = JSON.parse(body.slice(REQUEST_HEADER.length, -REQUEST_FOOTER.length)); }
  catch (_) { throw Error("Invalid chat request JSON"); }
  const baseDate = validDate(data?.baseDate);
  if (data?.v !== 1 || !["read","save"].includes(data.type)) throw Error("Invalid request type");
  const title = "Heartopia weekly chat " + data.type.toUpperCase() + " " + baseDate;
  if (issue.title !== title) throw Error("Issue title does not match request");
  if (data.type === "read") {
    if (!keysMatch(data, ["v","type","baseDate"])) throw Error("Invalid read request shape");
    return {type:"read",baseDate};
  }
  if (!keysMatch(data,["v","type","baseDate","readAt","expected","expectedVisible","updates"])) throw Error("Invalid save request shape");
  const readAt = new Date(data.readAt);
  const age = Date.now() - readAt.getTime();
  if (typeof data.readAt !== "string" || !Number.isFinite(age) || age < -60000 || age > 30 * 60000)
    throw Error("The comparison is older than 30 minutes. Read the latest data again.");
  if (!keysMatch(data.expected, KEYS) || !keysMatch(data.expectedVisible, KEYS))
    throw Error("Missing comparison state");
  const expected = normalizedWeeks(data.expected);
  const expectedVisible = normalizedWeeks(data.expectedVisible, 4);
  if (!Array.isArray(data.updates) || data.updates.length < 1 || data.updates.length > 7)
    throw Error("Updates must contain 1 to 7 weather days");
  const days = new Set();
  const updates = data.updates.map(row => {
    if (!keysMatch(row,["date","weather"])) throw Error("Invalid day entry");
    const date = validDate(row.date);
    const offset = (Date.parse(date+"T00:00:00Z") - Date.parse(baseDate+"T00:00:00Z")) / 86400000;
    if (!Number.isInteger(offset) || offset < 1 || offset > 7 || days.has(date) || !WEATHER.has(row.weather))
      throw Error("Invalid or repeated forecast day");
    days.add(date);
    return {date,weather:row.weather};
  });
  return {type:"save",baseDate,readAt:data.readAt,expected,expectedVisible,updates};
}
export function requestBody(data) {
  return REQUEST_HEADER + JSON.stringify(data) + REQUEST_FOOTER;
}
export function resultBody(data) {
  return RESULT_HEADER + "&#96;&#96;&#96;json\n" + JSON.stringify(data) + "\n&#96;&#96;&#96;";
}
function normalizedRecords(records) {
  if (!Array.isArray(records) || records.length > 5000) throw Error("Invalid independent weekly response");
  const byDate = new Map();
  for (const record of records) {
    const date = validDate(record.baseDate);
    if (byDate.has(date)) throw Error("Duplicate independent weekly forecast: " + date);
    byDate.set(date,normalizedWeeks(record.weeks));
  }
  return byDate;
}
function normalizedApproved(reports) {
  if (!Array.isArray(reports) || reports.length > 5000) throw Error("Invalid approved response");
  const byDate = new Map();
  for (const report of reports) {
    const date = validDate(report.date);
    byDate.set(date, normalizedWeeks(report.weeks || {}, 4));
  }
  return byDate;
}
export function snapshot(baseDate, forecasts, approved, checkedAt = new Date().toISOString()) {
  validDate(baseDate);
  const standalone = normalizedRecords(forecasts);
  const legacy = normalizedApproved(approved);
  const independentIndex = new Map();
  const legacyIndex = new Map();
  for (const [date, weeks] of [...standalone].sort((a,b)=>a[0].localeCompare(b[0]))) {
    KEYS.forEach((key,i) => { if (weeks[key].length) independentIndex.set(plus(date,i+1),weeks[key]); });
  }
  for (const [date, weeks] of [...legacy].sort((a,b)=>a[0].localeCompare(b[0]))) {
    KEYS.forEach((key,i) => { if (weeks[key].length) legacyIndex.set(plus(date,i+1),weeks[key]); });
  }
  const direct = standalone.get(baseDate) || blank();
  const directLegacy = legacy.get(baseDate) || blank();
  const visible = blank();
  KEYS.forEach((key,i) => {
    const day = plus(baseDate,i+1);
    visible[key] = (direct[key].length ? direct[key] :
      (independentIndex.get(day)?.length ? independentIndex.get(day) :
      (directLegacy[key].length ? directLegacy[key] : (legacyIndex.get(day) || [])))).slice();
  });
  return {baseDate,checkedAt,expected:direct,visible,days:KEYS.map((key,i)=>({date:plus(baseDate,i+1),weather:visible[key]}))};
}
export async function readLive(baseDate, fetchFn=fetch) {
  const load = async action => {
    const url = API + "?action=" + encodeURIComponent(action);
    const response = await fetchFn(url,{redirect:"follow",signal:AbortSignal.timeout(45000)});
    if (!response.ok) throw Error("Public API HTTP " + response.status + " (" + action + ")");
    const obj = await response.json();
    if (obj?.ok !== true) throw Error("Public API returned an error (" + action + ")");
    return obj;
  };
  const [weekly,approved] = await Promise.all([load("getWeeklyForecasts"),load("approved")]);
  return snapshot(baseDate,weekly.forecasts,approved.reports);
}
export async function runRequest(request,{fetchFn=fetch,adminKey=""}={}) {
  const before = await readLive(request.baseDate,fetchFn);
  if (request.type === "read") return {ok:true,type:"read",...before};
  if (JSON.stringify(before.expected) !== JSON.stringify(request.expected) ||
      JSON.stringify(before.visible) !== JSON.stringify(request.expectedVisible)) {
    return {ok:false,type:"save",code:"stale-comparison",message:"登録済みの週間予報が照合後に変わりました。再度読み取り・確認してください。"};
  }
  if (request.updates.every(row => {
    const i=(Date.parse(row.date+"T00:00:00Z")-Date.parse(request.baseDate+"T00:00:00Z"))/86400000;
    return JSON.stringify(before.visible["week"+i])===JSON.stringify([row.weather]);
  })) return {ok:true,type:"save",status:"no-change",baseDate:request.baseDate,verified:true};
  if (!adminKey) throw Error("GitHub Actions WEATHER_ADMIN_KEY is missing");
  const payload = {action:"saveWeeklyForecast",adminKey,baseDate:request.baseDate,
    expected:request.expected,updates:request.updates};
  const response = await fetchFn(API,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},
    body:JSON.stringify(payload),redirect:"follow",signal:AbortSignal.timeout(45000)});
  if (!response.ok) throw Error("Weekly save API returned HTTP " + response.status);
  const result = await response.json();
  if (result?.ok !== true || !result.forecast) {
    throw Error("Weekly save API rejected the update: " + String(result?.error || "unknown").slice(0,120));
  }
  const after = await readLive(request.baseDate,fetchFn);
  const success = request.updates.every(row=>{
    const i=(Date.parse(row.date+"T00:00:00Z")-Date.parse(request.baseDate+"T00:00:00Z"))/86400000;
    return JSON.stringify(after.expected["week"+i])===JSON.stringify([row.weather]);
  });
  return {ok:success,type:"save",status:success?"saved":"verify-failed",baseDate:request.baseDate,
    verified:success,days:request.updates};
}
async function comment(repo,issueNumber,body,token,fetchFn=fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw Error("Invalid repository");
  const url="https://api.github.com/repos/"+repo+"/issues/"+issueNumber+"/comments";
  const response=await fetchFn(url,{method:"POST",headers:{
    Authorization:"Bearer "+token,Accept:"application/vnd.github+json",
    "Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28"
  },body:JSON.stringify({body}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error("Could not post result: HTTP "+response.status);
}
export async function runEvent(event,env,fetchFn=fetch) {
  const owner=String(env.GITHUB_REPOSITORY_OWNER||"");
  const repo=String(env.GITHUB_REPOSITORY||"");
  const login=String(event?.issue?.user?.login||"");
  if (!owner || repo !== owner+"/heartopia-daily" || login !== owner ||
      event.action !== "opened" || event.issue.pull_request ||
      !/^Heartopia weekly chat (READ|SAVE) 20\d{2}-\d{2}-\d{2}$/.test(event.issue.title||"")) {
    return {ignored:true};
  }
  const number=event.issue.number;
  if (!Number.isInteger(number)||number<1)throw Error("Invalid issue number");
  let data;
  try {
    const req=parseRequest(event.issue);
    data=await runRequest(req,{fetchFn,adminKey:env.WEATHER_ADMIN_KEY||""});
  }catch(error) {
    data={ok:false,type:"error",message:String(error.message||error).slice(0,180)};
  }
  const token=String(env.GITHUB_TOKEN||"");
  if (!token)throw Error("Issue comment token missing");
  await comment(repo,number,resultBody(data),token,fetchFn);
  if (data.ok !== true) throw Error("Weekly chat job failed. See issue comment for details.");
  return data;
}
if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const event=JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH,"utf8"));
  await runEvent(event,process.env);
}
