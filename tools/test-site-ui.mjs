import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const root = path.resolve('.');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.svg':'image/svg+xml'};
const screenshots = path.join(root, 'site-ui-screenshots');
const mockCodes = [
  {id:'a',code:'UI_TEST_ACTIVE',reward:'テスト報酬',expiresAt:'2099-12-31',status:'active',sourceUrl:'https://x.com/myheartopia/status/1234567890123456789'},
  {id:'b',code:'UI_TEST_OLD',reward:'期限切れ',expiresAt:'2020-01-01',status:'expired'},
  {id:'c',code:'UI_TEST_HIDDEN',status:'hidden',expiresAt:'2099-12-31'}
];

function staticServer(){
  const server=createServer(async(req,res)=>{
    try{
      const u = new URL(req.url,'http://127.0.0.1');
      const requested=decodeURIComponent(u.pathname).replace(/^\/+/,'') || 'index.html';
      const file=path.resolve(root,requested);
      if(!file.startsWith(root + path.sep)) throw Error('invalid path');
      const data=await readFile(file);
      res.writeHead(200,{'content-type':mime[path.extname(file)] || 'application/octet-stream','cache-control':'no-store'});
      res.end(data);
    }catch(_){res.writeHead(404,{'content-type':'text/plain'});res.end('not found')}
  });
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve(server));
  });
}

function mockFiveSlots(){
  const now=new Date();
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
  const parts=Object.fromEntries(fmt.formatToParts(now).map(p=>[p.type,p.value]));
  const today=parts.year+'-'+parts.month+'-'+parts.day;
  const hour=Number(parts.hour);
  const base=Date.parse(today+'T00:00:00Z')-(hour<6?86400000:0);
  const gameDate=new Date(base).toISOString().slice(0,10);
  const slots=[6,12,18,24,30].map(offset=>{
    const d=new Date(base+offset*3600000);
    return {date:d.toISOString().slice(0,10),hour:d.getUTCHours(),category:'clear',label:'晴'};
  });
  return {version:1,timeZone:'Asia/Tokyo',gameDate,checkedAt:now.toISOString(),slots};
}

function installApiMock(context){
  const trace=[];
  const backup=new Map();
  context.route('https://script.google.com/**',route=>{
    const req=route.request();
    const url=new URL(req.url());
    let post={};
    if(req.method()==='POST'){
      try{post=JSON.parse(req.postData()||'{}')}catch(_){}
    }
    const action=post.action||url.searchParams.get('action')||'unknown';
    trace.push({action,method:req.method()});
    let data={ok:true};
    if(action==='getGiftCodes') data={ok:true,codes:mockCodes};
    else if(action==='getSiteNotice')data={ok:true,notice:{noticeDate:'2026-10-26',noticeText:'UIテスト用のお知らせ'}};
    else if(action==='getWeeklyForecasts')data={ok:true,forecasts:[]};
    else if(action==='getWeatherCalendar')data={ok:true,enabled:true,fiveSlots:mockFiveSlots(),calendar:null};
    else if(action==='syncGiftClaims'){
      const old=backup.get(post.backupId)||[];
      const codes=[...new Set([...old,...(post.claims||[])])];
      backup.set(post.backupId,codes);
      data={ok:true,claims:codes};
    }
    else if(action==='setGiftClaimState'){
      const old=backup.get(post.backupId)||[];
      const codes=post.claimed?[...new Set([...old,post.code])]:old.filter(x=>x!==post.code);
      backup.set(post.backupId,codes);
      data={ok:true,claims:codes};
    }
    else if(action==='recordAccess')data={ok:true,date:'2026-10-26'};
    else if(action==='approved'||action==='getApprovedWeather')data={ok:true,reports:[],approved:[]};
    return route.fulfill({status:200,contentType:'application/json; charset=utf-8',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(data)});
  });
  context.route('https://cdn.jsdelivr.net/**',route=>route.fulfill({status:200,contentType:'text/javascript',body:'window.html2canvas = async () => {const c=document.createElement("canvas");c.width=800;c.height=500;return c;};'}));
  context.route('https://fonts.googleapis.com/**',route=>route.abort());
  context.route('https://fonts.gstatic.com/**',route=>route.abort());
  return trace;
}

