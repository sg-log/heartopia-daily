(function(root) {
  'use strict';
  const icons={clear:'☀️',cloud:'☁️',heat:'🔥',petal:'🌸',meteor:'🌠',aurora:'🌌',sunshower:'🌦️',rain:'🌧️',snow:'❄️',rainbow:'🌈'};
  const creditUrl='https://heartopia.th.gl/forecast',cacheKey='heartopiaWeatherToday:v2';
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let snapshot=null,fiveSnapshot=null,enabled=false;
  function jst(now){const d=new Date(new Date(now).getTime()+9*3600000);return {date:d.toISOString().slice(0,10),hour:d.getUTCHours()};}
  function gameDate(now){const t=jst(now);return new Date(Date.parse(t.date+'T00:00:00Z')-(t.hour<6?86400000:0)).toISOString().slice(0,10);}
  function validFive(s){
    if(s?.version!==1||s.timeZone!=='Asia/Tokyo'||!/^20\d{2}-\d{2}-\d{2}$/.test(s.gameDate)||!Number.isFinite(Date.parse(s.gameDate+'T00:00:00Z'))||!Number.isFinite(Date.parse(s.checkedAt))||!Array.isArray(s.slots)||s.slots.length!==5)return false;
    return s.slots.every((p,i)=>{const d=new Date(Date.parse(s.gameDate+'T00:00:00Z')+[6,12,18,24,30][i]*3600000);return p.date===d.toISOString().slice(0,10)&&p.hour===d.getUTCHours()&&icons[p.category]&&typeof p.label==='string'&&p.label.length>0&&p.label.length<=40;});
  }
  function currentFive(s,now){return validFive(s)&&s.gameDate===gameDate(now);}
  function preferred(now){return currentFive(fiveSnapshot,now)?fiveSnapshot:snapshot;}
  function valid(s){
    return s?.version===2&&s.timeZone==='Asia/Tokyo'&&/^20\d{2}-\d{2}-\d{2}$/.test(s.date)&&Number.isFinite(Date.parse(s.checkedAt))&&
      Array.isArray(s.hours)&&s.hours.length>0&&s.hours.length<=24&&s.hours.every((h,i)=>Number.isInteger(h.hour)&&h.hour>=0&&h.hour<24&&
        (!i||h.hour===s.hours[i-1].hour+1)&&icons[h.category]&&typeof h.label==='string'&&h.label.length<=40);
  }
  function current(s,now){const t=jst(now);return valid(s)&&s.date===t.date?s.hours.find(h=>h.hour===t.hour)||null:null;}
  function intervals(s,now){
    const t=jst(now),groups=[];if(!valid(s)||s.date!==t.date)return groups;
    for(const h of s.hours.filter(h=>h.hour>=t.hour)){
      const last=groups.at(-1),icon=h.category==='clear'&&(h.hour<6||h.hour>=18)?'🌙':icons[h.category];
      if(last&&last.label===h.label&&last.icon===icon)last.end=h.hour+1;
      else groups.push({start:h.hour,end:h.hour+1,label:h.label,icon});
    }
    return groups;
  }
  const creditHtml=()=>`<p class="weatherAttribution">時間別予報：<a href="${creditUrl}" target="_blank" rel="noopener noreferrer" title="翌日以降の時間別予報（TH.GL）">Weather forecast by TH.GL</a></p>`;
  function fixedSlots(s,now){
    const t=jst(now),base=new Date(t.date+'T00:00:00Z');
    if(t.hour<6)base.setUTCDate(base.getUTCDate()-1);
    const active=t.hour<6?3:Math.floor((t.hour-6)/6);
    if(currentFive(s,now))return s.slots.map((p,i)=>({...p,current:i===active,sampleHour:p.hour,icon:p.category==='clear'&&(p.hour<6||p.hour>=18)?'🌙':icons[p.category]}));
    return [6,12,18,24,30].map((offset,i)=>{
      const point=new Date(base.getTime()+offset*3600000),date=point.toISOString().slice(0,10),hour=point.getUTCHours();
      // The highlighted block shows the current hour, not a guessed past forecast.
      const sampleHour=i===active?t.hour:hour;
      const h=valid(s)&&s.date===t.date&&date===t.date&&sampleHour>=t.hour?s.hours.find(value=>value.hour===sampleHour):null;
      return {date,hour,current:i===active,sampleHour:h?sampleHour:null,
        icon:h?(h.category==='clear'&&(sampleHour<6||sampleHour>=18)?'🌙':icons[h.category]):'—',
        label:h?(h.category==='meteor'?'流星':h.label==='晴'?'晴れ':h.label):''};
    });
  }
  function slotRowsHtml(s,now){
    if(!current(s,now)&&!currentFive(s,now))return '';
    const old=new Date(now)-Date.parse(s.checkedAt)>72*3600000;
    return `<div class="weatherNow"><div class="weatherSlotList weatherHourlySlots">${fixedSlots(s,now).map(g=>{
      const start=String(g.hour).padStart(2,'0');
      const detail=g.sampleHour===null?'予報データなし':validFive(s)?'6時間帯の予報 '+g.label:String(g.sampleHour).padStart(2,'0')+':00時点の予報 '+g.label;
      return `<div class="weatherLine${g.current?' current':''}"${g.current?' aria-current="time"':''} title="日本時間 ${escape(g.date)} ${start}:00 / ${escape(detail)}">
        <div class="weatherLineTime">${start}</div><div class="weatherLineText">${g.icon}</div><div class="weatherLineLabel">${escape(g.label)}</div>
      </div>`;
    }).join('')}</div></div>${old?'<p class="small">保存済みの予報を表示しています。</p>':''}`;
  }
  function publicHtml(s,now){const rows=slotRowsHtml(s,now);return rows?rows+creditHtml(s):'';}
  const slotsHtml=(now=new Date())=>slotRowsHtml(preferred(now),now);
  function html(now=new Date()){return publicHtml(preferred(now),now)||`<p class="small">今日の時間別予報を取得できませんでした。</p>${creditHtml()}`;}
  function start(options){
    let busy=false,clock='';
    try{const s=JSON.parse(localStorage.getItem(cacheKey));if(valid(s)&&s.date===jst(new Date()).date){snapshot=s;enabled=true;}}catch(_){}
    try{const s=JSON.parse(localStorage.getItem('heartopiaWeatherFive:v1'));if(currentFive(s,new Date())){fiveSnapshot=s;enabled=true;}}catch(_){}
    try{localStorage.removeItem('heartopiaWeatherCalendar:v1');}catch(_){}
    const changed=()=>{options.onChange?.();};
    async function load(){
      if(busy)return;busy=true;
      try{
        const url=new URL(options.apiUrl);url.searchParams.set('action','getWeatherCalendar');
        const response=await fetch(url,{cache:'no-store'}),r=await response.json();if(!response.ok||r.ok!==true)throw Error('load');
        enabled=r.enabled===true;
        if(r.fiveSlots===null){fiveSnapshot=null;try{localStorage.removeItem('heartopiaWeatherFive:v1');}catch(_){}}
        else if(r.fiveSlots!==undefined){if(!validFive(r.fiveSlots))throw Error('five-schema');fiveSnapshot=r.fiveSlots;try{localStorage.setItem('heartopiaWeatherFive:v1',JSON.stringify(fiveSnapshot));}catch(_){}}
        if(r.calendar===null){snapshot=null;try{localStorage.removeItem(cacheKey);}catch(_){}}
        else{if(!valid(r.calendar))throw Error('schema');snapshot=r.calendar;try{localStorage.setItem(cacheKey,JSON.stringify(snapshot));}catch(_){}}
      }catch(_){}finally{busy=false;changed();}
    }
    if(options.adminRoute){
      const anchor=document.getElementById('weatherAutomationStatus');
      if(anchor){
        const panel=document.createElement('div');panel.id='weatherCalendarReview';
        panel.innerHTML='<h3>時間別天気の自動反映</h3><p class="small">当日の予報を承認なしで表示します。週間天気はゲーム内UI画像の報告を使います。</p><button type="button" data-status>状態を更新</button> <button type="button" data-refresh>時間別予報を再取得</button><div role="status" data-result></div><div data-comparison></div>';
        anchor.after(panel);const result=panel.querySelector('[data-result]');
        async function review(refresh){
          const buttons=panel.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
          try{
            const r=await options.post({action:refresh?'refreshWeatherCalendar':'getWeatherCalendarStatus',adminKey:options.adminKey()});
            if(r.ok!==true)throw Error(r.error||'取得できませんでした');
            result.textContent=r.enabled===false?'自動取得は無効です。':`時間別予報は承認なしで反映します。${r.calendar?.checkedAt?' 最終取得：'+new Date(r.calendar.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):''}${r.lastError?' 直近の取得に失敗しています。':''}`;
            try{
              const five=await options.post({action:refresh?'refreshWeatherFiveSlots':'getWeatherFiveSlotsStatus',adminKey:options.adminKey()});
              if(five.ok===true){
                const status=refresh?await options.post({action:'getWeatherFiveSlotsStatus',adminKey:options.adminKey()}):five;
                if(status.enabled)result.textContent=`5枠の予報を承認なしで自動反映します。朝8時・夜19時に取得。${status.forecast?.checkedAt?' 最終取得：'+new Date(status.forecast.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):''}${status.comparison?.status==='mismatch'?' 取得先との相違を検出しています。':status.lastError?' 直近の更新に失敗したため保存済み予報を維持しています。':''}`;
              }
            }catch(_){result.textContent+=' 5枠予報の状態を確認できませんでした。';}
            if(r.enabled){const legacy=document.getElementById('runWeatherAutomationBtn');if(legacy){legacy.disabled=true;legacy.textContent='旧・今日の天気収集は停止中';}}
            const comparison=panel.querySelector('[data-comparison]');comparison.replaceChildren();
            if(r.comparison){
              const labels={matched:'照合した範囲は一致',unchecked:'画像未取得・未照合','needs-corroboration':'別の画像による確認待ち',mismatch:'複数画像で相違を確認'};
              const p=document.createElement('p');p.textContent=`SNS照合：${labels[r.comparison.status]||'未確認'}（${r.comparison.date}）`;comparison.append(p);
              for(const sha256 of r.comparison.evidenceHashes||[]){
                try{const image=await options.post({action:'getWeatherComparisonEvidence',adminKey:options.adminKey(),sha256});
                  if(image.ok&&['image/png','image/jpeg'].includes(image.mimeType)){const img=document.createElement('img');img.alt='照合に使ったゲーム内UI画像';img.style.maxWidth='100%';img.src=`data:${image.mimeType};base64,${image.bodyBase64}`;comparison.append(img);}}
                catch(_){}
              }
            }
            if(refresh)await load();
          }catch(e){result.textContent=e.message;}finally{buttons.forEach(b=>b.disabled=false);}
        }
        panel.querySelector('[data-status]').onclick=()=>review(false);panel.querySelector('[data-refresh]').onclick=()=>review(true);
      }
    }
    changed();load();
    setInterval(()=>{const t=jst(new Date()),next=t.date+':'+t.hour;if(clock!==next){clock=next;changed();if(fiveSnapshot?!currentFive(fiveSnapshot,new Date()):!snapshot||snapshot.date!==t.date)load();}},30000);
    setInterval(()=>{if(!document.hidden)load();},30*60000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
  }
  root.HeartopiaCalendar={jst,gameDate,valid,validFive,current,intervals,fixedSlots,publicHtml,html,slotsHtml,creditHtml,active:()=>enabled&&(currentFive(fiveSnapshot,new Date())||Boolean(current(snapshot,new Date()))),start};
})(typeof globalThis==='object'?globalThis:this);
