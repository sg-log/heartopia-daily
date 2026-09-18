import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function addDays(dateText,days){const d=new Date(`${dateText}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
async function readJson(file){return JSON.parse(await readFile(file,'utf8'));}
function mimeExt(mime){if(mime==='image/jpeg')return'jpg';if(mime==='image/png')return'png';throw new Error('unsupportedMimeType');}
async function imageMeta(dir,selected,outFile){
  const source=path.join(dir,String(selected.file||''));
  const bytes=await readFile(source);
  const digest=sha256(bytes);
  if(digest!==String(selected.captureSha256||''))throw new Error('selectedImageHashMismatch');
  const size=(await stat(source)).size;
  return{source,bytes,digest,size,mimeType:String(selected.mimeType||''),outFile};
}
function weeklyDaysFrom(review){
  const days=review?.interpretation?.weeklyDays||review?.interpretation?.days;
  return Array.isArray(days)?days:null;
}

export async function combineCrossSourceReviews({dailyDir,dailyReviewPath,weeklyDir,weeklyReviewPath,outputDir,outputPath,expectedStartSlot}){
  const [daily,weekly,dailyCapture,weeklyCapture,dailyDiscovery]=await Promise.all([
    readJson(dailyReviewPath),readJson(weeklyReviewPath),
    readJson(path.join(dailyDir,'capture.json')),readJson(path.join(weeklyDir,'capture.json')),
    readJson(path.join(dailyDir,'discovery-candidate.json'))
  ]);
  if(!daily?.ready||daily.interpretation?.ready!==true||!daily.selectedImage)throw new Error('dailyReviewNotReady');
  if(!weekly?.ready||weekly.interpretation?.ready!==true||!weekly.selectedImage)throw new Error('weeklyReviewNotReady');
  const targetDate=String(daily.targetDate||daily.interpretation?.observedDate||'');
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(targetDate)||String(weekly.targetDate||weekly.interpretation?.observedDate||'')!==targetDate)throw new Error('crossSourceDateMismatch');
  if(String(daily.interpretation.startSlot||'')!==String(expectedStartSlot||''))throw new Error('dailyStartSlotMismatch');
  const days=weeklyDaysFrom(weekly);
  if(!days||days.length<5||days.length>7)throw new Error('weeklyDaysNotReady');
  for(let i=0;i<days.length;i++){
    const day=days[i];
    if(String(day.date)!==addDays(targetDate,i+1)||day.visible!==true||String(day.confidence)!=='high'||!Array.isArray(day.weather)||!day.weather.length)throw new Error('weeklyDaysNotReady');
  }
  await mkdir(outputDir,{recursive:true});
  const dailyOut=`raw-media-0.${mimeExt(daily.selectedImage.mimeType)}`;
  const weeklyOut=`raw-media-1.${mimeExt(weekly.selectedImage.mimeType)}`;
  const dailyMeta=await imageMeta(dailyDir,daily.selectedImage,dailyOut);
  const weeklyMeta=await imageMeta(weeklyDir,weekly.selectedImage,weeklyOut);
  if(dailyMeta.digest===weeklyMeta.digest)throw new Error('crossSourceImagesMustDiffer');
  await copyFile(dailyMeta.source,path.join(outputDir,dailyOut));
  await copyFile(weeklyMeta.source,path.join(outputDir,weeklyOut));
  const dailyPost=path.join(dailyDir,dailyCapture.postContent?.file||'post-content.txt');
  await copyFile(dailyPost,path.join(outputDir,'post-content.txt'));
  await writeFile(path.join(outputDir,'discovery-candidate.json'),JSON.stringify(dailyDiscovery,null,2)+'\n','utf8');

  const dailyUrl=String(dailyCapture.sourceUrl||dailyDiscovery.sourceUrl||'');
  const weeklyUrl=String(weeklyCapture.sourceUrl||'');
  const capture={
    status:'captured',adapter:'cross-source-weather-evidence',
    sourceUrl:dailyUrl,finalUrl:dailyUrl,sourceType:String(dailyCapture.sourceType||'x'),sourceId:String(dailyCapture.sourceId||''),
    capturedAt:String(dailyCapture.capturedAt||new Date().toISOString()),
    pathways:[{name:'cross-source-combine',httpStatus:200}],
    postContent:{file:'post-content.txt'},
    rawMedia:[
      {url:dailyUrl,file:dailyOut,mimeType:dailyMeta.mimeType,byteSize:dailyMeta.size,sha256:dailyMeta.digest,sourceScope:'exact-status-current-slot'},
      {url:weeklyUrl,file:weeklyOut,mimeType:weeklyMeta.mimeType,byteSize:weeklyMeta.size,sha256:weeklyMeta.digest,sourceScope:'same-day-weekly-source'}
    ],
    evidence:{file:dailyOut,mimeType:dailyMeta.mimeType,byteSize:dailyMeta.size,sha256:dailyMeta.digest,kind:'original',capturedAt:String(dailyCapture.capturedAt||new Date().toISOString())},
    crossSource:{dailySourceUrl:dailyUrl,weeklySourceUrl:weeklyUrl,dailyOriginalFile:String(daily.selectedImage.file),weeklyOriginalFile:String(weekly.selectedImage.file)}
  };
  await writeFile(path.join(outputDir,'capture.json'),JSON.stringify(capture,null,2)+'\n','utf8');
  await writeFile(path.join(outputDir,'weekly-source.json'),JSON.stringify({targetDate,sourceUrl:weeklyUrl,selectedImage:weekly.selectedImage},null,2)+'\n','utf8');

  const dailyBound={file:dailyOut,mimeType:dailyMeta.mimeType,captureSha256:dailyMeta.digest};
  const weeklyBound={file:weeklyOut,mimeType:weeklyMeta.mimeType,captureSha256:weeklyMeta.digest};
  const combined={
    schemaVersion:2,ready:true,targetDate,selectedImage:dailyBound,
    reviewedImages:[dailyBound,weeklyBound],pendingEvidenceFile:dailyOut,
    interpretation:{
      ...daily.interpretation,
      weeklyDays:days,
      confidence:'high',
      summary:`${String(daily.interpretation.summary||'').trim()} 週間5日は同日別投稿のゲーム内週間UIから直接判読。`.trim(),
      unresolved:[]
    },
    diagnostics:{
      mode:'cross-source-daily-weekly-evidence',
      dailySourceUrl:dailyUrl,weeklySourceUrl:weeklyUrl,
      daily:daily.diagnostics||null,weekly:weekly.diagnostics||null
    }
  };
  await writeFile(outputPath,JSON.stringify(combined,null,2)+'\n','utf8');
  return combined;
}

function parseArgs(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('invalidArguments');out[argv[i].slice(2)]=argv[i+1];}return out;}
async function main(){const a=parseArgs(process.argv.slice(2));for(const k of ['daily-dir','daily-review','weekly-dir','weekly-review','output-dir','output','expected-start-slot'])if(!a[k])throw new Error('invalidArguments');const result=await combineCrossSourceReviews({dailyDir:path.resolve(a['daily-dir']),dailyReviewPath:path.resolve(a['daily-review']),weeklyDir:path.resolve(a['weekly-dir']),weeklyReviewPath:path.resolve(a['weekly-review']),outputDir:path.resolve(a['output-dir']),outputPath:path.resolve(a.output),expectedStartSlot:a['expected-start-slot']});process.stdout.write(JSON.stringify({ready:result.ready,startSlot:result.interpretation.startSlot,weeklyCount:result.interpretation.weeklyDays.length,dailySourceUrl:result.diagnostics.dailySourceUrl,weeklySourceUrl:result.diagnostics.weeklySourceUrl})+'\n');}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){main().catch(e=>{process.stderr.write(`Cross-source weather review failed: ${e.message}\n`);process.exitCode=1;});}
