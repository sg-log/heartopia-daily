$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function ConvertTo-ReviewBase64($Value) {
    $json = $Value | ConvertTo-Json -Depth 30 -Compress
    [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($json))
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-artifact-review-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $downloadDirectory = Join-Path $root 'downloaded-artifact'
    $artifactDirectory = Join-Path $downloadDirectory 'weather-x-embed-evidence-test'
    $resultDirectory = Join-Path $root 'result'
    New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null

    $evidencePath = Join-Path $artifactDirectory 'evidence.jpg'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\sun-day.png') -Destination $evidencePath
    $legacyEvidence = New-WeatherEvidenceImage $evidencePath screenshot '2026-09-14T06:01:00+09:00'

    $raw0Path = Join-Path $artifactDirectory 'raw-media-0.png'
    $raw1Path = Join-Path $artifactDirectory 'raw-media-1.png'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\sun-day.png') -Destination $raw0Path
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\rain.png') -Destination $raw1Path
    $raw0 = New-WeatherEvidenceImage $raw0Path original '2026-09-14T06:01:00+09:00'
    $raw1 = New-WeatherEvidenceImage $raw1Path original '2026-09-14T06:01:00+09:00'

    $capture = [ordered]@{
        status='captured';sourceUrl='https://x.com/example/status/123';finalUrl='https://x.com/example/status/123';capturedAt='2026-09-14T06:01:00+09:00'
        evidence=[ordered]@{mimeType=$legacyEvidence.mimeType;byteSize=$legacyEvidence.byteSize;sha256=$legacyEvidence.sha256;kind='screenshot';capturedAt=$legacyEvidence.capturedAt}
        rawMedia=@(
            [ordered]@{url='https://pbs.twimg.com/media/a?format=png&name=orig';file='raw-media-0.png';mimeType=$raw0.mimeType;byteSize=$raw0.byteSize;sha256=$raw0.sha256},
            [ordered]@{url='https://pbs.twimg.com/media/b?format=png&name=orig';file='raw-media-1.png';mimeType=$raw1.mimeType;byteSize=$raw1.byteSize;sha256=$raw1.sha256}
        )
    }
    $discovery = New-WeatherDiscoveryCandidate synthetic 'Heartopia weather' '2026-09-14T06:00:00+09:00' $capture.sourceUrl
    $discovery = Add-WeatherDiscoveryRetrieval $discovery confirmed '2026-09-14T06:01:00+09:00' $capture.finalUrl 'Synthetic artifact review capture'
    [IO.File]::WriteAllText((Join-Path $artifactDirectory 'capture.json'), ($capture | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $artifactDirectory 'discovery-candidate.json'), ($discovery | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

    $interpretation = [ordered]@{
        ready=$true;observedDate='2026-09-14';startSlot='06';confidence='high';summary='Two artifact raw images reviewed.';unresolved=@()
        slots=@(
            [ordered]@{slot='slot0';visible=$true;weather=@('晴');confidence='high';description='06 sun'},
            [ordered]@{slot='slot1';visible=$true;weather=@('雨');confidence='high';description='12 rain'},
            [ordered]@{slot='slot2';visible=$true;weather=@('晴');confidence='high';description='18 clear'},
            [ordered]@{slot='slot3';visible=$true;weather=@('晴');confidence='high';description='00 clear'},
            [ordered]@{slot='slot4';visible=$true;weather=@('晴');confidence='high';description='next 06 sun'}
        )
    }
    $review = [ordered]@{
        schemaVersion=4
        artifact=[ordered]@{runId='34870529944';id='10358184684';name='weather-x-embed-evidence-test'}
        reviewedImages=@(
            [ordered]@{file='raw-media-0.png';mimeType=$raw0.mimeType;captureSha256=$raw0.sha256},
            [ordered]@{file='raw-media-1.png';mimeType=$raw1.mimeType;captureSha256=$raw1.sha256}
        )
        pendingEvidenceFile='raw-media-1.png'
        interpretation=$interpretation
    }

    $reviewPath = Join-Path $root 'review.json'
    $githubOutput = Join-Path $root 'github-output.txt'
    $env:GITHUB_OUTPUT = $githubOutput
    & "$PSScriptRoot/weather-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $review) -ReviewPath $reviewPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains 'review_mode=artifact-raw-media-visual') 'Schema v4 routes to direct artifact visual review'
    Assert ($outputs -contains ('evidence_sha256=' + $raw1.sha256)) 'Selected pending evidence SHA is exported'

    $candidatePath = Join-Path $resultDirectory 'weather-candidate.json'
    $dryRunPath = Join-Path $resultDirectory 'weather-dry-run.json'
    $previewPath = Join-Path $resultDirectory 'pending-preview.json'
    & "$PSScriptRoot/weather-review-bridge.ps1" `
        -ReviewPath $reviewPath -ArtifactDirectory $downloadDirectory `
        -DownloadedArtifactId $review.artifact.id -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
        -CandidatePath $candidatePath -DryRunPath $dryRunPath -PendingPreviewPath $previewPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains 'review_scope=artifact-raw-media-visual') 'Bridge exports direct artifact review scope'
    Assert ($outputs -contains ('capture_sha256=' + $raw1.sha256)) 'Bridge verifies selected pending evidence bytes'
    $candidate = Get-Content -LiteralPath $candidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $preview = Get-Content -LiteralPath $previewPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($candidate.hourlyForecast.status -eq 'ready') 'Direct artifact review reaches existing ready candidate path'
    Assert (@($candidate.aiReview.reviewedImages).Count -eq 2) 'Candidate records every reviewed artifact image'
    Assert ($candidate.aiReview.verificationScope.visualReview -eq 'artifact-raw-media-images') 'Candidate records artifact visual scope'
    Assert ($preview.payload.evidenceImages[0].sha256 -eq $raw1.sha256) 'Pending preview uses the explicitly selected captured raw image'

    $badReview = ($review | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
    $badReview.reviewedImages[0].captureSha256 = '0' * 64
    $badPath = Join-Path $root 'bad-review.json'
    Clear-Content -LiteralPath $githubOutput
    & "$PSScriptRoot/weather-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $badReview) -ReviewPath $badPath | Out-Null
    $failed = $false
    try {
        & "$PSScriptRoot/weather-review-bridge.ps1" `
            -ReviewPath $badPath -ArtifactDirectory $downloadDirectory `
            -DownloadedArtifactId $review.artifact.id -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
            -CandidatePath $candidatePath -DryRunPath $dryRunPath -PendingPreviewPath $previewPath | Out-Null
    } catch { $failed = $true }
    Assert $failed 'A reviewed raw-media SHA mismatch stops before candidate conversion'

    'PASS: direct artifact multi-image review validation, SHA gates, candidate, and pending preview'
} finally {
    $env:GITHUB_OUTPUT = $null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
