# Preserve the private-config scripts by staging from a complete live clone.
# Never push from the public GitHub checkout.
param(
  [ValidateSet('Preview','Push')]
  [string]$Mode = 'Preview'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -LiteralPath (Join-Path $repoRoot '.clasp.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$scriptId = [string]$config.scriptId
if (-not $scriptId) { throw 'Missing scriptId.' }
$branch = (& git -C $repoRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'feat/weekly-ai-import-20261020') {
  throw 'Switch to feat/weekly-ai-import-20261020 before staging.'
}
$changes = @(& git -C $repoRoot status --porcelain -- apps-script/weather-api.gs)
if ($LASTEXITCODE -ne 0 -or $changes.Count -gt 0) {
  throw 'weather-api.gs has uncommitted changes. Stop.'
}
$code = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'apps-script/weather-api.gs'), [System.Text.Encoding]::UTF8)
foreach ($marker in @('if (action === "getWeeklyForecasts")', 'if (action === "saveWeeklyForecast")', 'function saveWeeklyForecast_(')) {
  if (-not $code.Contains($marker)) { throw "Weekly API missing: $marker" }
}
$stage = Join-Path $env:TEMP ('heartopia-safe-weekly-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$compareTemp = Join-Path $env:TEMP ('heartopia-weekly-compare-' + [guid]::NewGuid().ToString('N') + '.txt')
$required = @(
  'weather-api.js', 'weather-review-image.js', 'weather-scheduler.js',
  'weather-calendar.js', 'weather-history.js', 'weather-private-sources.js',
  'weather-calendar-private-config.js', 'weather-source-private-config.js',
  'gift-code-config.js', 'gift-code-parser.js', 'gift-code-storage.js',
  'gift-claim-backup.js', 'appsscript.json'
)
try {
  Push-Location $stage
  try {
    & npx.cmd --yes --package '@google/clasp' clasp clone-script $scriptId
    if ($LASTEXITCODE -ne 0) { throw 'Failed to clone live Apps Script. Nothing was pushed.' }
    foreach ($name in $required) {
      if (-not (Test-Path -LiteralPath (Join-Path $stage $name) -PathType Leaf)) {
        throw "Required live file missing: $name. Stop."
      }
    }
    $claspFile = Join-Path $stage '.clasp.json'
    if (-not (Test-Path -LiteralPath $claspFile)) { throw 'Clone did not create .clasp.json.' }
    $clonedId = [string]((Get-Content -LiteralPath $claspFile -Raw -Encoding UTF8 | ConvertFrom-Json).scriptId)
    if ($clonedId -ne $scriptId) { throw 'Cloned wrong Apps Script project. Stop.' }

    # Refuse to overwrite somebody else's newer remote editor changes.
    $liveApi = [System.IO.File]::ReadAllText((Join-Path $stage 'weather-api.js'), [System.Text.Encoding]::UTF8)
    $newline = [string][char]10
    $crlf = ([string][char]13) + $newline
    $liveApi = $liveApi.Replace($crlf, $newline).Replace(([string][char]13), $newline)
    [System.IO.File]::WriteAllText($compareTemp, $liveApi, (New-Object System.Text.UTF8Encoding($false)))
    $baseline = (& git -C $repoRoot rev-parse 'origin/main:apps-script/weather-api.gs').Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read origin/main baseline.' }
    $liveSha = (& git -C $repoRoot hash-object --no-filters $compareTemp).Trim()
    if ($LASTEXITCODE -ne 0 -or $liveSha -ne $baseline) {
      throw 'Google Apps Script weather-api changed since the audited baseline. Stop and reconcile.'
    }

    # Only replace the weekly API. Private files remain inside this local temp dir.
    $before = @{}
    foreach ($name in $required) {
      $before[$name] = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash
    }
    [System.IO.File]::WriteAllText((Join-Path $stage 'weather-api.js'), $code, (New-Object System.Text.UTF8Encoding($false)))
    $changed = @($required | Where-Object {
      (Get-FileHash -LiteralPath (Join-Path $stage $_) -Algorithm SHA256).Hash -ne $before[$_]
    })
    if ($changed.Count -ne 1 -or $changed[0] -ne 'weather-api.js') {
      throw ('Unexpected staged changes: ' + ($changed -join ', '))
    }
    Write-Host 'PREVIEW_OK: Complete 13-file remote clone; both private config files preserved.'
    Write-Host 'Only weather-api.js changed, adding the weekly endpoints.'
    Write-Host ('Private staging folder: ' + $stage)
    if ($Mode -eq 'Preview') {
      Write-Host 'No changes sent to Google. To push later, run again with -Mode Push.'
      return
    }
    $confirmation = Read-Host 'Type PUSH WEEKLY to update the Apps Script editor'
    if ($confirmation -cne 'PUSH WEEKLY') { throw 'Push cancelled.' }
    & npx.cmd --yes --package '@google/clasp' clasp push --force
    if ($LASTEXITCODE -ne 0) { throw 'Clasp push failed. Inspect the editor before retrying.' }
    Write-Host 'PUSH_OK: Apps Script editor updated. The /exec web app deployment is NOT updated.'
    Write-Host 'Deploy the existing web app version only after verifying its deployment ID.'
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $compareTemp -Force -ErrorAction SilentlyContinue
}
