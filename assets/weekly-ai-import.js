(function(root){
"use strict";
const allowed=new Set(["晴","雨","流星群","虹","猛暑","雪","桜"]);
const slotKeys=["slot0","slot1","slot2","slot3","slot4"];
const weekKeys=["week1","week2","week3","week4","week5","week6","week7"];
function date(s){
 if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Error("日付はYYYY-MM-DD形式で指定してください。");
 const [y,m,d]=s.split("-").map(Number),v=new Date(Date.UTC(y,m-1,d));
 if(v.getUTCFullYear()!==y||v.getUTCMonth()!==m-1||v.getUTCDate()!==d) throw Error("存在しない日付です。");
 return s;
}
function offset(base,s){
 const utc=x=>{const [y,m,d]=x.split("-").map(Number);return Date.UTC(y,m-1,d);};
 return Math.round((utc(s)-utc(base))/86400000);
}
function parse(text,expected){
 if(typeof text!=="string"||text.length>12000) throw Error("JSONが長すぎます。");
 const fence=String.fromCharCode(96).repeat(3);
 const clean=text.trim().replace(new RegExp("^"+fence+"(?:json)?\\s*\\n","i"),"").replace(new RegExp("\\n"+fence+"\\s*$"),"");
 let obj;try{obj=JSON.parse(clean);}catch(_){throw Error("JSON形式を確認してください。");}
 if(!obj||typeof obj!=="object"||Array.isArray(obj)||obj.schemaVersion!==1||obj.source!=="game-screenshot") throw Error("schemaVersion:1とsource:game-screenshotが必要です。");
 const baseDate=date(obj.baseDate);
 if(baseDate!==date(expected)) throw Error("スクショの基準日と選択日が違います。");
 if(!Array.isArray(obj.days)||obj.days.length<1||obj.days.length>7) throw Error("daysは1〜7日分にしてください。");
 let prev=0;
 const days=obj.days.map(row=>{
  if(!row||typeof row!=="object"||Array.isArray(row)) throw Error("daysの形式が不正です。");
  const day=date(row.date),n=offset(baseDate,day);
  if(n<1||n>7||n<=prev) throw Error("日付は翌日〜7日後の昇順で、重複なく指定してください。");
  prev=n;
  if(typeof row.weather!=="string"||!allowed.has(row.weather)) throw Error(day+"の天気が未判定または未対応です。");
  return {date:day,weather:row.weather,key:"week"+n};
 });
 return {baseDate,days};
}
const hashPrefix="#weekly-import=";
function buildImportLink(payload,siteUrl){
 const base=payload && payload.baseDate,parsed=parse(JSON.stringify(payload),base);
 const normalized={schemaVersion:1,source:"game-screenshot",baseDate:parsed.baseDate,days:parsed.days.map(d=>({date:d.date,weather:d.weather}))};
 const destination=new URL(siteUrl);
 if(destination.protocol!=="https:")throw Error("取り込み先はHTTPSが必要です。");
 destination.search="?admin=1";
 destination.hash="weekly-import="+encodeURIComponent(JSON.stringify(normalized));
 return destination.href;
}
function parseImportHash(hash){
 if(typeof hash!=="string"||!hash.startsWith(hashPrefix))return null;
 const encoded=hash.slice(hashPrefix.length);
 if(encoded.length>6000)throw Error("取り込みリンクが長すぎます。");
 let text;try{text=decodeURIComponent(encoded);}catch(_){throw Error("取り込みリンクが壊れています。");}
 let payload;try{payload=JSON.parse(text);}catch(_){throw Error("取り込みリンクのJSONが壊れています。");}
 const parsed=parse(text,payload?.baseDate);
 return {text:JSON.stringify({schemaVersion:1,source:"game-screenshot",baseDate:parsed.baseDate,days:parsed.days.map(d=>({date:d.date,weather:d.weather}))}),baseDate:parsed.baseDate};
}
function emptyWeeks(){return Object.fromEntries(["week1","week2","week3","week4","week5","week6","week7"].map(k=>[k,[]]));}
function mount(dep){
 const input=document.getElementById("aiWeeklyImportJson"),out=document.getElementById("aiWeeklyImportPreview"),status=document.getElementById("aiWeeklyImportStatus"),check=document.getElementById("aiWeeklyPreviewBtn"),save=document.getElementById("aiWeeklySaveBtn");
 if(!input||!out||!status||!check||!save)return;
 let plan=null;
 function clear(){plan=null;save.disabled=true;out.hidden=true;out.textContent="";}
 function message(e){status.textContent=e?.message||"エラーが発生しました。";}
 async function current(base){
  const data=await dep.readWeeklyForecasts();
  if(data?.ok===false)throw Error(data.error||"週間APIエラー");
  if(!Array.isArray(data?.forecasts))throw Error("現在の週間天気を取得できません。");
  const records=data.forecasts.filter(x=>dep.normalizeApiDate(x.baseDate)===base);
  if(records.length>1)throw Error("同じ日付の週間予報が複数あります。");
  const existing=emptyWeeks();
  if(records.length){
   for(const k of Object.keys(existing)){
    const value=records[0].weeks?.[k];
    if(!Array.isArray(value)||value.length>1||value.some(w=>!allowed.has(w)))throw Error("保存済みの週間データが不正です。");
    existing[k]=value;
   }
  }
  data.forecasts.forEach(dep.setWeeklyForecastRecord);
  const visible=dep.getVisibleWeeks(base);
  return {existing,visible};
 }
 const deepLink=typeof location==="object" ? location.hash : "";
 if(deepLink.startsWith(hashPrefix)){
  try{
   const incoming=parseImportHash(deepLink);
   dep.dateInput.value=incoming.baseDate;
   dep.onDateChanged?.();
   input.value=incoming.text;
   const panel=document.getElementById("aiWeeklyImportPanel");
   if(panel)panel.open=true;
   dep.reveal?.();
   if(dep.adminKey() && typeof requestAnimationFrame==="function")requestAnimationFrame(()=>panel?.scrollIntoView({behavior:"smooth",block:"center"}));
   status.textContent="スクショの7日間データを受け取りました。「既存データと照合」を押してください。";
   if(typeof history==="object" && typeof history.replaceState==="function")history.replaceState(null,"",location.pathname+location.search);
  }catch(e){message(e);}
 }
 input.addEventListener("input",clear);
 dep.dateInput.addEventListener("change",clear);
 check.addEventListener("click",async()=>{
  clear();
  try{
   if(!dep.apiUrl()||!dep.adminKey())throw Error("天気APIと管理キーを確認してください。");
   const parsed=parse(input.value,dep.dateInput.value);
   status.textContent="保存済み週間天気と照合中…";
   const {existing,visible}=await current(parsed.baseDate);
   if(dep.dateInput.value!==parsed.baseDate)throw Error("日付が変わりました。");
   const changes=parsed.days.filter(d=>JSON.stringify(visible[d.key]||[])!==JSON.stringify([d.weather]));
   out.textContent=[parsed.baseDate+"を基準とする週間予報",...parsed.days.map(d=>d.date+": "+((visible[d.key]||[]).join("・")||"未登録")+" → "+d.weather),"指定していない日付と今日の時間別天気は変更しません。"].join("\n");
   out.hidden=false;
   if(!changes.length){status.textContent="差分なし。保存不要です。";return;}
   plan={parsed,existing};
   save.disabled=false;
   status.textContent="変更 "+changes.length+"日。内容を確認して保存してください。";
  }catch(e){message(e);}
 });
 save.addEventListener("click",async()=>{
  if(!plan)return;
  const p=plan;clear();
  try{
   if(!dep.apiUrl()||!dep.adminKey()||dep.dateInput.value!==p.parsed.baseDate)throw Error("API・管理キー・日付を確認してください。");
   status.textContent="週間予報を保存中…";
   const response=await dep.apiPost({action:"saveWeeklyForecast",adminKey:dep.adminKey(),baseDate:p.parsed.baseDate,expected:p.existing,updates:p.parsed.days.map(d=>({date:d.date,weather:d.weather}))});
   if(response?.ok!==true||!response.forecast)throw Error(response?.error||"サーバーへの保存を確認できませんでした。");
   dep.setWeeklyForecastRecord(response.forecast);
   dep.renderToday();
   let verified=false;
   try{
    const reread=await dep.readWeeklyForecasts();
    const saved=reread.forecasts.find(row=>row.baseDate===p.parsed.baseDate);
    verified=Boolean(saved && p.parsed.days.every(day=>JSON.stringify(saved.weeks[day.key])===JSON.stringify([day.weather])));
   }catch(_){}
   status.textContent=verified
    ?"週間予報の保存と再取得を確認しました。公開画面でも表示を確認してください。"
    :"保存APIは成功しましたが、公開データの再取得は未確認です。連続保存せず、画面を更新して確認してください。";
  }catch(e){message(e);}
 });
}
root.HeartopiaWeeklyAIImport={parse,mount,buildImportLink,parseImportHash};
})(typeof globalThis!=="undefined"?globalThis:this);
