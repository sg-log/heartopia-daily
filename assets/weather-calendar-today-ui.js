(function(root) {
  'use strict';
  const icons={clear:'☀️',cloud:'☁️',heat:'🔥',petal:'🌸',meteor:'☄️',aurora:'🌌',sunshower:'🌦️',rain:'🌧️',snow:'❄️',rainbow:'🌈'};
  const creditUrl='https://heartopia.th.gl/forecast',cacheKey='heartopiaWeatherToday:v2';
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let snapshot=null,enabled=false;
  function jst(now){const d=new Date(new Date(now).getTime()+9*3600000);return {date:d.toISOString().slice(0,10),hour:d.getUTCHours()};}
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
  const creditHtml=()=>`<p class="small"><a href="${creditUrl}" target="_blank" rel="noopener noreferrer">Weather forecast by TH.GL</a> · <a href="${creditUrl}" target="_blank" rel="noopener noreferrer">翌日以降の時間別予報</a></p>`;
  function publicHtml(s,now){
    const h=current(s,now);if(!h)return '';
    const t=jst(now),groups=intervals(s,now),old=new Date(now)-Date.parse(s.checkedAt)>72*3600000;
    return `<div class="weatherNow"><strong>${groups[0].icon} ${escape(h.label)}</strong> <span class="small">日本時間 ${escape(t.date)} ${String(t.hour).padStart(2,'0')}:00台</span></div>
      <div class="weatherCalendarSlots" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:8px">${groups.map(g=>`<div class="weatherLine"><span class="weatherLineTime">${String(g.start).padStart(2,'0')}:00–${String(g.end).padStart(2,'0')}:00</span><span class="weatherLineText" style="white-space:nowrap">${g.icon} ${escape(g.label)}</span></div>`).join('')}</div>
      <p class="small">今日の時間別予報です。${old?'保存済みの予報を表示しています。':''}</p>${creditHtml()}`;
  }
  function html(now=new Date()){return publicHtml(snapshot,now)||`<p class="small">今日の時間別予報を取得できませんでした。</p>${creditHtml()}`;}
  function start(options){
    let busy=false,clock='';
    try{const s=JSON.parse(localStorage.getItem(cacheKey));if(valid(s)&&s.date===jst(new Date()).date){snapshot=s;enabled=true;}}catch(_){}
    try{localStorage.removeItem('heartopiaWeatherCalendar:v1');}catch(_){}
    const changed=()=>{options.onChange?.();};
    async function load(){
      if(busy)return;busy=true;
      try{
        const url=new URL(options.apiUrl);url.searchParams.set('action','getWeatherCalendar');
        const response=await fetch(url,{cache:'no-store'}),r=await response.json();if(!response.ok||r.ok!==true)throw Error('load');
        enabled=r.enabled===true;
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
    setInterval(()=>{const t=jst(new Date()),next=t.date+':'+t.hour;if(clock!==next){clock=next;changed();if(!snapshot||snapshot.date!==t.date)load();}},30000);
    setInterval(()=>{if(!document.hidden)load();},30*60000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
  }
  root.HeartopiaCalendar={jst,valid,current,intervals,publicHtml,html,active:()=>enabled&&Boolean(current(snapshot,new Date())),start};
})(typeof globalThis==='object'?globalThis:this);
