$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-candidate.ps1"

function Assert($condition, $message) {
    if (-not $condition) { throw $message }
}
function New-Sample {
    $slots = [ordered]@{}
    0..4 | ForEach-Object { $slots["slot$_"] = @{ weather = @('晴'); evidence = @('text', 'image') } }
    [pscustomobject]@{
        sourceType = 'x'
        sourceUrl = 'https://x.com/karino_yocchi/status/2097431567232844024'
        sourceId = '2097431567232844024'
        postedAt = '2026-09-09 06:07 (timezone unconfirmed)'
        observedDate = '2026-09-09'
        startSlot = '06'
        slots = $slots
        evidence = @{ text = '1日晴れ'; image = '本文と画像が一致。ユーザーが全体画像で06・12・18・00・翌06の晴を確認。AIは全体未確認。'; userConfirmed = $true }
        confidence = 'high'
        unresolved = @()
        memo = '本文と画像に基づく予報候補。翌06は次ゲーム日の開始。'
    }
}

$sample = New-Sample
$result = ConvertTo-WeatherReportDryRun $sample
Assert ($null -ne $result.payload) 'sample must generate a payload'
0..4 | ForEach-Object { Assert (($result.payload.slots["slot$_"] -join ',') -eq '晴') "slot$_ must be sunny" }
Assert ($result.payload.date -eq '2026-09-09') 'API base date'
Assert ($result.timeline[3].gameDate -eq '2026-09-09') '00 belongs to previous game day'
Assert ($result.timeline[4].gameDate -eq '2026-09-10') 'next 06 begins next game day'
Assert (-not $result.payload.Contains('postKey')) 'no secret field'
Assert ($result.payload.weeks.Count -eq 0) 'weeks must be empty'
$result.payload | ConvertTo-Json -Depth 8

$sample.observedDate = ''
$blocked = ConvertTo-WeatherReportDryRun $sample
Assert ($blocked.status -eq '要確認' -and $null -eq $blocked.payload) 'unknown observation date must block'

$sample = New-Sample
$sample.confidence = 'low'
Assert ($null -eq (ConvertTo-WeatherReportDryRun $sample).payload) 'low confidence must block'
$sample = New-Sample
$sample.slots.slot0.evidence = @('inference')
Assert ($null -eq (ConvertTo-WeatherReportDryRun $sample).payload) 'inference must block'
$sample = New-Sample
$sample.slots.slot2.weather = @('月')
Assert ($null -eq (ConvertTo-WeatherReportDryRun $sample).payload) 'unsupported moon conversion must block'
$sample.slots.slot2.nightSunnyConfirmed = $true
Assert ((ConvertTo-WeatherReportDryRun $sample).payload.slots.slot2[0] -eq '晴') 'supported night moon is sunny'
$sample = New-Sample
$sample.slots.slot3 = $null
Assert ((ConvertTo-WeatherReportDryRun $sample).payload.slots.slot3.Count -eq 0) 'unknown slot stays empty'
$sample = New-Sample
$sample.startSlot = '00'
$midnight = ConvertTo-WeatherReportDryRun $sample
Assert ($midnight.payload.date -eq '2026-09-09') '00 start must keep observed Heartopia game date for API'
Assert ($midnight.timeline[0].calendarTime -eq '2026-09-10 00:00') '00 start calendar timestamp is following midnight'
Assert ($midnight.timeline[0].gameDate -eq '2026-09-09') '00 start retains observation game day'
'PASS: sample, unknown date, low confidence, inference, moon evidence, empty slot, midnight game-date mapping'

function New-SectionSample {
    $slots = [ordered]@{}
    0..4 | ForEach-Object { $slots["slot$_"] = @{ weather = @('晴'); evidence = @('image') } }
    foreach ($key in @('slot2', 'slot3')) {
        $slots[$key].weather = @('月')
        $slots[$key].nightSunnyConfirmed = $true
    }
    [pscustomobject]@{
        sourceType = 'x'; sourceUrl = 'https://example.com/status/section-test'; sourceId = 'section-test'
        postedAt = '2026-09-10 06:08 (timezone unconfirmed)'; memo = '合成テスト。実投稿の再取得ではない。'
        currentWeather = @{ value = '晴'; evidence = @{ image = '右上の晴れを判読。撮影時刻は未確認。' }; status = 'ready'; confidence = 'high'; unresolved = @(); capturedAt = $null }
        hourlyForecast = @{
            observedDate = '2026-09-10'; startSlot = '06'; values = $slots
            evidence = @{ image = '06太陽・12太陽・18月・00月・翌06太陽を判読。月は基準UIの夜晴表示。'; userConfirmed = $false }
            status = 'ready'; confidence = 'high'; unresolved = @()
        }
        weeklyForecast = $null
    }
}
$top = New-SectionSample
$r = ConvertTo-SectionedWeatherReportDryRun $top
Assert ($r.currentWeather.status -eq 'ready' -and $r.hourlyForecast.status -eq 'ready' -and $r.weeklyForecast.status -eq 'missing') 'upper image section states'
Assert ($null -ne $r.hourlyDryRun.payload) 'upper image payload'
0..4 | ForEach-Object { Assert (($r.hourlyDryRun.payload.slots["slot$_"] -join ',') -eq '晴') 'all five sunny slots' }
Assert ($r.hourlyDryRun.payload.weeks.Count -eq 0 -and -not $r.hourlyDryRun.payload.Contains('currentWeather') -and -not $r.hourlyDryRun.payload.Contains('postKey')) 'no current, weekly or key serialization'
'PASS: 1 upper image; hourly payload generated'

