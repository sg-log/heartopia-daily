import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const parserContext=vm.createContext({});
vm.runInContext(fs.readFileSync(new URL("../assets/weekly-ai-import.js",import.meta.url),"utf8"),parserContext);
const parse=parserContext.HeartopiaWeeklyAIImport.parse;
function payload(baseDate,days){
 return JSON.stringify({schemaVersion:1,source:"game-screenshot",baseDate,days});
}
const baseDate="2026-10-20";
test("7日分と部分更新を解釈する",()=>{
 const days=Array.from({length:7},(_,i)=>({date:"2026-10-"+String(21+i),weather:"晴"}));
 assert.equal(parse(payload(baseDate,days),baseDate).days.length,7);
 assert.equal(parse(payload(baseDate,[{date:"2026-10-23",weather:"虹"}]),baseDate).days[0].key,"week3");
});
test("不正な日付と天気は拒否する",()=>{
 const valid=[{date:"2026-10-21",weather:"晴"}];
 assert.throws(()=>parse(payload(baseDate,valid),"2026-10-21"));
 assert.throws(()=>parse(payload(baseDate,[...valid,...valid]),baseDate));
 assert.throws(()=>parse(payload(baseDate,[{date:"2026-10-21",weather:"曇"}]),baseDate));
 assert.throws(()=>parse(payload(baseDate,[{date:"2026-10-28",weather:"晴"}]),baseDate));
 assert.equal(parse(payload("2026-10-31",[{date:"2026-11-01",weather:"晴"}]),"2026-10-31").days[0].key,"week1");
});

function fakeBackend(){
 const sheets=new Map(),visited=[];
 function makeSheet(){
  const rows=[];
  return {rows,getLastRow:()=>rows.length,getMaxRows:()=>100,getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),getRange:(r,c,nr=1,nc=1)=>({
   getValues:()=>Array.from({length:nr},(_,i)=>Array.from({length:nc},(_,j)=>rows[r+i-1]?.[c+j-1]||"")),
   setValues:values=>values.forEach((line,i)=>{rows[r+i-1]??=[];line.forEach((v,j)=>rows[r+i-1][c+j-1]=v);}),
   setValue:v=>{rows[r-1]??=[];rows[r-1][c-1]=v;},
   setNumberFormat:()=>{}
  }),insertRowsAfter:()=>{}};
 }
 const spreadsheet={
  getSheetByName:n=>{visited.push(n);return sheets.get(n)||null;},
  insertSheet:n=>{const s=makeSheet();sheets.set(n,s);return s;}
 };
 const output={MimeType:{JSON:"json"},createTextOutput:s=>({text:s,setMimeType(){return this;}})};
 const context=vm.createContext({
  SpreadsheetApp:{getActiveSpreadsheet:()=>spreadsheet},
  PropertiesService:{getScriptProperties:()=>({getProperty:()=> "SECRET"})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
  ContentService:output
 });
 vm.runInContext(fs.readFileSync(new URL("../apps-script/weather-api.gs",import.meta.url),"utf8"),context);
 return {save:vm.runInContext("saveWeeklyForecast_",context),list:vm.runInContext("listWeeklyForecasts_",context),visited};
}
test("週間専用の保存は他の天気データを触らず、未指定日を維持する",()=>{
 const api=fakeBackend();
 const empty=Object.fromEntries(Array.from({length:7},(_,i)=>["week"+(i+1),[]]));
 const doSave=(expected,updates)=>JSON.parse(api.save({adminKey:"SECRET",baseDate,expected,updates}).text);
 const r1=doSave(empty,[{date:"2026-10-21",weather:"雨"},{date:"2026-10-27",weather:"桜"}]);
 assert.equal(r1.ok,true);
 assert.deepEqual(JSON.parse(JSON.stringify(api.list()[0].weeks.week1)),["雨"]);
 assert.throws(()=>doSave(empty,[{date:"2026-10-22",weather:"晴"}]),/更新/);
 const current=JSON.parse(JSON.stringify(api.list()[0].weeks));
 doSave(current,[{date:"2026-10-22",weather:"雪"}]);
 const saved=api.list()[0].weeks;
 assert.deepEqual(JSON.parse(JSON.stringify(saved.week1)),["雨"]);
 assert.deepEqual(JSON.parse(JSON.stringify(saved.week2)),["雪"]);
 assert.deepEqual(JSON.parse(JSON.stringify(saved.week7)),["桜"]);
 assert.throws(()=>doSave(JSON.parse(JSON.stringify(saved)),[{date:"2026-10-28",weather:"晴"}]));
 assert.equal(api.visited.includes("weather_reports"),false);
});

