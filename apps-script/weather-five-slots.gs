// Six-hour game forecast facts. Independent of TH.GL's today-only projection.
const WEATHER_FIVE_CONFIG_KEY = 'WEATHER_FIVE_CONFIG';
const WEATHER_FIVE_CACHE_KEY = 'WEATHER_FIVE_CACHE';

function fiveGameDate_(now) {
  const t=calendarJst_(now);
  return t.hour<6 ? calendarAddDays_(t.date,-1) : t.date;
}

function fiveConfigured_() {
  const c=calendarRead_(WEATHER_FIVE_CONFIG_KEY);
  return c && c.enabled===true && c.calendarYear===2026 &&
    typeof c.sourceUrl==='string' && /^https:\/\/[a-z0-9][a-z0-9.-]*\/calendar$/i.test(c.sourceUrl) ? c : null;
}

function fiveParse_(html,firstDate,year,checkedAt) {
  if(typeof html!=='string'||html.length>1500000)throw Error('Forecast response is too large');
  const re=/<script\b(?=[^>]*\bid=["']cp["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  const match=re.exec(html);
  if(!match||re.exec(html))throw Error('Forecast JSON is missing or ambiguous');
  const p=JSON.parse(match[1]);
  if(p.y!==year||year!==2026||firstDate.slice(0,4)!==String(year)||!Array.isArray(p.cal)||p.cal.length!==366||!p.wd||!p.wnt)throw Error('Unconfirmed forecast schema or year');
  calendarDate_(firstDate);
  const byDay={};
  p.cal.forEach(function(row){
    if(!Array.isArray(row)||row.length!==4||!Number.isInteger(row[0])||!Number.isInteger(row[1]))throw Error('Invalid forecast day');
    const key=String(row[0]).padStart(2,'0')+'-'+String(row[1]).padStart(2,'0');
    calendarDate_('2028-'+key);
    if(byDay[key]||!Array.isArray(row[2])||row[2].length!==4||row[2].some(function(n){return ![1,2,3,4].includes(n);})||
      !Array.isArray(row[3])||row[3].length!==24||row[3].some(function(n){return !Number.isInteger(n)||!([1,2,3,4,101,102,104,105,106,201,202,203,204,211,212,213,301,302,303,304,305,399].includes(n)||n>=107&&n<=121)||typeof p.wd[n]!=='string'||typeof p.wnt[n]!=='string';}))throw Error('Incomplete or duplicate forecast day');
    byDay[key]=row;
  });
  function special(id){
    if(id===104)return 'heat';
    if(id===106)return 'petal';
    if(id>=107&&id<=118)return 'meteor';
    if(id>=119&&id<=121)return 'aurora';
    if(id>=211&&id<=213)return 'snow';
    return '';
  }
  const days=[];
  for(let i=0;i<8;i++){
    const date=calendarAddDays_(firstDate,i);
    if(date.slice(0,4)!==String(year))break; // No assumed annual repetition.
    const row=byDay[date.slice(5)];if(!row)throw Error('Forecast date is missing');
    const slots=row[2].map(function(base,index){
      const events=row[3].slice(index*6,index*6+6).map(special);
      const distinct=events.filter(function(e){return e;}).filter(function(e,i,a){return a.indexOf(e)===i;});
      if(distinct.length>1||distinct.length===1&&events.some(function(e){return e!==distinct[0];}))throw Error('Ambiguous six-hour event');
      return distinct[0]||({1:'clear',2:'rain',3:'rainbow',4:'cloud'})[base];
    });
    days.push({date:date,slots:slots});
  }
  if(!Number.isFinite(Date.parse(checkedAt)))throw Error('Invalid retrieval time');
  return {version:1,calendarYear:year,checkedAt:new Date(checkedAt).toISOString(),days:days};
}

function fivePoints_(snapshot,now) {
  const date=fiveGameDate_(now);
  return [6,12,18,24,30].map(function(offset){
    const point=new Date(calendarDate_(date).getTime()+offset*3600000),day=point.toISOString().slice(0,10),hour=point.getUTCHours();
    const row=snapshot.days.find(function(d){return d.date===day;});
    if(!row||!row.slots[hour/6])throw Error('Five-slot cache does not cover the game day');
    return {date:day,hour:hour,category:row.slots[hour/6]};
  });
}

function fiveCompare_(snapshot,now) {
  const saved=calendarRead_(WEATHER_CALENDAR_APPROVED_KEY),points=fivePoints_(snapshot,now),differences=[];
  let compared=0;
  if(saved&&saved.types&&Array.isArray(saved.days)&&Date.parse(saved.checkedAt)>=new Date(now).getTime()-36*3600000){
    points.forEach(function(point){
      const day=saved.days.find(function(d){return d.date===point.date;});if(!day)return;
      const cats=day.hours.slice(point.hour,point.hour+6).map(function(id){const t=saved.types[id];return t&&t.category;});
      // Hourly clouds within a sunny game block and rain variants share a UI summary.
      let expected=cats.length===6&&cats.every(function(c){return c==='clear'||c==='cloud';})?'clear':
        cats.length===6&&cats.every(function(c){return c==='rain'||c==='sunshower';})?'rain':
        cats.length===6&&cats.every(function(c){return c&&c===cats[0];})?cats[0]:null;
      if(!expected)return;
      compared++;
      const actual=point.category==='cloud'?'clear':point.category;
      if(actual!==expected)differences.push({date:point.date,hour:point.hour,primary:point.category,comparison:expected});
    });
  }
  return {checkedAt:new Date(now).toISOString(),gameDate:fiveGameDate_(now),status:differences.length?'mismatch':compared?'matched':'unchecked',compared:compared,differences:differences};
}

function fiveRefresh_() {
  const config=fiveConfigured_();if(!config)return {ok:false,status:'source-not-enabled'};
  const now=new Date(),saved=calendarRead_(WEATHER_FIVE_CACHE_KEY);
  if(saved&&Date.parse(saved.checkedAt)>now.getTime()-3600000)return {ok:true,status:'cached'};
  const r=UrlFetchApp.fetch(config.sourceUrl,{muteHttpExceptions:true,followRedirects:false});
  if(r.getResponseCode()!==200)throw Error('Five-slot source did not return HTTP 200');
  const snapshot=fiveParse_(r.getContentText(),fiveGameDate_(now),config.calendarYear,now.toISOString());
  const comparison=fiveCompare_(snapshot,now);
  calendarWrite_('WEATHER_FIVE_COMPARISON',comparison);
  if(comparison.status==='mismatch')throw Error('Five-slot forecast differs from the comparison source');
  weatherHistoryAppend_(snapshot.days.map(function(day){return {kind:'five-slot-forecast',targetDate:day.date,payload:{version:1,timeZone:'Asia/Tokyo',recordType:'forecast',resolutionHours:6,calendarYear:snapshot.calendarYear,slots:day.slots,sourceUrl:config.sourceUrl,verification:'source-comparison-only'}};}));
  // Complete dated snapshots are committed atomically; errors never clear a good cache.
  calendarWrite_(WEATHER_FIVE_CACHE_KEY,snapshot);
  return {ok:true,status:'updated',compared:comparison.compared};
}

function fivePublic_() {
  if(!fiveConfigured_())return null;
  const s=calendarRead_(WEATHER_FIVE_CACHE_KEY);if(!s||s.version!==1||!Array.isArray(s.days))return null;
  const labels={clear:'晴れ',rain:'雨',rainbow:'虹',cloud:'幸運雲',meteor:'流星',snow:'雪',aurora:'オーロラ',heat:'猛暑',petal:'花びら'};
  try{return {version:1,timeZone:'Asia/Tokyo',gameDate:fiveGameDate_(new Date()),checkedAt:s.checkedAt,
    slots:fivePoints_(s,new Date()).map(function(p){if(!labels[p.category])throw Error('Unknown weather');return {date:p.date,hour:p.hour,category:p.category,label:labels[p.category]};}),
    credit:{label:'Tidebell',url:'https://tidebell.com/calendar'}};
  }catch(_){return null;}
}

function fiveAdmin_(body) {
  requireKey_(body.adminKey,adminKey_(),'管理キー');
  return withScriptLock_(function(){
    if(body.action==='initializeWeatherFiveSlots'){
      const props=PropertiesService.getScriptProperties(),before=props.getProperty(WEATHER_FIVE_CONFIG_KEY);
      try{
        if(!fiveConfigured_()){
          if(typeof weatherFivePrivateDefaults_!=='function')throw Error('Five-slot setup is unavailable');
          calendarWrite_(WEATHER_FIVE_CONFIG_KEY,weatherFivePrivateDefaults_());
          if(!fiveConfigured_())throw Error('Five-slot configuration is incomplete');
        }
        const r=fiveRefresh_();return json_({ok:r.ok,enabled:true,status:r.status,slots:fivePublic_()});
      }catch(e){if(before)props.setProperty(WEATHER_FIVE_CONFIG_KEY,before);else props.deleteProperty(WEATHER_FIVE_CONFIG_KEY);throw e;}
    }
    if(body.action==='refreshWeatherFiveSlots')return json_(fiveRefresh_());
    return json_({ok:true,enabled:Boolean(fiveConfigured_()),forecast:fivePublic_(),comparison:calendarRead_('WEATHER_FIVE_COMPARISON'),lastError:calendarRead_('WEATHER_FIVE_LAST_ERROR')});
  });
}

function runFiveWeatherScheduler() {
  if(!fiveConfigured_())return;
  const now=new Date(),t=calendarJst_(now);
  if(t.hour!==8&&t.hour!==19)return;
  const props=PropertiesService.getScriptProperties(),marker=t.date+':'+t.hour,key='WEATHER_FIVE_ATTEMPT_'+(t.minute<10?'primary':'retry');
  const lock=LockService.getScriptLock();if(!lock.tryLock(3000))return;
  try{
    if(props.getProperty('WEATHER_FIVE_COMPLETED')===marker||props.getProperty(key)===marker)return;
    props.setProperty(key,marker);
    try{
      const r=fiveRefresh_();if(!r.ok)return;
      props.setProperty('WEATHER_FIVE_COMPLETED',marker);props.deleteProperty('WEATHER_FIVE_LAST_ERROR');props.deleteProperty('WEATHER_FIVE_FAILURE_NOTIFIED');
    }catch(_){
      calendarWrite_('WEATHER_FIVE_LAST_ERROR',{at:now.toISOString(),status:'refresh-failed'});
      const s=calendarRead_(WEATHER_FIVE_CACHE_KEY),last=s&&s.days&&s.days[s.days.length-1],comparison=calendarRead_('WEATHER_FIVE_COMPARISON');
      if((!last||last.date<=calendarAddDays_(t.date,1)||comparison&&comparison.status==='mismatch')&&props.getProperty('WEATHER_FIVE_FAILURE_NOTIFIED')!=='1'){
        const webhook=props.getProperty('WEATHER_CALENDAR_PRIVATE_WEBHOOK_URL');
        if(webhook){try{const r=UrlFetchApp.fetch(webhook,{method:'post',contentType:'application/json',muteHttpExceptions:true,payload:JSON.stringify({content:'⚠️ 5枠の天気予報の更新・照合を確認してください。保存済み予報は維持しています。\nhttps://sg-log.github.io/heartopia-daily/?admin=1#weatherCalendarReview',allowed_mentions:{parse:[]}})});if(r.getResponseCode()>=200&&r.getResponseCode()<300)props.setProperty('WEATHER_FIVE_FAILURE_NOTIFIED','1');}catch(_){}}
      }
    }
  }finally{lock.releaseLock();}
}
