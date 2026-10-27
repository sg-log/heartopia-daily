import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';

test('bird clock uses Japan time, rolls date at midnight and fits the weather heading',async()=>{
  const html=await fs.readFile('index.html','utf8');
  const style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const heading=html.match(/<div class="weatherHeading">([\s\S]*?)<div id="weatherResult">/)[1];
  const css=await fs.readFile('assets/weather-bird-clock.css','utf8');
  const script=await fs.readFile('assets/weather-bird-clock.js','utf8');
  const png=(await fs.readFile('assets/weather-bird-clock.png')).toString('base64');
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:400},timezoneId:'America/Los_Angeles'});
    await page.clock.install({time:new Date('2026-10-22T14:59:00Z')});
    let requests=0;await page.route(/^https?:/,route=>{requests++;return route.abort();});
    const markup=heading.replace('assets/weather-bird-clock.png','data:image/png;base64,'+png);
    await page.setContent(`<style>${style}\n${css}</style><main><div class="card weatherCard" style="max-width:370px"><div class="weatherHeading">${markup}</div></main><script>${script}</script>`,{waitUntil:'load'});
    assert.equal(await page.locator('#weatherBirdClockTime').textContent(),'23:59');
    assert.equal(await page.locator('#weatherClockDate').textContent(),'10/22（木）');
    assert.equal(await page.locator('#weatherClockDate').getAttribute('datetime'),'2026-10-22');
    await page.clock.fastForward(60050);
    assert.equal(await page.locator('#weatherBirdClockTime').textContent(),'00:00');
    assert.equal(await page.locator('#weatherClockDate').textContent(),'10/23（金）');
    await page.clock.setSystemTime(new Date('2026-10-22T21:05:00Z'));
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.locator('#weatherBirdClockTime').textContent(),'06:05');
    assert.equal(await page.locator('#weatherClockDate').textContent(),'10/23（金）');
    assert.equal(await page.locator('#weatherBirdClock').getAttribute('aria-label'),'日本時間 06時05分');
    for(const width of [320,390,1080]){
      await page.setViewportSize({width,height:400});
      assert.equal(await page.locator('.weatherHeading').evaluate(el=>el.scrollWidth>el.clientWidth),false,'heading must fit at '+width);
    }
    assert.equal(await page.locator('.weatherBirdClock img').evaluate(el=>el.naturalWidth>0),true);
    assert.equal(requests,0,'clock updates without a network request');
    if(process.env.WEATHER_CLOCK_SCREENSHOT){await page.setViewportSize({width:390,height:400});await page.locator('.weatherCard').screenshot({path:process.env.WEATHER_CLOCK_SCREENSHOT});}
  }finally{await browser.close();}
});

