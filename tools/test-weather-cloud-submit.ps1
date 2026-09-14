$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-cloud-submit-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $imagePath = Join-Path $root 'evidence.png'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\sun-day.png') -Destination $imagePath
    $artifact = New-WeatherEvidenceImage $imagePath screenshot '2026-09-11T06:01:00+09:00'
    $discovery = New-WeatherDiscoveryCandidate synthetic 'Heartopia weather' '2026-09-11T06:00:00+09:00' 'https://example.org/post/123'
    $discovery = Add-WeatherDiscoveryRetrieval $discovery confirmed '2026-09-11T06:01:00+09:00' $discovery.sourceUrl 'Synthetic direct capture'
    $slots = [ordered]@{}
    foreach ($index in 0..4) { $slots["slot$index"] = @{weather=@('晴');evidence=@('image')} }
    $hourly = @{observedDate='2026-09-11';startSlot='06';values=$slots;evidence=@{image='Synthetic image review';reviewedImageSha256=$artifact.sha256;userConfirmed=$false};status='ready';confidence='high';unresolved=@()}
    $candidate = ConvertTo-WeatherCandidateFromDiscovery $discovery $null $hourly $null
    $capture = @{status='captured';sourceUrl=$candidate.sourceUrl;evidence=@{sha256=$artifact.sha256;byteSize=$artifact.byteSize;mimeType=$artifact.mimeType;kind='screenshot';capturedAt=$artifact.capturedAt}}
    $candidatePath=Join-Path $root 'candidate.json';$capturePath=Join-Path $root 'capture.json';$resultPath=Join-Path $root 'result.json'
    [IO.File]::WriteAllText($candidatePath,($candidate|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($capturePath,($capture|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))

    $global:weatherTestPendingReports=@();$global:weatherTestSubmitCalls=0;$global:weatherTestPrivateCalls=0
    function Invoke-WebRequest {
        param($Uri,$Method,[switch]$UseBasicParsing,$ContentType,$Body,$TimeoutSec)
        $wire=[Text.Encoding]::UTF8.GetString($Body)|ConvertFrom-Json
        if($wire.action -eq 'pending'){$global:weatherTestPrivateCalls++;$data=@{ok=$true;reports=@($global:weatherTestPendingReports)}}
        elseif($wire.action -eq 'weatherEvidence'){$global:weatherTestPrivateCalls++;$data=@{ok=$true;mimeType=$artifact.mimeType;bodyBase64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($imagePath))}}
        elseif($wire.action -eq 'submit'){
            $global:weatherTestSubmitCalls++
            $report=[pscustomobject]@{id='mock-id';date=$wire.date;startSlot=$wire.startSlot;slots=$wire.slots;sourceUrl=$wire.sourceUrl;evidenceStatus='saved';evidenceImages=@(@{sha256=$artifact.sha256})}
            $global:weatherTestPendingReports=@($report)
            $data=@{ok=$true;status='pending';id='mock-id';duplicate=$false}
        } else { throw 'unexpected action' }
        [pscustomobject]@{StatusCode=200;Headers=@{'Content-Type'='application/json'};Content=($data|ConvertTo-Json -Depth 20 -Compress)}
    }
    $env:WEATHER_POST_KEY='synthetic-post';$env:WEATHER_ADMIN_KEY='synthetic-admin'
    & "$PSScriptRoot/weather-cloud-submit.ps1" $candidatePath $capturePath $imagePath $resultPath | Out-Null
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert ($result.stage -eq 'complete' -and $result.pendingRegistered -and $result.sha256Match) 'Mock submit reaches verified pending'
    Assert ($global:weatherTestSubmitCalls -eq 1 -and $global:weatherTestPrivateCalls -eq 3) 'One submit with pending and evidence verification'
    Assert ($null -eq $env:WEATHER_POST_KEY -and $null -eq $env:WEATHER_ADMIN_KEY) 'Secrets cleared from environment'

    $env:WEATHER_POST_KEY='synthetic-post';$env:WEATHER_ADMIN_KEY='synthetic-admin'
    & "$PSScriptRoot/weather-cloud-submit.ps1" $candidatePath $capturePath $imagePath $resultPath | Out-Null
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert ($result.stage -eq 'complete' -and $result.duplicate) 'Existing exact pending is accepted as duplicate'
    Assert ($global:weatherTestSubmitCalls -eq 1) 'Duplicate path never submits again'
    'PASS: cloud submit uses existing transport, exact duplicate skip, pending and evidence SHA-256 verification; all HTTP mocked'
} finally {
    $env:WEATHER_POST_KEY=$null;$env:WEATHER_ADMIN_KEY=$null
    Remove-Variable -Scope Global -Name weatherTestPendingReports,weatherTestSubmitCalls,weatherTestPrivateCalls -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
