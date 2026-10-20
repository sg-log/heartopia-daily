import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';
test('today-only forecast replaces daily display, preserves independent SNS weeks and keeps source values out of sharing',async()=>{
  const root=process.cwd(),html=await fs.readFile(process.env.WEATHER_TEST_INDEX||'index.html','utf8');
  const calendar={version:2,timeZone:'Asia/Tokyo',date:'2026-10-20',checkedAt:'2026-10-20T00:00:00Z',hours:Array.from({length:15},(_,i)=>({hour:i+9,category:i<9?'cloud':'rain',label:i<9?'くもり':'雨'})),credit:{label:'Weather forecast by TH.GL',url:'https://heartopia.th.gl/forecast'}};
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
    await context.addInitScript(()=>{const Original=Date;globalThis.Date=class extends Original{constructor(...args){super(...(args.length?args:['2026-10-20T00:30:00Z']));}static now(){return new Original('2026-10-20T00:30:00Z').getTime();}};});
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
    const actual=await page.evaluate(()=>({daily:document.getElementById('weatherResult').innerHTML,summary:document.getElementById('weatherSummary').innerHTML,weeklyRows:document.querySelectorAll('#weeklyWeather .weeklyWeatherRow').length,share:document.querySelector('.shareImageWeatherLine')?.textContent||'',discord:document.getElementById('discordText').textContent}));
    assert.deepEqual(errors,[]);assert.ok(actual.daily.includes('Weather forecast by TH.GL'));assert.ok(actual.summary.includes('09:00'));
    assert.ok(!actual.daily.includes('2026-10-21'));assert.equal(actual.weeklyRows,7);assert.ok(actual.share.includes('サイトで確認'));assert.ok(!actual.discord.includes('いまの天気：'));
    const size=await page.locator('#weatherResult .weatherLineText').first().evaluate(el=>({height:el.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(el).fontSize)}));
    assert.ok(size.height<=size.fontSize*1.6,'three-character weather labels stay on one line on mobile');
    if(process.env.WEATHER_TEST_SCREENSHOT)await page.screenshot({path:process.env.WEATHER_TEST_SCREENSHOT,fullPage:false});
    sourceUnavailable=true;
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(()=>!HeartopiaCalendar.active());
    const fallback=await page.locator('#weatherResult').textContent();assert.equal(await page.locator('#weatherResult .weatherSlotList .weatherLine').count(),5);assert.ok(!fallback.includes('Weather forecast by TH.GL'));
    assert.equal(await page.locator('#weeklyWeather .weeklyWeatherRow').count(),7);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
