import test from "node:test";
import assert from "node:assert/strict";
import {parseRequest,requestBody,resultBody,snapshot,runRequest,runEvent} from "./weekly-chat-bridge.mjs";

const BASE="2026-10-21";
const empty=()=>Object.fromEntries(Array.from({length:7},(_,i)=>["week"+(i+1),[]]));
const title=type=>"Heartopia weekly chat "+type.toUpperCase()+" "+BASE;
const read={v:1,type:"read",baseDate:BASE};
const validIssue=data=>({title:title(data.type),body:requestBody(data),number:201,user:{login:"sg-log"}});
function mockApi({rows=[],approved=[],write=true}={}) {
  const data=rows.slice(),calls=[],comments=[];
  const fake=async(url,options={})=>{
    const action=new URL(url).searchParams.get("action");
    if(action==="getWeeklyForecasts")return {ok:true,json:async()=>({ok:true,forecasts:data})};
    if(action==="approved")return {ok:true,json:async()=>({ok:true,reports:approved})};
    if(options.method==="POST" && String(url).includes("script.google.com")) {
      if(!write)throw Error("Write not expected");
      const payload=JSON.parse(options.body);calls.push(payload);
      assert.equal(payload.action,"saveWeeklyForecast");
      assert.deepEqual(Object.keys(payload).sort(),["action","adminKey","baseDate","expected","updates"].sort());
      let row=data.find(x=>x.baseDate===payload.baseDate);
      if(!row) {row={baseDate:payload.baseDate,weeks:empty()};data.push(row);}
      if(JSON.stringify(row.weeks)!==JSON.stringify(payload.expected))return {ok:true,json:async()=>({ok:false,error:"Changed"})};
      for(const change of payload.updates){
        const index=(Date.parse(change.date+"T00:00:00Z")-Date.parse(payload.baseDate+"T00:00:00Z"))/86400000;
        row.weeks["week"+index]=[change.weather];
      }
      return {ok:true,json:async()=>({ok:true,forecast:row})};
    }
    if(String(url).endsWith("/comments") && options.method==="POST") {
      comments.push(JSON.parse(options.body).body);
      return {ok:true};
    }
    throw Error("Unexpected request: "+url);
  };
  return {fake,calls,comments,data};
}

