$ErrorActionPreference = 'Stop'
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('weather-cloud-discovery-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $successCapture = Join-Path $testRoot 'success-capture.json'
    $successOutput = Join-Path $testRoot 'success-discovery.json'
    @{
        status = 'captured'
        sourceUrl = 'https://example.org/weather'
        finalUrl = 'https://example.org/weather'
        httpStatus = 200
        capturedAt = '2026-09-14T00:00:00.000Z'
        evidence = @{ sha256 = ('a' * 64) }
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $successCapture -Encoding UTF8
    & "$PSScriptRoot/weather-cloud-discovery.ps1" -CapturePath $successCapture -OutputPath $successOutput
    $success = Get-Content -LiteralPath $successOutput -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($success.sourceType -eq 'web' -and $success.retrievalStatus -eq 'confirmed') 'Generic Web capture becomes confirmed discovery.'
    Assert ($success.retrievalHistory[-1].evidence -match 'evidence SHA-256') 'Evidence artifact metadata is retained.'

    $failedCapture = Join-Path $testRoot 'failed-capture.json'
    $failedOutput = Join-Path $testRoot 'failed-discovery.json'
    @{
        status = 'failed'
        sourceUrl = 'https://x.com/example/status/123'
        finalUrl = 'https://x.com/example/status/123'
        httpStatus = 403
        capturedAt = '2026-09-14T00:01:00.000Z'
        failureCode = 'pageLoadFailed'
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $failedCapture -Encoding UTF8
    & "$PSScriptRoot/weather-cloud-discovery.ps1" -CapturePath $failedCapture -OutputPath $failedOutput
    $failed = Get-Content -LiteralPath $failedOutput -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($failed.sourceType -eq 'x' -and $failed.retrievalStatus -eq 'failed') 'Unavailable SNS capture uses the same discovery shape.'
    Assert ($failed.retrievalHistory[-1].evidence -match 'HTTP 403') 'Generic HTTP failure diagnostic is retained.'

    'PASS: cloud capture success and failure share the existing discovery candidate format'
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
