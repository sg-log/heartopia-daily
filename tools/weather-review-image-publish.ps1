param(
    [Parameter(Mandatory)] [string] $ArtifactDirectory,
    [Parameter(Mandatory)] [string] $ExpectedArtifactId,
    [Parameter(Mandatory)] [string] $ExpectedArtifactName,
    [Parameter(Mandatory)] [string] $ExpectedArtifactRunId,
    [Parameter(Mandatory)] [string] $ResultPath
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-submit.ps1"

function Read-WeatherReviewPublishJson {
    param([Parameter(Mandatory)] [string] $Path)
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
}

function Test-WeatherReviewPublishExactProperties {
    param([Parameter(Mandatory)] [object] $Value, [Parameter(Mandatory)] [string[]] $Names)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IEnumerable]) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    $actual.Count -eq $expected.Count -and (($actual -join "`n") -ceq ($expected -join "`n"))
}

if ($ExpectedArtifactId -notmatch '^[1-9][0-9]{0,19}$' -or
    $ExpectedArtifactRunId -notmatch '^[1-9][0-9]{0,19}$' -or
    $ExpectedArtifactName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
    throw 'Invalid expected artifact identity.'
}
$artifactRoot = [IO.Path]::GetFullPath($ArtifactDirectory)
$captureFiles = @(Get-ChildItem -LiteralPath $artifactRoot -Recurse -File -Filter 'capture.json')
if ($captureFiles.Count -ne 1) { throw 'Review image artifact must contain exactly one capture.json.' }
$evidenceDirectory = $captureFiles[0].Directory.FullName
$capture = Read-WeatherReviewPublishJson $captureFiles[0].FullName
$rawMedia = @($capture.rawMedia)
if ($capture.status -cne 'captured' -or [string]$capture.adapter -cne 'x-official-embed' -or
    $rawMedia.Count -lt 1 -or $rawMedia.Count -gt 4) {
    throw 'Captured public X raw media is required.'
}