test("read issue has exact envelope, owner-independent parser and no write credentials",()=>{
  assert.deepEqual(parseRequest(validIssue(read)),{type:"read",baseDate:BASE});
  assert.match(resultBody({ok:true,type:"read"}),/HEARTOPIA_WEEKLY_CHAT_RESULT_V1/);
  assert.throws(()=>parseRequest({...validIssue(read),title:"unrelated title"}));
  assert.throws(()=>parseRequest({...validIssue(read),body:"{\u0022v\u0022:1}"}));
  assert.throws(()=>parseRequest(validIssue({...read,unknown:1})));
});
test("read snapshot sees newest inherited independent data and older approved fallback",()=>{
  const a={baseDate:"2026-10-19",weeks:{...empty(),week3:["虹"],week4:["雨"]}};
  const b={baseDate:"2026-10-20",weeks:{...empty(),week2:["流星群"]}};
  const s=snapshot(BASE,[a,b],[{date:"2026-10-20",weeks:{...empty(),week5:["晴"]}}]);
  assert.deepEqual(s.visible.week1,["流星群"]);
  assert.deepEqual(s.visible.week2,["雨"]);
  assert.deepEqual(s.visible.week4,["晴"]);
  assert.deepEqual(s.expected.week1,[]);
  assert.equal(s.days.length,7);
});
test("same-base independent entry overrides carry forecast",()=>{
  const x={baseDate:"2026-10-20",weeks:{...empty(),week2:["流星群"]}};
  const y={baseDate:BASE,weeks:{...empty(),week1:["虹"]}};
  assert.deepEqual(snapshot(BASE,[x,y],[]).visible.week1,["虹"]);
});
test("save requires fresh preview and rejects invalid weather or mismatched dates",()=>{
  const raw={v:1,type:"save",baseDate:BASE,readAt:new Date().toISOString(),
    expected:empty(),expectedVisible:empty(),updates:[{date:"2026-10-22",weather:"虹"}]};
  assert.equal(parseRequest(validIssue(raw)).updates.length,1);
  assert.throws(()=>parseRequest(validIssue({...raw,updates:[{date:"2026-10-22",weather:"曇"}]})));
  assert.throws(()=>parseRequest(validIssue({...raw,updates:[{date:"2026-10-29",weather:"虹"}]})));
  assert.throws(()=>parseRequest(validIssue({...raw,readAt:new Date(Date.now()-40*60000).toISOString()})));
  assert.throws(()=>parseRequest(validIssue({...raw,expectedVisible:{}})));
});
test("save writes only standalone weekly action after successful comparison and verifies by GET",async()=>{
  const m=mockApi();
  const request={type:"save",baseDate:BASE,readAt:new Date().toISOString(),
    expected:empty(),expectedVisible:empty(),updates:[{date:"2026-10-22",weather:"流星群"},{date:"2026-10-23",weather:"虹"}]};
  const result=await runRequest(request,{fetchFn:m.fake,adminKey:"test-only"});
  assert.equal(result.ok,true);
  assert.equal(result.verified,true);
  assert.equal(result.status,"saved");
  assert.equal(m.calls.length,1);
  assert.deepEqual(m.data[0].weeks.week1,["流星群"]);
  assert.deepEqual(m.data[0].weeks.week2,["虹"]);
  assert.equal(m.calls[0].adminKey,"test-only");
});
test("stale effective forecast blocks saving, even if same-base raw row is unchanged",async()=>{
  const m=mockApi({rows:[{baseDate:"2026-10-20",weeks:{...empty(),week2:["晴"]}}],write:false});
  const request={type:"save",baseDate:BASE,readAt:new Date().toISOString(),expected:empty(),expectedVisible:empty(),
    updates:[{date:"2026-10-22",weather:"虹"}]};
  const r=await runRequest(request,{fetchFn:m.fake,adminKey:"test-only"});
  assert.equal(r.code,"stale-comparison");
  assert.equal(m.calls.length,0);
});
test("no-change skips the authenticated weekly write",async()=>{
  const m=mockApi({rows:[{baseDate:BASE,weeks:{...empty(),week1:["虹"]}}],write:false});
  const request={type:"save",baseDate:BASE,readAt:new Date().toISOString(),
    expected:{...empty(),week1:["虹"]},expectedVisible:{...empty(),week1:["虹"]},
    updates:[{date:"2026-10-22",weather:"虹"}]};
  const result=await runRequest(request,{fetchFn:m.fake});
  assert.equal(result.status,"no-change");
});
test("nonowner issue cannot read, cannot save and does not generate a comment",async()=>{
  const m=mockApi({write:false});
  const ev={action:"opened",issue:{...validIssue(read),user:{login:"intruder"}}};
  const r=await runEvent(ev,{GITHUB_REPOSITORY:"sg-log/heartopia-daily",GITHUB_REPOSITORY_OWNER:"sg-log"},m.fake);
  assert.deepEqual(r,{ignored:true});
  assert.equal(m.comments.length,0);
});
test("owner's read issue leaves machine-readable snapshot in GitHub comment",async()=>{
  const m=mockApi({write:false});
  const ev={action:"opened",issue:validIssue(read)};
  const r=await runEvent(ev,{GITHUB_REPOSITORY:"sg-log/heartopia-daily",
    GITHUB_REPOSITORY_OWNER:"sg-log",GITHUB_TOKEN:"fake-token"},m.fake);
  assert.equal(r.ok,true);
  assert.equal(r.type,"read");
  assert.equal(m.comments.length,1);
  assert.match(m.comments[0],/HEARTOPIA_WEEKLY_CHAT_RESULT_V1/);
  assert.match(m.comments[0],/checkedAt/);
});
