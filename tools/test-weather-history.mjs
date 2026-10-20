import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source=fs.readFileSync(new URL('../apps-script/weather-history.gs',import.meta.url),'utf8');
function setup(legacy=[]) {
  const sheets=new Map();let failWrite=false;
  function makeSheet(rows=[]) {
    return {rows,maxRows:1000,getLastRow(){return rows.length;},getMaxRows(){return this.maxRows;},insertRowsAfter(_start,count){this.maxRows+=count;},
      appendRow(row){rows.push(Array.from(row));},getDataRange(){return {getValues:()=>rows.map(row=>Array.from(row))};},
      getRange(start,col,height,width){return {getValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>rows[start-1+i]?.[col-1+j]??'')),
        setNumberFormat(){return this;},setValues(values){if(failWrite)throw Error('storage unavailable');values.forEach((row,i)=>{rows[start-1+i]??=[];row.forEach((v,j)=>{rows[start-1+i][col-1+j]=v;});});return this;}};}};
  }
  if(legacy.length)sheets.set('weather_reports',makeSheet(legacy));
  const book={getId:()=>'private-sheet',getSheetByName:name=>sheets.get(name)||null,insertSheet:name=>{const s=makeSheet();sheets.set(name,s);return s;}};
  const props=new Map();
  const c=vm.createContext({Date,JSON,Map,Set,SpreadsheetApp:{getActiveSpreadsheet:()=>book,flush(){}},SHEET_NAME:'weather_reports',
    DriveApp:{getFileById:()=>({private:true})},requirePrivateEvidence_:file=>{if(!file.private)throw Error('not private');},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>props.get(key),setProperty:(key,value)=>props.set(key,value)})},calendarWrite_:(key,value)=>props.set(key,JSON.stringify(value)),
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_a,text)=>Array.from(crypto.createHash('sha256').update(text).digest())},
    formatDateValue:value=>String(value).slice(0,10),requireKey_:(a,b)=>{if(a!==b)throw Error('denied');},adminKey_:()=>'private',withScriptLock_:fn=>fn(),json_:v=>v});
  vm.runInContext(source,c);
  return {c,sheets,failWrites:()=>{failWrite=true;},rows:()=>sheets.get('weather_history')?.rows.slice(1)||[]};
}
function snapshot(type=1) {return {calendarYear:2026,checkedAt:'2026-10-19T01:00:00Z',sourceUrl:'https://forecast.invalid/',days:[{date:'2026-10-19',hours:Array(24).fill(type)}],types:{1:{category:'clear',label:'晴れ'},2:{category:'rain',label:'雨'}}};}
test('keeps hourly dated forecasts privately, deduplicates refreshes and preserves A-B-A revisions',()=>{
  const s=setup();const a=snapshot();assert.equal(s.c.weatherHistoryCalendar_(a).added,1);
  a.checkedAt='2026-10-19T02:00:00Z';assert.equal(s.c.weatherHistoryCalendar_(a).added,0);
  assert.equal(s.c.weatherHistoryCalendar_(snapshot(2)).added,1);assert.equal(s.c.weatherHistoryCalendar_(a).added,1);
  assert.equal(s.rows().length,3);const p=JSON.parse(s.rows()[0][4]);assert.equal(p.recordType,'forecast');assert.equal(p.resolutionHours,1);assert.equal(p.hours.length,24);assert.equal(p.verification,'not-established');
});
test('another day or unused type changing does not invent a revision for this day',()=>{
  const s=setup();const a=snapshot();s.c.weatherHistoryCalendar_(a);
  a.types[2].label='別の表記';a.days.push({date:'2026-10-20',hours:Array(24).fill(2)});
  assert.equal(s.c.weatherHistoryCalendar_(a).added,1);assert.equal(s.rows().filter(r=>r[2]==='2026-10-19').length,1);
});
test('imports existing legacy rows without modifying them, filling missing dates or inventing approval',()=>{
  const legacy=[['id','date','status','slot0'],['one','2026-10-15','approved','晴'],['two','2026-10-17','pending','雨'],['three','2026-10-17','rejected','晴']];
  const before=JSON.stringify(legacy);const s=setup(legacy);
  assert.equal(s.c.weatherHistoryImportLegacy_().added,3);assert.equal(s.c.weatherHistoryImportLegacy_().added,0);assert.equal(JSON.stringify(legacy),before);
  assert.ok(!s.rows().some(r=>r[2]==='2026-10-16'));
  const p=JSON.parse(s.rows()[1][4]);assert.equal(p.report.status,'pending');assert.equal(p.recordType,'reported-forecast');assert.equal(p.resolutionHours,6);
  legacy[2][2]='approved';assert.equal(s.c.weatherHistoryImportLegacy_().added,1);assert.equal(JSON.parse(s.rows()[1][4]).report.status,'pending');
});
test('history export requires admin authorization and respects pagination',()=>{
  const s=setup();s.c.weatherHistoryCalendar_(snapshot());s.c.weatherHistoryCalendar_(snapshot(2));
  assert.throws(()=>s.c.weatherHistoryAdmin_({action:'getWeatherHistory',adminKey:'wrong'}),/denied/);
  assert.throws(()=>s.c.weatherHistoryAdmin_({adminKey:'private',limit:101}),/page/);
  const first=s.c.weatherHistoryAdmin_({adminKey:'private',limit:1});assert.equal(first.records.length,1);assert.equal(first.nextOffset,1);assert.equal(first.total,2);
  assert.equal(s.c.weatherHistoryAdmin_({adminKey:'private',offset:1}).nextOffset,null);
});
test('a failed archive is not silently reported successful and can be retried',()=>{
  const s=setup();s.failWrites();assert.throws(()=>s.c.weatherHistoryCalendar_(snapshot()),/unavailable/);assert.equal(s.rows().length,0);
});
test('history is not written to a publicly shared spreadsheet',()=>{
  const s=setup();s.c.DriveApp.getFileById=()=>({private:false});
  assert.throws(()=>s.c.weatherHistoryCalendar_(snapshot()),/not private/);assert.equal(s.rows().length,0);
});
test('image comparison results stay separate from hourly forecasts and retain unchecked coverage',()=>{
  const s=setup();s.c.weatherHistoryCalendar_(snapshot());
  const r=s.c.weatherHistoryAdmin_({action:'recordWeatherComparison',adminKey:'private',targetDate:'2026-10-19',result:{status:'unchecked',checks:[],skipped:[{reason:'date-or-image-unverified'}]}});
  assert.equal(r.result.added,1);const row=s.rows()[1];assert.equal(row[1],'sns-comparison');
  assert.equal(JSON.parse(row[4]).recordType,'forecast-ui-comparison');assert.equal(JSON.parse(row[4]).result.status,'unchecked');
  assert.equal(s.rows().filter(r=>r[1]==='calendar-forecast').length,1);
  assert.throws(()=>s.c.weatherHistoryComparison_('2026-10-19',{status:'matched',checks:[]}),/Invalid/);
});
test('calendar archives before replacing its display cache and has no public history route',()=>{
  const calendar=fs.readFileSync(new URL('../apps-script/weather-calendar.gs',import.meta.url),'utf8');
  assert.ok(calendar.indexOf('weatherHistoryCalendar_(snapshot)')<calendar.indexOf('calendarWrite_(WEATHER_CALENDAR_APPROVED_KEY,snapshot)'));
  const api=fs.readFileSync(new URL('../apps-script/weather-api.gs',import.meta.url),'utf8');
  assert.ok(!api.slice(api.indexOf('function doGet'),api.indexOf('function doPost')).includes('getWeatherHistory'));
});
