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

    $rawMediaPath = Join-Path $artifactDirectory 'raw-media-0.png'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\rain.png') -Destination $rawMediaPath
    $rawArtifact = New-WeatherEvidenceImage $rawMediaPath original '2026-09-11T06:01:00+09:00'
    $mediaUrl = 'https://pbs.twimg.com/media/weather-example?format=png&name=small'
    $capture['rawMedia'] = @([ordered]@{
        url=$mediaUrl;file='raw-media-0.png';mimeType=$rawArtifact.mimeType;byteSize=$rawArtifact.byteSize;sha256=$rawArtifact.sha256
    })
    [IO.File]::WriteAllText((Join-Path $artifactDirectory 'capture.json'), ($capture | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    $publicMediaReview = [ordered]@{
        schemaVersion=2
        artifact=$review.artifact
        selectedMedia=[ordered]@{url=$mediaUrl;file='raw-media-0.png';mimeType=$rawArtifact.mimeType;captureSha256=$rawArtifact.sha256}
        interpretation=$interpretation
    }
    $publicMediaReviewPath = Join-Path $root 'public-media-review.json'
    Clear-Content -LiteralPath $githubOutput
    & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $publicMediaReview) -ReviewPath $publicMediaReviewPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains 'review_mode=public-media-url-visual') 'Public media review is explicitly visual-only'
    Assert ($outputs -contains ('media_url=' + $mediaUrl)) 'Selected public media URL is exported literally'
    Assert ($outputs -contains ('evidence_sha256=' + $rawArtifact.sha256)) 'Actions capture SHA is exported without claiming Work calculated it'

    $refetchedMediaPath = Join-Path $root 'stage2-refetched.bin'
    Copy-Item -LiteralPath $rawMediaPath -Destination $refetchedMediaPath
    $publicCandidatePath = Join-Path $resultDirectory 'public-media-candidate.json'
    $publicDryRunPath = Join-Path $resultDirectory 'public-media-dry-run.json'
    $publicPreviewPath = Join-Path $resultDirectory 'public-media-preview.json'
    & "$PSScriptRoot/weather-work-review-bridge.ps1" `
        -ReviewPath $publicMediaReviewPath -ArtifactDirectory $downloadDirectory `
        -DownloadedArtifactId $review.artifact.id -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
        -CandidatePath $publicCandidatePath -DryRunPath $publicDryRunPath -PendingPreviewPath $publicPreviewPath `
        -RefetchedMediaPath $refetchedMediaPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains ('capture_sha256=' + $rawArtifact.sha256) -and $outputs -contains ('stage2_refetch_sha256=' + $rawArtifact.sha256)) 'Capture artifact and Stage2 re-fetch SHA values both match'
    Assert ($outputs -contains ('evidence_path=' + $rawMediaPath)) 'Pending evidence path is the capture artifact raw media, not the re-fetch'
    $publicCandidate = Get-Content -LiteralPath $publicCandidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $publicPreview = Get-Content -LiteralPath $publicPreviewPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($publicCandidate.aiReview.verificationScope.sha256VerifiedBy -eq 'github-actions' -and -not $publicCandidate.aiReview.verificationScope.workDisplayBytesCryptographicallyVerified) 'Candidate records the limited Work visual-review guarantee'
    Assert ($publicPreview.payload.evidenceImages[0].sha256 -eq $rawArtifact.sha256) 'Pending preview contains the capture artifact raw media SHA'

    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\sun-night.png') -Destination $refetchedMediaPath -Force
    $failed = $false
    try {
        & "$PSScriptRoot/weather-work-review-bridge.ps1" `
            -ReviewPath $publicMediaReviewPath -ArtifactDirectory $downloadDirectory `
            -DownloadedArtifactId $review.artifact.id -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
            -CandidatePath $publicCandidatePath -DryRunPath $publicDryRunPath -PendingPreviewPath $publicPreviewPath `
            -RefetchedMediaPath $refetchedMediaPath | Out-Null
    } catch { $failed = $true }
    Assert $failed 'A Stage2 re-fetch SHA mismatch stops before candidate and pending conversion'

    $missingMediaReview = ($publicMediaReview | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
    $missingMediaReview.selectedMedia.url = ''
    $failed = $false
    try { & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $missingMediaReview) -ReviewPath $badReviewPath | Out-Null }
    catch { $failed = $true }
    Assert $failed 'A missing media URL is rejected before Stage2'

    $privateReview = [ordered]@{
        schemaVersion=3
        artifact=$review.artifact
        selectedReviewImage=[ordered]@{
            file='raw-media-0.png';mimeType=$rawArtifact.mimeType
            captureSha256=$rawArtifact.sha256;reviewStoredSha256=$rawArtifact.sha256
            reviewUrl=('https://script.google.com/macros/s/test-deployment/exec?reviewToken=' + ('A' * 43))
            expiresAt='2026-09-15T12:34:56.789Z'
        }
        interpretation=$interpretation
    }
    $privateReviewPath = Join-Path $root 'private-review.json'
    Clear-Content -LiteralPath $githubOutput
    & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $privateReview) -ReviewPath $privateReviewPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains 'review_mode=private-review-url-visual') 'Private review URL schema is explicitly visual-only'
    $privateCandidatePath = Join-Path $resultDirectory 'private-review-candidate.json'
    $privateDryRunPath = Join-Path $resultDirectory 'private-review-dry-run.json'
    $privatePreviewPath = Join-Path $resultDirectory 'private-review-preview.json'
    & "$PSScriptRoot/weather-work-review-bridge.ps1" `
        -ReviewPath $privateReviewPath -ArtifactDirectory $downloadDirectory `
        -DownloadedArtifactId $review.artifact.id -DownloadedArtifactName $review.artifact.name -DownloadedArtifactRunId $review.artifact.runId `
        -CandidatePath $privateCandidatePath -DryRunPath $privateDryRunPath -PendingPreviewPath $privatePreviewPath | Out-Null
    $outputs = @(Get-Content -LiteralPath $githubOutput -Encoding UTF8)
    Assert ($outputs -contains ('review_storage_sha256=' + $rawArtifact.sha256)) 'Apps Script review storage SHA matches the capture artifact SHA'
    Assert ($outputs -contains ('evidence_path=' + $rawMediaPath)) 'Private review mode keeps the capture artifact raw media as pending evidence'
    $privateCandidate = Get-Content -LiteralPath $privateCandidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($privateCandidate.aiReview.verificationScope.visualReview -eq 'expiring-private-review-url-only' -and
        $privateCandidate.aiReview.verificationScope.sha256VerifiedBy -eq 'github-actions') 'Candidate records private URL visual scope without claiming Work hashed the image'

    $badPrivateReview = ($privateReview | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
    $badPrivateReview.selectedReviewImage.reviewStoredSha256 = '0' * 64
    $failed = $false
    try { & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $badPrivateReview) -ReviewPath $badReviewPath | Out-Null }
    catch { $failed = $true }
    Assert $failed 'A review Drive SHA mismatch is rejected before Stage2'

    $extra = ($review | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
    $extra.interpretation | Add-Member -NotePropertyName weeklyForecast -NotePropertyValue ([pscustomobject]@{})
    $failed = $false
    try { & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 (ConvertTo-ReviewBase64 $extra) -ReviewPath $badReviewPath | Out-Null }
    catch { $failed = $true }
    Assert $failed 'Unexpected weekly data is rejected by the handoff envelope'
    'PASS: legacy, public-media, and expiring private review URL handoffs; Actions/Drive SHA gates; artifact raw media pending preview'
} finally {
    $env:GITHUB_OUTPUT = $null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
