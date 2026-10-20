// Opt-in calendar source. Disabled unless its use conditions have been confirmed.
// No paid API, remote JavaScript execution, GitHub dispatch or friend notification.
const WEATHER_CALENDAR_CONFIG_KEY = 'WEATHER_CALENDAR_CONFIG';
const WEATHER_CALENDAR_APPROVED_KEY = 'WEATHER_CALENDAR_APPROVED';

function calendarJst_(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid forecast time');
  const shifted = new Date(date.getTime() + 9 * 3600000);
  return {date:shifted.toISOString().slice(0,10), hour:shifted.getUTCHours(), minute:shifted.getUTCMinutes()};
}

function calendarDate_(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(value))) throw new Error('Invalid forecast date');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new Error('Invalid forecast date');
  return date;
}

function calendarAddDays_(value, days) {
  return new Date(calendarDate_(value).getTime() + days * 86400000).toISOString().slice(0,10);
}

function parseCalendarHtml_(html) {
  if (typeof html !== 'string' || html.length > 1500000) throw new Error('Forecast response is too large');
  const chunks = [];
  const scripts = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scripts.exec(html))) {
    const literal = match[1].trim().replace(/;\s*$/, '');
    const prefix = 'self.__next_f.push(';
    if (!literal.startsWith(prefix) || !literal.endsWith(')')) continue;
    try {
      const entry = JSON.parse(literal.slice(prefix.length,-1));
      if (Array.isArray(entry) && entry[0] === 1 && typeof entry[1] === 'string') chunks.push(entry[1]);
    } catch (_) { /* A script is data only when its argument is valid JSON. */ }
  }
  const found = [];
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 30) return;
    if (Array.isArray(value.calendar) && value.types && typeof value.types === 'object') found.push(value);
    Object.keys(value).forEach(function(key) { visit(value[key], depth + 1); });
  }
  chunks.join('').split('\n').forEach(function(line) {
    const colon = line.indexOf(':');
    if (colon < 0) return;
    try { visit(JSON.parse(line.slice(colon + 1)), 0); } catch (_) {}
  });
  if (found.length !== 1) throw new Error('Forecast data is missing or ambiguous');
  return found[0];
}

function normalizeCalendar_(data, firstDate, calendarYear, checkedAt) {
  calendarDate_(firstDate);
  if (!Number.isInteger(calendarYear) || calendarYear < 2026 || calendarYear > 2099) throw new Error('Forecast year is not confirmed');
  if (firstDate.slice(0,4) !== String(calendarYear)) throw new Error('Forecast year is outside the confirmed range');
  if (!data || !Array.isArray(data.calendar) || !data.calendar.length || data.calendar.length > 366 || !data.types || Array.isArray(data.types)) throw new Error('Invalid forecast schema');
  const categories = ['clear','cloud','heat','petal','meteor','aurora','sunshower','rain','snow','rainbow'];
  const types = {};
  Object.keys(data.types).sort().forEach(function(id) {
    const type = data.types[id];
    if (!/^\d{1,6}$/.test(id) || !type || categories.indexOf(type.cat) < 0 || !type.names || typeof type.names.ja !== 'string' || !type.names.ja.trim() || type.names.ja.length > 40) throw new Error('Unknown forecast type');
    const night = type.namesNight && type.namesNight.ja;
    if (night != null && (typeof night !== 'string' || !night.trim() || night.length > 40)) throw new Error('Invalid night forecast');
    if (type.variant != null && ![1,2,3].includes(type.variant)) throw new Error('Unknown forecast variant');
    types[id] = {category:type.cat, label:type.names.ja, nightLabel:night || type.names.ja, variant:type.variant || null};
  });
  if (Object.keys(types).length > 100 || !Object.keys(types).length) throw new Error('Invalid forecast types');
  const byDay = {};
  data.calendar.forEach(function(row) {
    if (!row || !Number.isInteger(row.m) || !Number.isInteger(row.d)) throw new Error('Invalid calendar day');
    // Validate against a leap year: a yearless source may include February 29.
    const key = String(row.m).padStart(2,'0') + '-' + String(row.d).padStart(2,'0');
    calendarDate_('2028-' + key);
    if (byDay[key] || !Array.isArray(row.h) || row.h.length !== 24 || row.h.some(function(id) { return !Number.isInteger(id) || !types[String(id)]; })) throw new Error('Incomplete or duplicate forecast day');
    byDay[key] = row.h.slice();
  });
  const days = [];
  for (let i = 0; i < 8; i++) {
    const date = calendarAddDays_(firstDate,i);
    // Never assume that a yearless calendar repeats after the verified year.
    if (date.slice(0,4) !== String(calendarYear)) break;
    const hours = byDay[date.slice(5)];
    if (!hours) throw new Error('Forecast is missing a required date');
    days.push({date:date, hours:hours});
  }
  const usedTypes = {};
  Object.keys(types).forEach(function(id) {
    if (days.some(function(day) { return day.hours.indexOf(Number(id)) >= 0; })) usedTypes[id] = types[id];
  });
  const checked = new Date(checkedAt);
  if (!Number.isFinite(checked.getTime())) throw new Error('Invalid retrieval time');
  return {version:1, timeZone:'Asia/Tokyo', calendarYear:calendarYear, checkedAt:checked.toISOString(), days:days, types:usedTypes};
}

