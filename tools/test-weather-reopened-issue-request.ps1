$ErrorActionPreference = 'Stop'
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Write-TestJson($Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
}
function New-ReopenedEvent($Title, $Body) {
    [ordered]@{
        action='reopened'; repository=[ordered]@{full_name='sg-log/heartopia-daily'}
        sender=[ordered]@{login='sg-log'}
        issue=[ordered]@{number=16;state='open';title=$Title;body=$Body;author_association='OWNER';user=[ordered]@{login='sg-log'}}
    }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-reopened-request-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $eventPath = Join-Path $root 'event.json'
    $normalizedPath = Join-Path $root 'normalized.json'
    $outputPath = Join-Path $root 'output.txt'
    $env:GITHUB_OUTPUT = $outputPath

    $discovery = [ordered]@{schemaVersion=1;requestType='weather-public-discovery';targetDate='2026-09-15'}
    Write-TestJson $eventPath (New-ReopenedEvent '[weather-discovery-request]' ($discovery | ConvertTo-Json -Compress))
    & "$PSScriptRoot/weather-discovery-issue-request.ps1" -EventPath $eventPath -NormalizedPath $normalizedPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $outputPath -Encoding UTF8)
    Assert ($outputs -contains 'target_date=2026-09-15') 'Reopened fixed discovery issue is accepted'

    Clear-Content -LiteralPath $outputPath
    $capture = [ordered]@{schemaVersion=1;requestType='weather-evidence-capture';adapter='x-official-embed';sourceUrl='https://x.com/i/status/2099613608590381418'}
    Write-TestJson $eventPath (New-ReopenedEvent '[weather-capture-request]' ($capture | ConvertTo-Json -Compress))
    & "$PSScriptRoot/weather-issue-request.ps1" -Mode Capture -EventPath $eventPath -NormalizedPath $normalizedPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $outputPath -Encoding UTF8)
    Assert ($outputs -contains 'request_kind=capture') 'Reopened fixed capture issue is accepted'

    Clear-Content -LiteralPath $outputPath
    $sha = '63807b56ba4c7ac54edf3a8865db879c1e7e5251a67c16f1000fdd21fe2e5c22'
    $review = [ordered]@{
        schemaVersion=4
        artifact=[ordered]@{runId='34929955618';id='10381491521';name='weather-x-embed-evidence-34929955618'}
        reviewedImages=@([ordered]@{file='evidence.jpg';mimeType='image/jpeg';captureSha256=$sha})
        pendingEvidenceFile='evidence.jpg'
        interpretation=[ordered]@{
            ready=$true;observedDate='2026-09-15';startSlot='06';confidence='high';summary='Visible';unresolved=@()
            slots=@(
                [ordered]@{slot='slot0';visible=$true;weather=@('晴');confidence='high';description='06'},
                [ordered]@{slot='slot1';visible=$true;weather=@('晴');confidence='high';description='12'},
                [ordered]@{slot='slot2';visible=$true;weather=@('晴');confidence='high';description='18'},
                [ordered]@{slot='slot3';visible=$true;weather=@('晴');confidence='high';description='00'},
                [ordered]@{slot='slot4';visible=$true;weather=@('晴');confidence='high';description='06'}
            )
        }
    }
    Write-TestJson $eventPath (New-ReopenedEvent '[weather-review-result]' ($review | ConvertTo-Json -Depth 30 -Compress))
    & "$PSScriptRoot/weather-issue-request.ps1" -Mode Review -EventPath $eventPath -NormalizedPath $normalizedPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $outputPath -Encoding UTF8)
    Assert ($outputs -contains 'request_kind=review') 'Reopened fixed review issue is accepted'

    'PASS: one closed weather issue can be safely reopened for discovery, capture, and review'
} finally {
    $env:GITHUB_OUTPUT = $null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