const observedScreenshot={
 schemaVersion:1,source:"game-screenshot",baseDate:"2026-10-21",
 days:[
  {date:"2026-10-22",weather:"流星群"},{date:"2026-10-23",weather:"虹"},
  {date:"2026-10-24",weather:"晴"},{date:"2026-10-25",weather:"雨"},
  {date:"2026-10-26",weather:"晴"},{date:"2026-10-27",weather:"晴"},
  {date:"2026-10-28",weather:"晴"}
 ]
};
test("実スクショ7日分からリンクを作成・復元できる",()=>{
 const context=vm.createContext({URL});
 vm.runInContext(fs.readFileSync(new URL("../assets/weekly-ai-import.js",import.meta.url),"utf8"),context);
 const api=context.HeartopiaWeeklyAIImport;
 const url=api.buildImportLink(observedScreenshot,"https://sg-log.github.io/heartopia-daily/");
 assert.ok(url.startsWith("https://sg-log.github.io/heartopia-daily/?admin=1#weekly-import="));
 const imported=api.parseImportHash(new URL(url).hash);
 assert.equal(imported.baseDate,"2026-10-21");
 assert.deepEqual(JSON.parse(JSON.stringify(api.parse(imported.text,"2026-10-21").days.map(x=>x.weather))),["流星群","虹","晴","雨","晴","晴","晴"]);
 assert.throws(()=>api.parseImportHash("#weekly-import=%ZZ"));
});
test("リンクを開くだけでは保存せず、差分確認後に週間データだけ保存する",async()=>{
 const url=new URL("https://sg-log.github.io/heartopia-daily/?admin=1");
 url.hash="weekly-import="+encodeURIComponent(JSON.stringify(observedScreenshot));
 const handlers={};
 const elements=Object.fromEntries(["aiWeeklyImportJson","aiWeeklyImportPreview","aiWeeklyImportStatus","aiWeeklyPreviewBtn","aiWeeklySaveBtn","aiWeeklyImportPanel"].map(id=>[id,{
  id,hidden:false,disabled:false,textContent:"",value:"",open:false,
  addEventListener:(type,fn)=>{handlers[id+":"+type]=fn;},
  scrollIntoView:()=>{}
 }]));
 const historyCalls=[];
 const context=vm.createContext({
  URL,location:url,history:{replaceState:(...args)=>historyCalls.push(args)},
  document:{getElementById:id=>elements[id]||null}
 });
 vm.runInContext(fs.readFileSync(new URL("../assets/weekly-ai-import.js",import.meta.url),"utf8"),context);
 const api=context.HeartopiaWeeklyAIImport;
 const dateInput={value:"2026-10-20",addEventListener:(name,fn)=>{handlers["date:"+name]=fn;}};
 let saved=null,renderCount=0;
 const empty=Object.fromEntries(Array.from({length:7},(_,i)=>["week"+(i+1),[]]));
 let backend={ok:true,forecasts:[]};
 api.mount({
  dateInput,apiUrl:()=>"https://example.test",adminKey:()=>"SECRET",
  onDateChanged:()=>{},reveal:()=>{},normalizeApiDate:x=>x,
  getVisibleWeeks:()=>({...empty,week1:["雨"]}),
  readWeeklyForecasts:async()=>backend,
  setWeeklyForecastRecord:()=>{},
  renderToday:()=>{renderCount++;},
  apiPost:async payload=>{
   saved=payload;
   const weeks=JSON.parse(JSON.stringify(empty));
   payload.updates.forEach((d,i)=>{weeks["week"+(i+1)]=[d.weather];});
   backend={ok:true,forecasts:[{baseDate:payload.baseDate,weeks}]};
   return {ok:true,forecast:backend.forecasts[0]};
  }
 });
 assert.equal(dateInput.value,"2026-10-21");
 assert.equal(elements.aiWeeklyImportPanel.open,true);
 assert.ok(elements.aiWeeklyImportJson.value.includes("流星群"));
 assert.equal(saved,null,"link must never auto-save");
 assert.equal(historyCalls.length,1);
 await handlers["aiWeeklyPreviewBtn:click"]();
 assert.ok(elements.aiWeeklyImportPreview.textContent.includes("雨 → 流星群"));
 assert.equal(elements.aiWeeklySaveBtn.disabled,false);
 await handlers["aiWeeklySaveBtn:click"]();
 assert.equal(saved.action,"saveWeeklyForecast");
 assert.ok(!("slots" in saved) && !("slot0" in saved),"daily forecast must be untouched");
 assert.equal(saved.updates.length,7);
 assert.equal(renderCount,1);
 assert.match(elements.aiWeeklyImportStatus.textContent,/保存と再取得を確認/);
});
