(function(){
  'use strict';
  const clock=document.getElementById('weatherBirdClock');
  const time=document.getElementById('weatherBirdClockTime');
  const date=document.getElementById('weatherClockDate');
  if(!clock||!time||!date)return;
  const formatter=new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  });
  let timer;
  function update(){
    clearTimeout(timer);
    const now=new Date();
    const p=Object.fromEntries(formatter.formatToParts(now).map(part=>[part.type,part.value]));
    date.textContent=p.month+'/'+p.day+'（'+p.weekday+'）';
    date.dateTime=p.year+'-'+p.month+'-'+p.day;
    time.textContent=p.hour+':'+p.minute;
    time.dateTime=now.toISOString();
    clock.setAttribute('aria-label','日本時間 '+p.hour+'時'+p.minute+'分');
    if(!document.hidden)timer=setTimeout(update,60000-Date.now()%60000+20);
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)clearTimeout(timer);
    else update();
  });
  window.addEventListener('pagehide',()=>clearTimeout(timer));
  window.addEventListener('pageshow',update);
  update();
})();