test('today-only forecast keeps the approved game-style card, weekly focus and aligned current-hour cells',async()=>{
  const root=process.cwd(),html=await fs.readFile(process.env.WEATHER_TEST_INDEX||'index.html','utf8');
  const calendar={version:2,timeZone:'Asia/Tokyo',date:'2026-10-20',checkedAt:'2026-10-20T00:00:00Z',hours:Array.from({length:15},(_,i)=>({hour:i+9,category:i<9?'cloud':'meteor',label:i<9?'くもり':'流星群'})),credit:{label:'Weather forecast by TH.GL',url:'https://heartopia.th.gl/forecast'}};
  const report={date:'2026-10-20',startSlot:'00',slots:Object.fromEntries(Array.from({length:5},(_,i)=>['slot'+i,['晴']])),weeks:Object.fromEntries(Array.from({length:7},(_,i)=>['week'+(i+1),['雨']]))};
  const server=http.createServer(async(req,res)=>{try{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));
    if(pathname!=='/'&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    const body=pathname==='/'?html:await fs.readFile(file);
    const type=pathname==='/'?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream';
    res.writeHead(200,{'Content-Type':type});res.end(body);
  }catch(_){res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Tokyo'});
    await context.addInitScript(()=>{globalThis.weatherTestTime='2026-10-20T00:30:00Z';const Original=Date;globalThis.Date=class extends Original{constructor(...args){super(...(args.length?args:[globalThis.weatherTestTime]));}static now(){return new Original(globalThis.weatherTestTime).getTime();}};});
    const page=await context.newPage(),errors=[];let sourceUnavailable=false,fiveSlots=null,offline=false;page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url());
      if(u.hostname==='127.0.0.1'){await route.continue();return;}
      if(u.hostname==='script.google.com'){
        if(offline){await route.abort();return;}
        const action=u.searchParams.get('action')||JSON.parse(req.postData()||'{}').action;
        const body=action==='getWeatherCalendar'?{ok:true,enabled:true,calendar:sourceUnavailable?null:calendar,fiveSlots}:action==='approved'?{ok:true,reports:[report]}:action==='getGiftCodes'?{ok:true,codes:[]}:action==='getSiteNotice'?{ok:true,notice:{}}:{ok:true};
        await route.fulfill({status:200,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body:JSON.stringify(body)});return;
      }
      await route.abort();
    });
    await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'networkidle'});
    await page.waitForFunction(()=>globalThis.HeartopiaCalendar?.active());
    await page.waitForFunction(()=>document.querySelectorAll('#weatherResult .compactWeatherWeek .weeklyWeatherRow').length===7&&document.querySelector('#weatherResult .focusWeatherChip'));
    const actual=await page.evaluate(()=>({daily:document.getElementById('weatherResult').innerHTML,summary:document.getElementById('weatherSummary').innerHTML,weeklyRows:document.querySelectorAll('#weeklyWeather .weeklyWeatherRow').length,share:document.getElementById('shareImagePreview').textContent,shareWeekRows:document.querySelectorAll('#shareImagePreview .shareImageWeekCell').length,discord:document.getElementById('discordText').textContent}));
    assert.deepEqual(errors,[]);assert.ok(actual.daily.includes('Weather forecast by TH.GL'));assert.ok(actual.summary.includes('weatherHourlySlots'));
    assert.equal(actual.weeklyRows,7);assert.equal(actual.shareWeekRows,7);assert.ok(actual.share.includes('週間天気'));assert.doesNotMatch(actual.share,/TH.GL|時間別予報|注目/);assert.ok(!actual.discord.includes('いまの天気：'));assert.ok(actual.discord.includes('【週間天気】'));assert.doesNotMatch(actual.discord,/TH.GL|heartopia\.th\.gl/);
    assert.deepEqual(await page.locator('#weatherResult .weatherLineTime').allTextContents(),['06','12','18','00','06']);
    assert.deepEqual(await page.locator('#weatherResult .weatherLineLabel').allTextContents(),['くもり','くもり','流星','','']);
    assert.deepEqual(await page.locator('#weatherResult .weatherLineText').allTextContents(),['☁️','☁️','🌠','—','—']);
    assert.equal(await page.locator('#weatherResult .weatherLine[aria-current="time"]').count(),1);
    assert.equal(await page.locator('#weatherResult .weatherLine.current .weatherLineTime').textContent(),'06');
    assert.ok(actual.daily.includes('🌠'));assert.ok(!actual.daily.includes('☄️'));assert.ok(!actual.daily.includes('いま'));
    const geometry=await page.locator('#weatherResult .weatherHourlySlots').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,aligned:['.weatherLineTime','.weatherLineText','.weatherLineLabel'].every(selector=>{const nodes=[...el.querySelectorAll(selector)],ys=nodes.map(node=>node.getBoundingClientRect().top);return Math.max(...ys)-Math.min(...ys)<0.5;}),singleLine:[...el.querySelectorAll('.weatherLineLabel')].every(node=>node.getBoundingClientRect().height<=parseFloat(getComputedStyle(node).fontSize)*1.6)}));
    assert.equal(geometry.columns,5);assert.ok(geometry.aligned);assert.ok(geometry.singleLine);
    assert.equal(await page.locator('.weatherHeading').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    assert.equal(await page.locator('.weatherBirdClock').evaluate(el=>getComputedStyle(el).width),'104px','real page must load the clock stylesheet');
    if(process.env.WEATHER_TEST_SCREENSHOT)await page.screenshot({path:process.env.WEATHER_TEST_SCREENSHOT,fullPage:false});
    if(process.env.WEATHER_FIXED_FIVE_SCREENSHOT)await page.locator('.weatherCard').screenshot({path:process.env.WEATHER_FIXED_FIVE_SCREENSHOT});
    await page.evaluate(()=>{weatherTestTime='2026-10-20T09:05:00Z';renderWeather(E.targetDate.value,weatherData(E.targetDate.value));});
    assert.equal(await page.locator('#weatherResult .weatherLine.current .weatherLineTime').textContent(),'18');
    assert.equal(await page.locator('#weatherResult .weatherLine.current .weatherLineText').textContent(),'🌠');
    await page.evaluate(()=>{renderWeather('2026-10-21',weatherData('2026-10-21'));});
    assert.equal(await page.locator('#weatherResult .weatherHourlySlots').count(),0,'selecting another date does not show today-only source values');
    await page.evaluate(()=>{weatherTestTime='2026-10-20T00:30:00Z';globalThis.savedTestWeather=state.weather;state.weather=[];renderWeather(E.targetDate.value,null);});
    assert.equal(await page.locator('#weatherResult .compactWeatherWeek .weeklyWeatherRow').count(),7);
    assert.ok((await page.locator('#weatherResult .compactWeatherWeek').textContent()).includes('—'),'missing weekly data keeps empty cells, never borrowed hourly values');
    await page.evaluate(()=>{state.weather=savedTestWeather;renderWeather(E.targetDate.value,weatherData(E.targetDate.value));});
    sourceUnavailable=true;
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(()=>!HeartopiaCalendar.active());
    const fallback=await page.locator('#weatherResult').textContent();assert.equal(await page.locator('#weatherResult .weatherSlotList .weatherLine').count(),5);assert.ok(!fallback.includes('Weather forecast by TH.GL'));
    assert.equal(await page.locator('#weeklyWeather .weeklyWeatherRow').count(),7);
    fiveSlots={version:1,timeZone:'Asia/Tokyo',gameDate:'2026-10-20',checkedAt:'2026-10-20T00:00:00Z',slots:[6,12,18,24,30].map((offset,i)=>{const d=new Date(Date.parse('2026-10-20T00:00:00Z')+offset*3600000);return {date:d.toISOString().slice(0,10),hour:d.getUTCHours(),category:['clear','clear','meteor','clear','rain'][i],label:['晴れ','晴れ','流星','晴れ','雨'][i]};}),credit:{label:'Tidebell',url:'https://tidebell.com/calendar'}};
    await page.evaluate(()=>{weatherTestTime='2026-10-20T11:49:00Z';document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>HeartopiaCalendar.active()&&document.querySelectorAll('#weatherResult .weatherLineLabel')[4]?.textContent==='雨');
    assert.deepEqual(await page.locator('#weatherResult .weatherLineText').allTextContents(),['☀️','☀️','🌠','🌙','🌧️']);
    assert.deepEqual(await page.locator('#weatherResult .weatherLineLabel').allTextContents(),['晴れ','晴れ','流星','晴れ','雨']);
    assert.equal(await page.locator('#weatherResult .weatherLine.current .weatherLineTime').textContent(),'18');
    assert.equal(await page.locator('#weatherResult .compactWeatherWeek .weeklyWeatherRow').count(),7,'game UI weekly forecast is retained');
    if(process.env.WEATHER_FILLED_FIVE_SCREENSHOT)await page.locator('.weatherCard').screenshot({path:process.env.WEATHER_FILLED_FIVE_SCREENSHOT});
    offline=true;
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(100);
    assert.deepEqual(await page.locator('#weatherResult .weatherLineLabel').allTextContents(),['晴れ','晴れ','流星','晴れ','雨'],'network failure never erases the five cached facts');
    await page.reload({waitUntil:'networkidle'});
    await page.waitForFunction(()=>HeartopiaCalendar.active());
    assert.equal(await page.locator('#weatherResult .weatherLineLabel').count(),5,'saved five-slot forecast survives reload while offline');
    await page.evaluate(()=>{weatherTestTime='2026-10-20T15:05:00Z';renderWeather(E.targetDate.value,weatherData(E.targetDate.value));});
    assert.equal(await page.locator('#weatherResult .weatherLine.current .weatherLineTime').textContent(),'00');
    assert.equal(await page.locator('#weatherResult .weatherLineLabel').count(),5,'midnight keeps the same game-day forecast');
    await page.evaluate(()=>{weatherTestTime='2026-10-20T21:00:00Z';});
    assert.equal(await page.evaluate(()=>HeartopiaCalendar.active()),false,'yesterday forecast never masquerades as the new game day');
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
