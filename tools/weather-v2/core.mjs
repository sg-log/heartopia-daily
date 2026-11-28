import { createHash } from 'node:crypto';
export const SCHEMA = 'heartopia-weather-v2/1';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = x => JSON.stringify(x, null, 2) + '\n';
export function date(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || '') || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value) throw Error('invalidDate');
  return value;
}
export const plusDays = (d,n) => new Date(Date.parse(date(d)+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function canonical(raw) {
  try {
    let u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (/(google\.|bing.com|duckduckgo.com|yahoo.co.jp)/.test(u.hostname)) {
      const nested = ['uddg','url','q'].map(k=>u.searchParams.get(k)).find(v=>v?.startsWith('https://'));
      if (nested) u = new URL(nested);
    }
    if (/(^|\.)(x|twitter)\.com$/.test(u.hostname)) {
      const m=u.pathname.match(/^\/(?:i\/status|([\w]+)\/status)\/(\d+)/);
      return m ? {sourceUrl:`https://x.com/i/status/${m[2]}`,platform:'x',author:(m[1]||'').toLowerCase(),sourceId:m[2]} : null;
    }
    if (/(^|\.)(bing.com|duckduckgo.com|google.com|search.yahoo.co.jp|t.co|pic.x.com)$/.test(u.hostname)) return null;
    u.hash=''; for (const k of [...u.searchParams.keys()]) if (/^(utm_|__ysp|fbclid|gclid)/.test(k)) u.searchParams.delete(k);
    return {sourceUrl:u.href,platform:u.hostname.replace(/^www\./,''),author:'',sourceId:null};
  } catch { return null; }
}
export function dateMention(text, target) {
  const [,m,d]=target.split('-').map(Number);
  const pattern = new RegExp(`(?:^|[^0-9])(?:${target.slice(0,4)}[-/年])?0?${m}[-/月]0?${d}(?:日|[^0-9]|$)`);
  return pattern.test(text || '');
}
export function publishedAt(sourceId) {
  try { return new Date(Number((BigInt(sourceId)>>22n)+1288834974657n)).toISOString(); } catch { return ''; }
}
export function mergeCandidates(rows,targetDate) {
  const merged=new Map();
  for (const row of rows) {
    const c=canonical(row.sourceUrl); if(!c) continue;
    const old=merged.get(c.sourceUrl)||{...c,contexts:[],discoveries:[],lanes:[]};
    old.author ||= (row.author||c.author||'').toLowerCase();
    old.contexts=[...new Set([...old.contexts,row.context||''])];
    old.discoveries.push({provider:row.provider,query:row.query});
    old.lanes=[...new Set([...old.lanes,row.lane])];
    old.publishedAt=publishedAt(c.sourceId);
    merged.set(c.sourceUrl,old);
  }
  return [...merged.values()].map(c=>({...c,dateMentioned:c.contexts.some(t=>dateMention(t,targetDate)),publishedOnTarget:c.publishedAt?new Date(Date.parse(c.publishedAt)+9*3600000).toISOString().slice(0,10)===targetDate:false}));
}
export function rankLane(candidates,lane,{limit=12,authorLimit=2,history=[]}={}) {
  const ranked=candidates.map(c=>({...c,score:(c.dateMentioned?100:0)+(c.publishedOnTarget?45:0)+(c.lanes.includes(lane)?20:0)+(/週間|weekly|forecast/i.test(c.contexts.join(' '))&&lane==='weekly'?12:0)}))
    .sort((a,b)=>b.score-a.score || Number(history.includes(a.author)||history.includes(a.sourceUrl))-Number(history.includes(b.author)||history.includes(b.sourceUrl)) || a.sourceUrl.localeCompare(b.sourceUrl));
  const chosen=[],counts=new Map(),hostCounts=new Map();
  // Round-robin by author/host within a date-quality tier. Unknown authors never share one bucket.
  for (const tier of [true,false]) for (let round=0;round<authorLimit;round++) {
    for (const c of ranked.filter(c=>(c.dateMentioned||c.publishedOnTarget)===tier)) {
      const author=c.author?`${c.platform}:${c.author}`:c.sourceUrl;
      const host=c.platform;
      if(chosen.length>=limit) break;
      if(chosen.some(x=>x.sourceUrl===c.sourceUrl)||(counts.get(author)||0)>round) continue;
      if(round===0 && (hostCounts.get(host)||0)>=Math.ceil(limit/2)) continue;
      chosen.push(c);counts.set(author,(counts.get(author)||0)+1);hostCounts.set(host,(hostCounts.get(host)||0)+1);
    }
  }
  return chosen;
}
export function identity({targetDate,startSlot,slots,days=[]}) {
  const dailyKey=sha(JSON.stringify([date(targetDate),startSlot,slots]));
  const weeklyKey=days.length?sha(JSON.stringify(days.map(d=>[d.date,d.weather]))):null;
  return {dailyKey,weeklyKey};
}
export function compareExisting(candidate,existing) {
  if(!existing) return 'new';
  if(candidate.dailyKey!==existing.dailyKey) return 'daily-change';
  if(!candidate.weeklyKey||candidate.weeklyKey===existing.weeklyKey) return 'duplicate';
  return 'weekly-change';
}
export function selectConsistent(items,kind) {
  const ready=items.filter(x=>x[kind]?.ready);
  if(!ready.length)return {selected:null,status:'not_found_in_search'};
  const signature=x=>JSON.stringify(kind==='daily'?[x.daily.startSlot,x.daily.slots]:x.weekly.days);
  if(new Set(ready.map(signature)).size>1)return {selected:null,status:'conflict'};
  return {selected:ready[0],status:'verified',alternatives:ready.length-1};
}
