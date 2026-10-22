import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../apps-script/weather-calendar.gs',import.meta.url),'utf8');
function setup(now = '2026-10-19T23:02:00Z') {
  const props = new Map(), requests = [];
  let code = 200, html = '', failWrite = '';
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  const propertyApi = {getProperty:key=>props.get(key) ?? null, setProperty(key,value) { if (key === failWrite) throw Error('write failed'); props.set(key,String(value)); }, deleteProperty:key=>props.delete(key)};
  const c = vm.createContext({Date:Clock, console, JSON, PropertiesService:{getScriptProperties:()=>propertyApi},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'}, Charset:{UTF_8:'utf8'},
      computeDigest:(_algo,text)=>Array.from(crypto.createHash('sha256').update(text).digest()),
      newBlob:text=>({getBytes:()=>Array.from(Buffer.from(text))})},
    UrlFetchApp:{fetch(url,options) { requests.push({url,options}); return {getResponseCode:()=>code,getContentText:()=>html}; }},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    requireKey_(key,expected) { if (key !== expected) throw Error('unauthorized'); }, adminKey_:()=>'private-admin',
    withScriptLock_:fn=>fn(), json_:value=>value,
    weatherHistoryCalendar_:()=>({added:0}),
    weatherHistoryImportLegacy_:()=>({added:2}),
    ScriptApp:{getProjectTriggers:()=>[],newTrigger(){ throw Error('must not install in tests'); }}
  });
  vm.runInContext(source,c);
  return {c,props,requests, setResponse:(body,status=200)=>{html=body;code=status;}, failWrite:key=>{failWrite=key;}};
}
function fixture() {
  const types = {'1':{cat:'clear',names:{ja:'晴れ'}},'2':{cat:'rain',names:{ja:'雨'}},'3':{cat:'rainbow',names:{ja:'虹'},namesNight:{ja:'月虹'}}};
  return {types,calendar:Array.from({length:31},(_,i)=>({m:10,d:i+1,h:Array(24).fill(i===20?3:1)}))};
}
function htmlFor(data) {
  const flight = '8:'+JSON.stringify(['$','$L999',null,{data}])+'\n';
  const middle = Math.floor(flight.length/2);
  return '<script>globalThis.remoteRan = true</script>'+[flight.slice(0,middle),flight.slice(middle)].map(s=>'<script>self.__next_f.push('+JSON.stringify([1,s])+')</script>').join('');
}
function enable(s) {
  s.props.set('WEATHER_CALENDAR_CONFIG',JSON.stringify({enabled:true,permissionConfirmed:true,displayPolicy:'today-only',permissionReference:'test-only consent',calendarYear:2026,sourceUrl:'https://forecast.invalid/calendar'}));
}
function normalize(c,data=fixture(),date='2026-10-19') { return c.normalizeCalendar_(data,date,2026,'2026-10-19T00:00:00Z'); }

