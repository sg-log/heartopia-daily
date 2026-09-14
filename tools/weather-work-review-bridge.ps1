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
$evidencePath = Join-Path $evidenceDirectory 'evidence.jpg'
if (-not [IO.File]::Exists($discoveryPath) -or -not [IO.File]::Exists($evidencePath)) {
    throw 'Downloaded artifact is missing discovery-candidate.json or evidence.jpg.'
}

$capture = Read-WeatherWorkJson $capturePath
if ($capture.status -cne 'captured' -or $null -eq $capture.evidence) { throw 'Confirmed capture evidence is required.' }
$kind = if ([string]$capture.evidence.kind -match 'screenshot$') { 'screenshot' } else { 'original' }
$artifact = New-WeatherEvidenceImage -Path $evidencePath -Kind $kind -CapturedAt ([string]$capture.evidence.capturedAt)
if ($artifact.sha256 -cne [string]$review.evidenceSha256 -or
    $artifact.sha256 -cne [string]$capture.evidence.sha256 -or
    $artifact.byteSize -ne [long]$capture.evidence.byteSize -or
    $artifact.mimeType -cne [string]$capture.evidence.mimeType) {
    throw 'Work review SHA-256 does not match the downloaded evidence image.'
}

$resultDirectory = Split-Path -Parent $CandidatePath
if ($resultDirectory) { New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null }
$interpretationPath = Join-Path $resultDirectory 'work-interpretation.json'
$interpretation = [ordered]@{
    status = 'completed'
    inputSha256 = $artifact.sha256
    model = 'work-visual-review'
    responseId = ''
    interpretation = $review.interpretation
}
Write-WeatherWorkJson $interpretationPath $interpretation

& "$PSScriptRoot/weather-ai-candidate.ps1" `
    -CapturePath $capturePath -DiscoveryPath $discoveryPath -InterpretationPath $interpretationPath `
    -EvidencePath $evidencePath -CandidatePath $CandidatePath -DryRunPath $DryRunPath | Out-Null

$candidate = Read-WeatherWorkJson $CandidatePath
$candidate.aiReview | Add-Member -NotePropertyName artifact -NotePropertyValue ([pscustomobject]@{
    runId = [string]$review.artifact.runId
    id = [string]$review.artifact.id
    name = [string]$review.artifact.name
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
        'capture_path=' + $capturePath
        'evidence_path=' + $evidencePath
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, $outputs + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{ sha256Match=$true; ready=$ready; pendingPrepared=$pendingPrepared; sent=$false }
