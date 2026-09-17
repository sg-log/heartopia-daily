$ErrorActionPreference = 'Stop'

$script:calls = 0
$script:mode = 'success'
$script:lastUri = ''
$script:lastMethod = ''
function Invoke-WebRequest {
    param($Uri, $Method, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction)
    $script:calls++
    $script:lastUri = [string]$Uri
    $script:lastMethod = [string]$Method
    if ($script:mode -eq 'timeout') { throw 'synthetic network failure' }
    if ($script:mode -eq 'html') {
        return [pscustomobject]@{ StatusCode=200; Headers=@{'Content-Type'='text/html'}; Content='<html>no</html>' }
    }
    if ($script:mode -eq 'apiFalse') {
        return [pscustomobject]@{ StatusCode=200; Headers=@{'Content-Type'='application/json'}; Content='{"ok":false,"error":"synthetic"}' }
    }
    [pscustomobject]@{
        StatusCode = 200
        Headers = @{'Content-Type'='application/json; charset=utf-8'}
        Content = '{"ok":true,"reports":[{"date":"2026-09-17","startSlot":"00","slots":{"slot0":["雨"]},"weeks":{"week1":["晴"]}}]}'
    }
}

. "$PSScriptRoot/weather-submit.ps1"
. "$PSScriptRoot/weather-approved-public-read.ps1"

function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Assert-Throws([scriptblock]$action, $message) {
    $threw = $false
    try { & $action | Out-Null } catch { $threw = $true }
    Assert $threw $message
}

$call = Invoke-WeatherPublicApprovedRead -ApiUrl 'https://example.invalid/exec'
Assert ($call.data.ok -eq $true -and @($call.data.reports).Count -eq 1) 'Approved GET must return parsed reports.'
Assert ($script:calls -eq 1) 'Successful GET must run once.'
Assert ($script:lastMethod -eq 'Get') 'Approved lookup must use GET.'
Assert ($script:lastUri -eq 'https://example.invalid/exec?action=approved') 'Approved lookup must use only the public approved query.'
Assert ($script:lastUri -notmatch 'adminKey|postKey') 'No secret may appear in approved GET URL.'

$before = $script:calls
foreach ($badUrl in @('', 'http://example.invalid/exec', 'https://user:pass@example.invalid/exec', 'https://example.invalid/exec?x=1', 'https://example.invalid/exec#x')) {
    Assert-Throws { Invoke-WeatherPublicApprovedRead -ApiUrl $badUrl } 'Unsafe endpoint must fail before transport.'
}
Assert ($script:calls -eq $before) 'Unsafe endpoints must not reach transport.'

$script:mode = 'html'
$html = Invoke-WeatherPublicApprovedRead -ApiUrl 'https://example.invalid/exec'
Assert ($html.diagnostic.failureCode -eq 'htmlResponse') 'HTML response must fail closed.'

$script:mode = 'apiFalse'
$apiFalse = Invoke-WeatherPublicApprovedRead -ApiUrl 'https://example.invalid/exec'
Assert ($apiFalse.data.ok -eq $false) 'API false must remain visible to caller for fail-closed handling.'

$script:mode = 'timeout'
$prior = $script:calls
$timeout = Invoke-WeatherPublicApprovedRead -ApiUrl 'https://example.invalid/exec'
Assert ($timeout.diagnostic.failureCode -eq 'networkError') 'Network failure must be classified.'
Assert ($script:calls -eq $prior + 2) 'Only network failure gets one retry.'

Write-Host 'PASS: public approved lookup is GET-only, secret-free, and fail-closed.'