function calendarHash_(snapshot) {
  const text = JSON.stringify({version:snapshot.version, calendarYear:snapshot.calendarYear, days:snapshot.days, types:snapshot.types});
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(b) { return (b & 255).toString(16).padStart(2,'0'); }).join('');
}

function calendarRead_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function calendarConfigured_() {
  const config = calendarRead_(WEATHER_CALENDAR_CONFIG_KEY);
  return config && config.enabled === true && config.permissionConfirmed === true && config.displayPolicy === 'today-only' &&
    typeof config.permissionReference === 'string' && config.permissionReference.trim().length >= 5 &&
    typeof config.sourceUrl === 'string' && /^https:\/\/[a-z0-9][a-z0-9.-]*\/[a-z0-9/_?=&%.+-]*$/i.test(config.sourceUrl) &&
    Number.isInteger(config.calendarYear) && config.calendarYear >= 2026 && config.calendarYear <= 2099 ? config : null;
}

function calendarWrite_(key, value) {
  const text = JSON.stringify(value);
  if (Utilities.newBlob(text).getBytes().length > 8500) throw new Error('Forecast cache is too large');
  // One property write commits a complete snapshot. Failed fetch/parse never clears it.
  PropertiesService.getScriptProperties().setProperty(key,text);
}

function calendarRefresh_(force) {
  const config = calendarConfigured_();
  if (!config) return {ok:false, status:'source-not-enabled'};
  const now = new Date();
  const existing = calendarRead_(WEATHER_CALENDAR_APPROVED_KEY);
  if (!force && existing && Date.parse(existing.checkedAt) > now.getTime()-3600000) return {ok:true,status:'cached',hash:existing.hash};
  const jst = calendarJst_(now);
  const firstDate = jst.hour < 6 ? calendarAddDays_(jst.date,-1) : jst.date;
  const response = UrlFetchApp.fetch(config.sourceUrl, {muteHttpExceptions:true, followRedirects:false});
  if (response.getResponseCode() !== 200) throw new Error('Forecast source did not return HTTP 200');
  const snapshot = normalizeCalendar_(parseCalendarHtml_(response.getContentText()),firstDate,config.calendarYear,now.toISOString());
  snapshot.sourceUrl = config.sourceUrl;
  snapshot.hash = calendarHash_(snapshot);
  const approved = calendarRead_(WEATHER_CALENDAR_APPROVED_KEY);
  snapshot.approvedAt = approved && approved.hash === snapshot.hash ? approved.approvedAt : now.toISOString();
  weatherHistoryCalendar_(snapshot);
  calendarWrite_(WEATHER_CALENDAR_APPROVED_KEY,snapshot);
  return {ok:true, status:approved && approved.hash === snapshot.hash ? 'unchanged' : 'updated', hash:snapshot.hash};
}

function calendarPublic_() {
  if (!calendarConfigured_()) return null;
  const snapshot = calendarRead_(WEATHER_CALENDAR_APPROVED_KEY);
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.days)) return null;
  const clock = calendarJst_(new Date());
  const day = snapshot.days.find(function(d) { return d.date === clock.date; });
  if (!day) return null;
  // Permission covers now and the rest of today only. Never send the annual
  // table, past hours, future dates, history, type IDs or private metadata.
  return {version:2,timeZone:'Asia/Tokyo',checkedAt:snapshot.checkedAt,date:clock.date,
    hours:day.hours.map(function(id,hour) {
      const type=snapshot.types[id];
      return {hour:hour,category:type.category,label:(hour<6 || hour>=18 ? type.nightLabel : '') || type.label};
    }).filter(function(value) { return value.hour>=clock.hour; }),
    credit:{label:'Weather forecast by TH.GL',url:'https://heartopia.th.gl/forecast'}};
}

