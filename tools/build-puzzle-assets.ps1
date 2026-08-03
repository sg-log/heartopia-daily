$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $root "assets/puzzles/source"
$imageDir = Join-Path $root "assets/puzzles/images"
$reviewDir = Join-Path $root "assets/puzzles/review"
$reviewOriginalDir = Join-Path $reviewDir "original-images"
$jsonPath = Join-Path $root "assets/puzzles/puzzles.json"
$runnerPath = Join-Path $reviewDir "_webp-runner.html"

New-Item -ItemType Directory -Force -Path $imageDir, $reviewDir, $reviewOriginalDir | Out-Null

$puzzles = Get-Content -Path $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($puzzles.Count -ne 110) { throw "puzzles.json must contain 110 items, got $($puzzles.Count)." }

$pages = @(
  @{File="01.png"; Count=8;  Cols=@(36,224,413,599); Rows=@(18,213)},
  @{File="02.png"; Count=12; Cols=@(36,224,413,602); Rows=@(11,205,398)},
  @{File="03.png"; Count=8;  Cols=@(36,224,412,601); Rows=@(10,207)},
  @{File="04.png"; Count=8;  Cols=@(36,224,413,601); Rows=@(18,211)},
  @{File="05.png"; Count=8;  Cols=@(52,240,428,617); Rows=@(19,211)},
  @{File="06.png"; Count=12; Cols=@(39,227,415,604); Rows=@(18,211,405)},
  @{File="07.png"; Count=12; Cols=@(30,218,407,595); Rows=@(10,204,397)},
  @{File="08.png"; Count=12; Cols=@(34,222,410,599); Rows=@(8,205,398)},
  @{File="09.png"; Count=12; Cols=@(42,229,417,606); Rows=@(10,207,400)},
  @{File="10.png"; Count=12; Cols=@(37,225,414,603); Rows=@(0,193,386)},
  @{File="11.png"; Count=4;  Cols=@(36,224,413,602); Rows=@(20)},
  @{File="12.png"; Count=2;  Cols=@(37,225); Rows=@(20)}
)

$cropSize = 108
$outputSize = 160
$offsetX = 34
$offsetY = 27
$brightOwnedIds = @(
  "puzzle-001", "puzzle-002", "puzzle-004", "puzzle-005", "puzzle-007",
  "puzzle-018", "puzzle-026", "puzzle-039", "puzzle-056", "puzzle-103",
  "puzzle-106"
)
$brightOwnedSet = @{}
foreach ($id in $brightOwnedIds) { $brightOwnedSet[$id] = $true }
$items = New-Object System.Collections.Generic.List[object]
$order = 1
foreach ($page in $pages) {
  for ($i = 0; $i -lt $page.Count; $i++) {
    $row = [Math]::Floor($i / 4)
    $col = $i % 4
    $puzzle = $puzzles[$order - 1]
    $items.Add([PSCustomObject]@{
      id = $puzzle.id
      order = $order
      source = (Join-Path $sourceDir $page.File)
      sourceName = $page.File
      row = $row + 1
      col = $col + 1
      sx = $page.Cols[$col] + $offsetX
      sy = $page.Rows[$row] + $offsetY
      sw = $cropSize
      sh = $cropSize
      out = (Join-Path $imageDir "$($puzzle.id).webp")
      originalOut = (Join-Path $reviewOriginalDir "$($puzzle.id).webp")
      corrected = -not $brightOwnedSet.ContainsKey($puzzle.id)
    })
    $order++
  }
}
if ($items.Count -ne 110) { throw "Crop plan must contain 110 items, got $($items.Count)." }

$chromeCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "Chrome or Edge was not found; cannot encode WebP assets." }

$runnerItemsJson = $items | ConvertTo-Json -Depth 5 -Compress
$runnerHtml = @"
<!doctype html>
<meta charset="utf-8">
<body>loading
<script>
const items = $runnerItemsJson;
const outputSize = $outputSize;
function loadImage(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load " + src));
    img.src = "file:///" + src.replaceAll("\\", "/");
  });
}
(async () => {
  const cache = new Map();
  const results = [];
  for (const item of items) {
    if (!cache.has(item.source)) cache.set(item.source, await loadImage(item.source));
    const img = cache.get(item.source);
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, item.sx, item.sy, item.sw, item.sh, 0, 0, outputSize, outputSize);
    const originalData = canvas.toDataURL("image/webp", 0.92);
    if (item.corrected) {
      const imageData = ctx.getImageData(0, 0, outputSize, outputSize);
      const pixels = imageData.data;
      const gain = 1.36;
      const knee = 238;
      for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          let value = pixels[i + c] * gain;
          if (value > knee) value = knee + (value - knee) * 0.35;
          pixels[i + c] = Math.max(0, Math.min(255, Math.round(value)));
        }
      }
      ctx.putImageData(imageData, 0, 0);
    }
    results.push({
      id:item.id,
      order:item.order,
      corrected:Boolean(item.corrected),
      data:canvas.toDataURL("image/webp", 0.92),
      originalData
    });
  }
  document.body.textContent = "PUZZLE_WEBP_JSON_START\n" + JSON.stringify(results) + "\nPUZZLE_WEBP_JSON_END";
})().catch(error => {
  document.body.textContent = "PUZZLE_WEBP_ERROR\n" + error.stack;
});
</script>
</body>
"@
Set-Content -Path $runnerPath -Value $runnerHtml -Encoding UTF8

