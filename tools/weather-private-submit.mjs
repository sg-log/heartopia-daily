import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const allowed=new Set(['晴','雨','流星群','虹','猛暑','雪','桜']);
const sameValues=(a,b)=>JSON.stringify([...(a||[])].sort())===JSON.stringify([...(b||[])].sort());
function checkedValues(slot) {
  if(!slot || slot.visible!==true || slot.confidence!=='high' || !Array.isArray(slot.weather) || !slot.weather.length || slot.weather.length>4 || slot.weather.some(w=>!allowed.has(w))) throw Error('imageReviewNotReady');
  return [...new Set(slot.weather)];
}
export async function buildPrivateWeatherPayload(review,capture,captureDir) {
  const p=review?.interpretation;
  if(review?.ready!==true || p?.ready!==true || p.confidence!=='high' || review.targetDate!==p.observedDate || !/^20\d{2}-\d{2}-\d{2}$/.test(p.observedDate || '') || !['00','06','12','18'].includes(p.startSlot) || !Array.isArray(p.slots) || p.slots.length!==5) throw Error('imageReviewNotReady');
  const date=new Date(p.observedDate+'T00:00:00Z');
  if(!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==p.observedDate) throw Error('imageReviewNotReady');
  const filename=review.selectedImage?.file;
  if(typeof filename!=='string' || !filename || path.isAbsolute(filename)) throw Error('imageBindingInvalid');
  const root=await fs.realpath(captureDir), file=await fs.realpath(path.resolve(root,filename));
  const relative=path.relative(root,file);
  if(relative.startsWith('..') || path.isAbsolute(relative)) throw Error('imageBindingInvalid');
  if(review.pendingEvidenceFile && review.pendingEvidenceFile!==filename) throw Error('imageBindingInvalid');
  const bytes=await fs.readFile(file), sha=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length>524288 || !bytes.length || sha!==review.selectedImage.captureSha256 || !['image/png','image/jpeg'].includes(review.selectedImage.mimeType)) throw Error('imageBindingInvalid');
  if(capture?.status!=='captured' || !['x','web'].includes(capture.sourceType) || !/^https:\/\//.test(capture.sourceUrl || '') || !Number.isFinite(Date.parse(capture.capturedAt))) throw Error('captureNotBound');
  const slots=Object.fromEntries(p.slots.map((s,i)=>{
    if(s.slot!==`slot${i}`) throw Error('imageReviewNotReady');return [s.slot,checkedValues(s)];
  }));
  const days=p.weeklyDays || [], weeks=Object.fromEntries(Array.from({length:7},(_,i)=>[`week${i+1}`,[]]));
  if(!Array.isArray(days) || (days.length && (days.length<5 || days.length>7))) throw Error('weeklyReviewNotReady');
  days.forEach((d,i)=>{
    const expected=new Date(date.getTime()+(i+1)*86400000).toISOString().slice(0,10);
    if(d.date!==expected) throw Error('weeklyReviewNotReady');weeks[`week${i+1}`]=checkedValues(d);
  });
  return {action:'submit',date:p.observedDate,startSlot:p.startSlot,slots,weeks,
    memo:days.length?'同一のゲーム内予報画像から自動判読。':'デイリーのみ（週間は既存維持）',author:'自動収集',
    sourceUrl:capture.sourceUrl,sourceType:capture.sourceType,sourceImageUrls:[],retrievedAt:capture.capturedAt,
    evidenceImages:[{mimeType:review.selectedImage.mimeType,byteSize:bytes.length,sha256:sha,kind:'screenshot',capturedAt:capture.capturedAt,bodyBase64:bytes.toString('base64')}]};
}
export function matchingWeather(report,payload) {
  return report?.date===payload.date && String(report.startSlot)===payload.startSlot &&
    Object.entries(payload.slots).every(([k,v])=>sameValues(report.slots?.[k],v)) &&
    Object.entries(payload.weeks).every(([k,v])=>sameValues(report.weeks?.[k],v));
}
export async function submitPrivateWeather({payload,apiUrl,postKey,adminKey,fetcher=fetch}) {
  if(!postKey || !adminKey) throw Error('privateKeysMissing');
  async function post(body) {
    const response=await fetcher(apiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
    if(!response.ok) throw Error('privateApiFailed');const data=await response.json();if(data.ok!==true) throw Error('privateApiFailed');return data;
  }
  const pending=await post({action:'pending',adminKey});
  const publicUrl=new URL(apiUrl);publicUrl.searchParams.set('action','approved');
  const approvedResponse=await fetcher(publicUrl,{signal:AbortSignal.timeout(45000)});
  if(!approvedResponse.ok) throw Error('approvedReadFailed');const approved=await approvedResponse.json();
  if(approved.ok!==true) throw Error('approvedReadFailed');
  const duplicate=[...(pending.reports||[]),...(approved.reports||[])].find(r=>matchingWeather(r,payload));
  if(duplicate) return {pending_registered:false,duplicate:true,report_id:duplicate.id||'',weekly_count:Object.values(payload.weeks).filter(v=>v.length).length};
  const receipt=await post({...payload,postKey});if(typeof receipt.id!=='string' || !/^[A-Za-z0-9-]{1,100}$/.test(receipt.id)) throw Error('invalidPrivateReceipt');
  const saved=await post({action:'pending',adminKey});
  const row=(saved.reports||[]).find(r=>r.id===receipt.id && r.sourceUrl===payload.sourceUrl && matchingWeather(r,payload));
  if(!row || row.evidenceStatus!=='saved' || row.evidenceImages?.length!==1 || row.evidenceImages[0].sha256!==payload.evidenceImages[0].sha256) throw Error('privateEvidenceNotConfirmed');
  const evidence=await post({action:'weatherEvidence',adminKey,reportId:receipt.id,imageIndex:0});
  const bytes=Buffer.from(evidence.bodyBase64||'','base64');
  if(evidence.mimeType!==payload.evidenceImages[0].mimeType || bytes.length!==payload.evidenceImages[0].byteSize || createHash('sha256').update(bytes).digest('hex')!==payload.evidenceImages[0].sha256) throw Error('privateEvidenceNotConfirmed');
  return {pending_registered:true,duplicate:Boolean(receipt.duplicate),report_id:receipt.id,weekly_count:Object.values(payload.weeks).filter(v=>v.length).length};
}
async function main() {
  const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>i%2?a:[...a,[v,s[i+1]]],[]));
  const review=JSON.parse(await fs.readFile(args['--review'],'utf8'));
  const capture=JSON.parse(await fs.readFile(path.join(args['--capture-dir'],'capture.json'),'utf8'));
  const html=await fs.readFile('index.html','utf8'), apiUrl=html.match(/const WEATHER_API_URL\s*=\s*"([^"]+)"/)?.[1];
  if(!apiUrl) throw Error('privateApiMissing');
  const payload=await buildPrivateWeatherPayload(review,capture,args['--capture-dir']);
  const result=await submitPrivateWeather({payload,apiUrl,postKey:process.env.WEATHER_POST_KEY,adminKey:process.env.WEATHER_ADMIN_KEY});
  if(process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,Object.entries(result).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  console.log(JSON.stringify({registered:result.pending_registered,duplicate:result.duplicate,privateEvidence:true}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(()=>{console.error('Private weather submission failed; source details were withheld.');process.exitCode=1;});
