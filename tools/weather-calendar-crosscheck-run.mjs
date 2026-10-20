// Fixed private accounts compare forecasts only. Never submit/approve weather.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {discover} from './weather-public-discovery.mjs';
import {readPrivateSources} from './weather-private-source-config.mjs';
import {inspectUnifiedCapture} from './weather-unified-review.mjs';
import {inspectDirectDailyPanelCapture} from './weather-direct-daily-panel-review.mjs';
import {buildPrivateWeatherPayload} from './weather-private-submit.mjs';
import {compareCalendarWithImageReviews} from './weather-calendar-crosscheck.mjs';
const run=promisify(execFile);
async function main(){
  const html=await fs.readFile('index.html','utf8'),apiUrl=html.match(/const WEATHER_API_URL\s*=\s*"([^"]+)"/)?.[1],adminKey=process.env.WEATHER_ADMIN_KEY;
  if(!apiUrl||!adminKey)throw Error('access');
  async function post(body){const r=await fetch(apiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,adminKey}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('api');const d=await r.json();if(d.ok!==true)throw Error('api');return d;}
  const state=await post({action:'getWeatherCalendarStatus'});
  if(!state.enabled||!state.calendar){console.log(JSON.stringify({status:'not-enabled'}));return;}
  const {handles}=await readPrivateSources({apiUrl,adminKey});if(!handles.length)throw Error('comparison-accounts-missing');
  const targetDate=new Date(Date.now()+9*3600000).toISOString().slice(0,10),allowed=new Set(handles.map(h=>h.toLowerCase()));
  const discovery=await discover(targetDate,'',handles),records=[],hashes=[];
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weather-compare-'));
  try{
    let checked=0;
    for(const candidate of discovery.candidates){
      if(candidate.sourceType!=='x'||checked>=10||records.length>=5)continue;checked++;
      const captureDir=path.join(dir,String(checked));
      try{
        await run(process.execPath,['tools/weather-x-embed-evidence.mjs','--url',candidate.sourceUrl,'--output-dir',captureDir],{timeout:65000,maxBuffer:1024*1024});
        const capture=JSON.parse(await fs.readFile(path.join(captureDir,'capture.json'),'utf8'));
        const owner=(capture.rawMedia||[]).map(m=>m.ownerLink).find(Boolean)||'';
        const author=(owner.match(/\/([^/]+)\/status\//)?.[1]||'').toLowerCase();
        if(!allowed.has(author)||records.some(r=>r.author===author))continue;
        let review;try{review=await inspectUnifiedCapture({captureDir,targetDate});}catch(_){review={ready:false};}
        if(!review.ready)review=await inspectDirectDailyPanelCapture({captureDir,targetDate});
        if(!review.ready)continue;
        const payload=await buildPrivateWeatherPayload(review,capture,captureDir);
        const saved=await post({action:'saveWeatherComparisonEvidence',targetDate,author,sourceUrl:capture.sourceUrl,image:payload.evidenceImages[0]});
        if(saved.sha256!==payload.evidenceImages[0].sha256)throw Error('image-binding');
        const read=await post({action:'getWeatherComparisonEvidence',sha256:saved.sha256});
        if(createHash('sha256').update(Buffer.from(read.bodyBase64||'','base64')).digest('hex')!==saved.sha256)throw Error('image-readback');
        records.push({author,sourceUrl:capture.sourceUrl,review});hashes.push(saved.sha256);
      }catch(_){/* Unavailable and unreadable sources remain unchecked. */}
    }
    const result=compareCalendarWithImageReviews(state.calendar,records,targetDate);
    await post({action:'recordWeatherComparison',targetDate,result,evidenceHashes:hashes,notify:process.env.WEATHER_COMPARE_NOTIFY==='true'});
    console.log(JSON.stringify({status:result.status,comparedCells:result.comparedCells,independentAuthors:result.independentAuthors,privateImages:hashes.length}));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}
const timer=setTimeout(()=>{console.error('Private comparison reached its time limit.');process.exit(1);},12*60000);
main().catch(()=>{console.error('Private comparison could not complete; no source details were logged.');process.exitCode=1;}).finally(()=>clearTimeout(timer));
