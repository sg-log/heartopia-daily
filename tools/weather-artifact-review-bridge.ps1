param(
    [Parameter(Mandatory)] [string] $ReviewPath,
    [Parameter(Mandatory)] [string] $ArtifactDirectory,
    [Parameter(Mandatory)] [string] $DownloadedArtifactId,
    [Parameter(Mandatory)] [string] $DownloadedArtifactName,
    [Parameter(Mandatory)] [string] $DownloadedArtifactRunId,
    [Parameter(Mandatory)] [string] $CandidatePath,
    [Parameter(Mandatory)] [string] $DryRunPath,
    [Parameter(Mandatory)] [string] $PendingPreviewPath
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"

function Read-Json {
    param([Parameter(Mandatory)] [string] $Path)
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $options = @{ InputObject = $json; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    ConvertFrom-Json @options
}
function Write-Json {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [object] $Value)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), ($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

$review = Read-Json $ReviewPath
if ($review.schemaVersion -ne 4) { throw 'Artifact review bridge requires schemaVersion 4.' }
if ([string]$review.artifact.id -cne $DownloadedArtifactId -or
    [string]$review.artifact.name -cne $DownloadedArtifactName -or
    [string]$review.artifact.runId -cne $DownloadedArtifactRunId) {
    throw 'Downloaded artifact identifiers do not match the artifact review.'
}

$artifactRoot = [IO.Path]::GetFullPath($ArtifactDirectory)
if (-not [IO.Directory]::Exists($artifactRoot)) { throw 'Downloaded evidence artifact is missing.' }
$captureFiles = @(Get-ChildItem -LiteralPath $artifactRoot -Recurse -File -Filter 'capture.json')
if ($captureFiles.Count -ne 1) { throw 'Downloaded artifact must contain exactly one capture.json.' }
$evidenceDirectory = $captureFiles[0].Directory.FullName
$capturePath = $captureFiles[0].FullName
$discoveryPath = Join-Path $evidenceDirectory 'discovery-candidate.json'
if (-not [IO.File]::Exists($discoveryPath)) { throw 'Downloaded artifact is missing discovery-candidate.json.' }

$capture = Read-Json $capturePath
if ($capture.status -cne 'captured' -or $null -eq $capture.evidence) {
    throw 'Confirmed capture evidence is required.'
}
$rawMedia = @($capture.rawMedia)

$rawCapturedAt = if (-not [string]::IsNullOrWhiteSpace([string]$capture.capturedAt)) { [string]$capture.capturedAt } else { [string]$capture.evidence.capturedAt }
$verifiedImages = @()
$pendingArtifact = $null
$pendingEvidencePath = ''
foreach ($selected in @($review.reviewedImages)) {
    $file = [string]$selected.file
    $imagePath = Join-Path $evidenceDirectory $file
    if (-not [IO.File]::Exists($imagePath)) { throw 'Reviewed artifact image is missing from the capture artifact.' }

    $expectedMime = ''
    $expectedSha = ''
    $expectedSize = 0L
    $kind = 'original'
    if ($file -ceq [string]$capture.evidence.file) {
        $expectedMime = [string]$capture.evidence.mimeType
        $expectedSha = [string]$capture.evidence.sha256
        $expectedSize = [long]$capture.evidence.byteSize
        $kind = if ([string]$capture.evidence.kind -match 'screenshot$') { 'screenshot' } else { 'original' }
    } else {
        $matches = @($rawMedia | Where-Object {
            [string]$_.file -ceq $file -and
            [string]$_.mimeType -ceq [string]$selected.mimeType -and
            [string]$_.sha256 -ceq [string]$selected.captureSha256
        })
        if ($matches.Count -ne 1) { throw 'Reviewed artifact image does not exactly match capture metadata.' }
        $expectedMime = [string]$matches[0].mimeType
        $expectedSha = [string]$matches[0].sha256
        $expectedSize = [long]$matches[0].byteSize
    }

    $artifact = New-WeatherEvidenceImage -Path $imagePath -Kind $kind -CapturedAt $rawCapturedAt
    if ($artifact.sha256 -cne $expectedSha -or
        $artifact.sha256 -cne [string]$selected.captureSha256 -or
        $artifact.byteSize -ne $expectedSize -or
        $artifact.mimeType -cne $expectedMime -or
        $artifact.mimeType -cne [string]$selected.mimeType) {
        throw 'Reviewed artifact image does not match its Actions capture metadata.'
    }
    $verifiedImages += [pscustomobject]@{
        file = $file
        mimeType = $artifact.mimeType
        byteSize = $artifact.byteSize
        sha256 = $artifact.sha256
        kind = $kind
    }
    if ($file -ceq [string]$review.pendingEvidenceFile) {
        $pendingArtifact = $artifact
        $pendingEvidencePath = $imagePath
    }
}
if ($null -eq $pendingArtifact -or [string]::IsNullOrWhiteSpace($pendingEvidencePath)) {
    throw 'Pending evidence image was not verified.'
}

$resultDirectory = Split-Path -Parent $CandidatePath
if ($resultDirectory) { New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null }
$normalizedCapture = $capture | ConvertTo-Json -Depth 40 | ConvertFrom-Json
$normalizedCapture.evidence = [pscustomobject]@{
    file = [IO.Path]::GetFileName($pendingEvidencePath)
    mimeType = $pendingArtifact.mimeType
    byteSize = $pendingArtifact.byteSize
    sha256 = $pendingArtifact.sha256
    kind = $pendingArtifact.kind
    capturedAt = $rawCapturedAt
}
$capturePathForCandidate = Join-Path $resultDirectory 'selected-artifact-media-capture.json'
Write-Json $capturePathForCandidate $normalizedCapture

$interpretationPath = Join-Path $resultDirectory 'work-interpretation.json'
$interpretation = [ordered]@{
    status = 'completed'
    inputSha256 = $pendingArtifact.sha256
    model = 'artifact-captured-visual-review'
    responseId = ''
    interpretation = $review.interpretation
}
Write-Json $interpretationPath $interpretation

& "$PSScriptRoot/weather-ai-candidate.ps1" `
    -CapturePath $capturePathForCandidate -DiscoveryPath $discoveryPath -InterpretationPath $interpretationPath `
    -EvidencePath $pendingEvidencePath -CandidatePath $CandidatePath -DryRunPath $DryRunPath | Out-Null

$candidate = Read-Json $CandidatePath
$candidate.aiReview | Add-Member -NotePropertyName artifact -NotePropertyValue ([pscustomobject]@{
    runId = [string]$review.artifact.runId
    id = [string]$review.artifact.id
    name = [string]$review.artifact.name
}) -Force
$candidate.aiReview | Add-Member -NotePropertyName reviewedImages -NotePropertyValue $verifiedImages -Force
$candidate.aiReview | Add-Member -NotePropertyName verificationScope -NotePropertyValue ([pscustomobject]@{
    visualReview = 'artifact-captured-images'
    sha256VerifiedBy = 'github-actions'
    workDisplayBytesCryptographicallyVerified = $false
}) -Force
Write-Json $CandidatePath $candidate

$ready = $candidate.hourlyForecast.status -ceq 'ready'
$pendingPrepared = $false
if ($ready) {
    $preview = ConvertTo-WeatherEvidencePendingPreview -Candidate $candidate -EvidenceImage $pendingArtifact
    $preview | Add-Member -NotePropertyName artifact -NotePropertyValue $candidate.aiReview.artifact -Force
    Write-Json $PendingPreviewPath $preview
    $pendingPrepared = $true
} else {
    Write-Json $PendingPreviewPath ([ordered]@{ status='not-ready'; sent=$false; artifact=$candidate.aiReview.artifact })
}

if ($env:GITHUB_OUTPUT) {
    $outputs = @(
        'sha256_match=true'
        'ready=' + $ready.ToString().ToLowerInvariant()
        'pending_prepared=' + $pendingPrepared.ToString().ToLowerInvariant()
        'capture_path=' + $capturePathForCandidate
        'evidence_path=' + $pendingEvidencePath
        'capture_sha256=' + $pendingArtifact.sha256
        'stage2_refetch_sha256='
        'review_storage_sha256='
        'pending_evidence_source=capture-artifact'
        'review_scope=artifact-captured-visual'
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, $outputs + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{
    sha256Match=$true
    ready=$ready
    pendingPrepared=$pendingPrepared
    sent=$false
    captureSha256=$pendingArtifact.sha256
    stage2RefetchSha256=''
    reviewStorageSha256=''
    pendingEvidenceSource='capture-artifact'
    reviewScope='artifact-captured-visual'
}
