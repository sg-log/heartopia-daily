from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# 1) Search embedded screenshots for the actual game weather panel instead of assuming
#    the entire source image is the panel.
replace_once('tools/weather-deterministic-review.mjs',
"""      if(Math.abs(width/height-targetAspect)<=.18)add(0,0,width,height,'whole-image');
      for(const hf of [.72,.75,.78,.81]){const h=height*hf,w=h*targetAspect;for(const tf of [.07,.10,.12,.14])for(const rf of [.03,.055,.08,.105])add(width-width*rf-w,height*tf,w,h,'right-panel-search');}""",
"""      if(Math.abs(width/height-targetAspect)<=.18)add(0,0,width,height,'whole-image');
      for(const wf of [.72,.80,.88,.94]){const w=width*wf,h=w/targetAspect;if(h<=height*.90){for(const tf of [.01,.04,.07,.10,.13,.16,.20,.24,.28,.32,.36,.40,.44,.48,.52])for(const cf of [.46,.50,.54])add(width*cf-w/2,height*tf,w,h,'embedded-panel-search');}}
      for(const hf of [.72,.75,.78,.81]){const h=height*hf,w=h*targetAspect;for(const tf of [.07,.10,.12,.14])for(const rf of [.03,.055,.08,.105])add(width-width*rf-w,height*tf,w,h,'right-panel-search');}""")

# 2) Prefer actual weather-slot evidence scores. Geometry is only a tie breaker.
replace_once('tools/weather-deterministic-review.mjs',
"""    const rankedPanels=[...allCoarse,...refined]
      .sort((a,b)=>geometryAnchorV2(a)-geometryAnchorV2(b)||b.highCount-a.highCount||b.okCount-a.okCount||b.minMargin-a.minMargin||b.avg-a.avg);""",
"""    const rankedPanels=[...allCoarse,...refined]
      .sort((a,b)=>b.highCount-a.highCount||b.okCount-a.okCount||b.minMargin-a.minMargin||b.avg-a.avg||geometryAnchorV2(a)-geometryAnchorV2(b));""")

# 3) For X, review the cryptographically captured official embed screenshot too.
replace_once('tools/weather-deterministic-review.mjs',
"""    const panelCandidates = [];
    for (const media of capture.rawMedia.slice(0, 4)) {""",
"""    const panelCandidates = [];
    const reviewMedia = [...capture.rawMedia.slice(0, 4)];
    if (capture.evidence?.file && capture.evidence?.sha256 && capture.evidence?.mimeType && !reviewMedia.some(item => item?.file === capture.evidence.file)) {
      reviewMedia.push({ file:capture.evidence.file, sha256:capture.evidence.sha256, mimeType:capture.evidence.mimeType, sourceScope:'verified-embed' });
    }
    for (const media of reviewMedia.slice(0, 6)) {""")
replace_once('tools/weather-deterministic-review.mjs',
"""    panelCandidates.sort((a,b)=>a.geometryDistance-b.geometryDistance||b.panel.highCount-a.panel.highCount||b.panel.okCount-a.panel.okCount||b.panel.minMargin-a.panel.minMargin||b.panel.avg-a.panel.avg);""",
"""    panelCandidates.sort((a,b)=>b.panel.highCount-a.panel.highCount||b.panel.okCount-a.panel.okCount||b.panel.minMargin-a.panel.minMargin||b.panel.avg-a.panel.avg||a.geometryDistance-b.geometryDistance);""")

# 4) Never let X raw media (quote/reply/event/map images) become a text-assisted daily
#    result unless it is explicitly scoped to the exact status and has visual time labels.
replace_once('tools/weather-unified-review.mjs',
"""  const candidates = attempts.filter(item => {
    const slots = Array.isArray(item?.slots) ? item.slots : [];
    return slots.length === 5 && slots.every(slot => slot?.value && slot?.confidence !== 'low');
  });""",
"""  const candidates = attempts.filter(item => {
    const slots = Array.isArray(item?.slots) ? item.slots : [];
    const visualStart = inferStartSlotFromMappings([item?.ocr?.times || item?.ocr?.mapped || []]);
    return slots.length === 5 &&
      slots.every(slot => slot?.value && slot?.confidence !== 'low') &&
      visualStart?.startSlot === supplement.startSlot;
  });""")
replace_once('tools/weather-unified-review.mjs',
"""  const media = capture.rawMedia.find(item => String(item?.file || '') === String(best.file || ''));
  if (!media?.file || !media?.mimeType || !media?.sha256) return daily;""",
"""  const media = capture.rawMedia.find(item => String(item?.file || '') === String(best.file || ''));
  if (!media?.file || !media?.mimeType || !media?.sha256) return daily;
  if (capture.adapter === 'x-official-embed' && media.sourceScope !== 'exact-status') return daily;""")

