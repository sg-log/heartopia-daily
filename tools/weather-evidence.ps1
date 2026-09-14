# Local-only preview. No transport, Drive integration, or image recompression.
. "$PSScriptRoot/weather-submit.ps1"

function Read-WeatherEvidenceFile {
    param([Parameter(Mandatory)][string] $Path)
    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($file -isnot [IO.FileInfo]) { throw 'Evidence must be a local file.' }
    if ($file.Length -gt 524288) { throw "Evidence is $($file.Length) bytes; provisional limit is 524288 bytes. No compression performed." }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    if ($bytes.Length -gt 524288) { throw "Evidence is $($bytes.Length) bytes; provisional limit is 524288 bytes." }
    if ($env:OS -eq 'Windows_NT') {
        Add-Type -AssemblyName System.Drawing
        $stream = [IO.MemoryStream]::new($bytes, $false)
        $image = $null
        try {
            $image = [Drawing.Image]::FromStream($stream, $false, $true)
            $mime = if ($image.RawFormat.Guid -eq [Drawing.Imaging.ImageFormat]::Png.Guid) { 'image/png' }
                elseif ($image.RawFormat.Guid -eq [Drawing.Imaging.ImageFormat]::Jpeg.Guid) { 'image/jpeg' }
                else { throw 'Only decoded PNG or JPEG evidence is supported.' }
            if ([long]$image.Width * $image.Height -gt 16000000) { throw 'Evidence exceeds 16 megapixels.' }
        } finally {
            if ($null -ne $image) { $image.Dispose() }
            $stream.Dispose()
        }
    } else {
        $inspector = Join-Path $PSScriptRoot 'weather-evidence-inspect.mjs'
        $inspectionText = & node $inspector --path $file.FullName 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$inspectionText)) {
            throw 'Evidence could not be decoded by the cloud image inspector.'
        }
        try { $inspection = [string]$inspectionText | ConvertFrom-Json -ErrorAction Stop }
        catch { throw 'Evidence inspector returned an invalid result.' }
        if ($inspection.byteSize -ne $bytes.Length -or $inspection.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Evidence inspector metadata mismatch.'
        }
        $mime = [string]$inspection.mimeType
        if ($mime -notin @('image/png','image/jpeg')) { throw 'Only decoded PNG or JPEG evidence is supported.' }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    [pscustomobject]@{ localPath=$file.FullName; mimeType=$mime; byteSize=$bytes.Length; sha256=$hash; bytes=$bytes }
}

function New-WeatherEvidenceImage {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][ValidateSet('original','screenshot')][string] $Kind,
        [Parameter(Mandatory)][string] $CapturedAt
    )
    $time = ConvertTo-WeatherDiscoveryTime $CapturedAt
    $file = Read-WeatherEvidenceFile $Path
    # Local descriptor only. Never serialize it as a pending payload.
    [pscustomobject]@{ localPath=$file.localPath; mimeType=$file.mimeType; byteSize=$file.byteSize;
        sha256=$file.sha256; kind=$Kind; capturedAt=$time }
}

function ConvertTo-WeatherEvidencePendingPreview {
    param(
        [Parameter(Mandatory)][object] $Candidate,
        [Parameter(Mandatory)][object] $EvidenceImage
    )
    $payload = ConvertTo-WeatherPendingPayload $Candidate
    $reviewed = [string]$Candidate.hourlyForecast.evidence.reviewedImageSha256
    if ($reviewed -notmatch '^[a-fA-F0-9]{64}$' -or $reviewed -ne $EvidenceImage.sha256) {
        throw 'Record the saved image SHA-256 in hourly evidence only after reviewing that file.'
    }
    $file = Read-WeatherEvidenceFile $EvidenceImage.localPath
    if ($file.sha256 -ne $reviewed -or $file.byteSize -ne $EvidenceImage.byteSize -or $file.mimeType -ne $EvidenceImage.mimeType) {
        throw 'Evidence file changed after review; inspect the new file and repeat the forecast.'
    }
    if ($EvidenceImage.kind -notin @('original','screenshot')) { throw 'Invalid evidence kind.' }
    $capturedAt = ConvertTo-WeatherDiscoveryTime $EvidenceImage.capturedAt
    $discovery = Merge-WeatherDiscoveryCandidates @($Candidate.discovery)
    $payload['sourceType'] = $discovery.sourceType
    $payload['retrievedAt'] = $discovery.retrievalHistory[-1].retrievedAt
    $payload['evidenceImages'] = @([ordered]@{
        mimeType=$file.mimeType; byteSize=$file.byteSize; sha256=$file.sha256;
        kind=$EvidenceImage.kind; capturedAt=$capturedAt; bodyBase64=[Convert]::ToBase64String($file.bytes)
    })
    [pscustomobject]@{ status='preview'; sent=$false; payload=$payload }
}
