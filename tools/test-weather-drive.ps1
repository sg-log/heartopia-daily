param([string] $OutputPath = (Join-Path $env:TEMP 'heartopia-weather-drive-test.html'))
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/test-weather-pending.ps1" -OutputPath $OutputPath | Out-Null
# Real PNG fixture and hash, generated locally. Nothing reaches Drive or a network.
Add-Type -AssemblyName System.Drawing
$bmp = [Drawing.Bitmap]::new(300,250)
$random = [Random]::new(7)
$stream = [IO.MemoryStream]::new()
try {
    for($y=0;$y -lt 250;$y++){for($x=0;$x -lt 300;$x++){$bmp.SetPixel($x,$y,[Drawing.Color]::FromArgb($random.Next(256),$random.Next(256),$random.Next(256)))}}
    $bmp.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
    $bytes=$stream.ToArray()
} finally {$bmp.Dispose();$stream.Dispose()}
$sha=[Security.Cryptography.SHA256]::Create()
try {$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
$fixture=@{mimeType='image/png';byteSize=$bytes.Length;sha256=$hash;kind='screenshot';capturedAt='2026-09-11T06:00:00+09:00';bodyBase64=[Convert]::ToBase64String($bytes)} | ConvertTo-Json -Compress
$tests=@'
;(async()=>{
try{
assert(output.textContent.startsWith('PASS:'),'baseline pending harness must pass');
const fixture=__FIXTURE__;
let folderConfigured=true, driveFailure=false, appendFailure=false, appendAfterWrite=false, shared=false, trashed=0, creates=0, reads=0, logs=[];
const files=new Map();
Utilities.base64Decode=s=>Array.from(atob(s),c=>c.charCodeAt(0));
Utilities.base64Encode=b=>{let s='';for(const n of b)s+=String.fromCharCode(n&255);return btoa(s);};
Utilities.DigestAlgorithm={SHA_256:'sha256'};
// Synchronous Apps Script digest adapter, with expected hash independently verified by Web Crypto.
const actualHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(Utilities.base64Decode(fixture.bodyBase64))))).map(n=>n.toString(16).padStart(2,'0')).join('');
assert(actualHash===fixture.sha256,'real fixture SHA256');
Utilities.computeDigest=(_,b)=>Utilities.base64Encode(b)===fixture.bodyBase64 ? fixture.sha256.match(/../g).map(h=>parseInt(h,16)) : Array(32).fill(0);
Utilities.newBlob=(b,m)=>({getBytes:()=>typeof b==='string'?Array.from(new TextEncoder().encode(b)):b,getContentType:()=>m});
const privateMethods={getSharingAccess:()=> shared?'ANYONE':'PRIVATE', getViewers:()=>[],getEditors:()=>[]};
const folder={...privateMethods,getId:()=> 'mock-folder',createFile:blob=>{
 if(driveFailure)throw Error('mock failure');creates++;
 const id='mock-file-'+creates;
 const file={...privateMethods,getId:()=>id,getBlob:()=>blob,getSize:()=>blob.getBytes().length,isTrashed:()=>false,setTrashed:()=>{trashed++;},getParents:()=>{let done=false;return {hasNext:()=>!done,next:()=>{done=true;return folder;}};}};
 files.set(id,file);return file;
}};
window.DriveApp={Access:{PRIVATE:'PRIVATE'},getFolderById:()=>folder,getFileById:id=>{reads++;if(!files.has(id))throw Error();return files.get(id);}};
window.Logger={log:value=>logs.push(String(value))};
scriptProperty_=()=>{if(!folderConfigured)throw Error('unset');return 'mock-folder';};
const originalAppend=sheet.appendRow;
sheet.appendRow=row=>{if(appendFailure)throw Error('sheet failure');originalAppend(row);if(appendAfterWrite)throw Error('after append');};
sheet.deleteRow=n=>rows.splice(n-1,1);
rows.splice(0,rows.length,HEADERS.concat(['sourceUrl','sourceImageUrls']));columns=HEADERS.length+2;
const body={action:'submit',postKey:'synthetic',date:'2026-09-11',startSlot:'06',slots:{slot0:['晴']},weeks:{},sourceUrl:'https://example.org/post',sourceImageUrls:[],sourceType:'web',retrievedAt:'2026-09-11T06:00:00+09:00',evidenceImages:[fixture]};
authorizeWeatherEvidenceDrive();
assert(creates===0&&logs.length===1&&logs[0]==='Drive access OK'&&!logs[0].includes('mock-folder'),'authorization wrapper reads only and logs no ID');
function rejects(fn,label){let failed=false;try{fn();}catch(_){failed=true;}assert(failed,label);}
function rejectsCode(fn,code,stage,label){let error=null;try{fn();}catch(e){error=e;}assert(error&&error.weatherFailureCode===code&&error.weatherStage===stage,label);}
const large=JSON.stringify(body);
assert(new TextEncoder().encode(large).length>300000 && parseBody_({postData:{contents:large}}).evidenceImages.length===1,'307KiB class submit accepted');
rejects(()=>parseBody_({postData:{contents:JSON.stringify({action:'pending',padding:'x'.repeat(70000)})}}),'old action 64KiB');
rejectsCode(()=>parseBody_({postData:{contents:large+' '.repeat(1048576)}}),'requestTooLarge','requestParsing','1MiB max');
rejectsCode(()=>submit_({...body,postKey:'wrong'}),'postAuthFailed','postAuth','post auth stage');
rejectsCode(()=>submit_({...body,evidenceImages:[{...fixture,bodyBase64:'!!!!'}]}),'invalidBase64','base64Decode','base64 stage');
rejectsCode(()=>submit_({...body,evidenceImages:[{...fixture,mimeType:'image/svg+xml'}]}),'mimeTypeRejected','payloadValidation','mime stage');
rejectsCode(()=>submit_({...body,evidenceImages:[{...fixture,sha256:'0'.repeat(64)}]}),'sha256Mismatch','sha256Validation','hash stage');
rejectsCode(()=>submit_({...body,evidenceImages:[{...fixture,bodyBase64:btoa('x'.repeat(524289)),byteSize:524289}]}),'imageTooLarge','base64Decode','size stage');
for(const change of [{bodyBase64:'!!!!'},{mimeType:'image/svg+xml'},{sha256:'0'.repeat(64)},{byteSize:524289},{localPath:'file:///secret'},{bodyBase64:btoa('x'.repeat(524289)),byteSize:524289}]){
 rejects(()=>submit_({...body,evidenceImages:[{...fixture,...change}]}),'invalid image');
}
rejects(()=>submit_({...body,evidenceImages:[fixture,fixture]}),'two images');
assert(creates===0&&rows.length===1,'validation no writes');
folderConfigured=false;rejectsCode(()=>submit_(body),'evidenceFolderNotConfigured','driveFolder','folder unset');folderConfigured=true;
shared=true;rejectsCode(()=>submit_(body),'drivePermissionError','driveFolder','shared folder refused');shared=false;
driveFailure=true;rejectsCode(()=>submit_(body),'driveSaveError','driveSave','Drive failure');driveFailure=false;
assert(rows.length===1,'no pending on Drive failure');
appendFailure=true;rejectsCode(()=>submit_(body),'pendingSaveError','pendingSave','append failure');appendFailure=false;
assert(trashed===1&&rows.length===1,'orphan trashed');
appendAfterWrite=true;rejects(()=>submit_(body),'append committed then failed');appendAfterWrite=false;
assert(trashed===2&&rows.length===1,'ambiguous append rolled back');
const receipt=submit_(body), reports=listByStatus_('pending');
assert(receipt.status==='pending'&&reports[0].evidenceStatus==='saved','saved');
const createsAfterFirst=creates, duplicateReceipt=submit_(body), duplicateReports=listByStatus_('pending');
assert(duplicateReceipt.duplicate===true&&duplicateReceipt.id===receipt.id,'duplicate returns existing pending id');
assert(creates===createsAfterFirst&&duplicateReports.length===1,'duplicate creates no Drive file or pending row');
assert(!JSON.stringify(reports).includes('fileId')&&!JSON.stringify(reports).includes('bodyBase64'),'pending no file id/body');
assert(!JSON.stringify(publicWeatherItem_(reports[0])).includes('evidence'),'public no evidence');
const req={action:'weatherEvidence',adminKey:'synthetic',reportId:receipt.id,imageIndex:0};
const beforeReads=reads;
rejects(()=>getWeatherEvidence_({...req,adminKey:''}),'admin required');
rejects(()=>getWeatherEvidence_({...req,reportId:'other'}),'other report');
rejects(()=>getWeatherEvidence_({...req,fileId:'arbitrary'}),'arbitrary file');
rejects(()=>getWeatherEvidence_({...req,imageIndex:1}),'index invalid');
assert(reads===beforeReads,'unauthorized no Drive read');
assert(getWeatherEvidence_(req).bodyBase64===fixture.bodyBase64,'authorized bytes');
const host=document.querySelector('#cards');
host.innerHTML=pendingWeatherCard(reports[0])+pendingWeatherCard({id:'legacy',date:body.date,slots:body.slots});
assert(host.querySelectorAll('[data-weather-evidence]').length===1&&host.querySelectorAll('[data-load-weather-evidence]').length===0,'saved evidence auto target and no manual button');
const evidenceTarget=host.querySelector('[data-weather-evidence]'), sourceLink=host.querySelector('.pendingWeatherSourceLink'), actions=host.querySelector('.pendingWeatherActions'), details=host.querySelector('.pendingWeatherDetails');
assert(evidenceTarget.compareDocumentPosition(sourceLink)&Node.DOCUMENT_POSITION_FOLLOWING,'evidence before source link');
assert(sourceLink.compareDocumentPosition(actions)&Node.DOCUMENT_POSITION_FOLLOWING,'source link before actions');
assert(actions.compareDocumentPosition(details)&Node.DOCUMENT_POSITION_FOLLOWING,'actions before details');
let apiCalls=0;
window.apiPost=async data=>{apiCalls++;return getWeatherEvidence_(data);};
window.adminKeyValue=()=> 'synthetic';
assert(apiCalls===0,'no eager fetch');
window.E={pendingWeatherReports:host};let intersectionCallback=null,observedTargets=[];
window.IntersectionObserver=class{constructor(callback,options){intersectionCallback=callback;assert(options.rootMargin==='160px 0px','observer preload margin');}observe(target){observedTargets.push(target);}unobserve(){}disconnect(){}};
await observePendingEvidence();
assert(apiCalls===0&&observedTargets.length===1,'offscreen evidence is not fetched');
intersectionCallback([{isIntersecting:false,target:evidenceTarget}]);await Promise.resolve();assert(apiCalls===0,'non-intersecting card stays deferred');
intersectionCallback([{isIntersecting:true,target:evidenceTarget}]);await new Promise(resolve=>setTimeout(resolve,0));
assert(apiCalls===1&&host.querySelector('[data-evidence-display] img').src.startsWith('blob:'),'authenticated lazy blob display');
assert(host.querySelector('[data-evidence-display] a').textContent.includes('証拠画像を拡大'),'enlarge link retained');
const retryCard=document.createElement('div');retryCard.innerHTML=pendingWeatherCard(reports[0]);host.append(retryCard.firstElementChild);
const retryTarget=host.lastElementChild.querySelector('[data-weather-evidence]');
window.apiPost=async()=>{apiCalls++;throw Error('mock retrieval failure');};
await loadPendingEvidence(retryTarget);
assert(retryTarget.querySelector('[data-retry-weather-evidence]'),'failed retrieval is retryable');
window.apiPost=async data=>{apiCalls++;return getWeatherEvidence_(data);};
delete retryTarget.dataset.evidenceState;await loadPendingEvidence(retryTarget);
assert(retryTarget.querySelector('img'),'retry can load evidence');
clearPendingEvidenceImages();
changeStatus_({id:receipt.id,adminKey:'synthetic'},'approved');
rejects(()=>getWeatherEvidence_(req),'approved not pending');
const legacy=submit_({...body,evidenceImages:undefined});
changeStatus_({id:legacy.id,adminKey:'synthetic'},'rejected');
assert(listByStatus_('rejected').length===1,'legacy reject');
output.textContent='PASS: Drive evidence validation/size/Base64/hash, private configuration, rollback, old rows, authentication/report binding/fileId refusal, public redaction, lazy UI and approve/reject. ALL STORAGE/NETWORK MOCKED.';
}catch(e){output.textContent='FAIL DRIVE: '+e.message;}
})();
'@
$tests=$tests.Replace('__FIXTURE__',$fixture)
$html=[IO.File]::ReadAllText($OutputPath)
$pos=$html.LastIndexOf('</script>')
$html=$html.Insert($pos,$tests)
[IO.File]::WriteAllText($OutputPath,$html,[Text.UTF8Encoding]::new($false))
"Open in browser: $OutputPath"
