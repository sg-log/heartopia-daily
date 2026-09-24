import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { canonical, date, mergeCandidates, rankLane } from './core.mjs';
import { detectAccessBarrier } from '../weather-cloud-url-evidence.mjs';
export function queries(targetDate) {
  date(targetDate); const [,m,d]=targetDate.split('-').map(Number);
  return [
    {lane:'daily',query:`ハートピア 天気 ${targetDate} ${m}月${d}日`},
    {lane:'daily',query:`Heartopia weather ${targetDate}`},
    {lane:'daily',query:`ハートピア お天気 ${m}/${d}`},
    {lane:'weekly',query:`ハートピア 週間 天気 ${targetDate}`},
    {lane:'weekly',query:`Heartopia weekly forecast ${targetDate}`},
    {lane:'weekly',query:`ハートピア 天気予報 ${m}月${d}日 週間`}
  ];
}
export async function discover(targetDate,{config,history=[]}={}) {
  config ||= JSON.parse(await readFile(new URL('./config.json',import.meta.url),'utf8'));
  if(new Set(config.providers.map(p=>p.id)).size<2)throw Error('atLeastTwoSearchProvidersRequired');
  const browser=await chromium.launch({headless:true});
  const tasks=queries(targetDate).flatMap(q=>config.providers.map(p=>({...q,...p})));
  const attempts=new Array(tasks.length); let cursor=0;
  try {
    await Promise.all(Array.from({length:config.searchConcurrency},async()=>{
      const page=await browser.newPage({locale:'ja-JP',timezoneId:'Asia/Tokyo'});
      while(cursor<tasks.length){
        const index=cursor++,task=tasks[index];
        const url=task.url.replace('{query}',encodeURIComponent(task.query));
        const attempt={provider:task.id,query:task.query,lane:task.lane,url,status:'ok',candidates:[]};
        try {
          const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:config.timeoutMs});
          await page.waitForTimeout(1000);
          const body=await page.locator('body').innerText({timeout:3000});
          const barrier=detectAccessBarrier({finalUrl:page.url(),title:await page.title(),bodyText:body});
          if(barrier||!response?.ok())throw Error(barrier||`http${response?.status()}`);
          const rows=await page.locator('a[href]').evaluateAll(nodes=>nodes.slice(0,450).map(a=>{
            let node=a,context=a.innerText||'';
            for(let n=0;n<6&&node.parentElement;n++){
              node=node.parentElement;const text=node.innerText||'';
              if(text.length>1800)break;
              context=text;
              if(text.length>60&&/ハートピア|heartopia/i.test(text)&&/天気|weather|予報|forecast/i.test(text))break;
            }
            return {url:a.href,context:context.slice(0,1800)};
          }));
          for(const row of rows){
            const normalized=canonical(row.url);if(!normalized)continue;
            if(!/ハートピア|heartopia/i.test(row.context)||!/天気|weather|予報|forecast/i.test(row.context))continue;
            attempt.candidates.push({...normalized,context:row.context,author:normalized.author||row.context.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1]||'',provider:task.id,query:task.query,lane:task.lane});
          }
        }catch(e){attempt.status='unavailable';attempt.reason=e.message;}
        attempts[index]=attempt;
        console.log(JSON.stringify({stage:'search',provider:task.id,lane:task.lane,status:attempt.status,count:attempt.candidates.length}));
      }
      await page.close();
    }));
  }finally{await browser.close();}
  const candidates=mergeCandidates(attempts.flatMap(a=>a.candidates),targetDate);
  return {targetDate,attempts,candidates,daily:rankLane(candidates,'daily',{limit:config.perLaneLimit,authorLimit:config.perAuthorLimit,history}),weekly:rankLane(candidates,'weekly',{limit:config.perLaneLimit,authorLimit:config.perAuthorLimit,history})};
}
