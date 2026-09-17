from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once('tools/weather-unified-review.mjs', """  const candidates = attempts.filter(item => {
    const slots = Array.isArray(item?.slots) ? item.slots : [];
    return slots.length === 5 && slots.every(slot => slot?.value && slot?.confidence !== 'low');
  });""", """  const candidates = attempts.filter(item => {
    const slots = Array.isArray(item?.slots) ? item.slots : [];
    const visualStart = inferStartSlotFromMappings([item?.ocr?.times || []]);
    return slots.length === 5 &&
      slots.every(slot => slot?.value && slot?.confidence !== 'low') &&
      visualStart?.startSlot === supplement.startSlot;
  });""")

replace_once('tools/weather-unified-review.mjs', """  const media = capture.rawMedia.find(item => String(item?.file || '') === String(best.file || ''));
  if (!media?.file || !media?.mimeType || !media?.sha256) return daily;""", """  const media = capture.rawMedia.find(item => String(item?.file || '') === String(best.file || ''));
  if (!media?.file || !media?.mimeType || !media?.sha256) return daily;
  if (capture.adapter === 'x-official-embed' && media.sourceScope !== 'exact-status') return daily;""")

replace_once('tools/weather-deterministic-review.mjs', """    const panelCandidates = [];
    for (const media of capture.rawMedia.slice(0, 4)) {""", """    const panelCandidates = [];
    const reviewMedia = capture.adapter === 'x-official-embed'
      ? capture.rawMedia.filter(media => media?.sourceScope === 'exact-status')
      : capture.rawMedia;
    if (!reviewMedia.length) {
      return { schemaVersion:1, ready:false, targetDate, selectedImage:null, interpretation:{ready:false,observedDate:targetDate,startSlot:null,slots:Array.from({length:5},(_,i)=>({slot:`slot${i}`,visible:false,weather:[],confidence:'low',description:''})),confidence:'low',summary:'対象投稿そのものの天気UI画像を確認できませんでした。',unresolved:['対象投稿に属する天気UI画像が取得できませんでした']}, diagnostics:{postDates:dates,reason:'exactStatusMediaMissing'} };
    }
    for (const media of reviewMedia.slice(0, 4)) {""")

marker = """    // Some official X embeds render the post image correctly but do not expose a
    // downloadable pbs.twimg.com URL."""
insertion = """    // Capture rendered media links that belong to this exact status before any
    // quoted/replied status media can be considered authoritative evidence.
    const exactStatusMedia = [];
    const exactStatusMediaLinks = frame.locator(`a[href*="/status/${post.sourceId}/photo/"], a[href*="/status/${post.sourceId}/video/"]`);
    const exactStatusCount = Math.min(await exactStatusMediaLinks.count(), 12);
    const seenExactStatusHrefs = new Set();
    for (let index = 0; index < exactStatusCount; index += 1) {
      const target = exactStatusMediaLinks.nth(index);
      const href = String(await target.getAttribute("href").catch(() => "") || "");
      if (!href || seenExactStatusHrefs.has(href)) continue;
      const box = await target.boundingBox().catch(() => null);
      if (!box || box.width < 120 || box.height < 100) continue;
      seenExactStatusHrefs.add(href);
      await target.scrollIntoViewIfNeeded();
      const file = `status-media-${exactStatusMedia.length}.jpg`;
      const filePath = path.join(outputDir, file);
      await target.screenshot({ path: filePath, type: "jpeg", quality: 92, animations: "disabled" });
      let byteSize = (await stat(filePath)).size;
      if (byteSize > MAX_EVIDENCE_BYTES) {
        await target.screenshot({ path: filePath, type: "jpeg", quality: 70, animations: "disabled" });
        byteSize = (await stat(filePath)).size;
      }
      if (byteSize > MAX_EVIDENCE_BYTES) continue;
      exactStatusMedia.push({
        url: post.sourceUrl,
        file,
        mimeType: "image/jpeg",
        byteSize,
        sha256: await sha256File(filePath),
        sourceScope: "exact-status",
        renderedFallback: true,
        renderedFrom: "exact-status-media-link",
        statusMediaHref: href
      });
      if (exactStatusMedia.length >= 4) break;
    }
    if (exactStatusMedia.length) rawMedia.unshift(...exactStatusMedia);

""" + marker
replace_once('tools/weather-x-embed-evidence.mjs', marker, insertion)

replace_once('tools/test-weather-unified-review.mjs', """        file:'raw-media-0.jpg', highCount:0,
        slots:Array.from({length:5},()=>({value:'晴',confidence:'medium',bestScore:.67,margin:.16}))""", """        file:'status-media-0.jpg', highCount:0,
        slots:Array.from({length:5},()=>({value:'晴',confidence:'medium',bestScore:.67,margin:.16})),
        ocr:{ times:['06','12','','00',''] }""")
replace_once('tools/test-weather-unified-review.mjs', """  const capture = { rawMedia:[{file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:'a'.repeat(64)}] };""", """  const capture = { adapter:'x-official-embed', rawMedia:[{file:'status-media-0.jpg',mimeType:'image/jpeg',sha256:'a'.repeat(64),sourceScope:'exact-status'}] };""")
anchor = """  assert.equal(recoverVisualDailyWithTextStartSlot(incomplete, '06:00～翌05:59　晴れ', capture).ready, false);
});"""
extra = """  assert.equal(recoverVisualDailyWithTextStartSlot(incomplete, '06:00～翌05:59　晴れ', capture).ready, false);

  const mapLike = structuredClone(daily);
  mapLike.diagnostics.ocrAttempts[0].ocr = { times:['','','','',''] };
  assert.equal(recoverVisualDailyWithTextStartSlot(mapLike, '06:00～翌05:59　晴れ', capture).ready, false);

  const quotedMedia = structuredClone(capture);
  quotedMedia.rawMedia[0].sourceScope = 'unknown';
  assert.equal(recoverVisualDailyWithTextStartSlot(daily, '06:00～翌05:59　晴れ', quotedMedia).ready, false);
});"""
replace_once('tools/test-weather-unified-review.mjs', anchor, extra)