$bottom = New-SectionSample
$bottom.currentWeather = $null
$bottom.hourlyForecast = $null
$bottom.weeklyForecast = @{ values = @(@{ weekday = '金曜日'; date = $null; weather = @('雨') }); evidence = @{ image = '金曜の雨を判読' }; status = 'needsReview'; confidence = 'medium'; unresolved = @('曜日の実日付と保存仕様が未確定') }
$r = ConvertTo-SectionedWeatherReportDryRun $bottom
Assert ($r.currentWeather.status -eq 'missing' -and $r.hourlyForecast.status -eq 'missing' -and $r.weeklyForecast.status -eq 'needsReview') 'lower image section states'
Assert ($null -eq $r.hourlyDryRun.payload) 'lower image must not generate hourly payload'
'PASS: 2 lower image; no hourly payload'

$full = New-SectionSample
$full.weeklyForecast = @{ values = @(@{ weekday = '金曜日'; date = '2026-09-11'; weather = @('雨') }); evidence = @{ image = '日付と金曜の雨を確認した合成例' }; status = 'ready'; confidence = 'high'; unresolved = @() }
$r = ConvertTo-SectionedWeatherReportDryRun $full
Assert ($r.currentWeather.status -eq 'ready' -and $r.hourlyForecast.status -eq 'ready' -and $r.weeklyForecast.status -eq 'ready') 'full image independent ready states'
Assert ($r.weeklyForecast.values[0].date -eq '2026-09-11' -and $r.hourlyDryRun.payload.weeks.Count -eq 0) 'weekly facts retained without week mapping'
'PASS: 3 full image; independent sections, weekly retained only'

$post = New-SectionSample
$post.weeklyForecast = $bottom.weeklyForecast
$post.hourlyForecast.evidence.text = '00:00～翌05:59 終日晴れ'
$post.hourlyForecast.evidence.textAmbiguities = @('本文の時間範囲の意図は未解決。画像の時刻・晴れとは明確な矛盾を確認していない。')
$r = ConvertTo-SectionedWeatherReportDryRun $post
Assert ($r.currentWeather.status -eq 'ready' -and $r.hourlyForecast.status -eq 'ready' -and $r.weeklyForecast.status -eq 'needsReview') 'post-like independent states'
Assert ($null -ne $r.hourlyDryRun.payload -and $r.hourlyForecast.evidence.textAmbiguities.Count -eq 1) 'text ambiguity retained without blocking image'
'PASS: 4 post-like image; five hourly slots converted despite weekly review and text ambiguity'

$conflict = New-SectionSample
$conflict.hourlyForecast.unresolved = @('同じ日時の画像は晴、本文は雨で明確に矛盾')
$r = ConvertTo-SectionedWeatherReportDryRun $conflict
Assert ($r.hourlyForecast.status -eq 'needsReview' -and $null -eq $r.hourlyDryRun.payload -and $r.currentWeather.status -eq 'ready') 'explicit conflict blocks only hourly'
Assert ($conflict.hourlyForecast.status -eq 'ready') 'input not mutated'
foreach ($scenario in @('date', 'confidence', 'moon', 'evidence', 'weather', 'source', 'memo')) {
    $bad = New-SectionSample
    switch ($scenario) {
        'date' { $bad.hourlyForecast.observedDate = '' }
        'confidence' { $bad.hourlyForecast.confidence = 'low' }
        'moon' { $bad.hourlyForecast.values.slot2.nightSunnyConfirmed = $false }
        'evidence' { $bad.hourlyForecast.values.slot0.evidence = @('inference') }
        'weather' { $bad.hourlyForecast.values.slot0.weather = @('unknown') }
        'source' { $bad.sourceUrl = '' }
        'memo' { $bad.memo = 'x' * 1001 }
    }
    $r = ConvertTo-SectionedWeatherReportDryRun $bad
    Assert ($null -eq $r.hourlyDryRun.payload -and $r.hourlyForecast.status -eq 'needsReview') "legacy safety: $scenario"
}
$partial = New-SectionSample
$partial.hourlyForecast.values.slot4 = $null
$r = ConvertTo-SectionedWeatherReportDryRun ($partial | ConvertTo-Json -Depth 12 | ConvertFrom-Json)
Assert ($null -ne $r.hourlyDryRun.payload -and $r.hourlyDryRun.payload.slots.slot4.Count -eq 0) 'JSON candidate and unseen slot retained empty'
'PASS: section conflict isolation, immutable input, legacy safety gates, JSON input, partial slots'