async function runScenario(width,height,label){
  const server=await staticServer();
  const browser=await chromium.launch({headless:true});
  const {port}=server.address();
  const origin='http://127.0.0.1:'+port;
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,timezoneId:'Asia/Tokyo',permissions:['clipboard-read','clipboard-write']});
  const traces=installApiMock(context);
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(origin+'/index.html',{waitUntil:'domcontentloaded'});
    await page.locator('#todayResult .item').first().waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('#giftCodeList')?.textContent?.includes('UI_TEST_ACTIVE'),{timeout:15000});
    await page.locator('#weatherResult a[href="https://heartopia.th.gl/forecast"]').waitFor({state:'attached',timeout:15000});

    assert.equal(await page.locator('#todayResult .item img').count(),2,'stone/tree artwork');
    assert.equal(await page.locator('#weatherBirdClock img[src="assets/weather-bird-clock.png"]').count(),1,'bird clock');
    assert.equal(await page.locator('#weatherResult .weatherLine').count(),5,'weather five slots');
    await page.locator('#weatherResult .focusWeatherLabel').filter({hasText:'注目天気'}).waitFor({state:'visible',timeout:15000});
    assert.equal((await page.locator('#weatherResult .focusWeatherEmpty').textContent()).trim(),'—','rendered focus empty state is only a dash');
    const emptyFocus = await page.evaluate(()=>focusWeatherHtml(null,document.getElementById('targetDate').value));
    assert.ok(emptyFocus.includes('<span class="focusWeatherEmpty">—</span>'),'missing weekly forecast shows only dash');
    const sunnyFocus=await page.evaluate(()=>focusWeatherHtml({weeks:{week1:['晴'],week2:['晴']}},document.getElementById('targetDate').value));
    assert.ok(sunnyFocus.includes('<span class="focusWeatherEmpty">—</span>'),'sunny-only forecast shows only dash');
    await page.evaluate(()=>{
      const baseDate=document.getElementById('targetDate').value;
      setWeeklyForecastRecord({baseDate,weeks:{week1:['虹'],week2:['流星群'],week3:['雨']}});
      renderToday();
    });
    assert.equal(await page.locator('#weatherResult .focusWeatherChip').count(),3,'rainbow, meteor and rain shown without inventing dates');
    const weekly=page.getByRole('group',{name:'週間天気',exact:true}).filter({has:page.locator('.weeklyWeatherRow')}).first();
    assert.equal(await weekly.locator('time[datetime]').count(),7,'all seven forecast dates are machine-readable');
    assert.match(await weekly.ariaSnapshot(),/虹/,'forecast weather has a text equivalent');
    assert.match(await weekly.ariaSnapshot(),/未登録/,'missing data is explicitly labelled for readers');
    const boundary=await page.evaluate(()=>weeklyRowsHtml({weeks:{week1:['雨','雪'],week3:['虹']}},'2026-12-31'));
    await page.evaluate(markup=>{
      const host=document.createElement('div');host.id='weeklyBoundaryTest';host.innerHTML=markup;document.body.append(host);
    },boundary);
    const firstDay=page.locator('#weeklyBoundaryTest .weeklyWeatherRow').first();
    assert.equal(await firstDay.locator('time').getAttribute('datetime'),'2027-01-01');
    assert.equal(await firstDay.locator('time').textContent(),'1月1日');
    assert.match(await firstDay.ariaSnapshot(),/雨・雪/,'multiple weather values are retained');
    assert.equal(await firstDay.locator('.weeklyWeatherIcons').textContent(),'☔ ☃','visible icons stay unchanged');
    await page.locator('#weeklyBoundaryTest').evaluate(node=>node.remove());
    assert.equal(await page.locator('#weatherResult .focusWeatherChip').first().textContent().then(x=>x.includes('🌈')),true,'rainbow forecast icon');
    const navStyle=await page.locator('.siteHeaderNav').evaluate(el=>{
      const style=getComputedStyle(el);
      return {background:style.backgroundColor,border:style.borderTopWidth,shadow:style.boxShadow,position:style.position};
    });
    assert.ok(['rgba(0, 0, 0, 0)','transparent'].includes(navStyle.background),
      'navigation is part of the header, not a floating capsule: '+JSON.stringify(navStyle));
    assert.equal(navStyle.border,'0px','no detached navigation border');
    assert.equal(navStyle.shadow,'none','no navigation container shadow');
    assert.equal(await page.locator('#gift-codes').isVisible(),false,'gift panel not visible on top');
    assert.equal(await page.locator('#siteFooter').isVisible(),true,'About link visible on TOP');
    const controls=await page.evaluate(()=>({
      date:Number.parseFloat(getComputedStyle(document.getElementById('targetDate')).borderTopLeftRadius),
      today:Number.parseFloat(getComputedStyle(document.getElementById('todayBtn')).borderTopLeftRadius),
      card:Number.parseFloat(getComputedStyle(document.getElementById('placeCard')).borderTopLeftRadius)
    }));
    assert.ok(controls.date<=10&&controls.today<=10&&controls.card<=14,'refined square controls '+JSON.stringify(controls));
    assert.equal(await page.locator('#today .compactCopy details').count(),1,'Discord copy accordion');
    await page.locator('#today .compactCopy > details > summary').click();
    await page.locator('#copyBtn').click();
    await page.locator('#copyStatus').filter({hasText:'コピーしました'}).waitFor({state:'visible'});
    const discordCopy=await page.evaluate(()=>navigator.clipboard.readText());
    assert.doesNotMatch(discordCopy,/【ギフトコード】|UI_TEST_ACTIVE|UI_TEST_OLD|UI_TEST_HIDDEN|テスト報酬/,'Discord text omits gift codes even when active codes exist');
    assert.match(discordCopy,/無垢な蛍石：.+/,'Discord text keeps fluorite locations');
    assert.match(discordCopy,/ツルツルオーク：.+/,'Discord text keeps oak locations');
    assert.equal(discordCopy.split('https://sg-log.github.io/heartopia-daily/').length-1,1,'Discord text includes the public site URL once');
    assert.match(discordCopy,/【週間天気】/);
    assert.equal((discordCopy.match(/\d+\/\d+\([日月火水木金土]\) (?:虹|流星群|雨|—)/g)||[]).length,7,'shared weekly forecast has seven dated rows and preserves missing days');
    assert.doesNotMatch(discordCopy,/TH.GL|heartopia\.th\.gl|時間別予報|いまの天気|注目/,'shared text excludes the hourly source and featured summary');
    assert.equal(await page.locator('#shareImagePreview .shareImageWeekCell').count(),7);
    assert.equal(await page.locator('#shareImagePreview .shareImageWeatherLine, #shareImagePreview .shareImageFocusLine').count(),0);
    assert.equal(await page.locator('#shareImagePreview .shareImageUrl').getAttribute('href'),'https://sg-log.github.io/heartopia-daily/');
    assert.equal((await page.locator('#shareImagePreview .shareImageWeekText').allTextContents()).filter(text=>text==='未登録').length,4);
    assert.equal((await page.locator('#shareImagePreview .shareImageWeekIcon').allTextContents()).filter(text=>text==='—').length,4);
    assert.equal(await page.locator('#shareImagePreview').evaluate(el=>el.scrollWidth>el.clientWidth),false,'share preview fits the viewport');
    assert.equal(await page.locator('#shareImagePreview').evaluate(el=>el.scrollHeight>el.clientHeight+1),false,'the weekly cells and URL are not clipped vertically');
    assert.equal(await page.locator('#shareImagePreview .shareImageWeekCell').evaluateAll(cells=>cells.some(cell=>cell.scrollWidth>cell.clientWidth+1)),false,'weekly dates and labels fit every cell');
    const yearBoundary=await page.evaluate(()=>shareWeeklyLine({weeks:{week1:['雨'],week3:['虹']}},'2026-12-31'));
    assert.equal(yearBoundary.split('\n')[0],'1/1(金) 雨');
    assert.equal(yearBoundary.split('\n')[1],'1/2(土) —');
    assert.equal(yearBoundary.split('\n')[2],'1/3(日) 虹');
    await mkdir(screenshots,{recursive:true});
    await page.locator('#shareImagePreview').screenshot({path:path.join(screenshots,label+'-weekly-share-preview.png')});
    if(label==='desktop'){
      const png=await page.evaluate(async()=>{const blob=await createShareImageBlob();return Array.from(new Uint8Array(await blob.arrayBuffer()));});
      await writeFile(path.join(screenshots,'weekly-share.png'),Buffer.from(png));
      const fallback=await page.evaluate(async()=>{const d=E.targetDate.value,c=await drawShareImageCanvas(d,dayData(cycleDay(d)),weatherData(d),{withImages:false});return c.toDataURL('image/png').split(',')[1];});
      await writeFile(path.join(screenshots,'weekly-share-no-art.png'),Buffer.from(fallback,'base64'));
    }
    await page.locator('#today .compactCopy > details > summary').click();
    assert.equal(await page.locator('#tomorrowBtn').evaluate(el=>el.parentElement.contains(document.getElementById('shareTodayImageBtn'))),true,'share beside tomorrow');

    const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,view:window.innerWidth}));
    assert.ok(overflow.scroll<=overflow.view+2,'TOP page overflow: '+JSON.stringify(overflow));

    await mkdir(screenshots,{recursive:true});
    // Transient copy feedback is not part of the settled review layout.
    await page.locator('#toast').evaluate(el=>el.classList.remove('show'));
    await page.screenshot({path:path.join(screenshots,label+'-home.png'),fullPage:true});
    const shareDialogs=[];
    page.on('dialog',async dialog=>{shareDialogs.push(dialog.message());await dialog.accept()});
    await page.locator('#shareTodayImageBtn').click();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent?.includes('画像を'),{timeout:10000});
    const shareResult=await page.locator('#toast').textContent();
    assert.ok(
      /画像をコピーしました|画像を保存しました/.test(shareResult),
      'share icon returns usable image: '+shareResult+' dialogs='+shareDialogs.join(',')
    );

    await page.locator('.siteHeaderNav button[data-tab="puzzles"]').click();
    assert.equal(await page.locator('#puzzles').isVisible(),true,'puzzles tab opens');
    assert.equal(await page.locator('#siteFooter').isVisible(),false,'About link hidden on puzzle view');
    assert.equal(new URL(page.url()).hash,'#puzzles');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('#puzzles').waitFor({state:'visible',timeout:15000});
    assert.equal(await page.locator('#siteFooter').isVisible(),false,'About stays hidden after reloading puzzles');
    await page.locator('.siteHeaderNav button[data-tab="today"]').click();
    await page.locator('#today').waitFor({state:'visible'});
    await page.locator('#aboutFooterLink').click();
    await page.locator('#about').waitFor({state:'visible'});
    assert.equal(await page.locator('#siteFooter').isVisible(),false,'About footer hidden while About panel is open');
    assert.equal(await page.locator('#about a[href="?admin=1"]').count(),1,'admin link remains inside About');
    await page.locator('.siteHeaderNav button[data-tab="today"]').click();
    await page.locator('#today').waitFor({state:'visible'});
    assert.equal(await page.locator('#siteFooter').isVisible(),true,'About link returns with TOP');

    await page.locator('.siteHeaderNav a[href="codes.html"]').click();
    await page.locator('#giftCodeList .giftCard').first().waitFor({state:'visible'});
    assert.equal(new URL(page.url()).pathname,'/codes.html');
    assert.equal(await page.locator('#siteFooter').count(),0,'About link absent from gift codes page');
    const giftNav=await page.locator('.siteHeaderNav').evaluate(el=>{
      const style=getComputedStyle(el);
      return {background:style.backgroundColor,border:style.borderTopWidth,shadow:style.boxShadow};
    });
    assert.ok(['rgba(0, 0, 0, 0)','transparent'].includes(giftNav.background),'gift page nav has no detached white capsule');
    assert.equal(giftNav.border,'0px');
    assert.equal(giftNav.shadow,'none');
    const giftShape=await page.locator('#gift-codes').evaluate(el=>Number.parseFloat(getComputedStyle(el).borderTopLeftRadius));
    assert.ok(giftShape<=14,'squarer gift card');
    assert.equal(await page.locator('#giftCodeList .giftCard').count(),1);
    assert.equal(await page.locator('#expiredGiftCodeList .giftCard').count(),1);
    assert.equal(await page.locator('text=UI_TEST_HIDDEN').count(),0);
    assert.equal(await page.locator('#siteNotice').isVisible(),true,'site notice visible on codes page');
    await page.screenshot({path:path.join(screenshots,label+'-codes.png'),fullPage:true});

    await page.locator('[data-gift-copy="UI_TEST_ACTIVE"]').click();
    await page.locator('[data-gift-toggle="UI_TEST_ACTIVE"]').filter({hasText:'受取済'}).waitFor({state:'visible'});
    const clipped=await page.evaluate(()=>navigator.clipboard.readText());
    assert.equal(clipped,'UI_TEST_ACTIVE');
    await page.locator('[data-gift-toggle="UI_TEST_ACTIVE"]').click();
    await page.locator('[data-gift-toggle="UI_TEST_ACTIVE"]').filter({hasText:'未受取'}).waitFor({state:'visible'});

    await page.locator('#giftBackupCopyBtn').click();
    const backupCode=await page.evaluate(()=>navigator.clipboard.readText());
    assert.match(backupCode,/^HGD-[0-9a-f-]{39}$/);
    await page.locator('.giftBackupDetails > summary').click();
    await page.locator('#giftBackupCodeInput').fill(backupCode);
    await page.locator('#giftBackupRestoreBtn').click();
    await page.locator('#giftBackupRestoreStatus').filter({hasText:'受取済を復元しました'}).waitFor({state:'visible'});

    const codeOverflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,view:window.innerWidth}));
    assert.ok(codeOverflow.scroll<=codeOverflow.view+2,'codes page overflow: '+JSON.stringify(codeOverflow));
    assert.deepEqual(errors,[],'runtime errors');
    assert.equal(traces.some(x=>x.action==='getGiftCodes'),true,'getGiftCodes API used');
    assert.equal(traces.some(x=>x.action==='syncGiftClaims'),true,'claim backup API used');
    assert.equal(traces.some(x=>x.action==='setGiftClaimState'),true,'claim toggle API used');
    assert.equal(traces.some(x=>x.action==='getSiteNotice'),true,'notice API used');
    assert.equal(traces.some(x=>x.action==='getWeatherCalendar'),true,'weather API used');
    assert.equal(traces.some(x=>x.action==='saveGiftCode'),false,'no admin write');
  } finally {
    await context.close();
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

test('Heartopia Daily desktop: navigation, weather, gift code and existing features',{timeout:120000},async()=>runScenario(1280,900,'desktop'));
test('Heartopia Daily mobile: navigation, weather, gift code and existing features',{timeout:120000},async()=>runScenario(390,844,'mobile'));
test('Heartopia Daily small mobile: weekly share and existing features',{timeout:120000},async()=>runScenario(320,844,'small-mobile'));
test('Heartopia Daily tablet: navigation, weather, gift code and existing features',{timeout:120000},async()=>runScenario(768,1024,'tablet'));

test('Image sharing includes the canonical public URL without private route data and keeps save fallback',{timeout:120000},async()=>{
  const server=await staticServer();
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Tokyo',userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'});
    installApiMock(context);
    await context.addInitScript(()=>{
      window.sharedForTest=[];
      window.shareDrawnTextForTest=[];
      const originalFillText=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(...args){window.shareDrawnTextForTest.push(String(args[0]));return originalFillText.apply(this,args);};
      window.shareSupportedForTest=true;
      Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>window.shareSupportedForTest});
      Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{
        const files=await Promise.all(data.files.map(async file=>{const png=new DataView(await file.arrayBuffer());return {name:file.name,type:file.type,size:file.size,width:png.getUint32(16),height:png.getUint32(20)};}));
        window.sharedForTest.push({title:data.title,text:data.text,url:data.url,files,drawnText:window.shareDrawnTextForTest.splice(0)});
      }});
    });
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>dialog.accept());
    await page.goto('http://127.0.0.1:'+server.address().port+'/index.html',{waitUntil:'domcontentloaded'});
    await page.locator('#todayResult .item').first().waitFor({state:'visible'});
    await page.locator('#weatherResult a[href="https://heartopia.th.gl/forecast"]').waitFor({state:'attached'});
    await page.evaluate(()=>{const baseDate=E.targetDate.value;setWeeklyForecastRecord({baseDate,weeks:{week1:['虹'],week2:['雨'],week3:['流星群']}});renderToday();window.shareDrawnTextForTest=[];});
    // The share destination must never be derived from the current address.
    await page.evaluate(()=>history.replaceState(null,'','?admin=1&pending=DO_NOT_SHARE&restoreId=DO_NOT_SHARE#weekly-import=DO_NOT_SHARE'));
    await page.locator('#shareTodayImageBtn').click();
    await page.waitForFunction(()=>window.sharedForTest.length===1);
    await page.locator('#today .compactCopy > details > summary').click();
    await page.locator('#shareImageBtn').click();
    await page.waitForFunction(()=>window.sharedForTest.length===2);
    const payloads=await page.evaluate(()=>window.sharedForTest);
    for(const payload of payloads){
      assert.equal(payload.title,'Heartopia Daily');
      assert.equal(payload.text,'採取場所・週間天気\nhttps://sg-log.github.io/heartopia-daily/');
      assert.doesNotMatch(JSON.stringify(payload),/DO_NOT_SHARE|admin=|pending=|restoreId=|weekly-import=/);
      assert.equal(payload.files.length,1);
      assert.equal(payload.files[0].type,'image/png');
      assert.ok(payload.files[0].size>0);
      assert.equal(payload.files[0].width,1200);
      assert.equal(payload.files[0].height,675);
      assert.ok(payload.drawnText.includes('無垢な蛍石')&&payload.drawnText.includes('ツルツルオーク'));
      assert.ok(payload.drawnText.includes('週間天気')&&payload.drawnText.includes('https://sg-log.github.io/heartopia-daily/'));
      assert.ok(payload.drawnText.includes('虹')&&payload.drawnText.includes('雨')&&payload.drawnText.includes('流星群'));
      assert.equal(payload.drawnText.filter(text=>text==='—').length,4,'four unregistered weekly days keep dash icons');
      assert.equal(payload.drawnText.filter(text=>text==='未登録').length,4,'missing values are labelled without borrowing hourly forecasts');
      assert.doesNotMatch(payload.drawnText.join(' '),/今日の天気|注目|TH.GL|時間別予報|ギフトコード/);
    }
    assert.match(payloads[0].files[0].name,/^heartopia-place-\d{4}-\d{2}-\d{2}\.png$/);
    assert.match(payloads[1].files[0].name,/^heartopia-daily-\d{4}-\d{2}-\d{2}\.png$/);
    await page.evaluate(()=>{window.shareSupportedForTest=false;});
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#shareTodayImageBtn').click();
    const download=await downloadPromise;
    assert.match(download.suggestedFilename(),/^heartopia-place-.*\.png$/);
    assert.equal(await page.evaluate(()=>window.sharedForTest.length),2,'unsupported native sharing keeps the image-save fallback');
    assert.deepEqual(errors,[]);
    await context.close();
  }finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});


