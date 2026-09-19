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
    $candidatePath=Join-Path $root 'candidate.json';$capturePath=Join-Path $root 'capture.json';$reviewPath=Join-Path $root 'review.json';$resultPath=Join-Path $root 'result.json';$githubOutput=Join-Path $root 'github-output.txt'
    [IO.File]::WriteAllText($candidatePath,($candidate|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($capturePath,($capture|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    $review=[ordered]@{
        schemaVersion=4
        reviewedImages=@([ordered]@{file='evidence.png';mimeType=$artifact.mimeType;captureSha256=$artifact.sha256})
        pendingEvidenceFile='evidence.png'
        interpretation=[ordered]@{ready=$true;observedDate='2026-09-11';weeklyDays=@()}
    }
    [IO.File]::WriteAllText($reviewPath,($review|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))

    $global:weatherTestPendingReports=@();$global:weatherTestApprovedReports=@();$global:weatherTestSubmitCalls=0;$global:weatherTestPrivateCalls=0
    $global:weatherTestSubmitTimeout=$false;$global:weatherTestPersistOnTimeout=$true
    function Invoke-WebRequest {
        param($Uri,$Method,[switch]$UseBasicParsing,$ContentType,$Body,$TimeoutSec)
        if([string]$Method -eq 'Get' -and [string]$Uri -match 'action=approved'){
            $data=@{ok=$true;reports=@($global:weatherTestApprovedReports)}
        } else {
            $wire=[Text.Encoding]::UTF8.GetString($Body)|ConvertFrom-Json
            if($wire.action -eq 'pending'){$global:weatherTestPrivateCalls++;$data=@{ok=$true;reports=@($global:weatherTestPendingReports)}}
            elseif($wire.action -eq 'approved'){$global:weatherTestPrivateCalls++;$data=@{ok=$true;reports=@($global:weatherTestApprovedReports)}}
            elseif($wire.action -eq 'weatherEvidence'){$global:weatherTestPrivateCalls++;$data=@{ok=$true;mimeType=$artifact.mimeType;bodyBase64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($imagePath))}}
            elseif($wire.action -eq 'submit'){
                $global:weatherTestSubmitCalls++
                $report=[pscustomobject]@{id='mock-id';date=$wire.date;startSlot=$wire.startSlot;slots=$wire.slots;weeks=$wire.weeks;sourceUrl=$wire.sourceUrl;evidenceStatus='saved';evidenceImages=@(@{sha256=$artifact.sha256})}
                if(-not $global:weatherTestSubmitTimeout -or $global:weatherTestPersistOnTimeout){$global:weatherTestPendingReports=@($report)}
                if($global:weatherTestSubmitTimeout){throw [System.TimeoutException]::new('synthetic timeout after server-side commit')}
                $data=@{ok=$true;status='pending';id='mock-id';duplicate=$false}
            } else { throw 'unexpected action' }
        }
        [pscustomobject]@{StatusCode=200;Headers=@{'Content-Type'='application/json'};Content=($data|ConvertTo-Json -Depth 20 -Compress)}
    }
    $env:GITHUB_OUTPUT=$githubOutput;$env:WEATHER_POST_KEY='synthetic-post';$env:WEATHER_ADMIN_KEY='synthetic-admin'
    & "$PSScriptRoot/weather-cloud-submit.ps1" $candidatePath $capturePath $imagePath $resultPath | Out-Null
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert ($result.stage -eq 'complete' -and $result.pendingRegistered -and $result.sha256Match -and $result.reportId -eq 'mock-id') 'Mock submit reaches verified pending and retains report ID'
    $outputs=@(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains 'report_id=mock-id' -and $outputs -contains 'pending_registered=true' -and $outputs -contains 'sha256_match=true') 'Verified submit exports reusable workflow outputs'
    Assert ($global:weatherTestSubmitCalls -eq 1) 'Initial path submits exactly once'
    Assert ($null -eq $env:WEATHER_POST_KEY -and $null -eq $env:WEATHER_ADMIN_KEY) 'Secrets cleared from environment'

    $env:WEATHER_POST_KEY='synthetic-post';$env:WEATHER_ADMIN_KEY='synthetic-admin'
    & "$PSScriptRoot/weather-cloud-submit.ps1" $candidatePath $capturePath $imagePath $resultPath | Out-Null
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert ($result.stage -eq 'complete' -and $result.duplicate -and $result.reportId -eq 'mock-id') 'Existing exact pending is accepted as duplicate and retains report ID'
    Assert ($global:weatherTestSubmitCalls -eq 1) 'Exact pending duplicate never submits again'

    $approvedDuplicate = [pscustomobject]@{
        id='approved-id';date=$global:weatherTestPendingReports[0].date;startSlot=$global:weatherTestPendingReports[0].startSlot
        slots=$global:weatherTestPendingReports[0].slots;weeks=$global:weatherTestPendingReports[0].weeks
        sourceUrl='https://example.org/post/different-source'
    }
    $global:weatherTestPendingReports=@()
    $global:weatherTestApprovedReports=@($approvedDuplicate)
    $env:WEATHER_POST_KEY='synthetic-post';$env:WEATHER_ADMIN_KEY='synthetic-admin'
    & "$PSScriptRoot/weather-cloud-submit.ps1" $candidatePath $capturePath $imagePath $resultPath | Out-Null
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert ($result.stage -eq 'contentDuplicateApproved' -and $result.duplicate -and $result.reportId -eq 'approved-id') 'Same weather content from a different source is skipped when already approved'
    Assert ($global:weatherTestSubmitCalls -eq 1) 'Approved content duplicate never submits a second pending report'

    $global:weatherTestPendingReports=@();$global:weatherTestApprovedReports=@();$global:weatherTestSubmitCalls=0;$global:weatherTestPrivateCalls=0
    $global:weatherTestSubmitTimeout=$true;$global:weatherTestPersistOnTimeout=$true
    Clear-Content -LiteralPath $githubOutput
    $env:WEATHER_POST_KEY='synthetic-post';$env:WEATHER_ADMIN_KEY='synthetic-admin'
    & "$PSScriptRoot/weather-cloud-submit-unified.ps1" $candidatePath $capturePath $imagePath $reviewPath $resultPath | Out-Null
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert ($result.stage -eq 'complete' -and $result.pendingRegistered -and $result.driveSaved -and $result.sha256Match -and $result.reportId -eq 'mock-id') 'Unified submit recovers a server-side pending after an ambiguous network timeout'
    Assert (-not $result.duplicate) 'Recovered timeout is treated as the newly submitted pending'
    Assert ($global:weatherTestSubmitCalls -eq 1) 'Ambiguous timeout never re-POSTs the pending payload'
    Assert (@($global:weatherTestPendingReports).Count -eq 1) 'Ambiguous timeout recovery does not create duplicate pending rows'
    $outputs=@(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains 'report_id=mock-id' -and $outputs -contains 'pending_registered=true' -and $outputs -contains 'drive_saved=true') 'Recovered timeout exports normal success outputs'

    $global:weatherTestPendingReports=@();$global:weatherTestApprovedReports=@();$global:weatherTestSubmitCalls=0;$global:weatherTestPrivateCalls=0
    $global:weatherTestSubmitTimeout=$true;$global:weatherTestPersistOnTimeout=$false
    Clear-Content -LiteralPath $githubOutput
    $env:WEATHER_POST_KEY='synthetic-post';$env:WEATHER_ADMIN_KEY='synthetic-admin'
    $failed=$false
    try { & "$PSScriptRoot/weather-cloud-submit-unified.ps1" $candidatePath $capturePath $imagePath $reviewPath $resultPath | Out-Null } catch { $failed=$true }
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    Assert $failed 'Unified submit still fails when a network timeout did not create a pending'
    Assert ($result.failureCode -eq 'networkError' -and -not $result.pendingRegistered) 'Missing pending after timeout remains a networkError'
    Assert ($global:weatherTestSubmitCalls -eq 1) 'Missing pending after timeout is not retried with another POST'

    $global:weatherTestSubmitTimeout=$false;$global:weatherTestPersistOnTimeout=$true

    'PASS: cloud submit verifies evidence, skips exact source duplicates, and skips identical weather content across pending/approved data; all HTTP mocked'
} finally {
    $env:GITHUB_OUTPUT=$null;$env:WEATHER_POST_KEY=$null;$env:WEATHER_ADMIN_KEY=$null
    Remove-Variable -Scope Global -Name weatherTestPendingReports,weatherTestApprovedReports,weatherTestSubmitCalls,weatherTestPrivateCalls,weatherTestSubmitTimeout,weatherTestPersistOnTimeout -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
