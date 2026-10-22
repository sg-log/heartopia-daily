import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
function fixture(){
  const p={y:2026,wd:{101:'Sunny',102:'Cloudy',107:'Meteor Shower',202:'Light Rain',301:'Rainbow'},wnt:{101:'Clear',102:'Cloudy',107:'Meteor Shower',202:'Light Rain',301:'Moon Rainbow'},cal:[]};
  for(let i=0;i<366;i++){const d=new Date(Date.UTC(2028,0,1+i));p.cal.push([d.getUTCMonth()+1,d.getUTCDate(),[1,1,1,1],Array(24).fill(101)]);}
  const a=p.cal.find(r=>r[0]===10&&r[1]===22);a[3].fill(107,18);a[3][7]=102;a[3][14]=102;
  const b=p.cal.find(r=>r[0]===10&&r[1]===23);b[2]=[1,2,3,1];b[3].fill(202,6,12);b[3].fill(301,12,18);
  return p;
}
const html=p=>'<script>globalThis.remoteRan=true</script><script type="application/json" id="cp">'+JSON.stringify(p)+'</script>';
function setup(){
  let time='2026-10-22T11:49:00Z',body=html(fixture()),status=200,failHistory=false;
  const props=new Map(),requests=[],history=[];
  class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return Date.parse(time);}}
  const c=vm.createContext({Date:Clock,console,JSON,PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,String(v)),deleteProperty:k=>props.delete(k)})},
    Utilities:{newBlob:s=>({getBytes:()=>Buffer.from(s)})},UrlFetchApp:{fetch(url,options){requests.push({url,options});return {getResponseCode:()=>status,getContentText:()=>body};}},
    weatherHistoryAppend_:events=>{if(failHistory)throw Error('history unavailable');history.push(...events);return {added:events.length};},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},withScriptLock_:fn=>fn(),requireKey_:(a,b)=>{if(a!==b)throw Error('unauthorized');},adminKey_:()=>'secret',json_:v=>v});
  vm.runInContext(fs.readFileSync(new URL('apps-script/weather-calendar.gs',root),'utf8')+'\n'+fs.readFileSync(new URL('apps-script/weather-five-slots.gs',root),'utf8'),c);
  return {c,props,requests,history,now:v=>{time=v;},response:(p,code=200)=>{body=typeof p==='string'?p:html(p);status=code;},failHistory:()=>{failHistory=true;},enable:()=>props.set('WEATHER_FIVE_CONFIG',JSON.stringify({enabled:true,calendarYear:2026,sourceUrl:'https://source.invalid/calendar'}))};
}
const plain=v=>JSON.parse(JSON.stringify(v));
test('extracts game six-hour summaries, preserving meteor events and avoiding hourly cloud substitutions',()=>{
  const s=setup(),p=s.c.fiveParse_(html(fixture()),'2026-10-22',2026,'2026-10-22T11:00:00Z');
  assert.deepEqual(plain(s.c.fivePoints_(p,'2026-10-22T11:49:00Z')).map(x=>x.category),['clear','clear','meteor','clear','rain']);
  assert.equal(s.c.remoteRan,undefined);assert.equal(p.days.length,8);
});
test('five complete facts stay available in the morning, late evening and after midnight until the 06:00 reset',()=>{
  const s=setup();s.enable();s.c.fiveRefresh_();
  for(const time of ['2026-10-22T00:01:00Z','2026-10-22T14:59:00Z','2026-10-22T15:01:00Z','2026-10-22T20:59:00Z']){
    s.now(time);const p=s.c.fivePublic_();assert.equal(p.gameDate,'2026-10-22');assert.equal(p.slots.length,5);assert.deepEqual(plain(p.slots).map(x=>x.hour),[6,12,18,0,6]);
  }
  s.now('2026-10-22T21:00:00Z');assert.equal(s.c.fivePublic_().gameDate,'2026-10-23');assert.equal(s.c.fivePublic_().slots[0].category,'rain');assert.equal(s.requests.length,1,'projecting a new game day uses the private cache');
});
test('public response exposes exactly five facts and credit, no annual table, private URLs, histories or raw IDs',()=>{
  const s=setup();s.enable();s.c.fiveRefresh_();const p=plain(s.c.fivePublic_());
  assert.deepEqual(Object.keys(p).sort(),['checkedAt','credit','gameDate','slots','timeZone','version']);assert.equal(p.slots.length,5);
  assert.ok(!JSON.stringify(p).includes('source.invalid'));assert.equal(p.days,undefined);assert.equal(p.types,undefined);
  assert.equal(s.history.length,8);assert.equal(s.history[0].kind,'five-slot-forecast');assert.equal(s.history[0].payload.recordType,'forecast');
});
test('rejects duplicate JSON, incomplete days, unknown IDs, partial events and unconfirmed years',()=>{
  const s=setup(),parse=p=>s.c.fiveParse_(typeof p==='string'?p:html(p),'2026-10-22',2026,'2026-10-22T00:00:00Z');
  assert.throws(()=>parse(html(fixture())+html(fixture())),/ambiguous/);
  let p=fixture();p.cal[0][3].pop();assert.throws(()=>parse(p),/Incomplete/);
  p=fixture();p.cal[0]=p.cal[1];assert.throws(()=>parse(p),/duplicate/);
  p=fixture();p.wd[999]='Unknown';p.wnt[999]='Unknown';p.cal[0][3][0]=999;assert.throws(()=>parse(p),/Incomplete/);
  p=fixture();p.cal.find(r=>r[0]===10&&r[1]===22)[3][19]=101;assert.throws(()=>parse(p),/Ambiguous/);
  p=fixture();p.y=2027;assert.throws(()=>parse(p),/year/);
  assert.throws(()=>s.c.fiveParse_(html(fixture()),'2027-01-01',2026,'2026-10-22T00:00:00Z'),/year/);
});
test('does not reuse annual data for January of an unverified year',()=>{
  const s=setup();s.enable();s.now('2026-12-31T00:00:00Z');assert.throws(()=>s.c.fiveRefresh_(),/cover/);assert.equal(s.c.fivePublic_(),null);
});
test('HTTP, parsing and private history failures preserve all previously saved weather',()=>{
  const s=setup();s.enable();s.c.fiveRefresh_();const before=s.props.get('WEATHER_FIVE_CACHE');s.now('2026-10-23T00:00:00Z');
  s.response('down',503);assert.throws(()=>s.c.fiveRefresh_(),/HTTP/);assert.equal(s.props.get('WEATHER_FIVE_CACHE'),before);
  s.response('<html>login</html>');assert.throws(()=>s.c.fiveRefresh_(),/missing/);assert.equal(s.props.get('WEATHER_FIVE_CACHE'),before);
  s.response(fixture());s.failHistory();assert.throws(()=>s.c.fiveRefresh_(),/history/);assert.equal(s.props.get('WEATHER_FIVE_CACHE'),before);assert.equal(s.c.fivePublic_().slots.length,5);
});
test('disabled source is silent and setup is authenticated with configuration rollback on failure',()=>{
  const s=setup();assert.equal(s.c.fivePublic_(),null);s.c.runFiveWeatherScheduler();assert.equal(s.requests.length,0);
  assert.throws(()=>s.c.fiveAdmin_({action:'initializeWeatherFiveSlots',adminKey:'bad'}),/unauthorized/);
  s.c.weatherFivePrivateDefaults_=()=>({enabled:true,calendarYear:2026,sourceUrl:'https://source.invalid/calendar'});s.response('no',403);
  assert.throws(()=>s.c.fiveAdmin_({action:'initializeWeatherFiveSlots',adminKey:'secret'}),/HTTP/);assert.equal(s.c.fiveConfigured_(),null);
});
test('cross-check compares independent six-hour facts, fails on disagreement and keeps a good cache',()=>{
  const s=setup();s.enable();s.c.fiveRefresh_();const before=s.props.get('WEATHER_FIVE_CACHE');s.now('2026-10-22T13:00:00Z');
  s.props.set('WEATHER_CALENDAR_APPROVED',JSON.stringify({checkedAt:'2026-10-22T10:00:00Z',types:{1:{category:'clear'},2:{category:'meteor'},3:{category:'rain'},4:{category:'cloud'}},days:[{date:'2026-10-22',hours:Array(18).fill(1).concat(Array(6).fill(2))},{date:'2026-10-23',hours:Array(6).fill(1).concat(Array(6).fill(3),Array(12).fill(1))}]}));
  assert.equal(s.c.fiveRefresh_().compared,5);assert.equal(JSON.parse(s.props.get('WEATHER_FIVE_COMPARISON')).status,'matched');
  const last=s.props.get('WEATHER_FIVE_CACHE');s.now('2026-10-22T14:10:00Z');const saved=JSON.parse(s.props.get('WEATHER_CALENDAR_APPROVED'));saved.days[0].hours.fill(3,18);s.props.set('WEATHER_CALENDAR_APPROVED',JSON.stringify(saved));
  assert.throws(()=>s.c.fiveRefresh_(),/differs/);assert.equal(s.props.get('WEATHER_FIVE_CACHE'),last);assert.equal(JSON.parse(s.props.get('WEATHER_FIVE_COMPARISON')).status,'mismatch');assert.ok(before);
});
test('scheduler fetches at 08 and 19 JST once each, with one bounded failure retry and no friend notification',()=>{
  const s=setup();s.enable();s.props.set('DISCORD_WEBHOOK_URL','https://friend.invalid');
  s.now('2026-10-21T21:00:00Z');s.c.runFiveWeatherScheduler();assert.equal(s.requests.length,0);
  s.now('2026-10-21T23:02:00Z');s.c.runFiveWeatherScheduler();s.c.runFiveWeatherScheduler();assert.equal(s.requests.length,1);
  s.now('2026-10-22T10:02:00Z');s.response('down',503);s.c.runFiveWeatherScheduler();s.c.runFiveWeatherScheduler();assert.equal(s.requests.length,2);
  s.now('2026-10-22T10:12:00Z');s.response(fixture());s.c.runFiveWeatherScheduler();s.c.runFiveWeatherScheduler();assert.equal(s.requests.length,3);
  assert.ok(s.requests.every(r=>r.url==='https://source.invalid/calendar'));
});

test('existing heartbeat refreshes the comparison source first and runs the five-slot source independently on failure',()=>{
  const calls=[],c=vm.createContext({fiveConfigured_:()=>true,runCalendarWeatherScheduler:()=>calls.push('comparison'),runFiveWeatherScheduler:()=>calls.push('five')});
  vm.runInContext(fs.readFileSync(new URL('apps-script/weather-scheduler.gs',root),'utf8'),c);
  c.runWeatherScheduler();assert.deepEqual(calls,['comparison','five']);
  calls.length=0;c.runCalendarWeatherScheduler=()=>{calls.push('failed comparison');throw Error('source unavailable');};
  assert.throws(()=>c.runWeatherScheduler(),/unavailable/);assert.deepEqual(calls,['failed comparison','five']);
});
