// Input comes from the existing exact-post, image-verified review pipeline.
// Keep the returned evidence private. This module neither fetches nor publishes it.
const coarse = {clear:'晴',cloud:'晴',rain:'雨',sunshower:'雨',rainbow:'虹',meteor:'流星群',heat:'猛暑',snow:'雪',petal:'桜',aurora:'オーロラ'};
const validWeather = new Set(Object.values(coarse));
const signature = values => [...new Set(values)].sort().join(',');
const dateAt = (date, hours) => new Date(Date.parse(`${date}T00:00:00Z`)+hours*3600000).toISOString().slice(0,10);

export function compareCalendarWithImageReviews(calendar, records, targetDate) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(targetDate) || !Array.isArray(calendar?.days) || !calendar?.types || !Array.isArray(records)) throw Error('Invalid comparison input');
  const checks=[], skipped=[], seenAuthors=new Set(), seenImages=new Set();
  for (const record of records) {
    const r=record.review, p=r?.interpretation;
    const author=String(record.author || '').toLowerCase();
    const sha=r?.selectedImage?.captureSha256;
    if (!author || seenAuthors.has(author) || !/^[a-f0-9]{64}$/.test(sha || '') || seenImages.has(sha)) {skipped.push({reason:'duplicate-or-unidentified-source'});continue;}
    if (r?.ready!==true || p?.ready!==true || r.targetDate!==targetDate || p.observedDate!==targetDate || !['00','06','12','18'].includes(p.startSlot) || p.confidence!=='high' || !Array.isArray(p.slots) || p.slots.length!==5) {
      skipped.push({reason:'date-or-image-unverified'});continue;
    }
    if (!/^https:\/\/(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+\/status|i\/status)\/\d+(?:[?#].*)?$/.test(record.sourceUrl || '')) {skipped.push({reason:'source-url-invalid'});continue;}
    seenAuthors.add(author); seenImages.add(sha);
    for (let i=0;i<5;i++) {
      const slot=p.slots[i];
      if (slot.slot!==`slot${i}` || slot.visible!==true || slot.confidence!=='high' || !Array.isArray(slot.weather) || !slot.weather.length || slot.weather.some(w=>!validWeather.has(w))) continue;
      const absolute=Number(p.startSlot)+i*6, date=dateAt(targetDate,absolute), hour=absolute%24;
      const day=calendar.days.find(d=>d.date===date);
      if (!day || !Array.isArray(day.hours) || day.hours.length!==24) continue;
      const expected=[...new Set(day.hours.slice(hour,hour+6).map(id=>coarse[calendar.types[id]?.category]))];
      // A six-hour image icon cannot verify an hourly mixture or a detailed variant.
      if (expected.length!==1 || !expected[0]) {skipped.push({reason:'hourly-window-not-comparable',date,hour});continue;}
      const actual=signature(slot.weather), wanted=signature(expected);
      checks.push({date,hour,match:actual===wanted,expected:wanted,observed:actual,author,sourceUrl:record.sourceUrl,imageSha256:sha});
    }
  }
  const conflicts=checks.filter(c=>!c.match), groups=new Map();
  for (const c of conflicts) {
    const key=`${c.date}:${c.hour}:${c.observed}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(c);
  }
  const confirmed=[...groups.values()].filter(g=>new Set(g.map(c=>c.author)).size>=2 && new Set(g.map(c=>c.imageSha256)).size>=2).flat();
  return {status:confirmed.length?'mismatch':conflicts.length?'needs-corroboration':checks.length?'matched':'unchecked',
    notify:confirmed.length>0, comparedCells:checks.length, independentAuthors:new Set(checks.map(c=>c.author)).size,
    conflicts, confirmedConflicts:confirmed, checks, skipped};
}
