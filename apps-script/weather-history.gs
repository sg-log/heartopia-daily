// Private, append-only research records. Forecasts are never labelled observations.
const WEATHER_HISTORY_SHEET = 'weather_history';
const WEATHER_HISTORY_HEADERS = ['key','kind','targetDate','recordedAt','payload'];

function weatherHistoryCanonical_(value) {
  if (Array.isArray(value)) return '[' + value.map(weatherHistoryCanonical_).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(function(k) { return value[k] !== undefined; }).map(function(k) {
    return JSON.stringify(k) + ':' + weatherHistoryCanonical_(value[k]);
  }).join(',') + '}';
  return JSON.stringify(value);
}

function weatherHistoryHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(b) { return (b & 255).toString(16).padStart(2,'0'); }).join('');
}

function weatherHistoryEntity_(kind,date,payload,key) {
  return kind + '\n' + date + '\n' + (kind === 'legacy-report' ? String(payload.report.id || key) : '');
}

function weatherHistorySheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  requirePrivateEvidence_(DriveApp.getFileById(book.getId()));
  let sheet = book.getSheetByName(WEATHER_HISTORY_SHEET);
  if (!sheet) sheet = book.insertSheet(WEATHER_HISTORY_SHEET);
  if (!sheet.getLastRow()) sheet.appendRow(WEATHER_HISTORY_HEADERS);
  const headers = sheet.getRange(1,1,1,WEATHER_HISTORY_HEADERS.length).getValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(WEATHER_HISTORY_HEADERS)) throw new Error('Weather history schema differs');
  return sheet;
}

// Call under the existing script lock. Keys exclude retrieval time so unchanged
// forecasts do not create a second copy at every refresh; changed forecasts do.
function weatherHistoryAppend_(events) {
  const now = new Date().toISOString();
  const rows = events.map(function(event) {
    if (!['legacy-report','calendar-forecast','sns-comparison','sns-evidence'].includes(event.kind) || !/^20\d{2}-\d{2}-\d{2}$/.test(event.targetDate)) throw new Error('Invalid history event');
    const payload = weatherHistoryCanonical_(event.payload);
    if (payload.length > 45000) throw new Error('Weather history record too large');
    const key = weatherHistoryHash_(event.kind + '\n' + event.targetDate + '\n' + payload);
    return [key,event.kind,event.targetDate,now,payload];
  });
  if (!rows.length) return {added:0,unchanged:0};
  const sheet = weatherHistorySheet_(), last = sheet.getLastRow();
  const latest = new Map();
  if (last > 1) sheet.getRange(2,1,last-1,5).getValues().forEach(function(row) {
    latest.set(weatherHistoryEntity_(row[1],row[2],JSON.parse(row[4]),row[0]),row[0]);
  });
  const added = [];
  rows.forEach(function(row) {
    const entity = weatherHistoryEntity_(row[1],row[2],JSON.parse(row[4]),row[0]);
    if (latest.get(entity) !== row[0]) { latest.set(entity,row[0]); added.push(row); }
  });
  if (added.length) {
    const end = last + added.length;
    if (end > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),end-sheet.getMaxRows());
    // All values are trusted literals, hashes or JSON (never raw spreadsheet formulas).
    sheet.getRange(last+1,1,added.length,WEATHER_HISTORY_HEADERS.length).setNumberFormat('@').setValues(added);
    SpreadsheetApp.flush();
  }
  return {added:added.length,unchanged:rows.length-added.length};
}

function weatherHistoryCalendar_(snapshot) {
  return weatherHistoryAppend_(snapshot.days.map(function(day) {
    const used = {};
    day.hours.forEach(function(id) { used[id] = snapshot.types[id]; });
    return {kind:'calendar-forecast',targetDate:day.date,payload:{version:1,timeZone:'Asia/Tokyo',
      recordType:'forecast',resolutionHours:1,calendarYear:snapshot.calendarYear,hours:day.hours,types:used,
      sourceUrl:snapshot.sourceUrl || '',verification:'not-established'}};
  }));
}

function weatherHistoryImportLegacy_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return {added:0,unchanged:0,skipped:0};
  const values = sheet.getDataRange().getValues(), headers = values.shift().map(String);
  let skipped = 0;
  const events = [];
  values.forEach(function(row) {
    const item = {};
    headers.forEach(function(key,i) { if (key) item[key] = row[i] instanceof Date ? row[i].toISOString() : row[i]; });
    const date = formatDateValue(item.date);
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) { skipped++; return; }
    events.push({kind:'legacy-report',targetDate:date,payload:{version:1,timeZone:'Asia/Tokyo',
      recordType:'reported-forecast',resolutionHours:6,verification:'legacy-status-only',report:item}});
  });
  const result = weatherHistoryAppend_(events);
  result.skipped = skipped;
  return result;
}

function weatherHistoryComparison_(date,result) {
  if (!result || !['matched','unchecked','needs-corroboration','mismatch'].includes(result.status) ||
      !Array.isArray(result.checks) || result.checks.length > 100 ||
      (result.status !== 'unchecked' && !result.checks.length)) throw new Error('Invalid comparison history');
  return weatherHistoryAppend_([{kind:'sns-comparison',targetDate:date,payload:{version:1,timeZone:'Asia/Tokyo',
    recordType:'forecast-ui-comparison',resolutionHours:6,result:result}}]);
}