test('parses fragmented page data without executing scripts or relying on a build-specific component ID',()=>{
  const {c}=setup(); assert.equal(c.parseCalendarHtml_(htmlFor(fixture())).calendar.length,31); assert.equal(c.remoteRan,undefined);
  assert.throws(()=>c.parseCalendarHtml_('<script>self.__next_f.push((globalThis.remoteRan=true))</script>'),/missing/); assert.equal(c.remoteRan,undefined);
});
test('rejects ambiguous and oversized payloads',()=>{
  const {c}=setup(); assert.throws(()=>c.parseCalendarHtml_(htmlFor(fixture())+htmlFor(fixture())),/ambiguous/);
  assert.throws(()=>c.parseCalendarHtml_('x'.repeat(1500001)),/large/);
});
test('uses Japanese calendar date at midnight and preserves the independent 06:00 game reset',()=>{
  const {c}=setup(); const a=c.calendarJst_('2026-10-19T14:59:00Z'), b=c.calendarJst_('2026-10-19T15:00:00Z'), d=c.calendarJst_('2026-10-19T21:00:00Z');
  assert.equal(a.date,'2026-10-19'); assert.equal(b.date,'2026-10-20'); assert.equal(b.hour,0); assert.equal(d.hour,6);
});
test('keeps all 24 actual hourly values, night labels and eight dated days',()=>{
  const {c}=setup(); const s=normalize(c); assert.equal(s.days.length,8); assert.equal(s.days[2].hours.length,24); assert.equal(s.types['3'].nightLabel,'月虹');
});
test('fails closed for incomplete hours, missing dates, duplicate days and unknown types',()=>{
  const {c}=setup();
  let d=fixture(); d.calendar[18].h.pop(); assert.throws(()=>normalize(c,d),/Incomplete/);
  d=fixture(); d.calendar=d.calendar.filter(x=>x.d!==20); assert.throws(()=>normalize(c,d),/missing/);
  d=fixture(); d.calendar.push(d.calendar[0]); assert.throws(()=>normalize(c,d),/duplicate/);
  d=fixture(); d.types['1'].cat='alien'; assert.throws(()=>normalize(c,d),/Unknown/);
  d=fixture(); d.calendar[18].h[0]=999; assert.throws(()=>normalize(c,d),/Incomplete/);
});
test('does not invent data across an unconfirmed year boundary or an invalid date',()=>{
  const {c}=setup(); const d=fixture(); d.calendar=Array.from({length:31},(_,i)=>({m:12,d:i+1,h:Array(24).fill(1)}));
  assert.equal(normalize(c,d,'2026-12-30').days.length,2);
  assert.throws(()=>normalize(c,d,'2027-01-01'),/year/); assert.throws(()=>normalize(c,d,'2026-02-30'),/date/);
});
test('disabled or unconfirmed source makes no external requests and publishes nothing',()=>{
  const s=setup(); assert.equal(s.c.calendarRefresh_().status,'source-not-enabled'); assert.equal(s.c.calendarPublic_(),null); assert.equal(s.requests.length,0);
  s.props.set('WEATHER_CALENDAR_CONFIG',JSON.stringify({enabled:true})); s.c.runCalendarWeatherScheduler(); assert.equal(s.requests.length,0);
});
test('initialization needs admin authorization and restores the disabled mode if the first source fetch fails',()=>{
  const s=setup();
  s.c.weatherCalendarPrivateDefaults_=()=>({enabled:true,permissionConfirmed:true,displayPolicy:'today-only',permissionReference:'test-only consent',calendarYear:2026,sourceUrl:'https://forecast.invalid/calendar'});
  s.c.ScriptApp.getProjectTriggers=()=>[{getHandlerFunction:()=>'runWeatherScheduler'}];
  assert.throws(()=>s.c.weatherCalendarAdmin_({action:'initializeWeatherCalendar',adminKey:'wrong'}),/unauthorized/);
  s.setResponse('blocked',403);
  assert.throws(()=>s.c.weatherCalendarAdmin_({action:'initializeWeatherCalendar',adminKey:'private-admin'}),/HTTP/);
  assert.equal(s.c.calendarConfigured_(),null);assert.equal(s.c.calendarPublic_(),null);assert.equal(s.requests.length,1);
});
test('fetches once and automatically publishes a fully validated snapshot without approval or Discord',()=>{
  const s=setup(); enable(s); s.setResponse(htmlFor(fixture())); const r=s.c.calendarRefresh_();
  assert.equal(s.requests.length,1); assert.equal(r.status,'updated');
  assert.throws(()=>s.c.weatherCalendarAdmin_({action:'getWeatherCalendarStatus',adminKey:'wrong'}),/unauthorized/);
  assert.equal(s.c.calendarPublic_().hours.length,16); assert.equal(s.c.calendarPublic_().hash,undefined);
  assert.equal(s.c.calendarPublic_().sourceUrl,undefined);assert.ok(!JSON.stringify(s.c.calendarPublic_()).includes('forecast.invalid'));
  assert.equal(s.c.calendarRefresh_().status,'cached');
});
test('HTTP, parse and write failures preserve the last approved snapshot',()=>{
  const s=setup(); enable(s); s.setResponse(htmlFor(fixture())); const r=s.c.calendarRefresh_();
  const before=s.props.get('WEATHER_CALENDAR_APPROVED');
  s.setResponse('down',503); assert.throws(()=>s.c.calendarRefresh_(true),/HTTP/);
  assert.equal(s.props.get('WEATHER_CALENDAR_APPROVED'),before);
  s.setResponse('<html>login</html>'); assert.throws(()=>s.c.calendarRefresh_(true),/missing/);
  assert.equal(s.props.get('WEATHER_CALENDAR_APPROVED'),before);
  s.setResponse(htmlFor(fixture())); s.failWrite('WEATHER_CALENDAR_APPROVED'); assert.throws(()=>s.c.calendarRefresh_(true),/write failed/);
  assert.equal(s.props.get('WEATHER_CALENDAR_APPROVED'),before);
});
test('successful scheduler collection is silent and does not contact the gift or private webhook',()=>{
  const s=setup(); enable(s); s.setResponse(htmlFor(fixture()));
  s.props.set('DISCORD_WEBHOOK_URL','https://friend.invalid'); s.props.set('WEATHER_CALENDAR_PRIVATE_WEBHOOK_URL','https://private.invalid');
  s.c.runCalendarWeatherScheduler(); s.c.runCalendarWeatherScheduler();
  assert.deepEqual(s.requests.map(x=>x.url),['https://forecast.invalid/calendar']);
});
test('archive failure keeps the last display snapshot and is not reported as a successful refresh',()=>{
  const s=setup();enable(s);s.setResponse(htmlFor(fixture()));s.c.calendarRefresh_();
  const before=s.props.get('WEATHER_CALENDAR_APPROVED');
  s.c.weatherHistoryCalendar_=()=>{throw Error('history write failed');};
  assert.throws(()=>s.c.calendarRefresh_(true),/history write failed/);assert.equal(s.props.get('WEATHER_CALENDAR_APPROVED'),before);
});
test('scheduler caps failed retries and never fetches outside the selected windows',()=>{
  const s=setup('2026-10-19T23:12:00Z'); enable(s); s.setResponse('down',503);
  s.c.runCalendarWeatherScheduler(); assert.equal(s.requests.length,1); assert.ok(s.props.has('WEATHER_CALENDAR_LAST_ERROR'));
  s.c.runCalendarWeatherScheduler(); assert.equal(s.requests.length,1);
  const late=setup('2026-10-20T01:00:00Z'); enable(late); late.c.runCalendarWeatherScheduler(); assert.equal(late.requests.length,0);
});
test('cache exhaustion warning is sent once to the dedicated private webhook, never to friends',()=>{
  const s=setup(); enable(s); s.setResponse('down',200);
  s.props.set('DISCORD_WEBHOOK_URL','https://friend.invalid');s.props.set('WEATHER_CALENDAR_PRIVATE_WEBHOOK_URL','https://private.invalid');
  s.c.runCalendarWeatherScheduler();s.c.runCalendarWeatherScheduler();
  assert.deepEqual(s.requests.map(x=>x.url),['https://forecast.invalid/calendar','https://private.invalid']);
  assert.equal(JSON.parse(s.requests[1].options.payload).allowed_mentions.parse.length,0);
});
const uiContext=vm.createContext({console,Date});
vm.runInContext(fs.readFileSync(new URL('../assets/weather-calendar-today-ui.js',import.meta.url),'utf8'),uiContext);
function publicSnapshot(s,date='2026-10-19') {return {version:2,timeZone:'Asia/Tokyo',checkedAt:s.checkedAt,date,hours:s.days.find(d=>d.date===date).hours.map((id,hour)=>({hour,category:s.types[id].category,label:(hour<6||hour>=18?s.types[id].nightLabel:'')||s.types[id].label}))};}
test('public display switches at Japanese midnight and hour boundaries with no data extrapolation',()=>{
  const {c}=setup();const data=fixture();data.calendar[18].h[23]=3;data.calendar[19].h[0]=2;const s=normalize(c,data);
  const ui=uiContext.HeartopiaCalendar;
  assert.equal(ui.current(publicSnapshot(s),'2026-10-19T14:59:59Z').label,'月虹');
  assert.equal(ui.current(publicSnapshot(s,'2026-10-20'),'2026-10-19T15:00:00Z').label,'雨');
  assert.equal(ui.current(publicSnapshot(s),'2026-11-01T00:00:00Z'),null);
  assert.equal(ui.publicHtml(publicSnapshot(s),'2026-11-01T00:00:00Z'),'');
});
test('public rendering escapes source labels and explicitly distinguishes forecasts from observations',()=>{
  const {c}=setup();const s=normalize(c);s.types['1'].label='<img src=x onerror=alert(1)>';
  const html=uiContext.HeartopiaCalendar.publicHtml(publicSnapshot(s),'2026-10-19T03:00:00Z');
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(html.includes('時間別予報'));assert.ok(!html.includes('forecast.invalid'));assert.ok(html.includes('Weather forecast by TH.GL'));
});
test('public API exposes only current-hour and later values today, with required credit and no source table',()=>{
  const s=setup('2026-10-19T14:02:00Z');enable(s);s.setResponse(htmlFor(fixture()));s.c.calendarRefresh_();
  const p=s.c.calendarPublic_();assert.equal(p.date,'2026-10-19');assert.equal(p.hours.length,1);assert.equal(p.hours[0].hour,23);
  assert.equal(p.days,undefined);assert.equal(p.types,undefined);assert.equal(p.calendarYear,undefined);assert.equal(p.sourceUrl,undefined);
  assert.equal(p.credit.url,'https://heartopia.th.gl/forecast');
  const ui=uiContext.HeartopiaCalendar.publicHtml(p,'2026-10-19T14:02:00Z');assert.ok(ui.includes('翌日以降の時間別予報'));
  const points=uiContext.HeartopiaCalendar.fixedSlots(p,'2026-10-19T14:02:00Z');
  assert.equal(points.length,5);assert.ok(points.filter(x=>x.date!=='2026-10-19').every(x=>x.sampleHour===null));
});