function weatherCalendarAdmin_(body) {
  requireKey_(body.adminKey,adminKey_(),'管理キー');
  return withScriptLock_(function() {
    if (body.action === 'initializeWeatherCalendar') {
      const beforeConfig=PropertiesService.getScriptProperties().getProperty(WEATHER_CALENDAR_CONFIG_KEY);
      if (!calendarConfigured_()) {
        if (typeof weatherCalendarPrivateDefaults_ !== 'function') throw new Error('Calendar setup is unavailable');
        const config=weatherCalendarPrivateDefaults_();
        PropertiesService.getScriptProperties().setProperty(WEATHER_CALENDAR_CONFIG_KEY,JSON.stringify(config));
        if (!calendarConfigured_()) throw new Error('Calendar permission configuration is incomplete');
      }
      const props=PropertiesService.getScriptProperties();
      if (body.privateWebhook) {
        if (!/^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(body.privateWebhook)) throw new Error('Invalid private notification destination');
        props.setProperty('WEATHER_CALENDAR_PRIVATE_WEBHOOK_URL',body.privateWebhook);
      }
      const imported=weatherHistoryImportLegacy_();
      if (!ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction()==='runWeatherScheduler'; })) installWeatherScheduler();
      let refreshed;
      try {refreshed=calendarRefresh_();} catch(error) {
        if(!beforeConfig)props.deleteProperty(WEATHER_CALENDAR_CONFIG_KEY);
        else props.setProperty(WEATHER_CALENDAR_CONFIG_KEY,beforeConfig);
        throw error;
      }
      return json_({ok:refreshed.ok,enabled:true,historyAdded:imported.added,status:refreshed.status});
    }
    if (body.action === 'refreshWeatherCalendar') return json_(calendarRefresh_());
    const approved = calendarRead_(WEATHER_CALENDAR_APPROVED_KEY);
    return json_({ok:true, enabled:Boolean(calendarConfigured_()), calendar:approved,
      lastError:calendarRead_('WEATHER_CALENDAR_LAST_ERROR'),comparison:calendarRead_('WEATHER_CALENDAR_COMPARISON')});
  });
}

function installCalendarWeatherScheduler() {
  if (!calendarConfigured_()) throw new Error('Confirm source use conditions before enabling the calendar source');
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runCalendarWeatherScheduler') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('runCalendarWeatherScheduler').timeBased().everyMinutes(5).create();
}

function runCalendarWeatherScheduler() {
  if (!calendarConfigured_()) return;
  const now = new Date(), jst = calendarJst_(now), minutes = jst.hour * 60 + jst.minute;
  const slot = minutes >= 480 && minutes < 540 ? 'morning' : minutes >= 1140 && minutes < 1200 ? 'evening' : '';
  if (!slot) return;
  const attempt = minutes % 60 < 10 ? 'primary' : 'retry';
  const marker = jst.date + ':' + slot;
  const props = PropertiesService.getScriptProperties(), key = 'WEATHER_CALENDAR_ATTEMPT_' + attempt;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    if (props.getProperty('WEATHER_CALENDAR_COMPLETED') === marker || props.getProperty(key) === marker) return;
    props.setProperty(key,marker);
    try {
      const result = calendarRefresh_();
      if (!result.ok) return;
      props.setProperty('WEATHER_CALENDAR_COMPLETED',marker);
      props.deleteProperty('WEATHER_CALENDAR_LAST_ERROR');
      props.deleteProperty('WEATHER_CALENDAR_FAILURE_NOTIFIED');
    } catch (_) {
      props.setProperty('WEATHER_CALENDAR_LAST_ERROR',JSON.stringify({at:now.toISOString(), slot:slot, status:'refresh-failed'}));
      const saved = calendarRead_(WEATHER_CALENDAR_APPROVED_KEY);
      const last = saved && saved.days && saved.days[saved.days.length - 1];
      // Warn only when the cache is about to run out; once per incident.
      // Never reuse the gift webhook, which points to the friend's server.
      if ((!last || last.date <= calendarAddDays_(jst.date,1)) && props.getProperty('WEATHER_CALENDAR_FAILURE_NOTIFIED') !== '1') {
        const webhook = props.getProperty('WEATHER_CALENDAR_PRIVATE_WEBHOOK_URL');
        if (webhook) {
          try {
            const notice = UrlFetchApp.fetch(webhook,{method:'post', contentType:'application/json', muteHttpExceptions:true,
              payload:JSON.stringify({content:'⚠️ 天気予報を更新できず、保存済み予報の残りが少なくなっています。管理画面の天気自動更新を確認してください。\nhttps://sg-log.github.io/heartopia-daily/?admin=1#weatherCalendarReview',allowed_mentions:{parse:[]}})});
            if (notice.getResponseCode() >= 200 && notice.getResponseCode() < 300) props.setProperty('WEATHER_CALENDAR_FAILURE_NOTIFIED','1');
          } catch (_) {}
        }
      }
    }
  } finally { lock.releaseLock(); }
}
