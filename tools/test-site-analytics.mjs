import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const source=fs.readFileSync(new URL('assets/site-analytics.js',root),'utf8');
const CONSENT='heartopiaAnalyticsConsent.v1', EXCLUDED='heartopiaAccessExcluded.v1';
function boot(options={}) {
 const values=new Map(Object.entries(options.storage||{}));
 const listeners={},docListeners={},requests=[],cookieWrites=[];
 const controls={};
 for(const key of ['status','choices','change','allow','deny']) controls[key]={hidden:false,events:{},addEventListener(e,fn){this.events[e]=fn;}};
 const box={querySelector(selector){return controls[selector.match(/analytics-(\w+)/)[1]];},hasAttribute(){return false;}};
 const location=new URL(options.url||'https://sg-log.github.io/heartopia-daily/');
 location.reload=()=>{state.reloads++;};
 const document={readyState:'loading',referrer:options.referrer||'',
   head:{appendChild(script){requests.push(script.src);}},
   createElement(){return {};},
   querySelectorAll(selector){return selector==='[data-analytics-settings]'?[box]:[controls[selector.match(/analytics-(\w+)/)[1]]];},
   addEventListener(e,fn){docListeners[e]=fn;}
 };
 Object.defineProperty(document,'cookie',{get(){return options.cookies||'';},set(value){cookieWrites.push(value);}});
 const window={addEventListener(e,fn){listeners[e]=fn;}};
 const localStorage={getItem(key){if(options.storageBlocked)throw Error('denied');return values.get(key)||null;},setItem(key,value){if(options.storageBlocked)throw Error('denied');values.set(key,value);}};
 const state={window,requests,cookieWrites,values,controls,listeners,location,reloads:0,
   init(){docListeners.DOMContentLoaded();},click(name){controls[name].events.click();},
   commands(){return Array.from(window.dataLayer||[],v=>Array.from(v));}};
 vm.runInNewContext(source,{window,document,location,localStorage,navigator:{webdriver:!!options.webdriver},URL,Date});
 return state;
}
test('unanswered consent loads no Google script and sends no analytics commands',()=>{
 const s=boot();assert.equal(s.window.heartopiaAnalytics.isExcluded(),false);assert.equal(s.requests.length,0);s.init();assert.equal(s.requests.length,0);assert.deepEqual(s.commands(),[]);
});
test('refusal remains silent on this and subsequent visits',()=>{
 const s=boot();s.init();s.click('deny');assert.equal(s.values.get(CONSENT),'denied');assert.equal(s.requests.length,0);
 const next=boot({storage:{[CONSENT]:'denied'}});next.init();assert.equal(next.requests.length,0);
});
test('consent loads one tag and sends one explicit public page view',()=>{
 const s=boot();s.init();s.click('allow');s.click('allow');assert.equal(s.requests.length,1);assert.equal(s.commands().filter(c=>c[0]==='event'&&c[1]==='page_view').length,1);
 assert.equal(s.requests[0],'https://www.googletagmanager.com/gtag/js?id=G-6N7VWBC1C1');
});
test('previous consent starts after DOM is ready',()=>{
 const s=boot({storage:{[CONSENT]:'granted'}});assert.equal(s.requests.length,0);s.init();assert.equal(s.requests.length,1);
});
for (const url of [
 'https://sg-log.github.io/heartopia-daily/?admin=1',
 'https://sg-log.github.io/heartopia-daily/#admin',
 'https://sg-log.github.io/heartopia-daily/#pendingGiftReviews',
 'https://sg-log.github.io/heartopia-daily/codes.html?adminKey=DO_NOT_SEND',
 'https://sg-log.github.io/heartopia-daily/?no_track=1',
 'https://sg-log.github.io/heartopia-daily/?restoreId=DO_NOT_SEND',
 'https://sg-log.github.io/heartopia-daily/?utm_source=private-server',
 'https://sg-log.github.io/heartopia-daily/?utm_source=discord&utm_source=private-server&utm_medium=social&utm_campaign=friends',
 'https://sg-log.github.io/heartopia-daily/assets/puzzles/review/index.html',
 'https://sg-log.github.io/other/',
 'http://127.0.0.1:8765/heartopia-daily/'
]) test('exclusion blocks even saved consent: '+url,()=>{
 const s=boot({url,storage:{[CONSENT]:'granted'}});s.init();assert.equal(s.window.heartopiaAnalytics.isExcluded(),true);assert.equal(s.requests.length,0);assert.deepEqual(s.commands(),[]);
});
test('operator exclusion applies to both public pages',()=>{
 for(const url of ['https://sg-log.github.io/heartopia-daily/','https://sg-log.github.io/heartopia-daily/codes.html']){
  const s=boot({url,storage:{[CONSENT]:'granted',[EXCLUDED]:'1'}});s.init();assert.equal(s.window.heartopiaAnalytics.isExcluded(),true);assert.equal(s.requests.length,0);
 }
});
test('webdriver is supplemental exclusion',()=>{const s=boot({webdriver:true,storage:{[CONSENT]:'granted'}});s.init();assert.equal(s.requests.length,0);});
test('storage denied fails closed',()=>{const s=boot({storageBlocked:true});s.init();s.click('allow');assert.equal(s.requests.length,0);assert.match(s.controls.status.textContent,/保存できない/);});
test('fixed UTM labels survive sanitisation without copying query or fragment',()=>{
 const s=boot({url:'https://sg-log.github.io/heartopia-daily/index.html?utm_source=discord&utm_medium=social&utm_campaign=friends#puzzles',storage:{[CONSENT]:'granted'},referrer:'https://discord.com/channels/private-server/private-channel?secret=DO_NOT_SEND'});s.init();
 const command=s.commands().find(c=>c[0]==='config')[2];assert.equal(command.page_location,'https://sg-log.github.io/heartopia-daily/');assert.equal(command.page_referrer,'https://discord.com/');
 assert.equal(command.campaign_source,'discord');assert.equal(command.campaign_medium,'social');assert.equal(command.campaign_name,'friends');assert.doesNotMatch(JSON.stringify(s.commands()),/private-server|private-channel|DO_NOT_SEND|utm_|#puzzles/);
});
test('codes page uses a fixed title and URL',()=>{
 const s=boot({url:'https://sg-log.github.io/heartopia-daily/codes.html',storage:{[CONSENT]:'granted'},referrer:'https://google.com/search?q=DO_NOT_SEND'});s.init();const c=s.commands().find(c=>c[0]==='config')[2];assert.equal(c.page_location,'https://sg-log.github.io/heartopia-daily/codes.html');assert.equal(c.page_referrer,'https://google.com/');assert.match(c.page_title,/ギフトコード一覧/);
});
test('TOP search, social and analytics titles use the approved brand-first name',()=>{
 const expected='Heartopia Daily｜ハートピアの今日の採取場所・天気';
 const html=fs.readFileSync(new URL('index.html',root),'utf8');
 assert.equal(html.match(/<title>([^<]+)<\/title>/)[1],expected);
 assert.equal(html.match(/<meta property="og:title" content="([^"]+)">/)[1],expected);
 assert.match(html,/<h1>Heartopia Daily<\/h1><p>ハートピアの天気予報と、今日の採取場所。<\/p>/);
 const s=boot({storage:{[CONSENT]:'granted'}});s.init();
 for(const c of s.commands().filter(c=>c[0]==='config'||c[0]==='event')) assert.equal(c[2].page_title,expected);
 for(const file of ['index.html','codes.html']) assert.match(fs.readFileSync(new URL(file,root),'utf8'),/site-analytics\.js\?v=20261029/);
});
test('advertising disabled and automatic pageviews disabled; debug is explicit',()=>{
 const s=boot({storage:{[CONSENT]:'granted'}});s.init();const c=s.commands().find(c=>c[0]==='config')[2];assert.equal(c.send_page_view,false);assert.equal(c.allow_google_signals,false);assert.equal(c.allow_ad_personalization_signals,false);assert.equal(Object.hasOwn(c,'debug_mode'),false);assert.equal(c.cookie_path,'/heartopia-daily/');
 const debug=boot({url:'https://sg-log.github.io/heartopia-daily/?analytics_debug=1',storage:{[CONSENT]:'granted'}});debug.init();assert.equal(debug.commands().find(c=>c[0]==='config')[2].debug_mode,true);
});
test('withdrawal disables GA, reloads and removes only this stream cookies',()=>{
 const s=boot({storage:{[CONSENT]:'granted',puzzleOwned:'keep',giftClaimState:'keep'},cookies:'_ga=a; _ga_6N7VWBC1C1=b; functional=c; _ga_OTHER=d'});s.init();s.click('deny');assert.equal(s.window['ga-disable-G-6N7VWBC1C1'],true);assert.equal(s.reloads,1);assert.equal(s.values.get('puzzleOwned'),'keep');assert.equal(s.values.get('giftClaimState'),'keep');assert.equal(s.cookieWrites.length,2);assert(s.cookieWrites.every(v=>!v.includes('functional')&&!v.includes('OTHER')&&v.includes('path=/heartopia-daily/;')));
});
test('operator toggle immediately stops an already loaded tracker',()=>{
 const s=boot({storage:{[CONSENT]:'granted'}});s.init();s.values.set(EXCLUDED,'1');s.listeners['heartopia:access-exclusion-change']();assert.equal(s.window['ga-disable-G-6N7VWBC1C1'],true);assert.equal(s.reloads,1);
});
test('other tabs consent withdrawal and cleared storage stop the tracker',()=>{
 for(const key of [CONSENT,null]){const s=boot({storage:{[CONSENT]:'granted'}});s.init();s.values.clear();s.listeners.storage({key});assert.equal(s.window['ga-disable-G-6N7VWBC1C1'],true);assert.equal(s.reloads,1);}
});
test('navigating to a private fragment disables tracker',()=>{
 const s=boot({storage:{[CONSENT]:'granted'}});s.init();s.location.hash='#admin';s.listeners.hashchange();assert.equal(s.window['ga-disable-G-6N7VWBC1C1'],true);assert.equal(s.reloads,1);
});
test('SEO metadata and sitemap list only the canonical public pages',()=>{
 for(const file of ['index.html','codes.html']){const html=fs.readFileSync(new URL(file,root),'utf8');assert.match(html,/<meta property="og:image" content="https:\/\/sg-log.github.io\/heartopia-daily\/assets\/og-site.png">/);assert.match(html,/<link rel="canonical"/);assert.match(html,/<meta name="twitter:card" content="summary_large_image">/);assert.match(html,/<script src="assets\/site-analytics.js/);assert.match(html,/heartopiaAnalytics\?\.isExcluded\(\)\s*!==\s*false/);}
 const sitemap=fs.readFileSync(new URL('sitemap.xml',root),'utf8');assert.equal((sitemap.match(/<loc>/g)||[]).length,2);assert.doesNotMatch(sitemap,/admin|review|#|lastmod/);
 assert.match(fs.readFileSync(new URL('index.html',root),'utf8'),/AjKCfy55CZOxQcE-bZKSmUNJSynsaw1nAAnpoph_VYQ/);
 assert.match(fs.readFileSync(new URL('assets/puzzles/review/index.html',root),'utf8'),/name="robots" content="noindex,nofollow"/);
});
function functionSource(html,name){
 const start=html.indexOf('async function '+name+'(');
 assert(start>=0);const open=html.indexOf('{',start);let depth=1,end=open+1;
 while(depth&&end<html.length){if(html[end]==='{')depth++;if(html[end]==='}')depth--;end++;}
 return html.slice(start,end);
}
for(const file of ['index.html','codes.html']){
 test(file+': existing counter still records once per JST day and honours shared exclusion',async()=>{
  const html=fs.readFileSync(new URL(file,root),'utf8');
  let recorded=0,sentDate='',excluded=false;
  const context=vm.createContext({WEATHER_API_URL:'local-test',isAdminRoute:()=>false,accessExcluded:()=>false,
   navigator:{locks:{request:async(_key,fn)=>fn()}},window:{heartopiaAnalytics:{isExcluded:()=>excluded}},
   jstDateValue:()=> '2026-10-27',accessSentDate:()=>sentDate,setAccessSentDate:value=>{sentDate=value;},
   apiPost:async(payload)=>{assert.equal(payload.action,'recordAccess');recorded++;return {ok:true,date:'2026-10-27'};}
  });
  vm.runInContext(functionSource(html,'recordAccessIfNeeded'),context);
  await vm.runInContext('recordAccessIfNeeded()',context);await vm.runInContext('recordAccessIfNeeded()',context);assert.equal(recorded,1);
  sentDate='';excluded=true;await vm.runInContext('recordAccessIfNeeded()',context);assert.equal(recorded,1);
  delete context.window.heartopiaAnalytics;await vm.runInContext('recordAccessIfNeeded()',context);assert.equal(recorded,1);
 });
}
