import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";
import path from "node:path";
import test from "node:test";
import {chromium} from "playwright";

const root=process.cwd();
const screenshot={
 schemaVersion:1,source:"game-screenshot",baseDate:"2026-10-21",
 days:[
  {date:"2026-10-22",weather:"流星群"},{date:"2026-10-23",weather:"虹"},
  {date:"2026-10-24",weather:"晴"},{date:"2026-10-25",weather:"雨"},
  {date:"2026-10-26",weather:"晴"},{date:"2026-10-27",weather:"晴"},
  {date:"2026-10-28",weather:"晴"}
 ]
};
function startServer(){
 const server=createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,"http://localhost").pathname;
   const file=path.resolve(root,"."+decodeURIComponent(pathname==="/"?"/index.html":pathname));
   if(!file.startsWith(root+path.sep))throw Error("outside root");
   const body=await readFile(file);
   const type=file.endsWith(".js")?"text/javascript":file.endsWith(".json")?"application/json":file.endsWith(".css")?"text/css":file.endsWith(".png")?"image/png":"text/html; charset=utf-8";
   res.writeHead(200,{"Content-Type":type});res.end(body);
  }catch(_){res.writeHead(404);res.end("not found");}
 });
 return new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve(server)));
}
test("管理画面の取り込みリンク→既存表示差分→保存→再取得をブラウザで検証",async()=>{
 const server=await startServer();
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:"Asia/Tokyo"});
  await context.addInitScript(()=>{
   sessionStorage.setItem("heartopiaAdminKey","SECRET");
  });
  const page=await context.newPage(),errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  const blank=Object.fromEntries(Array.from({length:7},(_,i)=>["week"+(i+1),[]]));
  const prior={date:"2026-10-20",startSlot:"12",slots:Object.fromEntries(Array.from({length:5},(_,i)=>["slot"+i,["晴"]])),weeks:{...blank,week2:["雨"],week3:["晴"]}};
  const existing=[];
  let saved=null,writeCalls=0;
  await page.route("**/*",async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.hostname==="127.0.0.1"){await route.continue();return;}
   if(url.hostname!=="script.google.com"){await route.abort();return;}
   let body={};try{body=JSON.parse(request.postData()||"{}");}catch(_){}
   const action=url.searchParams.get("action")||body.action||"";
   let result={ok:true};
   switch(action){
    case "approved":result={ok:true,reports:[prior]};break;
    case "getWeeklyForecasts":result={ok:true,forecasts:existing};break;
    case "saveWeeklyForecast":{
      writeCalls++;saved=body;
      const weeks=structuredClone(blank);
      body.updates.forEach(row=>{const n=Math.round((Date.parse(row.date)-Date.parse(body.baseDate))/86400000);weeks["week"+n]=[row.weather];});
      const forecast={baseDate:body.baseDate,weeks};
      existing.push(forecast);result={ok:true,forecast};break;
    }
    case "getWeatherCalendar":result={ok:true,enabled:false,calendar:null};break;
    case "getGiftCodes":result={ok:true,codes:[]};break;
    case "getSiteNotice":result={ok:true,notice:{}};break;
    case "getAccessStats":result={ok:true,stats:{}};break;
    case "pending":result={ok:true,reports:[]};break;
    default:result={ok:true};break;
   }
   await route.fulfill({status:200,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"},body:JSON.stringify(result)});
  });
  const hash="weekly-import="+encodeURIComponent(JSON.stringify(screenshot));
  await page.goto("http://127.0.0.1:"+server.address().port+"/index.html?admin=1#"+hash,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>Boolean(globalThis.HeartopiaWeeklyAIImport && document.getElementById("aiWeeklyImportJson")?.value));
  assert.equal(await page.locator("#quickWeatherDate").inputValue(),"2026-10-21");
  assert.equal(await page.locator("#aiWeeklyImportPanel").evaluate(el=>el.open),true);
  assert.equal(writeCalls,0,"a link should never cause an automatic save");
  await page.locator("#aiWeeklyPreviewBtn").click();
  await page.waitForFunction(()=>document.getElementById("aiWeeklyImportPreview")?.textContent.includes("雨 → 流星群"));
  assert.equal(await page.locator("#aiWeeklySaveBtn").isEnabled(),true);
  await page.locator("#aiWeeklySaveBtn").click();
  await page.waitForFunction(()=>document.getElementById("aiWeeklyImportStatus")?.textContent.includes("保存と再取得を確認"));
  assert.equal(writeCalls,1);
  assert.equal(saved.action,"saveWeeklyForecast");
  assert.equal(saved.adminKey,"SECRET");
  assert.equal(saved.updates.length,7);
  assert.equal(saved.slot0,undefined);
  const weather=await page.evaluate(()=>({
   week1:weatherData("2026-10-21")?.weeks.week1,
   carry:weatherData("2026-10-22")?.weeks.week1
  }));
  assert.deepEqual(weather,{week1:["流星群"],carry:["虹"]});
  assert.deepEqual(errors,[]);
 }finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
 }
});