$apiUrl = Get-WeatherApiUrlFromSiteConfig
$postPlain = [string]$env:WEATHER_POST_KEY
$env:WEATHER_POST_KEY = $null
if ([string]::IsNullOrEmpty($postPlain)) { throw 'WEATHER_SAFE:missingPostKey' }
$postKey = ConvertTo-SecureString $postPlain -AsPlainText -Force
$postPlain = $null
$results = New-Object 'System.Collections.Generic.List[object]'
try {
    foreach ($media in $rawMedia) {
        if (-not (Test-WeatherReviewPublishExactProperties $media @('url','file','mimeType','byteSize','sha256')) -or
            [string]$media.url -notmatch '^https://pbs\.twimg\.com/' -or
            [string]$media.file -notmatch '^raw-media-[0-3]\.(?:jpg|png)$' -or
            [string]$media.mimeType -notin @('image/jpeg','image/png') -or
            [string]$media.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Invalid raw media metadata.'
        }
        $mediaPath = Join-Path $evidenceDirectory ([string]$media.file)
        $fileInfo = Get-Item -LiteralPath $mediaPath -ErrorAction Stop
        $bytes = [IO.File]::ReadAllBytes($fileInfo.FullName)
        if (-not $bytes.Length -or $bytes.Length -gt 524288) { throw 'Invalid raw media size.' }
        $unsigned = @($bytes | ForEach-Object { [int]$_ })
        $isPng = $bytes.Length -ge 45 -and ($unsigned[0..7] -join ',') -ceq '137,80,78,71,13,10,26,10' -and
            ($unsigned[12..15] -join ',') -ceq '73,72,68,82' -and ($unsigned[($bytes.Length-8)..($bytes.Length-5)] -join ',') -ceq '73,69,78,68'
        $isJpeg = $bytes.Length -ge 4 -and $unsigned[0] -eq 255 -and $unsigned[1] -eq 216 -and
            $unsigned[2] -eq 255 -and $unsigned[$bytes.Length-2] -eq 255 -and $unsigned[$bytes.Length-1] -eq 217
        $mimeType = if ($isPng) { 'image/png' } elseif ($isJpeg) { 'image/jpeg' } else { throw 'Raw media is not a validated PNG or JPEG.' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        $capturedAt = ConvertTo-WeatherDiscoveryTime ([string]$capture.capturedAt)
        $artifact = [pscustomobject]@{ localPath=$fileInfo.FullName;mimeType=$mimeType;byteSize=$bytes.Length;sha256=$hash;capturedAt=$capturedAt }
        if ($artifact.sha256 -cne [string]$media.sha256 -or $artifact.mimeType -cne [string]$media.mimeType -or
            $artifact.byteSize -ne [long]$media.byteSize) {
            throw 'Capture artifact raw media changed before review publication.'
        }

        $request = [ordered]@{
            action = 'weatherReviewImage'
            artifact = [ordered]@{ runId=$ExpectedArtifactRunId; id=$ExpectedArtifactId; name=$ExpectedArtifactName }
            image = [ordered]@{
                file = [string]$media.file
                mimeType = $artifact.mimeType
                byteSize = $artifact.byteSize
                sha256 = $artifact.sha256
                capturedAt = $artifact.capturedAt
                bodyBase64 = [Convert]::ToBase64String($bytes)
            }
        }
        $keyPointer = [IntPtr]::Zero
        $bodyBytes = $null
        try {
            $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($postKey)
            $request['postKey'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
            $bodyBytes = [Text.UTF8Encoding]::new($false).GetBytes(($request | ConvertTo-Json -Depth 12 -Compress))
            $call = Invoke-WeatherJsonHttpRequest -Uri ([uri]$apiUrl) -Body $bodyBytes
        } finally {
            if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
            $request.Remove('postKey')
            $request.image.bodyBase64 = ''
            if ($null -ne $bodyBytes) { [Array]::Clear($bodyBytes, 0, $bodyBytes.Length) }
        }
        if ($call.diagnostic.failureCode -or $call.data.ok -ne $true) { throw 'Review image API rejected the captured raw media.' }
        $responseJson = $call.data | ConvertTo-Json -Depth 10 -Compress
        if ($responseJson -match '(?i)postKey|adminKey|fileId') { throw 'Review image API response exposed a protected value.' }
        $reviewUri = $null
        if (-not [uri]::TryCreate([string]$call.data.reviewUrl, [UriKind]::Absolute, [ref]$reviewUri) -or
            $reviewUri.Scheme -cne 'https' -or $reviewUri.DnsSafeHost -cne 'script.google.com' -or
            $reviewUri.AbsolutePath -notmatch '^/macros/s/[A-Za-z0-9_-]+/(?:exec|dev)$' -or
            $reviewUri.Query -notmatch '^\?reviewToken=[A-Za-z0-9_-]{43}$' -or $reviewUri.Fragment) {
            throw 'Review image API returned an invalid review URL.'
        }
        $imageMismatch = @()
        if ([string]$call.data.mediaFile -cne [string]$media.file) { $imageMismatch += 'file' }
        if ([string]$call.data.mimeType -cne $artifact.mimeType) { $imageMismatch += 'mime' }
        if ([long]$call.data.byteSize -ne $artifact.byteSize) { $imageMismatch += 'size' }
        if ([string]$call.data.captureSha256 -cne $artifact.sha256) { $imageMismatch += 'captureSha' }
        if ([string]$call.data.reviewStoredSha256 -cne $artifact.sha256) { $imageMismatch += 'storedSha' }
        if ($imageMismatch.Count) { throw ('Review image API returned mismatched image metadata: ' + ($imageMismatch -join ',')) }
        if ([string]$call.data.artifact.runId -cne $ExpectedArtifactRunId -or
            [string]$call.data.artifact.id -cne $ExpectedArtifactId -or
            [string]$call.data.artifact.name -cne $ExpectedArtifactName) {
            throw 'Review image API returned mismatched artifact metadata.'
        }
        if ([string]$call.data.expiresAt -notmatch '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T') {
            throw 'Review image API returned an invalid expiry.'
        }
        $results.Add([pscustomobject][ordered]@{
            file=[string]$media.file;mimeType=$artifact.mimeType;byteSize=$artifact.byteSize
            captureSha256=$artifact.sha256;reviewStoredSha256=[string]$call.data.reviewStoredSha256
            reviewUrl=$reviewUri.AbsoluteUri;expiresAt=[string]$call.data.expiresAt
        })
    }
} finally {
    $postKey.Dispose()
}

$result = [ordered]@{
    schemaVersion=1;artifact=[ordered]@{runId=$ExpectedArtifactRunId;id=$ExpectedArtifactId;name=$ExpectedArtifactName}
    reviewImages=@($results.ToArray());sha256Match=$true
}
$parent = Split-Path -Parent $ResultPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ResultPath), ($result | ConvertTo-Json -Depth 20) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
if ($env:GITHUB_OUTPUT) {
    $json = ConvertTo-Json -InputObject @($results.ToArray()) -Depth 10 -Compress
    $encoded = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($json))
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "review_images_base64=$encoded$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{ published=$results.Count; sha256Match=$true }
