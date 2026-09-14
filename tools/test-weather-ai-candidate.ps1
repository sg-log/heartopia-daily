$ErrorActionPreference = 'Stop'
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-ai-candidate-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $evidencePath = Join-Path $root 'evidence.png'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\sun-day.png') -Destination $evidencePath
    $bytes = [IO.File]::ReadAllBytes($evidencePath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $capture = [ordered]@{
        status='captured'; sourceUrl='https://example.org/post/123'; finalUrl='https://example.org/post/123'
        evidence=[ordered]@{mimeType='image/png';byteSize=$bytes.Length;sha256=$hash;kind='screenshot';capturedAt='2026-09-11T06:01:00+09:00'}
    }
    . "$PSScriptRoot/weather-discovery.ps1"
    $discovery = New-WeatherDiscoveryCandidate -DiscoverySource synthetic -SearchQuery 'Heartopia weather' `
        -DiscoveredAt '2026-09-11T06:00:00+09:00' -SourceUrl $capture.sourceUrl
    $discovery = Add-WeatherDiscoveryRetrieval $discovery confirmed '2026-09-11T06:01:00+09:00' $capture.finalUrl 'Synthetic direct capture'
    $interpretation = [ordered]@{
        ready=$true;observedDate='2026-09-11';startSlot='06';confidence='high';summary='All fields visible.';unresolved=@()
        slots=@(
            [ordered]@{slot='slot0';visible=$true;weather=@('晴');confidence='high';description='06 sun'},
            [ordered]@{slot='slot1';visible=$true;weather=@('雨');confidence='high';description='12 rain'},
            [ordered]@{slot='slot2';visible=$true;weather=@('月');confidence='high';description='18 moon'},
            [ordered]@{slot='slot3';visible=$true;weather=@('月');confidence='high';description='00 moon'},
            [ordered]@{slot='slot4';visible=$true;weather=@('晴');confidence='high';description='06 sun'}
        )
    }
    $review = [ordered]@{status='completed';inputSha256=$hash;model='synthetic-model';responseId='resp_synthetic';interpretation=$interpretation}
    $capturePath = Join-Path $root 'capture.json'; $discoveryPath = Join-Path $root 'discovery.json'; $reviewPath = Join-Path $root 'review.json'
    [IO.File]::WriteAllText($capturePath, ($capture | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($discoveryPath, ($discovery | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($reviewPath, ($review | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $candidatePath = Join-Path $root 'candidate.json'; $dryPath = Join-Path $root 'dry.json'
    & "$PSScriptRoot/weather-ai-candidate.ps1" $capturePath $discoveryPath $reviewPath $evidencePath $candidatePath $dryPath | Out-Null
    $candidate = Get-Content -LiteralPath $candidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $dry = Get-Content -LiteralPath $dryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($candidate.hourlyForecast.status -eq 'ready') 'Clear five-slot image becomes ready candidate'
    Assert (($dry.hourlyDryRun.payload.slots.slot0 -join ',') -eq '晴') 'slot0 remains sunny'
    Assert (($dry.hourlyDryRun.payload.slots.slot1 -join ',') -eq '雨') 'slot1 remains rain'
    Assert (($dry.hourlyDryRun.payload.slots.slot2 -join ',') -eq '晴' -and ($dry.hourlyDryRun.payload.slots.slot3 -join ',') -eq '晴') 'Night moon maps only at 18/00'
    Assert ($candidate.hourlyForecast.evidence.reviewedImageSha256 -eq $hash) 'Candidate bound to reviewed image hash'
    Assert ($candidate.currentWeather.status -eq 'missing' -and $candidate.weeklyForecast.status -eq 'missing') 'Current and weekly remain excluded'

    $interpretation.ready = $false
    $interpretation.slots[4].visible = $false
    $interpretation.slots[4].weather = @()
    $interpretation.slots[4].confidence = 'low'
    $interpretation.unresolved = @('slot4 cropped')
    [IO.File]::WriteAllText($reviewPath, ($review | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    & "$PSScriptRoot/weather-ai-candidate.ps1" $capturePath $discoveryPath $reviewPath $evidencePath $candidatePath $dryPath | Out-Null
    $candidate = Get-Content -LiteralPath $candidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $dry = Get-Content -LiteralPath $dryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($candidate.hourlyForecast.status -eq 'needsReview' -and $null -eq $dry.hourlyDryRun.payload) 'Cropped slot never becomes ready or payload'
    Assert (($candidate.hourlyForecast.values.slot4.weather | Measure-Object).Count -eq 0) 'Invisible slot is not filled'

    $review.inputSha256 = '0' * 64
    [IO.File]::WriteAllText($reviewPath, ($review | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $failed = $false
    try { & "$PSScriptRoot/weather-ai-candidate.ps1" $capturePath $discoveryPath $reviewPath $evidencePath $candidatePath $dryPath | Out-Null }
    catch { $failed = $true }
    Assert $failed 'Mismatched AI review hash rejected'
    'PASS: AI interpretation bridge, existing candidate dry-run, partial-image fail closed, SHA-256 binding'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
