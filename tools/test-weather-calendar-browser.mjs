import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';
test('today-only forecast keeps the approved game-style card, weekly focus and aligned current-hour cells',async()=>{
  const root=process.cwd(),html=await fs.readFile(process.env.WEATHER_TEST_INDEX||'index.html','utf8');
  const calendar={version:2,timeZone:'Asia/Tokyo',date:'2026-10-20',checkedAt:'2026-10-20T00:00:00Z',hours:Array.from({length:15},(_,i)=>({hour:i+9,category:i<9?'cloud':'meteor',label:i<9?'くもり':'流星群'})),credit:{label:'Weather forecast by TH.GL',url:'https://heartopia.th.gl/forecast'}};
  const report={date:'2026-10-20',startSlot:'00',slots:Object.fromEntries(Array.from({length:5},(_,i)=>['slot'+i,['晴']])),weeks:Object.fromEntries(Array.from({length:7},(_,i)=>['week'+(i+1),['雨']]))};
  const server=http.createServer(async(req,res)=>{try{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const file=path.resolve(root,'.'+decodeURIComponent(pathname));
    if(pathname!=='/'&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    const body=pathname==='/'?html:await fs.readFile(file);
    const type=pathname==='/'?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream';
    res.writeHead(200,{'Content-Type':type});res.end(body);
  }catch(_){res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Tokyo'});
    await context.addInitScript(()=>{globalThis.weatherTestTime='2026-10-20T00:30:00Z';const Original=Date;globalThis.Date=class extends Original{constructor(...args){super(...(args.length?args:[globalThis.weatherTestTime]));}static now(){return new Original(globalThis.weatherTestTime).getTime();}};});
    const page=await context.newPage(),errors=[];let sourceUnavailable=false;page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url());
      if(u.hostname==='127.0.0.1'){await route.continue();return;}
      if(u.hostname==='script.google.com'){
        const action=u.searchParams.get('action')||JSON.parse(req.postData()||'{}').action;
        const body=action==='getWeatherCalendar'?{ok:true,enabled:true,calendar:sourceUnavailable?null:calendar}:action==='approved'?{ok:true,reports:[report]}:action==='getGiftCodes'?{ok:true,codes:[]}:action==='getSiteNotice'?{ok:true,notice:{}}:{ok:true};
        await route.fulfill({status:200,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body:JSON.stringify(body)});return;
      }
      await route.abort();
    });
    await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'networkidle'});
    await page.waitForFunction(()=>globalThis.HeartopiaCalendar?.active());
    await page.waitForFunction(()=>document.querySelectorAll('#weatherResult .compactWeatherWeek .weeklyWeatherRow').length===7&&document.querySelector('#weatherResult .focusWeatherChip'));
    const actual=await page.evaluate(()=>({daily:document.getElementById('weatherResult').innerHTML,summary:document.getElementById('weatherSummary').innerHTML,weeklyRows:document.querySelectorAll('#weeklyWeather .weeklyWeatherRow').length,share:document.querySelector('.shareImageWeatherLine')?.textContent||'',discord:document.getElementById('discordText').textContent}));
    assert.deepEqual(errors,[]);assert.ok(actual.daily.includes('Weather forecast by TH.GL'));assert.ok(actual.summary.includes('weatherHourlySlots'));
    assert.ok(!actual.daily.includes('2026-10-21'));assert.equal(actual.weeklyRows,7);assert.ok(actual.share.includes('サイトで確認'));assert.ok(!actual.discord.includes('いまの天気：'));
    assert.deepEqual(await page.locator('#weatherResult .weatherLineTime').allTextContents(),['09','18']);
    assert.deepEqual(await page.locator('#weatherResult .weatherLineLabel').allTextContents(),['くもり','流星']);
    assert.equal(await page.locator('#weatherResult .weatherLine[aria-current="time"]').count(),1);
    assert.equal(await page.locator('#weatherResult .weatherLine.current .weatherLineTime').textContent(),'09');
    assert.ok(actual.daily.includes('🌠'));assert.ok(!actual.daily.includes('☄️'));assert.ok(!actual.daily.includes('いま'));
    const geometry=await page.locator('#weatherResult .weatherHourlySlots').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,aligned:['.weatherLineTime','.weatherLineText','.weatherLineLabel'].every(selector=>{const nodes=[...el.querySelectorAll(selector)],ys=nodes.map(node=>node.getBoundingClientRect().top);return Math.max(...ys)-Math.min(...ys)<0.5;}),singleLine:[...el.querySelectorAll('.weatherLineLabel')].every(node=>node.getBoundingClientRect().height<=parseFloat(getComputedStyle(node).fontSize)*1.6)}));
    assert.equal(geometry.columns,5);assert.ok(geometry.aligned);assert.ok(geometry.singleLine);
    if(process.env.WEATHER_TEST_SCREENSHOT)await page.screenshot({path:process.env.WEATHER_TEST_SCREENSHOT,fullPage:false});
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
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
