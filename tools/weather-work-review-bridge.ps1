param(
    [Parameter(Mandatory)] [string] $ReviewPath,
    [Parameter(Mandatory)] [string] $ArtifactDirectory,
    [Parameter(Mandatory)] [string] $DownloadedArtifactId,
    [Parameter(Mandatory)] [string] $DownloadedArtifactName,
    [Parameter(Mandatory)] [string] $DownloadedArtifactRunId,
    [Parameter(Mandatory)] [string] $CandidatePath,
    [Parameter(Mandatory)] [string] $DryRunPath,
    [Parameter(Mandatory)] [string] $PendingPreviewPath,
    [string] $RefetchedMediaPath = ''
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"

function Read-WeatherWorkJson {
    param([Parameter(Mandatory)] [string] $Path)
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $options = @{ InputObject = $json; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    ConvertFrom-Json @options
}

function Write-WeatherWorkJson {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [object] $Value)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), ($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

$review = Read-WeatherWorkJson $ReviewPath
if ([string]$review.artifact.id -cne $DownloadedArtifactId -or
    [string]$review.artifact.name -cne $DownloadedArtifactName -or
    [string]$review.artifact.runId -cne $DownloadedArtifactRunId) {
    throw 'Downloaded artifact identifiers do not match the Work review.'
}

$artifactRoot = [IO.Path]::GetFullPath($ArtifactDirectory)
if (-not [IO.Directory]::Exists($artifactRoot)) { throw 'Downloaded evidence artifact is missing.' }
$captureFiles = @(Get-ChildItem -LiteralPath $artifactRoot -Recurse -File -Filter 'capture.json')
if ($captureFiles.Count -ne 1) { throw 'Downloaded artifact must contain exactly one capture.json.' }
$evidenceDirectory = $captureFiles[0].Directory.FullName
$capturePath = $captureFiles[0].FullName
$discoveryPath = Join-Path $evidenceDirectory 'discovery-candidate.json'
if (-not [IO.File]::Exists($discoveryPath)) { throw 'Downloaded artifact is missing discovery-candidate.json.' }

$capture = Read-WeatherWorkJson $capturePath
if ($capture.status -cne 'captured' -or $null -eq $capture.evidence) { throw 'Confirmed capture evidence is required.' }

$resultDirectory = Split-Path -Parent $CandidatePath
if ($resultDirectory) { New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null }
$capturePathForCandidate = $capturePath
$reviewMode = if ($review.schemaVersion -eq 2) { 'public-media-url-visual' } else { 'legacy-evidence' }
$refetchedSha256 = ''
if ($reviewMode -ceq 'public-media-url-visual') {
    $selected = $review.selectedMedia
    if ($null -eq $selected -or [string]$selected.file -notmatch '^raw-media-[0-3]\.(?:jpg|png)$' -or
        [string]$selected.mimeType -notin @('image/jpeg','image/png') -or
        [string]$selected.captureSha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Invalid selected public media binding.'
    }
    $matches = @($capture.rawMedia | Where-Object {
        [string]$_.url -ceq [string]$selected.url -and
        [string]$_.file -ceq [string]$selected.file -and
        [string]$_.mimeType -ceq [string]$selected.mimeType -and
        [string]$_.sha256 -ceq [string]$selected.captureSha256
    })
    if ($matches.Count -ne 1) { throw 'Selected public media does not exactly match capture metadata.' }
    $mediaRecord = $matches[0]
    $evidencePath = Join-Path $evidenceDirectory ([string]$selected.file)
    if (-not [IO.File]::Exists($evidencePath)) { throw 'Selected raw media is missing from the capture artifact.' }
    $rawCapturedAt = if (-not [string]::IsNullOrWhiteSpace([string]$capture.capturedAt)) { [string]$capture.capturedAt } else { [string]$capture.evidence.capturedAt }
    $artifact = New-WeatherEvidenceImage -Path $evidencePath -Kind original -CapturedAt $rawCapturedAt
    if ($artifact.sha256 -cne [string]$mediaRecord.sha256 -or
        $artifact.sha256 -cne [string]$selected.captureSha256 -or
        $artifact.byteSize -ne [long]$mediaRecord.byteSize -or
        $artifact.mimeType -cne [string]$mediaRecord.mimeType) {
        throw 'Capture artifact raw media does not match its Actions capture metadata.'
    }
    if ([string]::IsNullOrWhiteSpace($RefetchedMediaPath) -or -not [IO.File]::Exists($RefetchedMediaPath)) {
        throw 'Stage2 public media re-fetch is required.'
    }
    $refetched = New-WeatherEvidenceImage -Path $RefetchedMediaPath -Kind original -CapturedAt $rawCapturedAt
    $refetchedSha256 = $refetched.sha256
    if ($refetched.sha256 -cne $artifact.sha256 -or $refetched.byteSize -ne $artifact.byteSize -or
        $refetched.mimeType -cne $artifact.mimeType) {
        throw 'Stage2 public media re-fetch does not match the capture artifact raw media.'
    }
    $normalizedCapture = $capture | ConvertTo-Json -Depth 40 | ConvertFrom-Json
    $normalizedCapture.evidence = [pscustomobject]@{
        file = [string]$selected.file
        mimeType = $artifact.mimeType
        byteSize = $artifact.byteSize
        sha256 = $artifact.sha256
        kind = 'original'
        capturedAt = $rawCapturedAt
    }
    $capturePathForCandidate = Join-Path $resultDirectory 'selected-media-capture.json'
    Write-WeatherWorkJson $capturePathForCandidate $normalizedCapture
} else {
    $evidencePath = Join-Path $evidenceDirectory 'evidence.jpg'
    if (-not [IO.File]::Exists($evidencePath)) { throw 'Downloaded artifact is missing evidence.jpg.' }
    $kind = if ([string]$capture.evidence.kind -match 'screenshot$') { 'screenshot' } else { 'original' }
    $artifact = New-WeatherEvidenceImage -Path $evidencePath -Kind $kind -CapturedAt ([string]$capture.evidence.capturedAt)
    if ($artifact.sha256 -cne [string]$review.evidenceSha256 -or
        $artifact.sha256 -cne [string]$capture.evidence.sha256 -or
        $artifact.byteSize -ne [long]$capture.evidence.byteSize -or
        $artifact.mimeType -cne [string]$capture.evidence.mimeType) {
        throw 'Review envelope SHA-256 does not match the downloaded evidence image.'
    }
}

$interpretationPath = Join-Path $resultDirectory 'work-interpretation.json'
$interpretation = [ordered]@{
    status = 'completed'
    inputSha256 = $artifact.sha256
    model = $(if ($reviewMode -ceq 'public-media-url-visual') { 'work-public-media-url-visual-review' } else { 'work-visual-review' })
    responseId = ''
    interpretation = $review.interpretation
}
Write-WeatherWorkJson $interpretationPath $interpretation

& "$PSScriptRoot/weather-ai-candidate.ps1" `
    -CapturePath $capturePathForCandidate -DiscoveryPath $discoveryPath -InterpretationPath $interpretationPath `
    -EvidencePath $evidencePath -CandidatePath $CandidatePath -DryRunPath $DryRunPath | Out-Null

$candidate = Read-WeatherWorkJson $CandidatePath
$candidate.aiReview | Add-Member -NotePropertyName artifact -NotePropertyValue ([pscustomobject]@{
    runId = [string]$review.artifact.runId
    id = [string]$review.artifact.id
    name = [string]$review.artifact.name
}) -Force
$candidate.aiReview | Add-Member -NotePropertyName verificationScope -NotePropertyValue ([pscustomobject]@{
    visualReview = $(if ($reviewMode -ceq 'public-media-url-visual') { 'capture-time-public-media-url-only' } else { 'artifact-image' })
    sha256VerifiedBy = 'github-actions'
    workDisplayBytesCryptographicallyVerified = $false
}) -Force
Write-WeatherWorkJson $CandidatePath $candidate

$ready = $candidate.hourlyForecast.status -ceq 'ready'
$pendingPrepared = $false
if ($ready) {
    $preview = ConvertTo-WeatherEvidencePendingPreview -Candidate $candidate -EvidenceImage $artifact
    $preview | Add-Member -NotePropertyName artifact -NotePropertyValue $candidate.aiReview.artifact -Force
    Write-WeatherWorkJson $PendingPreviewPath $preview
    $pendingPrepared = $true
} else {
    Write-WeatherWorkJson $PendingPreviewPath ([ordered]@{ status='not-ready'; sent=$false; artifact=$candidate.aiReview.artifact })
}

if ($env:GITHUB_OUTPUT) {
    $outputs = @(
        'sha256_match=true'
        'ready=' + $ready.ToString().ToLowerInvariant()
        'pending_prepared=' + $pendingPrepared.ToString().ToLowerInvariant()
        'capture_path=' + $capturePathForCandidate
        'evidence_path=' + $evidencePath
        'capture_sha256=' + $artifact.sha256
        'stage2_refetch_sha256=' + $refetchedSha256
        'pending_evidence_source=capture-artifact'
        'review_scope=' + $reviewMode
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, $outputs + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{ sha256Match=$true; ready=$ready; pendingPrepared=$pendingPrepared; sent=$false; captureSha256=$artifact.sha256; stage2RefetchSha256=$refetchedSha256; pendingEvidenceSource='capture-artifact'; reviewScope=$reviewMode }
