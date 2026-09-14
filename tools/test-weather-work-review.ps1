$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }

function ConvertTo-ReviewBase64($Value) {
    $json = $Value | ConvertTo-Json -Depth 30 -Compress
    [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($json))
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-work-review-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $downloadDirectory = Join-Path $root 'downloaded-artifact'
    $artifactDirectory = Join-Path $downloadDirectory 'weather-x-embed-evidence-34794384921'
    $resultDirectory = Join-Path $root 'result'
    New-Item -ItemType Directory -Path $artifactDirectory | Out-Null
    $evidencePath = Join-Path $artifactDirectory 'evidence.jpg'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\sun-day.png') -Destination $evidencePath
    $artifact = New-WeatherEvidenceImage $evidencePath screenshot '2026-09-11T06:01:00+09:00'

    $capture = [ordered]@{
        status='captured'; sourceUrl='https://example.org/post/123'; finalUrl='https://example.org/post/123'
        evidence=[ordered]@{mimeType=$artifact.mimeType;byteSize=$artifact.byteSize;sha256=$artifact.sha256;kind='screenshot';capturedAt=$artifact.capturedAt}
    }
    $discovery = New-WeatherDiscoveryCandidate synthetic 'Heartopia weather' '2026-09-11T06:00:00+09:00' $capture.sourceUrl
    $discovery = Add-WeatherDiscoveryRetrieval $discovery confirmed '2026-09-11T06:01:00+09:00' $capture.finalUrl 'Synthetic direct capture'
    [IO.File]::WriteAllText((Join-Path $artifactDirectory 'capture.json'), ($capture | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $artifactDirectory 'discovery-candidate.json'), ($discovery | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))

    $interpretation = [ordered]@{
        ready=$true; observedDate='2026-09-11'; startSlot='06'; confidence='high'; summary='All five hourly slots are visible.'; unresolved=@()
        slots=@(
            [ordered]@{slot='slot0';visible=$true;weather=@('晴');confidence='high';description='06 sun'},
            [ordered]@{slot='slot1';visible=$true;weather=@('雨');confidence='high';description='12 rain'},
            [ordered]@{slot='slot2';visible=$true;weather=@('晴');confidence='high';description='18 sun'},
            [ordered]@{slot='slot3';visible=$true;weather=@('晴');confidence='high';description='00 sun'},
            [ordered]@{slot='slot4';visible=$true;weather=@('晴');confidence='high';description='06 sun'}
        )
    }
    $review = [ordered]@{
        schemaVersion=1
        artifact=[ordered]@{runId='34794384921';id='10328214917';name='weather-x-embed-evidence-34794384921'}
        evidenceSha256=$artifact.sha256
        interpretation=$interpretation
    }
    $reviewPath = Join-Path $root 'review.json'
    $githubOutput = Join-Path $root 'github-output.txt'
    $env:GITHUB_OUTPUT = $githubOutput
    & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $review) -ReviewPath $reviewPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains 'artifact_id=10328214917') 'Validated artifact ID is exported'
    Assert ($outputs -contains "evidence_sha256=$($artifact.sha256)") 'Validated evidence SHA-256 is exported'

    $candidatePath = Join-Path $resultDirectory 'weather-candidate.json'
    $dryRunPath = Join-Path $resultDirectory 'weather-dry-run.json'
    $previewPath = Join-Path $resultDirectory 'pending-preview.json'
    & "$PSScriptRoot/weather-work-review-bridge.ps1" `
        -ReviewPath $reviewPath -ArtifactDirectory $downloadDirectory `
        -DownloadedArtifactId $review.artifact.id -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
        -CandidatePath $candidatePath -DryRunPath $dryRunPath -PendingPreviewPath $previewPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains ('capture_path=' + (Join-Path $artifactDirectory 'capture.json'))) 'Bridge exports the exact nested capture path'
    Assert ($outputs -contains ('evidence_path=' + $evidencePath)) 'Bridge exports the exact nested evidence path'
    $candidate = Get-Content -LiteralPath $candidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $preview = Get-Content -LiteralPath $previewPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($candidate.hourlyForecast.status -eq 'ready') 'Work review connects to the existing ready candidate path'
    Assert ($candidate.currentWeather.status -eq 'missing' -and $candidate.weeklyForecast.status -eq 'missing') 'Current and weekly forecasts remain excluded'
    Assert ($candidate.aiReview.inputSha256 -eq $artifact.sha256 -and $candidate.aiReview.artifact.id -eq $review.artifact.id) 'Candidate keeps SHA and artifact identifiers'
    Assert ($preview.status -eq 'preview' -and $preview.sent -eq $false) 'Pending connection is prepared without sending'
    Assert ($preview.payload.evidenceImages[0].sha256 -eq $artifact.sha256) 'Pending attachment is the Work-reviewed image SHA-256'

    $failed = $false
    try {
        & "$PSScriptRoot/weather-work-review-bridge.ps1" `
            -ReviewPath $reviewPath -ArtifactDirectory $downloadDirectory `
            -DownloadedArtifactId '999999' -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
            -CandidatePath $candidatePath -DryRunPath $dryRunPath -PendingPreviewPath $previewPath | Out-Null
    } catch { $failed = $true }
    Assert $failed 'A downloaded artifact identifier mismatch is rejected'

    $badReview = ($review | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
    $badReview.evidenceSha256 = '0' * 64
    $badReviewPath = Join-Path $root 'bad-review.json'
    & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $badReview) -ReviewPath $badReviewPath | Out-Null
    $failed = $false
    try {
        & "$PSScriptRoot/weather-work-review-bridge.ps1" `
            -ReviewPath $badReviewPath -ArtifactDirectory $downloadDirectory `
            -DownloadedArtifactId $review.artifact.id -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
            -CandidatePath $candidatePath -DryRunPath $dryRunPath -PendingPreviewPath $previewPath | Out-Null
    } catch { $failed = $true }
    Assert $failed 'A Work SHA-256 mismatch stops before candidate conversion'

    $extra = ($review | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
    $extra.interpretation | Add-Member -NotePropertyName weeklyForecast -NotePropertyValue ([pscustomobject]@{})
    $failed = $false
    try { & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $extra) -ReviewPath $badReviewPath | Out-Null }
    catch { $failed = $true }
    Assert $failed 'Unexpected weekly data is rejected by the handoff envelope'
    'PASS: two-stage Work handoff, artifact identifiers, SHA-256 gate, existing candidate, unsent pending preview'
} finally {
    $env:GITHUB_OUTPUT = $null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
