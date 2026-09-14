$ErrorActionPreference = 'Stop'
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }

function Write-TestJson($Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
}
function New-TestEvent($Title, $Body) {
    [ordered]@{
        action='opened'; repository=[ordered]@{full_name='sg-log/heartopia-daily'}
        sender=[ordered]@{login='sg-log'}
        issue=[ordered]@{number=123;state='open';title=$Title;body=$Body;author_association='OWNER';user=[ordered]@{login='sg-log'}}
    }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-issue-request-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $eventPath=Join-Path $root 'event.json';$normalizedPath=Join-Path $root 'normalized.json';$outputPath=Join-Path $root 'output.txt'
    $env:GITHUB_OUTPUT=$outputPath
    $capture=[ordered]@{schemaVersion=1;requestType='weather-evidence-capture';adapter='x-official-embed';sourceUrl='https://x.com/example/status/123/photo/1?s=20'}
    Write-TestJson $eventPath (New-TestEvent '[weather-capture-request]' ($capture|ConvertTo-Json -Depth 10 -Compress))
    & "$PSScriptRoot/weather-issue-request.ps1" Capture $eventPath $normalizedPath | Out-Null
    $outputs=@(Get-Content -LiteralPath $outputPath -Encoding UTF8)
    Assert ($outputs -contains 'request_kind=capture' -and $outputs -contains 'adapter=x-official-embed') 'Authorized capture issue routes to X Stage1'
    Assert ($outputs -contains ('source_url=' + $capture.sourceUrl)) 'Validated source URL is exported literally'

    $direct=[ordered]@{schemaVersion=1;requestType='weather-evidence-capture';adapter='direct-url';sourceUrl='https://example.org/weather/post/123'}
    Clear-Content -LiteralPath $outputPath
    Write-TestJson $eventPath (New-TestEvent '[weather-capture-request]' ($direct|ConvertTo-Json -Depth 10 -Compress))
    & "$PSScriptRoot/weather-issue-request.ps1" Capture $eventPath $normalizedPath | Out-Null
    $outputs=@(Get-Content -LiteralPath $outputPath -Encoding UTF8)
    Assert ($outputs -contains 'adapter=direct-url') 'Authorized direct URL issue routes to generic Stage1'
    $direct.sourceUrl='https://127.0.0.1/weather'
    Write-TestJson $eventPath (New-TestEvent '[weather-capture-request]' ($direct|ConvertTo-Json -Depth 10 -Compress))
    $failed=$false;try{& "$PSScriptRoot/weather-issue-request.ps1" Capture $eventPath $normalizedPath|Out-Null}catch{$failed=$true}
    Assert $failed 'IP literal capture hosts are rejected before Stage1'

    $unauthorized=New-TestEvent '[weather-capture-request]' ($capture|ConvertTo-Json -Depth 10 -Compress)
    $unauthorized.issue.user.login='attacker'
    Write-TestJson $eventPath $unauthorized
    $failed=$false;try{& "$PSScriptRoot/weather-issue-request.ps1" Capture $eventPath $normalizedPath|Out-Null}catch{$failed=$true}
    Assert $failed 'Unauthorized issue author is rejected'

    $capture['weeklyForecast']=@{}
    Write-TestJson $eventPath (New-TestEvent '[weather-capture-request]' ($capture|ConvertTo-Json -Depth 10 -Compress))
    $failed=$false;try{& "$PSScriptRoot/weather-issue-request.ps1" Capture $eventPath $normalizedPath|Out-Null}catch{$failed=$true}
    Assert $failed 'Unexpected capture fields are rejected'

    $imagePath=Join-Path $root 'evidence.png';Copy-Item -LiteralPath(Join-Path $PSScriptRoot '..\assets\weather-templates\sun-day.png')-Destination $imagePath
    $bytes=[IO.File]::ReadAllBytes($imagePath);$sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    $review=[ordered]@{
        schemaVersion=2;artifact=[ordered]@{runId='34794384921';id='10328214917';name='weather-x-embed-evidence-34794384921'}
        selectedMedia=[ordered]@{url='https://pbs.twimg.com/media/weather-example?format=png&name=small';file='raw-media-0.png';mimeType='image/png';captureSha256=$hash}
        interpretation=[ordered]@{ready=$true;observedDate='2026-09-11';startSlot='06';confidence='high';summary='Visible';unresolved=@();slots=@(
            [ordered]@{slot='slot0';visible=$true;weather=@('晴');confidence='high';description='06'},[ordered]@{slot='slot1';visible=$true;weather=@('雨');confidence='high';description='12'},
            [ordered]@{slot='slot2';visible=$true;weather=@('晴');confidence='high';description='18'},[ordered]@{slot='slot3';visible=$true;weather=@('晴');confidence='high';description='00'},
            [ordered]@{slot='slot4';visible=$true;weather=@('晴');confidence='high';description='06'})}
    }
    Clear-Content -LiteralPath $outputPath
    Write-TestJson $eventPath (New-TestEvent '[weather-review-result]' ($review|ConvertTo-Json -Depth 30 -Compress))
    & "$PSScriptRoot/weather-issue-request.ps1" Review $eventPath $normalizedPath | Out-Null
    $outputs=@(Get-Content -LiteralPath $outputPath -Encoding UTF8)
    Assert ($outputs -contains 'request_kind=review' -and $outputs -contains 'artifact_id=10328214917' -and $outputs -contains 'review_mode=public-media-url-visual') 'Authorized review issue exports a validated exact artifact and public media binding'
    Assert (@($outputs|Where-Object{$_ -like 'review_payload_base64=*'}).Count -eq 1) 'Validated review payload is exported without evaluation'
    'PASS: authorized dedicated issues, strict capture/review JSON, safe workflow outputs'
} finally {
    $env:GITHUB_OUTPUT=$null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
