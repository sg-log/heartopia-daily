# Generates an offline browser harness from the actual API and pending renderer.
param([string] $OutputPath = (Join-Path $env:TEMP 'heartopia-weather-pending-test.html'))
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$api = [IO.File]::ReadAllText((Join-Path $root 'apps-script/weather-api.gs'))
$page = [IO.File]::ReadAllText((Join-Path $root 'index.html'))
$start = $page.IndexOf('function pendingWeatherEvidenceUrl(')
$end = $page.IndexOf('async function fetchPendingWeatherReports()', $start)
$renderer = $page.Substring($start, $end - $start)
$css = [regex]::Match($page, '(?s)\.pendingWeatherCard\{.*?@media\(max-width:640px\)\{.*?\}\}').Value
$tests = @'
const output = document.querySelector('#result');
function assert(ok, message){ if(!ok) throw Error(message); }
const rows = [HEADERS.slice(), ['old','2026-09-11','06','晴','雨','晴','晴','晴', ...Array(7).fill(''), 'legacy','pending','','','']];
let columns = HEADERS.length;
const sheet = {
 getLastRow:()=>rows.length, getMaxRows:()=>100, getMaxColumns:()=>columns,
 insertColumnsAfter:(_,count)=>{columns+=count;},
 appendRow:row=>rows.push(row), getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),
 getRange:(r,c,h=1,w=1)=>({
  getValues:()=>Array.from({length:h},(_,i)=>Array.from({length:w},(_,j)=>rows[r-1+i]?.[c-1+j]??'')),
  setValues:values=>{assert(values.length===h && values.every(v=>v.length===w),'range shape');values.forEach((row,i)=>row.forEach((v,j)=>{rows[r-1+i]??=[];rows[r-1+i][c-1+j]=v;}));},
  setValue:v=>{rows[r-1][c-1]=v;}, setNumberFormat:()=>{}
 })
};
const SpreadsheetApp = {getActiveSpreadsheet:()=>({getSheetByName:()=>sheet})};
const Utilities = {getUuid:()=>`test-${rows.length}`};
postKey_ = ()=> 'synthetic'; adminKey_ = ()=> 'synthetic';
withScriptLock_ = fn=>fn(); json_ = value=>value;
const WEATHER_SLOT_KEYS=['slot0','slot1','slot2','slot3','slot4'];
const WEATHER_WEEK_KEYS=Array.from({length:7},(_,i)=>`week${i+1}`);
// Surrounding display helpers are deterministic stubs; card/API code above is unmodified.
const normalizeStartSlot=v=>v||'18', normalizeApiDate=v=>v;
const normalizeWeatherSlots=r=>r.slots||{}, normalizeWeatherWeeks=r=>r.weeks||{};
const slotLabel=(key,start)=>`${String((Number(start)+Number(key.slice(4))*6)%24).padStart(2,'0')}時`;
const weatherText=(v,k,s,f)=>(v||[]).join('・')||f;
const simpleWeatherText=(v,f)=>(v||[]).join('・')||f;
const weekDateLabel=(d,i)=>`${d}+${i+2}`;
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
try {
 let old=listByStatus_('pending')[0];
 assert(old.sourceUrl==='' && old.sourceImageUrls.length===0,'legacy read');
 assert(rows[0].length===HEADERS.length,'read must not migrate');
 const body={postKey:'synthetic',date:'2026-09-11',startSlot:'06',slots:{slot0:['晴'],slot1:['雨'],slot2:['晴'],slot3:['晴'],slot4:['晴']},weeks:{},sourceUrl:'https://example.org/post',sourceImageUrls:['https://example.org/one.png','https://example.org/two.png']};
 const receipt=submit_(body);
 assert(receipt.ok && receipt.status==='pending','submit pending');
 assert(rows[0].slice(HEADERS.length).join(',')===WEATHER_EVIDENCE_HEADERS.join(','),'append headers');
 assert(rows[1][HEADERS.indexOf('status')]==='pending','old row preserved');
 let report=listByStatus_('pending')[1];
 assert(report.sourceImageUrls.length===2 && report.sourceUrl===body.sourceUrl,'evidence round trip');
 for(const invalid of ['javascript:alert(1)','https://user:secret@example.org/a','data:image/png,xx']){
  let rejected=false;try{submit_({...body,sourceImageUrls:[invalid]});}catch(_){rejected=true;}
  assert(rejected,'invalid URL rejected');
 }
 assert(rows.length===3,'invalid submit no append');
 const host=document.querySelector('#cards');
 host.innerHTML=[old,report,{...report,sourceImageUrls:[body.sourceImageUrls[0]]},{...report,sourceImageUrls:['',null,'javascript:alert(1)','https://user:secret@example.org/a']}].map(pendingWeatherCard).join('');
 assert(host.querySelectorAll('article').length===4,'all cards rendered');
 assert(host.querySelectorAll('img').length===3,'single/multiple/invalid images');
 assert(host.querySelectorAll('[data-approve-weather]').length===4 && host.querySelectorAll('[data-reject-weather]').length===4,'existing action attributes');
 assert(host.querySelectorAll('a[target="_blank"][rel="noopener noreferrer"]').length===6,'safe links');
 assert(host.firstElementChild.textContent.includes('元画像情報なし'),'legacy fallback');
 // Prevent external requests: CSP blocks these synthetic image URLs. Replace only for visual fixture.
 host.querySelectorAll('img').forEach(img=>{img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="lightblue"/><text x="20" y="130" font-size="30">TEST: 06 sun / 12 rain / 18 sun</text></svg>');});
 const mobile=document.createElement('iframe');
 mobile.title='390px mobile layout';mobile.style='width:390px;max-width:100%;height:650px';
 mobile.srcdoc='<style>'+document.querySelector('style').textContent+'</style>'+host.children[1].outerHTML;
 mobile.onload=()=>{
  const doc=mobile.contentDocument, card=doc.querySelector('article');
  const columns=mobile.contentWindow.getComputedStyle(card).gridTemplateColumns.split(' ');
  if(columns.length!==1 || doc.documentElement.scrollWidth>mobile.clientWidth) output.textContent='FAIL: mobile layout';
  else output.textContent+=' Mobile 390px: PASS.';
 };
 document.body.append(mobile);
 let rejected=false;try{changeStatus_({id:receipt.id,adminKey:'wrong'},'approved');}catch(_){rejected=true;}
 assert(rejected,'admin auth preserved');
 changeStatus_({id:receipt.id,adminKey:'synthetic'},'approved');
 assert(listByStatus_('approved')[0].sourceImageUrls.length===2,'approval retains evidence');
 changeStatus_({id:'old',adminKey:'synthetic'},'rejected');
 assert(listByStatus_('pending').length===0 && listByStatus_('rejected').length===1,'reject old report');
 rows[2][HEADERS.length+1]='not JSON';
 assert(listByStatus_('approved')[0].sourceImageUrls.length===0,'corrupt stored evidence tolerated');
 output.textContent='PASS: legacy + one/multiple/invalid images, source links, schema append/round-trip, pending, approval/rejection/auth, corrupt data. All API/storage mocked; no network.';
} catch(error){output.textContent='FAIL: '+error.message;}
'@
$html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src ''none''; script-src ''unsafe-inline''; style-src ''unsafe-inline''; img-src data: blob:; frame-src ''self''"><style>body{font-family:sans-serif;margin:16px}' + $css + '</style><h1>Offline pending test</h1><p id="result">Running</p><main id="cards"></main><script>window.onerror=(m,u,l,c)=>document.querySelector("#result").textContent="FAIL: "+m+" line "+l+":"+c;</script><script>' + $api + "`n" + $renderer + "`n" + $tests + '</script>'
[IO.File]::WriteAllText($OutputPath, $html, [Text.UTF8Encoding]::new($false))
Write-Output "Open in browser: $OutputPath"
