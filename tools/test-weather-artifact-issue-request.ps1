$ErrorActionPreference = 'Stop'
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Write-TestJson($Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-artifact-issue-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $eventPath = Join-Path $root 'event.json'
    $normalizedPath = Join-Path $root 'normalized.json'
    $outputPath = Join-Path $root 'output.txt'
    $env:GITHUB_OUTPUT = $outputPath

    $sha0 = '1' * 64
    $sha1 = '2' * 64
    $review = [ordered]@{
        schemaVersion=4
        artifact=[ordered]@{runId='34870529944';id='10358184684';name='weather-x-embed-evidence-34870529944'}
        reviewedImages=@(
            [ordered]@{file='raw-media-0.jpg';mimeType='image/jpeg';captureSha256=$sha0},
            [ordered]@{file='raw-media-1.jpg';mimeType='image/jpeg';captureSha256=$sha1}
        )
        pendingEvidenceFile='raw-media-1.jpg'
        interpretation=[ordered]@{
            ready=$true;observedDate='2026-09-14';startSlot='06';confidence='high';summary='Artifact raw media reviewed';unresolved=@()
            slots=@(
                [ordered]@{slot='slot0';visible=$true;weather=@('晴');confidence='high';description='06'},
                [ordered]@{slot='slot1';visible=$true;weather=@('雨');confidence='high';description='12'},
                [ordered]@{slot='slot2';visible=$true;weather=@('晴');confidence='high';description='18'},
                [ordered]@{slot='slot3';visible=$true;weather=@('晴');confidence='high';description='00'},
                [ordered]@{slot='slot4';visible=$true;weather=@('晴');confidence='high';description='next 06'}
            )
        }
    }
    $event = [ordered]@{
        action='opened';repository=[ordered]@{full_name='sg-log/heartopia-daily'};sender=[ordered]@{login='sg-log'}
        issue=[ordered]@{number=123;state='open';title='[weather-review-result]';body=($review | ConvertTo-Json -Depth 30 -Compress);author_association='OWNER';user=[ordered]@{login='sg-log'}}
    }
    Write-TestJson $eventPath $event
    & "$PSScriptRoot/weather-issue-request.ps1" Review $eventPath $normalizedPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $outputPath -Encoding UTF8)
    Assert ($outputs -contains 'request_kind=review') 'Artifact review Issue is accepted as a review request'
    Assert ($outputs -contains 'review_mode=artifact-raw-media-visual') 'Artifact review Issue exports the direct artifact visual mode'
    Assert ($outputs -contains 'artifact_id=10358184684') 'Artifact review Issue keeps the exact artifact ID'
    Assert (@($outputs | Where-Object { $_ -like 'review_payload_base64=*' }).Count -eq 1) 'Artifact review Issue exports one validated payload'
    'PASS: production Issue routing accepts strict schema v4 artifact reviews'
} finally {
    $env:GITHUB_OUTPUT = $null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
