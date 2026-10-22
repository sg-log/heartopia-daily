import fs from 'node:fs/promises';
const html=await fs.readFile('index.html','utf8'),apiUrl=html.match(/const WEATHER_API_URL\s*=\s*"([^"]+)"/)?.[1];
if(!apiUrl||!process.env.WEATHER_ADMIN_KEY)throw Error('Five-slot setup access is unavailable');
async function post(action){
  const r=await fetch(apiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,adminKey:process.env.WEATHER_ADMIN_KEY}),signal:AbortSignal.timeout(90000)});
  if(!r.ok)throw Error('Five-slot setup request failed');const body=await r.json();if(body.ok!==true)throw Error('Five-slot setup failed');return body;
}
try{
  await post('initializeWeatherFiveSlots');
  const r=await fetch(apiUrl+'?action=getWeatherCalendar',{signal:AbortSignal.timeout(45000)}),body=await r.json(),p=body.fiveSlots;
  const now=new Date(Date.now()+9*3600000),base=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-(now.getUTCHours()<6?1:0)));
  if(!r.ok||body.ok!==true||body.enabled!==true||p?.version!==1||p.gameDate!==base.toISOString().slice(0,10)||p.slots?.length!==5||'days' in p||'types' in p||'sourceUrl' in p)throw Error('Five-slot public projection failed');
  p.slots.forEach((s,i)=>{const d=new Date(base.getTime()+[6,12,18,24,30][i]*3600000);if(s.date!==d.toISOString().slice(0,10)||s.hour!==d.getUTCHours()||!s.category||!s.label)throw Error('Incomplete five-slot forecast');});
  const status=await post('getWeatherFiveSlotsStatus');
  if(status.enabled!==true||status.forecast?.slots?.length!==5||status.comparison?.status==='mismatch')throw Error('Five-slot status did not pass');
  console.log(JSON.stringify({fiveSlots:5,gameDate:p.gameDate,labels:p.slots.map(s=>s.label),comparison:status.comparison?.status,compared:status.comparison?.compared,privateHistoryPublic:false,friendDiscordMessages:0}));
}catch(_){console.error('Five-slot setup did not pass; private details were withheld.');process.exitCode=1;}