# 5) The older direct-panel fast path must not accept arbitrary X media.
replace_once('tools/weather-direct-panel-review.mjs',
"""export async function inspectDirectPanelCapture({captureDir,targetDate,repoRoot='.'}){
  targetDate=normalizeTargetDate(targetDate);repoRoot=path.resolve(repoRoot);const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8')),postText=await readFile(path.join(captureDir,capture.postContent?.file||'post-content.txt'),'utf8');if(capture?.status!=='captured'||!extractPostDates(postText).includes(targetDate)||!Array.isArray(capture.rawMedia)||!capture.rawMedia.length)return buildFailure(targetDate,{reason:'captureOrDateNotReady'});const templates=await loadTemplates(repoRoot),browser=await chromium.launch({headless:true}),attempts=[];
  try{const page=await browser.newPage();for(const media of capture.rawMedia.slice(0,6)){""",
"""export async function inspectDirectPanelCapture({captureDir,targetDate,repoRoot='.'}){
  targetDate=normalizeTargetDate(targetDate);repoRoot=path.resolve(repoRoot);const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8')),postText=await readFile(path.join(captureDir,capture.postContent?.file||'post-content.txt'),'utf8');if(capture?.status!=='captured'||!extractPostDates(postText).includes(targetDate)||!Array.isArray(capture.rawMedia)||!capture.rawMedia.length)return buildFailure(targetDate,{reason:'captureOrDateNotReady'});const directMedia=capture.adapter==='x-official-embed'?capture.rawMedia.filter(media=>media?.sourceScope==='exact-status'):capture.rawMedia;if(!directMedia.length)return buildFailure(targetDate,{reason:'directExactStatusMediaMissing'});const templates=await loadTemplates(repoRoot),browser=await chromium.launch({headless:true}),attempts=[];
  try{const page=await browser.newPage();for(const media of directMedia.slice(0,6)){""")

# 6) Weekly X review: do not inspect arbitrary raw media first; use exact-status media
#    when available and the verified official embed screenshot as the safe fallback.
replace_once('tools/weather-weekly-screenshot-review.mjs',
"""  const candidates=[];
  for(const media of Array.isArray(capture.rawMedia)?capture.rawMedia.slice(0,4):[]) {
    if(media?.file&&media?.sha256&&media?.mimeType) candidates.push({file:media.file,sha256:media.sha256,mimeType:media.mimeType,kind:'raw-media'});
  }
  if(capture.evidence?.file&&capture.evidence?.sha256&&capture.evidence?.mimeType) {""",
"""  const candidates=[];
  const weeklyRaw = Array.isArray(capture.rawMedia) ? (capture.adapter==='x-official-embed' ? capture.rawMedia.filter(media=>media?.sourceScope==='exact-status') : capture.rawMedia) : [];
  for(const media of weeklyRaw.slice(0,4)) {
    if(media?.file&&media?.sha256&&media?.mimeType) candidates.push({file:media.file,sha256:media.sha256,mimeType:media.mimeType,kind:'raw-media'});
  }
  if(capture.evidence?.file&&capture.evidence?.sha256&&capture.evidence?.mimeType) {""")

# 7) Regression: text-assisted recovery now needs visible time-label evidence and X
#    unscoped media must fail closed.
replace_once('tools/test-weather-unified-review.mjs',
"""        file:'raw-media-0.jpg', highCount:0,
        slots:Array.from({length:5},()=>({value:'晴',confidence:'medium',bestScore:.67,margin:.16}))""",
"""        file:'raw-media-0.jpg', highCount:0,
        slots:Array.from({length:5},()=>({value:'晴',confidence:'medium',bestScore:.67,margin:.16})),
        ocr:{ times:['06','12','','00',''] }""")
replace_once('tools/test-weather-unified-review.mjs',
"""  const capture = { rawMedia:[{file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:'a'.repeat(64)}] };""",
"""  const capture = { adapter:'public-url', rawMedia:[{file:'raw-media-0.jpg',mimeType:'image/jpeg',sha256:'a'.repeat(64)}] };""")
replace_once('tools/test-weather-unified-review.mjs',
"""  assert.equal(recoverVisualDailyWithTextStartSlot(incomplete, '06:00～翌05:59　晴れ', capture).ready, false);
});""",
"""  assert.equal(recoverVisualDailyWithTextStartSlot(incomplete, '06:00～翌05:59　晴れ', capture).ready, false);

  const mapLike = structuredClone(daily);
  mapLike.diagnostics.ocrAttempts[0].ocr = { times:['','','','',''] };
  assert.equal(recoverVisualDailyWithTextStartSlot(mapLike, '06:00～翌05:59　晴れ', capture).ready, false);

  const xCapture = structuredClone(capture);
  xCapture.adapter = 'x-official-embed';
  assert.equal(recoverVisualDailyWithTextStartSlot(daily, '06:00～翌05:59　晴れ', xCapture).ready, false);
});""")