test('fixed five times stay anchored to the 06:00 game day without inventing missing weather',()=>{
  const ui=uiContext.HeartopiaCalendar;
  const s={version:2,timeZone:'Asia/Tokyo',date:'2026-10-22',checkedAt:'2026-10-22T00:00:00Z',hours:Array.from({length:8},(_,i)=>({hour:16+i,category:i<2?'clear':'meteor',label:i<2?'晴れ':'流星群'}))};
  const points=ui.fixedSlots(s,'2026-10-22T07:38:00Z');
  assert.deepEqual(Array.from(points,x=>x.hour),[6,12,18,0,6]);
  assert.deepEqual(Array.from(points,x=>x.icon),['—','☀️','🌠','—','—']);
  assert.equal(points[1].current,true);assert.equal(points[1].sampleHour,16);
  assert.equal(points[0].sampleHour,null);assert.equal(points[3].date,'2026-10-23');assert.equal(points[3].sampleHour,null);
  assert.deepEqual(Array.from(ui.fixedSlots({...s,hours:s.hours.map(x=>({...x,category:'clear',label:'晴れ'}))},'2026-10-22T07:38:00Z'),x=>x.hour),[6,12,18,0,6],'equal forecasts must not collapse the five times');
});

test('midnight stays in the fourth slot and 06:00 resets to the first slot',()=>{
  const ui=uiContext.HeartopiaCalendar;
  const s={version:2,timeZone:'Asia/Tokyo',date:'2026-10-23',checkedAt:'2026-10-22T10:00:00Z',hours:Array.from({length:24},(_,hour)=>({hour,category:'clear',label:'晴れ'}))};
  const before=ui.fixedSlots(s,'2026-10-22T17:00:00Z');
  assert.equal(before[0].date,'2026-10-22');assert.equal(before[3].current,true);assert.equal(before[3].icon,'🌙');assert.equal(before[4].icon,'☀️');
  assert.ok(before.slice(0,3).every(x=>x.sampleHour===null));
  const after=ui.fixedSlots(s,'2026-10-22T21:00:00Z');
  assert.equal(after[0].date,'2026-10-23');assert.equal(after[0].current,true);assert.equal(after[4].date,'2026-10-24');assert.equal(after[4].sampleHour,null);
});
