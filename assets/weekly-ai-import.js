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
  return existing;
 }
 input.addEventListener("input",clear);
 dep.dateInput.addEventListener("change",clear);
 check.addEventListener("click",async()=>{
  clear();
  try{
   if(!dep.apiUrl()||!dep.adminKey())throw Error("天気APIと管理キーを確認してください。");
   const parsed=parse(input.value,dep.dateInput.value);
   status.textContent="保存済み週間天気と照合中…";
   const existing=await current(parsed.baseDate);
   if(dep.dateInput.value!==parsed.baseDate)throw Error("日付が変わりました。");
   const changes=parsed.days.filter(d=>JSON.stringify(existing[d.key])!==JSON.stringify([d.weather]));
   out.textContent=[parsed.baseDate+"を基準とする週間予報",...parsed.days.map(d=>d.date+": "+(existing[d.key].join("・")||"未登録")+" → "+d.weather),"指定していない日付と今日の時間別天気は変更しません。"].join("\n");
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
   status.textContent="週間予報を保存しました。公開画面を再読み込みして確認してください。";
  }catch(e){message(e);}
 });
}
root.HeartopiaWeeklyAIImport={parse,mount};
})(typeof globalThis!=="undefined"?globalThis:this);
