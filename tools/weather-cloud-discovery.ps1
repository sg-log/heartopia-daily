param(
    [Parameter(Mandatory)] [string] $CapturePath,
    [Parameter(Mandatory)] [string] $OutputPath,
    [string] $DiscoverySource = 'github-actions-url',
    [string] $SearchQuery = 'workflow_dispatch direct URL'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-discovery.ps1"

$captureJson = Get-Content -LiteralPath $CapturePath -Raw -Encoding UTF8
$jsonOptions = @{ InputObject = $captureJson }
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
    # PowerShell 7.5 otherwise converts ISO strings to DateTime and drops their text form.
    $jsonOptions.DateKind = 'String'
}
$capture = ConvertFrom-Json @jsonOptions
if ($capture.status -notin @('captured', 'failed')) { throw 'Unsupported capture status.' }
if ([string]::IsNullOrWhiteSpace([string]$capture.sourceUrl) -or
    [string]::IsNullOrWhiteSpace([string]$capture.capturedAt)) {
    throw 'Capture sourceUrl and capturedAt are required.'
}

$candidate = New-WeatherDiscoveryCandidate `
    -DiscoverySource $DiscoverySource `
    -SearchQuery $SearchQuery `
    -DiscoveredAt ([string]$capture.capturedAt) `
    -SourceUrl ([string]$capture.sourceUrl)

$retrievedUrl = if ([string]::IsNullOrWhiteSpace([string]$capture.finalUrl)) {
    [string]$capture.sourceUrl
} else {
    [string]$capture.finalUrl
}

if ($capture.status -eq 'captured') {
    if ($null -eq $capture.evidence -or [string]::IsNullOrWhiteSpace([string]$capture.evidence.sha256)) {
        throw 'Captured result requires evidence metadata.'
    }
    $status = 'confirmed'
    $evidence = 'GitHub Actions direct-page.png and evidence.jpg artifact; evidence SHA-256 ' + [string]$capture.evidence.sha256
} else {
    $status = 'failed'
    $http = if ([int]$capture.httpStatus -gt 0) { 'HTTP ' + [string]$capture.httpStatus } else { 'no HTTP response' }
    $code = if ([string]::IsNullOrWhiteSpace([string]$capture.failureCode)) { 'captureFailed' } else { [string]$capture.failureCode }
    $evidence = 'GitHub-hosted Playwright retrieval failed: ' + $code + ' (' + $http + '); no direct content confirmation.'
}

$result = Add-WeatherDiscoveryRetrieval `
    -Candidate $candidate `
    -Status $status `
    -RetrievedAt ([string]$capture.capturedAt) `
    -RetrievedUrl $retrievedUrl `
    -Evidence $evidence

$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$json = $result | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText(
    [System.IO.Path]::GetFullPath($OutputPath),
    $json + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)
