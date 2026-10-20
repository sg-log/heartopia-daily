// Authorized removal of public weather reference traces. Never print bodies/URLs.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const weatherName=value=>/weather|天気/i.test(String(value||''));
export function redactWeatherReferences(text) {
  return String(text||'').replace(/https?:\/\/[^\s<>"'`\\]+/gi,url=>{
    let host;try{host=new URL(url).hostname.toLowerCase();}catch{return url;}
    return host==='github.com' || host==='api.github.com' || host==='sg-log.github.io' ? url : '[非公開の参照情報]';
  });
}
export async function collectCleanupPlan({api,cutoff}) {
  const limit=Date.parse(cutoff);if(!Number.isFinite(limit))throw Error('invalidCutoff');
  const plan={runs:[],artifacts:[],issues:[],comments:[]};
  const workflows=await api('GET','/actions/workflows?per_page=100');
  for(const workflow of (workflows.workflows||[]).filter(w=>weatherName(w.name)||weatherName(w.path))) {
    for(let page=1;page<=10;page++) {
      const data=await api('GET',`/actions/workflows/${workflow.id}/runs?per_page=100&page=${page}&created=${encodeURIComponent('<='+cutoff)}`);
      for(const run of data.workflow_runs||[]) if(run.status==='completed' && Date.parse(run.created_at)<=limit) plan.runs.push(run.id);
      if((data.workflow_runs||[]).length<100)break;
      if(page===10)throw Error('runPaginationLimit');
    }
  }
  for(let page=1;page<=20;page++) {
    const data=await api('GET',`/actions/artifacts?per_page=100&page=${page}`);
    for(const artifact of data.artifacts||[]) if(weatherName(artifact.name) && !artifact.expired && Date.parse(artifact.created_at)<=limit) plan.artifacts.push(artifact.id);
    if((data.artifacts||[]).length<100)break;
    if(page===20)throw Error('artifactPaginationLimit');
  }
  for(let page=1;page<=10;page++) {
    const data=await api('GET',`/issues?state=all&per_page=100&page=${page}`);
    for(const issue of data) {
      if(!weatherName(issue.title) || Date.parse(issue.created_at)>limit)continue;
      const body=redactWeatherReferences(issue.body);
      if(body!==String(issue.body||''))plan.issues.push({number:issue.number,body});
      if(issue.comments>0) {
        for(let cp=1;cp<=10;cp++) {
          const comments=await api('GET',`/issues/${issue.number}/comments?per_page=100&page=${cp}`);
          for(const comment of comments){const clean=redactWeatherReferences(comment.body);if(clean!==String(comment.body||''))plan.comments.push({id:comment.id,body:clean});}
          if(comments.length<100)break;
          if(cp===10)throw Error('commentPaginationLimit');
        }
      }
    }
    if(data.length<100)break;
    if(page===10)throw Error('issuePaginationLimit');
  }
  plan.runs=[...new Set(plan.runs)];plan.artifacts=[...new Set(plan.artifacts)];
  return plan;
}
export async function applyCleanupPlan({api,plan}) {
  const result={logsDeleted:0,artifactsDeleted:0,issuesRedacted:0,commentsRedacted:0,alreadyAbsent:0,failures:0};
  for(const issue of plan.issues)try{await api('PATCH',`/issues/${issue.number}`,{body:issue.body});result.issuesRedacted++;}catch{result.failures++;}
  for(const comment of plan.comments||[])try{await api('PATCH',`/issues/comments/${comment.id}`,{body:comment.body});result.commentsRedacted++;}catch{result.failures++;}
  for(const id of plan.artifacts)try{const r=await api('DELETE',`/actions/artifacts/${id}`);if(r?.alreadyAbsent)result.alreadyAbsent++;else result.artifactsDeleted++;}catch{result.failures++;}
  for(const id of plan.runs)try{const r=await api('DELETE',`/actions/runs/${id}/logs`);if(r?.alreadyAbsent)result.alreadyAbsent++;else result.logsDeleted++;}catch{result.failures++;}
  return result;
}
export function resumePreviousCleanup(plan) {
  const runs=plan.runs.filter(id=>id!==39187968927);
  if(runs.length!==863)throw Error('previousCleanupPlanChanged');
  return {...plan,runs:runs.slice(727)};
}
async function main() {
  const repository=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository||'') || !token)throw Error('missingRepositoryAccess');
  const resume=process.env.CLEANUP_RESUME_PREVIOUS==='true';
  const cutoff=resume?'2026-10-19T02:01:46Z':process.env.CLEANUP_CUTOFF_UTC || new Date().toISOString();
  let calls=0;
  const api=async(method,suffix,body)=>{
    if(++calls>850)throw Error('requestBudgetReached');
    const response=await fetch(`https://api.github.com/repos/${repository}${suffix}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    if(response.status===404 && method==='DELETE')return {alreadyAbsent:true};
    if(!response.ok)throw Error('cleanupRequestFailed');
    return response.status===204?null:response.json();
  };
  const collected=await collectCleanupPlan({api,cutoff});
  const plan=resume?resumePreviousCleanup(collected):collected;
  console.log(JSON.stringify({plannedLogs:plan.runs.length,plannedArtifacts:plan.artifacts.length,plannedIssueEdits:plan.issues.length,plannedCommentEdits:plan.comments.length}));
  if(process.env.CLEANUP_APPLY!=='true')return;
  const result=await applyCleanupPlan({api,plan});console.log(JSON.stringify(result));
  if(result.failures || (resume && result.alreadyAbsent))process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('Weather reference cleanup incomplete; no source details were logged.');process.exitCode=1;});
