param(
    [Parameter(Mandatory)] [string] $ReviewPayloadBase64,
    [Parameter(Mandatory)] [string] $ReviewPath
)

$ErrorActionPreference = 'Stop'

if ($ReviewPayloadBase64.Length -gt 65536 -or $ReviewPayloadBase64.Length % 4 -ne 0 -or
    $ReviewPayloadBase64 -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') {
    throw 'Invalid review envelope encoding.'
}
try {
    $bytes = [Convert]::FromBase64String($ReviewPayloadBase64)
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $json = $utf8.GetString($bytes)
    $options = @{ InputObject = $json; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    $review = ConvertFrom-Json @options
} catch {
    throw 'Invalid review envelope JSON.'
}

if ($review.schemaVersion -eq 4) {
    & "$PSScriptRoot/weather-artifact-review-request.ps1" -ReviewPayloadBase64 $ReviewPayloadBase64 -ReviewPath $ReviewPath
} else {
    & "$PSScriptRoot/weather-work-review-request.ps1" -ReviewPayloadBase64 $ReviewPayloadBase64 -ReviewPath $ReviewPath
}
