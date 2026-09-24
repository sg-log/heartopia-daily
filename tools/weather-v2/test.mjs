import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical,mergeCandidates,rankLane,identity,compareExisting,selectConsistent,dateMention } from './core.mjs';
import { strictDaily } from './review.mjs';
import { readFile } from 'node:fs/promises';
test('same article tracking links collapse; author discovered later survives',()=>{
  const rows=[{sourceUrl:'https://x.com/i/status/123',context:'Heartopia weather',lane:'daily'},{sourceUrl:'https://x.com/Alice/status/123',context:'2026/09/22',lane:'weekly'}];
  const [c]=mergeCandidates(rows,'2026-09-22');assert.equal(c.author,'alice');assert.equal(c.dateMentioned,true);assert.equal(c.discoveries.length,2);
  assert.equal(canonical('https://example.org/a?__ysp=x&utm_source=y').sourceUrl,'https://example.org/a');
});
test('daily-only repeats ignore approved inherited weekly; actual new weekly remains a change',()=>{
  const c={targetDate:'2026-09-22',startSlot:'06',slots:Array(5).fill(['晴'])};
  const daily=identity(c),approved=identity({...c,days:[{date:'2026-09-23',weather:['雨']}]});
  assert.equal(compareExisting(daily,approved),'duplicate');assert.equal(compareExisting(approved,daily),'weekly-change');
});
test('author diversity retains alternatives and no fixed identity',()=>{
  const cs=Array.from({length:12},(_,i)=>({sourceUrl:`https://example.org/${i}`,author:i<10?'alice':'bob',platform:'x',contexts:[],lanes:['daily'],dateMentioned:true,publishedOnTarget:true}));
  const ranked=rankLane(cs,'daily',{limit:8,authorLimit:2});assert.equal(ranked.filter(c=>c.author==='alice').length,2);assert.equal(ranked.filter(c=>c.author==='bob').length,2);
});
test('different verified images with conflicting weather never silently choose first',()=>{
  const cs=[{daily:{ready:true,startSlot:'06',slots:['晴']}},{daily:{ready:true,startSlot:'06',slots:['流星群']}}];
  assert.equal(selectConsistent(cs,'daily').status,'conflict');
});
test('sunny heuristic cannot override meteor template and become accepted',()=>{
  const p={ready:true,interpretation:{startSlot:'06',slots:Array(5).fill({weather:['晴']})},diagnostics:{scores:Array(5).fill({templateValue:'流星群',bestScore:.8,margin:.1})}};
  assert.equal(strictDaily(p,'06'),false);assert.equal(strictDaily(p,'18'),false);
});
test('date matching does not confuse 9/2 with 9/22',()=>{assert.equal(dateMention('9/22','2026-09-02'),false);assert.equal(dateMention('9月22日','2026-09-22'),true);});
test('workflow has read-only permissions and no production credentials or submit step',async()=>{
  const w=await readFile(new URL('../../.github/workflows/weather-v2-dry-run.yml',import.meta.url),'utf8');
  assert.match(w,/contents: read/);assert.doesNotMatch(w,/secrets\.|issues: write|weather-cloud-submit|discord-notify|schedule:/);
});