$runnerUri = ([Uri](Resolve-Path $runnerPath).Path).AbsoluteUri
$dumpPath = Join-Path $reviewDir "_webp-dump.html"
& $chrome --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files --virtual-time-budget=50000 --dump-dom $runnerUri | Set-Content -Path $dumpPath -Encoding UTF8
$dumpText = Get-Content -Path $dumpPath -Raw -Encoding UTF8
if ($dumpText -notmatch "(?s)PUZZLE_WEBP_JSON_START\s*(.*?)\s*PUZZLE_WEBP_JSON_END") {
  throw "Chrome WebP generation failed. Output: $($dumpText.Substring(0, [Math]::Min(1000, $dumpText.Length)))"
}
$resultJson = [System.Net.WebUtility]::HtmlDecode($Matches[1])
$webps = $resultJson | ConvertFrom-Json
foreach ($item in $webps) {
  $target = Join-Path $imageDir "$($item.id).webp"
  $base64 = $item.data -replace '^data:image/webp;base64,', ''
  [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($base64))
  $originalTarget = Join-Path $reviewOriginalDir "$($item.id).webp"
  $originalBase64 = $item.originalData -replace '^data:image/webp;base64,', ''
  [IO.File]::WriteAllBytes($originalTarget, [Convert]::FromBase64String($originalBase64))
}

$reviewCards = foreach ($p in $puzzles) {
  $plan = $items[[int]$p.order - 1]
  $badge = if ($plan.corrected) { '<span class="badge corrected">明るさ補正</span>' } else { '<span class="badge unchanged">無補正</span>' }
  @"
    <article class="puzzle-card">
      <img src="../images/$($p.id).webp" alt="">
      <div class="meta">
        <strong>$($p.order). $([System.Net.WebUtility]::HtmlEncode($p.name))</strong>
        <code>$($p.id)</code>
        <span>$($plan.sourceName) / row $($plan.row), col $($plan.col)</span>
        $badge
      </div>
    </article>
"@
}
$reviewHtml = @"
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heartopia Daily Puzzle Review</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f4ee;color:#2c2925}
header{position:sticky;top:0;background:#fffdf8;border-bottom:1px solid #ded5c8;padding:14px 18px;z-index:2}
h1{font-size:20px;margin:0 0 4px}
p{margin:0;color:#71685e;font-size:13px}
main{padding:18px;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.puzzle-card{background:#fff;border:1px solid #dfd3c3;border-radius:8px;padding:10px;display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;align-items:center}
.puzzle-card img{width:72px;height:72px;object-fit:cover;border-radius:6px;background:#f2eadf}
.meta{display:grid;gap:4px;min-width:0}
.meta strong{font-size:13px;line-height:1.25}
.meta code{font-size:12px;color:#80643f}
.meta span{font-size:11px;color:#81776d}
.badge{width:max-content;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:700}
.badge.corrected{background:#e7f0ea;color:#3f6d52}
.badge.unchanged{background:#f2eadf;color:#80643f}
</style>
</head>
<body>
<header>
  <h1>Heartopia Daily Puzzle Review</h1>
  <p>order / image / puzzle name / ID. Corrected images are marked. Generated from assets/puzzles/puzzles.json.</p>
</header>
<main>
$($reviewCards -join "`n")
</main>
</body>
</html>
"@
Set-Content -Path (Join-Path $reviewDir "index.html") -Value $reviewHtml -Encoding UTF8

$comparisonCards = foreach ($p in $puzzles) {
  $plan = $items[[int]$p.order - 1]
  $badge = if ($plan.corrected) { "明るさ補正" } else { "無補正" }
  @"
    <article class="compare-card">
      <div class="pair">
        <figure><img src="original-images/$($p.id).webp" alt=""><figcaption>before</figcaption></figure>
        <figure><img src="../images/$($p.id).webp" alt=""><figcaption>after</figcaption></figure>
      </div>
      <div class="meta">
        <strong>$($p.order). $([System.Net.WebUtility]::HtmlEncode($p.name))</strong>
        <code>$($p.id)</code>
        <span>$badge / $($plan.sourceName) row $($plan.row), col $($plan.col)</span>
      </div>
    </article>
"@
}
$comparisonHtml = @"
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heartopia Daily Puzzle Brightness Compare</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f4ee;color:#2c2925}
header{position:sticky;top:0;background:#fffdf8;border-bottom:1px solid #ded5c8;padding:14px 18px;z-index:2}
h1{font-size:20px;margin:0 0 4px}
p{margin:0;color:#71685e;font-size:13px}
main{padding:18px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.compare-card{background:#fff;border:1px solid #dfd3c3;border-radius:8px;padding:10px;display:grid;gap:9px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
figure{margin:0;display:grid;gap:4px}
figure img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:#f2eadf}
figcaption{font-size:11px;color:#81776d;text-transform:uppercase;letter-spacing:.06em}
.meta{display:grid;gap:4px;min-width:0}
.meta strong{font-size:13px;line-height:1.25}
.meta code{font-size:12px;color:#80643f}
.meta span{font-size:11px;color:#81776d}
</style>
</head>
<body>
<header>
  <h1>Heartopia Daily Puzzle Brightness Compare</h1>
  <p>Before uses the original crop. After uses the current production image.</p>
</header>
<main>
$($comparisonCards -join "`n")
</main>
</body>
</html>
"@
Set-Content -Path (Join-Path $reviewDir "comparison.html") -Value $comparisonHtml -Encoding UTF8

Remove-Item -LiteralPath $runnerPath -Force
Remove-Item -LiteralPath $dumpPath -Force
Write-Host "Generated $($webps.Count) WebP files, review/index.html, and review/comparison.html"