test('Admin gate and unlocked admin can return to TOP without retaining the session key',{timeout:120000},async()=>{
  const server=await staticServer();
  const browser=await chromium.launch({headless:true});
  const origin='http://127.0.0.1:'+server.address().port;
  try{
    for(const width of [1280,390]){
      const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Tokyo'});
      installApiMock(context);
      const page=await context.newPage();
      try{
        await page.goto(origin+'/?admin=1',{waitUntil:'domcontentloaded'});
        await page.locator('#admin .adminGate').waitFor({state:'visible',timeout:15000});
        await page.locator('#adminReturnToTop').waitFor({state:'visible'});
        assert.equal(await page.locator('.siteHeaderNav').isVisible(),false,'public navigation remains hidden on admin');
        assert.equal(await page.locator('#siteFooter').isVisible(),false,'public About footer remains hidden on admin');
        const widthState=await page.evaluate(()=>({view:innerWidth,doc:document.documentElement.scrollWidth}));
        assert.ok(widthState.doc<=widthState.view+2,'admin gate no horizontal overflow '+JSON.stringify(widthState));

        await page.locator('#adminReturnToTop').click();
        await page.waitForURL(url=>!url.searchParams.has('admin'),{timeout:15000});
        await page.locator('#today').waitFor({state:'visible',timeout:15000});

        await page.evaluate(()=>sessionStorage.setItem('heartopiaAdminKey','ui-admin-test'));
        await page.goto(origin+'/?admin=1',{waitUntil:'domcontentloaded'});
        await page.locator('#admin .adminShell').waitFor({state:'visible',timeout:15000});
        await page.locator('#adminReturnToTop').waitFor({state:'visible'});
        await page.locator('#adminReturnToTop').click();
        await page.waitForURL(url=>!url.searchParams.has('admin'),{timeout:15000});
        await page.locator('#today').waitFor({state:'visible',timeout:15000});
        assert.equal(await page.evaluate(()=>sessionStorage.getItem('heartopiaAdminKey')),null,'return closes admin session');
      }finally{await context.close()}
    }
  }finally{
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