function weatherHistoryAdmin_(body) {
  requireKey_(body.adminKey,adminKey_(),'管理キー');
  return withScriptLock_(function() {
    if (body.action === 'archiveWeatherHistory') return json_({ok:true,result:weatherHistoryImportLegacy_()});
    if (body.action === 'recordWeatherComparison') {
      const saved=weatherHistoryComparison_(body.targetDate,body.result);
      const hashes=Array.isArray(body.evidenceHashes)?body.evidenceHashes.filter(function(h){return /^[a-f0-9]{64}$/.test(h);}).slice(0,5):[];
      const summary={date:body.targetDate,status:body.result.status,at:new Date().toISOString(),comparedCells:body.result.comparedCells||0,independentAuthors:body.result.independentAuthors||0,evidenceHashes:hashes};
      calendarWrite_('WEATHER_CALENDAR_COMPARISON',summary);
      const conflicts=Array.from(new Set((body.result.confirmedConflicts||[]).map(function(c){return c.date+':'+c.hour+':'+c.observed;}))).sort();
      const incident=body.targetDate+':'+weatherHistoryHash_(weatherHistoryCanonical_(conflicts));
      const props=PropertiesService.getScriptProperties(),webhook=props.getProperty('WEATHER_CALENDAR_PRIVATE_WEBHOOK_URL');
      if(body.notify===true && body.result.status==='mismatch' && body.result.notify===true && body.result.independentAuthors>=2 && webhook && props.getProperty('WEATHER_CALENDAR_COMPARISON_NOTIFIED')!==incident) {
        const response=UrlFetchApp.fetch(webhook,{method:'post',contentType:'application/json',muteHttpExceptions:true,payload:JSON.stringify({content:'⚠️ 時間別予報と、複数のゲーム内UI画像で相違を確認しました。管理画面で根拠画像を確認してください。\nhttps://sg-log.github.io/heartopia-daily/?admin=1#weatherCalendarReview',allowed_mentions:{parse:[]}})});
        if(response.getResponseCode()>=200 && response.getResponseCode()<300)props.setProperty('WEATHER_CALENDAR_COMPARISON_NOTIFIED',incident);
      }
      return json_({ok:true,result:saved,status:summary.status});
    }
    const offset = body.offset == null ? 0 : Number(body.offset);
    const limit = body.limit == null ? 100 : Number(body.limit);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid history page');
    const book=SpreadsheetApp.getActiveSpreadsheet();requirePrivateEvidence_(DriveApp.getFileById(book.getId()));
    const sheet = book.getSheetByName(WEATHER_HISTORY_SHEET);
    const total = sheet ? Math.max(0,sheet.getLastRow()-1) : 0;
    const size = Math.max(0,Math.min(limit,total-offset));
    const records = size ? sheet.getRange(offset+2,1,size,5).getValues().map(function(row) {
      return {key:row[0],kind:row[1],targetDate:row[2],recordedAt:row[3],payload:JSON.parse(row[4])};
    }) : [];
    return json_({ok:true,total:total,records:records,nextOffset:offset+size < total ? offset+size : null});
  });
}

function weatherComparisonEvidenceAdmin_(body) {
  requireKey_(body.adminKey,adminKey_(),'管理キー');
  return withScriptLock_(function(){
    const props=PropertiesService.getScriptProperties(),folder=weatherEvidenceFolder_();
    if(body.action==='saveWeatherComparisonEvidence') {
      const evidence=validateWeatherEvidence_([body.image]),key='WEATHER_COMPARISON_IMAGES';
      const recent=JSON.parse(props.getProperty(key)||'[]');
      if(recent.some(function(m){return m.image.sha256===evidence.meta.sha256;}))return json_({ok:true,saved:true,sha256:evidence.meta.sha256});
      const file=folder.createFile(Utilities.newBlob(evidence.bytes,evidence.meta.mimeType,'comparison-'+evidence.meta.sha256+(evidence.meta.mimeType==='image/png'?'.png':'.jpg')));
      try {
        requirePrivateEvidence_(file);
        const meta={fileId:file.getId(),image:evidence.meta,author:limitText_(body.author,TEXT_LIMITS.author,'author'),sourceUrl:weatherEvidenceUrl_(body.sourceUrl,false)};
        weatherHistoryAppend_([{kind:'sns-evidence',targetDate:validateDateForWrite_(body.targetDate),payload:meta}]);
        props.setProperty(key,JSON.stringify(recent.concat([meta]).slice(-10)));
      }catch(error){try{file.setTrashed(true);}catch(_){}throw error;}
      return json_({ok:true,saved:true,sha256:evidence.meta.sha256});
    }
    if(!/^[a-f0-9]{64}$/.test(body.sha256||''))throw new Error('Invalid comparison image');
    const meta=JSON.parse(props.getProperty('WEATHER_COMPARISON_IMAGES')||'[]').find(function(m){return m.image.sha256===body.sha256;});
    if(!meta)throw new Error('Comparison image unavailable');
    const file=DriveApp.getFileById(meta.fileId);requirePrivateEvidence_(file);
    const parents=file.getParents();let belongs=false;while(parents.hasNext())if(parents.next().getId()===folder.getId())belongs=true;
    if(!belongs||file.isTrashed())throw new Error('Comparison image unavailable');
    const bodyBase64=Utilities.base64Encode(file.getBlob().getBytes());
    validateWeatherEvidence_([Object.assign({},meta.image,{bodyBase64:bodyBase64})]);
    return json_({ok:true,mimeType:meta.image.mimeType,bodyBase64:bodyBase64});
  });
}
