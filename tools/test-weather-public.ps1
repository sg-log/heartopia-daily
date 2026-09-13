$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$api = [IO.File]::ReadAllText((Join-Path $root 'apps-script/weather-api.gs'))
$page = [IO.File]::ReadAllText((Join-Path $root 'index.html'))

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

$publicItem = [regex]::Match($api, '(?s)function publicWeatherItem_\(item\)\s*\{.*?\n\}').Value
Assert-True ($publicItem.Length -gt 0) 'publicWeatherItem_ was not found'
foreach ($field in @('memo', 'sourceUrl', 'sourceImageUrls', 'sourceType', 'sourceId', 'retrievedAt', 'evidenceStatus', 'evidenceImages')) {
    Assert-True (-not $publicItem.Contains($field)) "public weather response exposes $field"
}
foreach ($field in @('date:', 'startSlot:', 'slots:', 'weeks:')) {
    Assert-True ($publicItem.Contains($field)) "public weather response is missing $field"
}
Assert-True ($api.Contains('listByStatus_("approved").map(publicWeatherItem_)')) 'public approved endpoint does not apply redaction'
Assert-True ($api.Contains('return json_({ ok: true, reports: listByStatus_("approved") });')) 'authenticated approved endpoint no longer returns review data'

$renderWeather = [regex]::Match($page, '(?s)function renderWeather\(date, w\)\{.*?\n\}').Value
$renderSummary = [regex]::Match($page, '(?s)function renderWeatherSummary\(\)\{.*?\n\}').Value
Assert-True ($renderWeather.Length -gt 0 -and $renderSummary.Length -gt 0) 'public weather renderers were not found'
Assert-True (-not $renderWeather.Contains('.memo')) 'public today weather card renders memo'
Assert-True (-not $renderSummary.Contains('.memo')) 'public today weather summary renders memo'
Assert-True ($page.Contains('class="pendingWeatherMemo"')) 'pending review memo display was removed'
Assert-True ($page.Contains('data-approve-weather=') -and $page.Contains('data-reject-weather=')) 'pending approval actions were removed'

Write-Output 'PASS: public weather API and today cards expose weather only; authenticated review metadata remains available.'
