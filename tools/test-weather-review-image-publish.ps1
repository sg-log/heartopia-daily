$ErrorActionPreference = 'Stop'
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }

$root = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-review-publish-' + [guid]::NewGuid().ToString())
$artifactDirectory = Join-Path $root 'weather-x-embed-evidence-34865798800'
New-Item -ItemType Directory -Path $artifactDirectory | Out-Null
try {
    $mediaPath = Join-Path $artifactDirectory 'raw-media-0.png'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\assets\weather-templates\sun-day.png') -Destination $mediaPath
    $bytes = [IO.File]::ReadAllBytes($mediaPath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $capture = [ordered]@{
        status='captured';adapter='x-official-embed';capturedAt='2026-09-15T00:00:00.000Z'
        rawMedia=@([ordered]@{url='https://pbs.twimg.com/media/example?format=png&name=small';file='raw-media-0.png';mimeType='image/png';byteSize=$bytes.Length;sha256=$hash})
    }
    [IO.File]::WriteAllText((Join-Path $artifactDirectory 'capture.json'), ($capture|ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $global:weatherReviewStoredSha = $hash
    $global:weatherReviewPostCalls = 0
    function Invoke-WebRequest {
        param($Uri,$Method,[switch]$UseBasicParsing,$ContentType,$Body,$TimeoutSec,$ErrorAction)
        $global:weatherReviewPostCalls++
        $wire = [Text.UTF8Encoding]::new($false).GetString($Body) | ConvertFrom-Json
        Assert ($wire.action -eq 'weatherReviewImage' -and $wire.postKey -eq 'synthetic-post-key') 'Publisher uses the authenticated review action'
        Assert ($wire.image.sha256 -eq $hash -and $wire.image.bodyBase64 -eq [Convert]::ToBase64String($bytes)) 'Publisher sends the exact artifact raw media bytes'
        $data = [ordered]@{
            ok=$true;artifact=$wire.artifact;mediaFile=$wire.image.file;mimeType=$wire.image.mimeType;byteSize=$wire.image.byteSize
            captureSha256=$wire.image.sha256;reviewStoredSha256=$global:weatherReviewStoredSha
            reviewUrl=('https://script.google.com/macros/s/test-deployment/exec?reviewToken=' + ('A'*43));expiresAt='2026-09-15T12:34:56.789Z'
        }
        [pscustomobject]@{StatusCode=200;Headers=@{'Content-Type'='application/json'};Content=($data|ConvertTo-Json -Depth 10 -Compress)}
    }

    $resultPath = Join-Path $root 'result.json'
    $outputPath = Join-Path $root 'github-output.txt'
    $env:GITHUB_OUTPUT = $outputPath
    $env:WEATHER_POST_KEY = 'synthetic-post-key'
    & "$PSScriptRoot/weather-review-image-publish.ps1" `
        -ArtifactDirectory $root -ExpectedArtifactId '10357091608' `
        -ExpectedArtifactName 'weather-x-embed-evidence-34865798800' -ExpectedArtifactRunId '34865798800' `
        -ResultPath $resultPath | Out-Null
    $result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($result.sha256Match -and $result.reviewImages.Count -eq 1 -and $result.reviewImages[0].captureSha256 -eq $hash) 'Publisher returns a capture-bound review URL'
    Assert ($result.reviewImages[0].reviewStoredSha256 -eq $hash -and $result.reviewImages[0].reviewUrl -notmatch 'fileId|postKey|adminKey') 'Publisher requires the Apps Script stored SHA and exposes no protected ID or key'
    Assert ($global:weatherReviewPostCalls -eq 1 -and $null -eq $env:WEATHER_POST_KEY) 'Publisher makes one request and clears the environment secret'

    $global:weatherReviewStoredSha = '0' * 64
    $env:WEATHER_POST_KEY = 'synthetic-post-key'
    $failed = $false
    try {
        & "$PSScriptRoot/weather-review-image-publish.ps1" `
            -ArtifactDirectory $root -ExpectedArtifactId '10357091608' `
            -ExpectedArtifactName 'weather-x-embed-evidence-34865798800' -ExpectedArtifactRunId '34865798800' `
            -ResultPath $resultPath | Out-Null
    } catch { $failed = $true }
    Assert $failed 'Publisher fails closed when the Drive stored SHA differs'
    'PASS: trusted artifact raw media upload, protected response, capture/Drive SHA gate'
} finally {
    $env:GITHUB_OUTPUT = $null
    $env:WEATHER_POST_KEY = $null
    Remove-Variable -Scope Global -Name weatherReviewStoredSha,weatherReviewPostCalls -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
