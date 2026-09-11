$ErrorActionPreference = 'Stop'
# Reuse the existing synthetic candidate and network-forbidden transport mock.
. "$PSScriptRoot/test-weather-submit.ps1"
. "$PSScriptRoot/weather-evidence.ps1"
$paths = @()
try {
    Add-Type -AssemblyName System.Drawing
    $path = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.png')
    $paths += $path
    $bitmap = [Drawing.Bitmap]::new(32,32)
    try { $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
    foreach ($kind in @('original','screenshot')) {
        $artifact = New-WeatherEvidenceImage -Path $path -Kind $kind -CapturedAt '2026-09-11T06:00:00+09:00'
        $candidate = New-SubmissionSample
        # Synthetic review acknowledgement, not a claim of actual AI image recognition.
        $candidate.hourlyForecast.evidence.reviewedImageSha256 = $artifact.sha256
        $preview = ConvertTo-WeatherEvidencePendingPreview $candidate $artifact
        $decoded = [Convert]::FromBase64String($preview.payload.evidenceImages[0].bodyBase64)
        Assert ([Convert]::ToBase64String($decoded) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))) 'Exact bytes survive Base64'
        Assert ($preview.payload.sourceUrl -eq $candidate.sourceUrl -and $preview.payload.slots.slot0[0] -eq '晴') 'Source and slots preserved'
        $json = $preview.payload | ConvertTo-Json -Depth 20
        Assert ($json -notmatch 'localPath|postKey|adminKey|currentWeather|weeklyForecast') 'Payload whitelist'
        Assert ($preview.payload.evidenceImages.Count -eq 1 -and -not $preview.sent) 'One image and no send'
        $priorCalls = $script:calls
        $prepared = Invoke-WeatherPendingSubmission -Candidate $candidate -EvidenceImage $artifact
        Assert (-not $prepared.sent -and $script:calls -eq $priorCalls) 'Evidence preview never sends by default'
        $script:mode = 'pending'
        $key = ConvertTo-SecureString 'synthetic-test-only' -AsPlainText -Force
        try {
            $receipt = Invoke-WeatherPendingSubmission -Candidate $candidate -EvidenceImage $artifact `
                -Send -ApiUrl 'https://example.invalid/api' -PostKey $key
        } finally { $key.Dispose() }
        Assert ($receipt.sent -and $script:calls -eq $priorCalls + 1) 'Explicit evidence send calls transport exactly once'
        Assert ($script:wire.evidenceImages[0].sha256 -eq $artifact.sha256) 'Evidence reaches existing transport'
        $script:mode = 'forbid'
    }
    Assert-Throws { ConvertTo-WeatherEvidencePendingPreview $candidate $null } 'Missing image rejected'
    $candidate.hourlyForecast.evidence.reviewedImageSha256 = '0' * 64
    Assert-Throws { ConvertTo-WeatherEvidencePendingPreview $candidate $artifact } 'Unreviewed/different image rejected'
    $candidate.hourlyForecast.evidence.reviewedImageSha256 = $artifact.sha256
    [IO.File]::AppendAllText($path, 'changed')
    Assert-Throws { ConvertTo-WeatherEvidencePendingPreview $candidate $artifact } 'File changed after review rejected'
    $bad = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.png')
    $paths += $bad
    [IO.File]::WriteAllText($bad, '<svg></svg>')
    Assert-Throws { New-WeatherEvidenceImage $bad original '2026-09-11T06:00:00+09:00' } 'Invalid format rejected'
    [IO.File]::WriteAllBytes($bad, [byte[]]::new(524289))
    Assert-Throws { New-WeatherEvidenceImage $bad screenshot '2026-09-11T06:00:00+09:00' } 'Oversize rejected'
    'PASS: original/screenshot, exact hash binding, explicit one-call image transport, no image, invalid format, size limit, source/slots'
} finally {
    foreach ($path in $paths) { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }
}
