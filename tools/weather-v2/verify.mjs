import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha,SCHEMA,identity } from './core.mjs';
function local(root,file){
  const p=path.resolve(root,String(file));
  if(!p.startsWith(path.resolve(root)+path.sep))throw Error('artifactPathEscape');
  return p;
}
export async function verifyBundle(root){
  const read=async file=>JSON.parse(await readFile(local(root,file),'utf8'));
  const r=await read('result.json');
  if(r.schema!==SCHEMA||r.mode!=='dry-run'||r.pendingCreated!==false||r.discordSent!==false)throw Error('invalidDryRunContract');
  if(!r.ready)throw Error('resultNotReady');
  if(r.slots?.length!==5||!['06','18'].includes(r.startSlot))throw Error('invalidDaily');
  const id=identity(r);if(id.dailyKey!==r.identity.dailyKey||id.weeklyKey!==r.identity.weeklyKey)throw Error('identityMismatch');
  for(const kind of ['daily','weekly']){
    const e=r.evidence.filter(x=>x.kind===kind);
    if(kind==='weekly'&&!r.days?.length){if(e.length||r.sourceUrls.weekly)throw Error('fabricatedWeekly');continue;}
    if(e.length!==1)throw Error('evidenceCountMismatch');
    const ref=e[0],bytes=await readFile(local(root,ref.file));
    if(sha(bytes)!==ref.sha256)throw Error('downloadedEvidenceHashMismatch');
    if(ref.sourceUrl!==r.sourceUrls[kind])throw Error('sourceMismatch');
    const c=await read(ref.captureFile),review=await read(ref.reviewFile);
    const match=c.rawMedia.find(m=>m.sha256===ref.sha256&&m.url===ref.mediaUrl);
    if(!match||c.sourceUrl!==ref.sourceUrl)throw Error('captureBindingMismatch');
    if(sha(await readFile(local(root,path.join(path.dirname(ref.captureFile),match.file))))!==ref.sha256)throw Error('capturedImageHashMismatch');
    if(!review[kind]?.ready||review[kind].evidence.sha256!==ref.sha256)throw Error('reviewBindingMismatch');
    if(kind==='daily'&&(review.daily.startSlot!==r.startSlot||JSON.stringify(review.daily.slots)!==JSON.stringify(r.slots)))throw Error('dailyValueMismatch');
    if(kind==='weekly'&&JSON.stringify(review.weekly.days)!==JSON.stringify(r.days))throw Error('weeklyValueMismatch');
  }
  return {verified:true,targetDate:r.targetDate,startSlot:r.startSlot,evidenceCount:r.evidence.length,weeklyCount:r.days.length,pendingCreated:false,discordSent:false};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  verifyBundle(process.argv[2]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
