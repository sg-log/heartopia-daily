import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {buildPrivateWeatherPayload,submitPrivateWeather} from './weather-private-submit.mjs';
import {readPrivateSources} from './weather-private-source-config.mjs';
import {comparisonSourceQueries} from './weather-public-discovery.mjs';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8yIAAAAASUVORK5CYII=','base64');
const sha=createHash('sha256').update(image).digest('hex');
const review=()=>({ready:true,targetDate:'2026-10-19',selectedImage:{file:'panel.png',mimeType:'image/png',captureSha256:sha},interpretation:{ready:true,confidence:'high',observedDate:'2026-10-19',startSlot:'00',slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,weather:['晴'],visible:true,confidence:'high'})),weeklyDays:[]}});
const capture={status:'captured',sourceType:'x',sourceUrl:'https://x.com/example/status/123',capturedAt:'2026-10-19T00:00:00Z'};
let dir;
test.before(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'weather-private-'));await fs.writeFile(path.join(dir,'panel.png'),image);});
test.after(async()=>{await fs.rm(dir,{recursive:true,force:true});});
test('private payload binds the exact high-confidence image and keeps seven unknown weeks empty',async()=>{
  const p=await buildPrivateWeatherPayload(review(),capture,dir);assert.equal(p.evidenceImages[0].sha256,sha);assert.equal(p.evidenceImages[0].bodyBase64,image.toString('base64'));assert.deepEqual(p.weeks.week7,[]);assert.ok(!('adminKey' in p));
});
test('tampered image hashes, absolute paths, date disagreements and weak reviews are rejected',async()=>{
  let r=review();r.selectedImage.captureSha256='0'.repeat(64);await assert.rejects(buildPrivateWeatherPayload(r,capture,dir),/Binding/);
  r=review();r.selectedImage.file=path.resolve(dir,'panel.png');await assert.rejects(buildPrivateWeatherPayload(r,capture,dir),/Binding/);
  r=review();r.interpretation.observedDate='2026-10-18';await assert.rejects(buildPrivateWeatherPayload(r,capture,dir),/NotReady/);
  r=review();r.interpretation.slots[0].confidence='low';await assert.rejects(buildPrivateWeatherPayload(r,capture,dir),/NotReady/);
});
test('registers once and verifies the private stored image bytes before reporting success',async()=>{
  const payload=await buildPrivateWeatherPayload(review(),capture,dir);const calls=[];let posted=false;
  const fetcher=async(_url,options)=>{
    const body=options?.body?JSON.parse(options.body):null;calls.push(body?.action||'public');let data;
    if(!body)data={ok:true,reports:[]};
    else if(body.action==='pending')data={ok:true,reports:posted?[{...payload,id:'private-id',evidenceStatus:'saved',evidenceImages:[{sha256:sha}]}]:[]};
    else if(body.action==='submit'){posted=true;data={ok:true,id:'private-id'};}
    else data={ok:true,mimeType:'image/png',bodyBase64:image.toString('base64')};
    return {ok:true,json:async()=>data};
  };
  const r=await submitPrivateWeather({payload,apiUrl:'https://api.invalid/',postKey:'post',adminKey:'admin',fetcher});
  assert.equal(r.pending_registered,true);assert.deepEqual(calls,['pending','public','submit','pending','weatherEvidence']);assert.ok(!JSON.stringify(r).includes(capture.sourceUrl));
});
test('does not repost identical existing content or expose private config in summaries',async()=>{
  const payload=await buildPrivateWeatherPayload(review(),capture,dir);let calls=0;
  const fetcher=async(_url,options)=>({ok:true,json:async()=>{calls++;return {ok:true,reports:options?.body?[]:[{...payload,id:'old'}]};}});
  const r=await submitPrivateWeather({payload,apiUrl:'https://api.invalid/',postKey:'post',adminKey:'admin',fetcher});assert.equal(r.duplicate,true);assert.equal(calls,2);
  const config=await readPrivateSources({apiUrl:'https://api.invalid/',adminKey:'admin',fetcher:async()=>({ok:true,json:async()=>({ok:true,handles:['example_a','example_b','example_a']})})});
  assert.deepEqual(config.handles,['example_a','example_b']);assert.equal(comparisonSourceQueries('2026-10-19',config.handles).length,4);
});
test('an existing pending without private evidence is not reported as successful',async()=>{
  const payload=await buildPrivateWeatherPayload(review(),capture,dir);
  const fetcher=async(_url,options)=>({ok:true,json:async()=>({ok:true,reports:options?.body?[{...payload,id:'old',evidenceStatus:'missing',evidenceImages:[]}]:[]})});
  await assert.rejects(submitPrivateWeather({payload,apiUrl:'https://api.invalid/',postKey:'post',adminKey:'admin',fetcher}),/privateEvidenceNotConfirmed/);
});
test('an existing pending is reused only after its private image bytes are verified',async()=>{
  const payload=await buildPrivateWeatherPayload(review(),capture,dir);const actions=[];
  const fetcher=async(_url,options)=>{
    const action=options?.body?JSON.parse(options.body).action:'public';actions.push(action);
    return {ok:true,json:async()=>action==='weatherEvidence'?{ok:true,mimeType:'image/png',bodyBase64:image.toString('base64')}:{ok:true,reports:action==='pending'?[{...payload,id:'old',evidenceStatus:'saved'}]:[]}};
  };
  assert.equal((await submitPrivateWeather({payload,apiUrl:'https://api.invalid/',postKey:'post',adminKey:'admin',fetcher})).duplicate,true);
  assert.deepEqual(actions,['pending','public','weatherEvidence']);
});
test('comparison accounts are not wired into the normal weather collector',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/weather-scheduled-run.yml',import.meta.url),'utf8');
  assert.ok(!workflow.includes('weather-private-source-config.mjs'));
  assert.ok(!workflow.includes('--comparison-sources-file'));
  assert.ok(!workflow.includes('--sources-file'));
});
test('source configuration is admin-only and real handles need not appear in source code',async()=>{
  const properties=new Map();const c=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k),setProperty:(k,v)=>properties.set(k,v)})},
    requireKey_:(a,b)=>{if(a!==b)throw Error('denied');},adminKey_:()=>'admin',json_:v=>v,weatherPrivateSourceDefaults_:()=>['example_a','example_b']});
  vm.runInContext(await fs.readFile(new URL('../apps-script/weather-private-sources.gs',import.meta.url),'utf8'),c);
  assert.throws(()=>c.getWeatherPrivateSources_({adminKey:'wrong'}),/denied/);assert.equal(c.getWeatherPrivateSources_({adminKey:'admin'}).handles.length,2);
  assert.ok(properties.has('WEATHER_PRIVATE_SOURCE_HANDLES'));
});
