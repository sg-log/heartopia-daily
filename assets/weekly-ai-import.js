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
function snapshot(raw,dep,base){
 const start=String(raw.startSlot??"").replace("時","").trim().padStart(2,"0");
 if(!["00","06","12","18"].includes(start)) throw Error("既存の日次開始時刻が不正です。");
 const slots=dep.normalizeWeatherSlots(raw),weeks=dep.normalizeWeatherWeeks(raw);
 if(slotKeys.some(k=>!Array.isArray(slots[k])||!slots[k].length)) throw Error("承認済みの時間別天気5枠が揃っていません。");
 return {date:base,startSlot:start,slots,weeks,memo:String(raw.memo||"")};
}
function mount(dep){
 const input=document.getElementById("aiWeeklyImportJson"),out=document.getElementById("aiWeeklyImportPreview"),status=document.getElementById("aiWeeklyImportStatus"),check=document.getElementById("aiWeeklyPreviewBtn"),save=document.getElementById("aiWeeklySaveBtn");
 if(!input||!out||!status||!check||!save)return;
 let plan=null;
 function clear(){plan=null;save.disabled=true;out.hidden=true;out.textContent="";}
 function message(e){status.textContent=e?.message||"エラーが発生しました。";}
 function current(response,base){
  if(response?.ok===false)throw Error(response.error||"APIエラー");
  const rows=response?.reports||response?.data;
  if(!Array.isArray(rows))throw Error("承認済みデータを取得できません。");
  const matches=rows.filter(r=>dep.normalizeApiDate(r.date)===base);
  if(matches.length!==1)throw Error("対象日の承認済み天気が"+matches.length+"件です。1件必要です。");
  return snapshot(matches[0],dep,base);
 }
 input.addEventListener("input",clear);
 dep.dateInput.addEventListener("change",clear);
 check.addEventListener("click",async()=>{
  clear();
  try{
   if(!dep.apiUrl()||!dep.adminKey())throw Error("天気APIと管理キーを確認してください。");
   const parsed=parse(input.value,dep.dateInput.value);
   status.textContent="承認済み天気と照合中…";
   const existing=current(await dep.apiPost({action:"approved",adminKey:dep.adminKey()}),parsed.baseDate);
   if(dep.dateInput.value!==parsed.baseDate)throw Error("日付が変わりました。");
   const next=JSON.parse(JSON.stringify(existing));
   parsed.days.forEach(d=>{next.weeks[d.key]=[d.weather];});
   const changes=parsed.days.filter(d=>JSON.stringify(existing.weeks[d.key]||[])!==JSON.stringify([d.weather]));
   out.textContent=[parsed.baseDate+"を基準とする週間予報",...parsed.days.map(d=>d.date+": "+(existing.weeks[d.key]||[]).join("・")+" → "+d.weather),"指定していない日付と時間別天気は変更しません。"].join("\n");
   out.hidden=false;
   if(!changes.length){status.textContent="差分なし。保存は不要です。";return;}
   plan={parsed,next,fingerprint:JSON.stringify(existing)};
   save.disabled=false;
   status.textContent="変更 "+changes.length+"日。内容を確認して保存してください。";
  }catch(e){message(e);}
 });
 save.addEventListener("click",async()=>{
  if(!plan)return;
  const p=plan;clear();
  try{
   if(!dep.apiUrl()||!dep.adminKey()||dep.dateInput.value!==p.parsed.baseDate)throw Error("API・管理キー・日付を確認してください。");
   status.textContent="保存直前にデータを再確認中…";
   const latest=current(await dep.apiPost({action:"approved",adminKey:dep.adminKey()}),p.parsed.baseDate);
   if(JSON.stringify(latest)!==p.fingerprint)throw Error("承認済み天気が変更されました。もう一度照合してください。");
   const result=await dep.saveApprovedWeatherToApi(p.next);
   if(result?.ok===false||result?.skipped)throw Error("サーバーへの保存が確認できませんでした。");
   dep.upsertWeather(p.next);dep.save();dep.renderToday();
   status.textContent="週間予報を保存しました。公開表示も確認してください。";
  }catch(e){message(e);}
 });
}
root.HeartopiaWeeklyAIImport={parse,mount};
})(typeof globalThis!=="undefined"?globalThis:this);
