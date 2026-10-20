import test from 'node:test';
import assert from 'node:assert/strict';
import {compareCalendarWithImageReviews as compare} from './weather-calendar-crosscheck.mjs';
const calendar=()=>({types:{1:{category:'clear'},2:{category:'cloud'},3:{category:'rain'}},days:[{date:'2026-10-19',hours:Array(24).fill(1)},{date:'2026-10-20',hours:Array(24).fill(2)}]});
const record=(author='a',weather='晴',hash='a')=>({author,sourceUrl:`https://x.com/${author}/status/123`,review:{ready:true,targetDate:'2026-10-19',selectedImage:{captureSha256:hash.repeat(64)},interpretation:{ready:true,confidence:'high',observedDate:'2026-10-19',startSlot:'00',slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:true,confidence:'high',weather:[weather]}))}}});
test('matches independent game images, including the next-day midnight slot',()=>{
  const r=compare(calendar(),[record(),record('b','晴','b')],'2026-10-19');assert.equal(r.status,'matched');assert.equal(r.comparedCells,10);assert.equal(r.notify,false);
});
test('absent or unreadable SNS posts are unchecked, not a weather mismatch',()=>{
  assert.equal(compare(calendar(),[],'2026-10-19').status,'unchecked');
  const r=record();r.review.ready=false;assert.equal(compare(calendar(),[r],'2026-10-19').notify,false);
});
test('one inconsistent author waits for corroboration; two agreeing independent images trigger a warning',()=>{
  const a=record('a','雨','a'),b=record('b','雨','b');assert.equal(compare(calendar(),[a],'2026-10-19').status,'needs-corroboration');
  const r=compare(calendar(),[a,b],'2026-10-19');assert.equal(r.status,'mismatch');assert.equal(r.notify,true);assert.ok(r.confirmedConflicts.length);
});
test('reposts of the same image and repeated authors do not count as independent confirmation',()=>{
  assert.equal(compare(calendar(),[record('a','雨','a'),record('b','雨','a')],'2026-10-19').notify,false);
  assert.equal(compare(calendar(),[record('a','雨','a'),record('a','雨','b')],'2026-10-19').notify,false);
});
test('old dates, weak classifications and unsupported weather never generate mismatch notices',()=>{
  const a=record();a.review.interpretation.observedDate='2026-10-18';assert.equal(compare(calendar(),[a],'2026-10-19').status,'unchecked');
  const b=record('b','雨','b');b.review.interpretation.slots.forEach(s=>s.confidence='low');assert.equal(compare(calendar(),[b],'2026-10-19').status,'unchecked');
  const d=record('c','不明','c');assert.equal(compare(calendar(),[d],'2026-10-19').status,'unchecked');
});
test('does not compare a six-hour icon against a mixed hourly window',()=>{
  const c=calendar();c.days[0].hours[0]=3;const r=compare(c,[record()],'2026-10-19');assert.equal(r.comparedCells,4);assert.equal(r.notify,false);
});
