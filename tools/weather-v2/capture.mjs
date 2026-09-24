import { chromium } from 'playwright';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPublicHostname,validateSourceUrl,detectAccessBarrier } from '../weather-cloud-url-evidence.mjs';
import { sha,json } from './core.mjs';
async function publicGet(url) {
  const u=validateSourceUrl(url);await assertPublicHostname(u.hostname);
  const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error(`http${r.status}`);
  return r;
}
export async function capture(candidate,dir) {
  await mkdir(dir,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({locale:'ja-JP',timezoneId:'Asia/Tokyo',viewport:{width:1440,height:1800}});
  const hosts=new Map();
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(['data:','blob:','about:'].includes(u.protocol))return route.continue();
    try {
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('invalidUrl');
      if(!hosts.has(u.hostname))hosts.set(u.hostname,assertPublicHostname(u.hostname));
      await hosts.get(u.hostname);await route.continue();
    }catch{await route.abort();}
  });
  const page=await context.newPage();let scope=page,text='',images=[];
  try {
    if(candidate.platform==='x') {
      // Public, official embed only; no logged-in API, cookies, proxy, or challenge solving.
      const r=await publicGet(`https://publish.twitter.com/oembed?url=${encodeURIComponent(candidate.sourceUrl)}&omit_script=true`);
      const embed=await r.json();
      if(typeof embed.html!=='string')throw Error('embedUnavailable');
      await writeFile(path.join(dir,'oembed.json'),json(embed));
      await page.setContent(`<html><body>${embed.html}<script async src="https://platform.twitter.com/widgets.js"></script></body></html>`);
      const iframe=page.locator('iframe[id^="twitter-widget-"]').first();
      await iframe.waitFor({state:'visible',timeout:25000});
      scope=await (await iframe.elementHandle()).contentFrame();
      await scope.waitForTimeout(1500);
      text=await scope.locator('body').innerText();
      const barrier=detectAccessBarrier({bodyText:text});if(barrier)throw Error(barrier);
      images=await scope.locator('img').evaluateAll((nodes,id)=>nodes.map((im,index)=>{
        const anchor=im.closest('a[href]');const href=anchor?.href||'';
        const status=href.match(/\/status\/(\d+)\/(?:photo|video)\//)?.[1];
        return {index,url:im.currentSrc||im.src,width:im.naturalWidth,height:im.naturalHeight,sourceScope:status===id?'exact-status':'unverified',ownerLink:href};
      }),candidate.sourceId);
      images=images.filter(im=>im.sourceScope==='exact-status'&&im.width>=250&&im.height>=160);
    } else {
      validateSourceUrl(candidate.sourceUrl);await assertPublicHostname(new URL(candidate.sourceUrl).hostname);
      const r=await page.goto(candidate.sourceUrl,{waitUntil:'domcontentloaded',timeout:25000});
      if(!r?.ok())throw Error(`http${r?.status()}`);
      await page.waitForTimeout(1200);text=await page.locator('body').innerText();
      const barrier=detectAccessBarrier({finalUrl:page.url(),title:await page.title(),bodyText:text});if(barrier)throw Error(barrier);
      images=await page.locator('img').evaluateAll(nodes=>nodes.map((im,index)=>({index,url:im.currentSrc||im.src,width:im.naturalWidth,height:im.naturalHeight,alt:im.alt,sourceScope:'public-page'})));
      images=images.filter(im=>im.width>=300&&im.height>=180&&!/avatar|logo|profile|icon/i.test(im.alt||''));
    }
    await writeFile(path.join(dir,'post-content.txt'),text+'\n');
    await page.screenshot({path:path.join(dir,'page.png'),fullPage:true});
    const rawMedia=[],seen=new Set(),rejected=[];
    for(const im of images.slice(0,12)) {
      if(seen.has(im.url))continue;seen.add(im.url);
      try {
        const r=await publicGet(im.url);const bytes=Buffer.from(await r.arrayBuffer());
        if(bytes.length>8*1024*1024)throw Error('imageTooLarge');
        const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':null;
        if(!mime)throw Error('unsupportedImage');
        const file=`media-${rawMedia.length}.${mime==='image/png'?'png':'jpg'}`;
        await writeFile(path.join(dir,file),bytes);
        rawMedia.push({...im,file,mimeType:mime,sha256:sha(bytes),byteSize:bytes.length});
      }catch(e){rejected.push({url:im.url,reason:e.message});}
    }
    const report={status:'captured',adapter:'weather-v2-public-media',sourceUrl:candidate.sourceUrl,sourceHandle:candidate.author,capturedAt:new Date().toISOString(),postContent:{file:'post-content.txt'},rawMedia,rejected};
    await writeFile(path.join(dir,'capture.json'),json(report));
    return report;
  }finally{await browser.close();}
}
