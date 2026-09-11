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
    Assert ((Get-WeatherPendingResponseFailureCode @{ok=$true;reports=@()}) -eq '') 'Valid empty pending response'
    Assert ((Get-WeatherPendingResponseFailureCode @{ok=$false;error='認証に失敗しました'}) -eq 'adminAuthFailed') 'Safe auth classification'
    Assert ((Get-WeatherPendingResponseFailureCode @{ok=$false;error='1行目の列名をREADME記載の順番に合わせてください'}) -eq 'sheetSchemaError') 'Safe sheet classification'
    Assert ((Get-WeatherPendingResponseFailureCode @{ok=$false;error='sensitive internal detail'}) -eq 'apiError') 'Safe API classification'
    Assert ((Get-WeatherPendingResponseFailureCode $null) -eq 'apiError') 'Safe invalid response classification'
    $validHttp = ConvertFrom-WeatherApiHttpResponse 200 'application/json; charset=utf-8' '{"ok":true,"reports":[]}'
    Assert ($validHttp.diagnostic.jsonParsed -and $validHttp.diagnostic.ok -and -not $validHttp.diagnostic.failureCode) 'HTTP JSON metadata'
    $htmlHttp = ConvertFrom-WeatherApiHttpResponse 200 'text/html; charset=utf-8' '<html>secret sentinel</html>'
    Assert ($htmlHttp.diagnostic.failureCode -eq 'htmlResponse' -and ($htmlHttp.diagnostic | ConvertTo-Json) -notmatch 'sentinel') 'HTML classified without body'
    $badJson = ConvertFrom-WeatherApiHttpResponse 502 'application/json' '{not json secret sentinel}'
    Assert ($badJson.diagnostic.failureCode -eq 'invalidJson' -and ($badJson.diagnostic | ConvertTo-Json) -notmatch 'sentinel') 'Invalid JSON classified without body'
    $authHttp = ConvertFrom-WeatherApiHttpResponse 200 'application/json' '{"ok":false,"error":"認証に失敗しました secret sentinel"}'
    Assert ($authHttp.diagnostic.failureCode -eq 'adminAuthFailed' -and ($authHttp.diagnostic | ConvertTo-Json) -notmatch 'sentinel') 'Auth classified without error body'
    $schemaHttp = ConvertFrom-WeatherApiHttpResponse 200 'application/json' '{"ok":false,"error":"Weather evidence columns conflict secret sentinel"}'
    Assert ($schemaHttp.diagnostic.failureCode -eq 'sheetSchemaError' -and ($schemaHttp.diagnostic | ConvertTo-Json) -notmatch 'sentinel') 'Schema classified without error body'
    $taggedHttp = ConvertFrom-WeatherApiHttpResponse 200 'application/json' '{"ok":false,"error":"safe","failureCode":"driveSaveError","stage":"driveSave"}'
    Assert ($taggedHttp.diagnostic.failureCode -eq 'driveSaveError' -and $taggedHttp.diagnostic.apiStage -eq 'driveSave') 'Allowlisted submit stage retained'
    $transportHttp = ConvertFrom-WeatherApiHttpResponse 0 '' ''
    Assert ($transportHttp.diagnostic.failureCode -eq 'networkError' -and -not $transportHttp.diagnostic.jsonParsed) 'No-response transport classified safely'
    $siteApiUrl = Get-WeatherApiUrlFromSiteConfig
    Assert ($siteApiUrl -match '^https://script\.google\.com/' -and $siteApiUrl -notmatch '[?#]') 'Existing public API URL reused from index'
    function Invoke-WebRequest {
        param($Uri, $Method, [switch]$UseBasicParsing, $ContentType, $Body, $TimeoutSec)
        $script:privateWire = [Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json
        [pscustomobject]@{
            StatusCode = 200
            Headers = @{'Content-Type'='application/json; charset=utf-8'}
            Content = '{"ok":true,"reports":[]}'
        }
    }
    $privateKey = ConvertTo-SecureString 'synthetic-admin-only' -AsPlainText -Force
    $privatePayload = [ordered]@{action='pending'}
    try { $privateCall = Invoke-WeatherPrivateApiRequest $siteApiUrl $privateKey $privatePayload }
    finally { $privateKey.Dispose() }
    Assert ($privateCall.diagnostic.httpStatus -eq 200 -and $privateCall.diagnostic.contentType -eq 'application/json') 'Private transport retains safe HTTP metadata'
    Assert ($privateCall.data.ok -and @($privateCall.data.reports).Count -eq 0) 'Private transport parses pending JSON'
    Assert (-not $privatePayload.Contains('adminKey') -and ($privateCall.diagnostic | ConvertTo-Json) -notmatch 'synthetic-admin-only') 'Private transport removes key and diagnostics omit it'
    'PASS: original/screenshot, exact hash binding, explicit one-call image transport, safe duplicate-check diagnostics, image validation'
} finally {
    foreach ($path in $paths) { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }
}
