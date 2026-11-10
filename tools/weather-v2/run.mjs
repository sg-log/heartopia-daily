import { mkdir,readFile,writeFile,copyFile } from 'node:fs/promises';
import path from 'node:path';
import { discover } from './discover.mjs';
import { capture } from './capture.mjs';
import { review } from './review.mjs';
import { SCHEMA,date,sha,json,identity,selectConsistent } from './core.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,v)=>i%2?a:[...a,[x,v[i+1]]],[]));
const targetDate=date(args['--date']),startSlot=args['--start']||'06';
if(!['06','18'].includes(startSlot))throw Error('invalidStart');
const out=path.resolve(args['--out']||'weather-v2-output');
await mkdir(out,{recursive:true});
// This executable has no submit mode and receives no production credentials.
const productionNames=['WEATHER_POST_KEY','WEATHER_ADMIN_KEY','WEATHER_DC_WEBHOOK_URL'];
if(productionNames.some(k=>process.env[k]))throw Error('productionCredentialsForbidden');
const result={schema:SCHEMA,mode:'dry-run',targetDate,startSlot,createdAt:new Date().toISOString(),pendingCreated:false,discordSent:false,acceptance:'unverified'};
try{
  const history=[];
  // Read-only public result history, used only as a ranking tie-break, never as discovery seeds.
  if(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GITHUB_REPOSITORY||'')){
    try{
      const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues?state=all&per_page=100`,{signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw Error(`historyHttp${r.status}`);
      for(const issue of await r.json()){
        if(!issue.body?.includes('heartopia-weather-scheduled-success:'))continue;
        const data=issue.body.match(/```json\s*([\s\S]*?)```/)?.[1];if(!data)continue;
        try{const v=JSON.parse(data);if(v.sourceHandle)history.push(v.sourceHandle.toLowerCase());if(v.sourceUrl)history.push(v.sourceUrl);}catch{}
      }
    }catch(e){result.historyWarning=e.message;}
  }
  result.historyEntries=history.length;
  const discovery=await discover(targetDate,{history});
  await writeFile(path.join(out,'discovery.json'),json(discovery));
  const queue=[...new Map([...discovery.daily,...discovery.weekly].map(c=>[c.sourceUrl,c])).values()];
  const inspected=[];
  for(const [index,candidate] of queue.entries()){
    const dir=path.join(out,`candidate-${String(index).padStart(2,'0')}`);
    const item={candidate,dir:path.basename(dir),daily:{ready:false},weekly:{ready:false}};
    try{
      const captured=await capture(candidate,dir);
      item.candidate.author=captured.sourceHandle||item.candidate.author;
      Object.assign(item,await review(dir,targetDate,startSlot));
      await writeFile(path.join(dir,'review.json'),json(item));
    }catch(e){item.error=e.message;}
    inspected.push(item);
    await writeFile(path.join(out,'inspected.json'),json(inspected));
    console.log(JSON.stringify({stage:'review',index,sourceUrl:candidate.sourceUrl,author:candidate.author,daily:item.daily.ready,weekly:item.weekly.ready,error:item.error||'',dailyReason:item.daily.reason||'',weeklyReason:item.weekly.reason||''}));
  }
  const dailySelection=selectConsistent(inspected,'daily'),weeklySelection=selectConsistent(inspected,'weekly');
  result.dailyStatus=dailySelection.status;result.weeklyStatus=weeklySelection.status;
  result.search={candidateCount:discovery.candidates.length,reviewedCount:inspected.length,providers:discovery.attempts.map(a=>({provider:a.provider,status:a.status,lane:a.lane})),authors:[...new Set(queue.map(c=>c.author).filter(Boolean))]};
  result.sourceUrls={daily:dailySelection.selected?.candidate.sourceUrl||null,weekly:weeklySelection.selected?.candidate.sourceUrl||null};
  result.evidence=[];
  for(const [kind,selection] of [['daily',dailySelection],['weekly',weeklySelection]]){
    const item=selection.selected;if(!item)continue;
    const evidence=item[kind].evidence;
    const source=path.join(out,item.dir,evidence.file),file=`${kind}${path.extname(evidence.file)}`;
    await copyFile(source,path.join(out,file));
    if(sha(await readFile(path.join(out,file)))!==evidence.sha256)throw Error('finalHashMismatch');
    result.evidence.push({...evidence,file,reviewFile:`${item.dir}/review.json`,captureFile:`${item.dir}/capture.json`,sourceAuthor:item.candidate.author});
  }
  result.ready=Boolean(dailySelection.selected)&&weeklySelection.status!=='conflict';
  if(result.ready){
    result.slots=dailySelection.selected.daily.slots;
    result.days=weeklySelection.selected?.weekly.days||[];
    result.identity=identity({...result});
    result.preview={date:targetDate,startSlot,slots:result.slots,weekly:{action:result.days.length?'replace-observed-dates':'preserve',days:result.days},sourceUrls:result.sourceUrls,evidence:result.evidence};
  }
  // CI is execution status only. Acceptance requires inspection of the downloaded artifact.
  result.acceptance='requires-artifact-review';
} catch(e){result.ready=false;result.error=e.message;process.exitCode=1;}
await writeFile(path.join(out,'result.json'),json(result));
await writeFile(path.join(out,'SHA256SUMS'),result.evidence?.map(e=>`${e.sha256}  ${e.file}`).join('\n')+'\n');
console.log(json(result));
if(!result.ready)process.exitCode=2;
