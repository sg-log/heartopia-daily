import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const root = path.resolve('.');

function startStaticServer(){
  const server=createServer(async(req,res)=>{
    try{
      const relative=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname).replace(/^\/+/, '')||'index.html';
      const target=path.resolve(root,relative);
      if(target!==root&&!target.startsWith(`${root}${path.sep}`)) throw new Error('outsideRoot');
      const body=await readFile(target);
      const type=target.endsWith('.js')?'text/javascript':target.endsWith('.png')?'image/png':'text/html; charset=utf-8';
      res.writeHead(200,{'content-type':type});res.end(body);
    }catch(error){res.writeHead(404);res.end('not found');}
  });
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve(server));
  });
}

test('ブラウザ判定は全画面内のdailyパネルとパネル切り抜きを発見し、非パネルを棄却する', async () => {
  const server=await startStaticServer();
  const browser = await chromium.launch({headless:true});
  try{
    const page = await browser.newPage();
    const address=server.address();
    await page.goto(`http://127.0.0.1:${address.port}/index.html`, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.WeatherScreenshotCore && window.locateWeatherPanel));
    const result = await page.evaluate(async () => {
      const {templates} = await loadWeatherTemplates();
      const load = src => new Promise((resolve,reject) => {
        const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=src;
      });
      const sun=await load('assets/weather-templates/sun-day.png');
      const panel=document.createElement('canvas');panel.width=panel.height=600;
      const pctx=panel.getContext('2d');pctx.fillStyle='#3978bd';pctx.fillRect(0,0,600,600);
      const layout=WEATHER_SCREENSHOT_LAYOUT.dailyOnly,size=63;
      layout.x.forEach(x=>pctx.drawImage(sun,600*x-size/2,600*layout.iconY-size/2,size,size));

      const full=document.createElement('canvas');full.width=1600;full.height=900;
      const fctx=full.getContext('2d');fctx.fillStyle='#20242a';fctx.fillRect(0,0,full.width,full.height);fctx.drawImage(panel,700,120);
      const cropFound=locateWeatherPanel(panel,templates);
      const fullFound=locateWeatherPanel(full,templates);

      const blank=document.createElement('canvas');blank.width=1200;blank.height=700;
      blank.getContext('2d').fillStyle='#333';blank.getContext('2d').fillRect(0,0,blank.width,blank.height);
      return {
        crop:{found:Boolean(cropFound),high:cropFound?.dailyHighCount||0,mode:cropFound?.layout?.mode||''},
        full:{found:Boolean(fullFound),high:fullFound?.dailyHighCount||0,mode:fullFound?.layout?.mode||''},
        blankFound:Boolean(locateWeatherPanel(blank,templates))
      };
    });
    assert.deepEqual(result.crop, {found:true,high:5,mode:'daily-only'});
    assert.deepEqual(result.full, {found:true,high:5,mode:'daily-only'});
    assert.equal(result.blankFound, false);
  } finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('実スクショ相当fixtureはdaily晴5枠・00開始・weekly既存判定を維持する', async t => {
  const server=await startStaticServer();
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    const address=server.address();
    await page.goto(`http://127.0.0.1:${address.port}/index.html`, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.WeatherScreenshotCore && window.locateWeatherPanel));
    const result=await page.evaluate(async () => {
      const {templates}=await loadWeatherTemplates();
      const image=await new Promise((resolve,reject)=>{
        const value=new Image();value.onload=()=>resolve(value);value.onerror=reject;
        value.src='tools/fixtures/weather-manual-sunny-purple.png';
      });
      const panel=locateWeatherPanel(image,templates);
      if(!panel) return {found:false};
      // CI is offline. The crop/preprocessing path is exercised here with a
      // deterministic worker; the same fixture is also suitable for live OCR.
      window.loadTesseract=async()=>({createWorker:async()=>({
        setParameters:async()=>{},
        recognize:async canvas=>({data:{text:canvas.width/canvas.height>4?'00 06 12 18 00':'00'}}),
        terminate:async()=>{}
      })});
      const start=await readWeatherScreenshotStartSlot(panel.panel,panel.layout);
      const review=WeatherScreenshotCore.buildManualReview({
        panelConfirmed:true,
        dailyScores:panel.dailyScores,
        mappedTimes:start.mapped,
        weeklyPanelConfirmed:panel.weeklyPanelConfirmed,
        weeklyScores:panel.weeklyScores
      });
      return {
        found:true,
        mode:panel.layout.mode,
        mapped:start.mapped,
        startSlot:review.startSlot,
        daily:review.slots.map(item=>item.value),
        weekly:review.weeks.map(item=>item.value),
        diagnostics:review.slots.map((item,index)=>({
          slot:index,
          bestValue:item.bestValue,
          bestScore:Number(item.bestScore.toFixed(3)),
          secondValue:item.secondValue,
          margin:Number(item.margin.toFixed(3)),
          warm:Number((item.metrics.warm||0).toFixed(3)),
          cyan:Number((item.metrics.cyan||0).toFixed(3)),
          purple:Number((item.metrics.purple||0).toFixed(3)),
          red:Number((item.metrics.red||0).toFixed(3)),
          box:item.box
        }))
      };
    });
    t.diagnostic(`daily crop metrics: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.found,true);
    assert.equal(result.mode,'combined');
    assert.deepEqual(result.mapped,['00','06','12','18','00']);
    assert.equal(result.startSlot,'00');
    assert.deepEqual(result.daily,['晴','晴','晴','晴','晴']);
    assert.deepEqual(result.weekly,['虹','流星群','晴','晴','晴']);
  } finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('実テンプレートfixtureで流星群・虹・雨・猛暑を維持する', async () => {
  const server=await startStaticServer();
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    const address=server.address();
    await page.goto(`http://127.0.0.1:${address.port}/index.html`, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.WeatherScreenshotCore && window.classifyWeatherCrop));
    const result=await page.evaluate(async () => {
      const {templates}=await loadWeatherTemplates();
      return Object.fromEntries(await Promise.all(['流星群','虹','雨','猛暑'].map(async weather=>{
        const template=templates.find(item=>item.weather===weather);
        const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=reject;value.src=template.path;});
        const canvas=document.createElement('canvas');canvas.width=canvas.height=56;
        canvas.getContext('2d').drawImage(image,0,0,56,56);
        const score=classifyWeatherCrop(canvas,templates);
        return [weather,WeatherScreenshotCore.resolveDailyScore(score).value];
      })));
    });
    assert.deepEqual(result,{'流星群':'流星群','虹':'虹','雨':'雨','猛暑':'猛暑'});
  } finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
