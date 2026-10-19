import test from 'node:test';
import assert from 'node:assert/strict';
import {redactWeatherReferences,collectCleanupPlan,applyCleanupPlan} from './weather-reference-cleanup.mjs';
test('redacts external weather references but preserves run keys, success markers and GitHub links',()=>{
  const body='<!-- heartopia-weather-scheduled-success:2026-10-19-morning -->\n{"sourceUrl":"https://x.com/example/status/123","runUrl":"https://github.com/example/repo/actions/runs/12"}';
  const r=redactWeatherReferences(body);assert.ok(!r.includes('x.com'));assert.ok(r.includes('scheduled-success:2026-10-19-morning'));assert.ok(r.includes('github.com'));assert.equal(redactWeatherReferences(r),r);
});
test('cleanup plan is restricted to completed weather runs and weather evidence before the cutoff',async()=>{
  const api=async(_method,url)=>{
    if(url.startsWith('/actions/workflows?'))return {workflows:[{id:1,name:'Weather collector'},{id:2,name:'Gift poll'}]};
    if(url.startsWith('/actions/workflows/1/runs'))return {workflow_runs:[{id:10,status:'completed',created_at:'2026-10-18T00:00:00Z'},{id:11,status:'in_progress',created_at:'2026-10-18T00:00:00Z'},{id:12,status:'completed',created_at:'2026-10-20T00:00:00Z'}]};
    if(url.startsWith('/actions/artifacts?'))return {artifacts:[{id:20,name:'weather-evidence',created_at:'2026-10-18T00:00:00Z',expired:false},{id:21,name:'gift-evidence',created_at:'2026-10-18T00:00:00Z',expired:false}]};
    return [{number:30,title:'[weather-scheduled-result] date',created_at:'2026-10-18T00:00:00Z',body:'https://x.com/example/status/123'},{number:31,title:'Gift code',created_at:'2026-10-18T00:00:00Z',body:'https://x.com/example/status/123'}];
  };
  const p=await collectCleanupPlan({api,cutoff:'2026-10-19T00:00:00Z'});assert.deepEqual(p.runs,[10]);assert.deepEqual(p.artifacts,[20]);assert.equal(p.issues.length,1);assert.equal(p.issues[0].number,30);
});
test('applies only the planned actions and continues with a compact failure count',async()=>{
  const calls=[];const api=async(method,url,body)=>{calls.push({method,url,body});if(url.includes('/runs/'))throw Error('denied');};
  const r=await applyCleanupPlan({api,plan:{runs:[10],artifacts:[20],issues:[{number:30,body:'redacted'}]}});
  assert.deepEqual(r,{logsDeleted:0,artifactsDeleted:1,issuesRedacted:1,commentsRedacted:0,alreadyAbsent:0,failures:1});assert.deepEqual(calls.map(c=>c.method),['PATCH','DELETE','DELETE']);
});
