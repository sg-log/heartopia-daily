import fs from 'node:fs';
import { extractAppsScriptUrl } from './gift-discord-poll.mjs';
const api=extractAppsScriptUrl(fs.readFileSync('index.html','utf8'));
const adminKey=process.env.WEATHER_ADMIN_KEY;
if(!adminKey)throw Error('Weather admin key is not configured');
async function call(action){
  const response=await fetch(api,{method:'POST',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,adminKey})});
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{throw Error('Scheduler API did not return JSON')}
  if(!response.ok||!data.ok)throw Error('Scheduler status/setup was rejected');
  return data.scheduler;
}
const before=await call('getWeatherSchedulerStatus');
const repair=process.env.WEATHER_SCHEDULER_MODE==='repair';
const after=repair&&!before.installed?await call('repairWeatherScheduler'):before;
console.log(JSON.stringify({wasInstalled:before.installed,installed:after.installed,githubConfigured:after.githubConfigured,primaryTimes:after.primaryTimes,repairRequested:repair,weatherDispatched:false,discordNotified:false}));
if(repair&&(!after.installed||!after.githubConfigured))throw Error('Primary weather scheduler is not ready');
