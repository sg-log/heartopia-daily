param(
    [Parameter(Mandatory)] [string] $EventPath,
    [Parameter(Mandatory)] [string] $NormalizedPath
)

$ErrorActionPreference = 'Stop'

function Read-Json([string]$Path) {
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $options = @{ InputObject=$raw; ErrorAction='Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind='String' }
    ConvertFrom-Json @options
}

function Test-ExactProperties($Value, [string[]]$Names) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IEnumerable]) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    $actual.Count -eq $expected.Count -and (($actual -join "`n") -ceq ($expected -join "`n"))
}

function Write-OutputValue([string]$Name, [string]$Value) {
    if ($Value -match "[`r`n]") { throw 'Unsafe workflow output.' }
    if ($env:GITHUB_OUTPUT) {
        [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "$Name=$Value$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))
    }
}

$event = Read-Json $EventPath
if ([string]$event.action -cne 'opened' -or [string]$event.repository.full_name -cne 'sg-log/heartopia-daily' -or
    [string]$event.issue.state -cne 'open' -or [string]$event.issue.title -cne '[weather-discovery-request]' -or
    [string]$event.issue.user.login -cne 'sg-log' -or [string]$event.sender.login -cne 'sg-log' -or
    [string]$event.issue.author_association -cne 'OWNER' -or [long]$event.issue.number -le 0) {
    throw 'Unauthorized weather discovery issue.'
}

$body = [string]$event.issue.body
if ([string]::IsNullOrWhiteSpace($body) -or [Text.UTF8Encoding]::new($false).GetByteCount($body) -gt 4096) {
    throw 'Invalid weather discovery issue body.'
}
try {
    $options = @{ InputObject=$body; ErrorAction='Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind='String' }
    $request = ConvertFrom-Json @options
} catch { throw 'Invalid weather discovery request JSON.' }

if (-not (Test-ExactProperties $request @('schemaVersion','requestType','targetDate')) -or
    $request.schemaVersion -ne 1 -or [string]$request.requestType -cne 'weather-public-discovery' -or
    [string]$request.targetDate -notmatch '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$') {
    throw 'Invalid weather discovery request shape.'
}
try { [void][datetime]::ParseExact([string]$request.targetDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
catch { throw 'Invalid weather discovery target date.' }

$parent = Split-Path -Parent $NormalizedPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($NormalizedPath), ($request | ConvertTo-Json -Depth 10) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-OutputValue target_date ([string]$request.targetDate)
Write-OutputValue issue_number ([string]$event.issue.number)
[pscustomobject]@{ authorized=$true; targetDate=[string]$request.targetDate; issueNumber=[long]$event.issue.number }
