import fs from 'node:fs/promises';
const html=await fs.readFile('index.html','utf8');
const apiUrl=html.match(/const WEATHER_API_URL\s*=\s*"([^"]+)"/)?.[1];
if(!apiUrl||!process.env.WEATHER_ADMIN_KEY)throw Error('Calendar setup access is unavailable');
async function post(body){
  const r=await fetch(apiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,adminKey:process.env.WEATHER_ADMIN_KEY}),signal:AbortSignal.timeout(120000)});
  if(!r.ok)throw Error('Calendar setup request failed');const result=await r.json();if(result.ok!==true)throw Error('Calendar setup failed');return result;
}
try {
  const initialized=await post({action:'initializeWeatherCalendar',privateWebhook:process.env.WEATHER_PRIVATE_WEBHOOK_URL||''});
  const response=await fetch(apiUrl+'?action=getWeatherCalendar',{signal:AbortSignal.timeout(45000)}),publicResult=await response.json();
  const p=publicResult.calendar,clock=new Date(Date.now()+9*3600000),date=clock.toISOString().slice(0,10);
  if(!response.ok||publicResult.ok!==true||publicResult.enabled!==true||p?.version!==2||p.date!==date||!p.hours?.length||p.hours.some(h=>h.hour<clock.getUTCHours())||'days' in p||'types' in p||'sourceUrl' in p||p.credit?.url!=='https://heartopia.th.gl/forecast')throw Error('Calendar public projection failed');
  const status=await post({action:'getWeatherCalendarStatus'});
  if(!status.calendar?.days?.length)throw Error('Calendar private cache missing');
  const history=await post({action:'getWeatherHistory',limit:1});
  console.log(JSON.stringify({enabled:initialized.enabled,today:date,hours:p.hours.length,privateCacheDays:status.calendar.days.length,historyRecords:history.total,legacyHistoryAdded:initialized.historyAdded,privateUrlInPublic:false,discordMessages:0}));
}catch(_){console.error('Calendar setup did not pass; private details were withheld.');process.exitCode=1;}
