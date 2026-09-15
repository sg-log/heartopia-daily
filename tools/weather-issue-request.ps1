param(
    [Parameter(Mandatory)] [ValidateSet('Capture','Review')] [string] $Mode,
    [Parameter(Mandatory)] [string] $EventPath,
    [Parameter(Mandatory)] [string] $NormalizedPath
)

$ErrorActionPreference = 'Stop'

function Read-WeatherIssueJson {
    param([Parameter(Mandatory)] [string] $Path)
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $options = @{ InputObject=$json; ErrorAction='Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind='String' }
    ConvertFrom-Json @options
}

function Test-WeatherIssueExactProperties {
    param([Parameter(Mandatory)] [object] $Value, [Parameter(Mandatory)] [string[]] $Names)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IEnumerable]) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    $actual.Count -eq $expected.Count -and (($actual -join "`n") -ceq ($expected -join "`n"))
}

function Write-WeatherIssueOutput {
    param([Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] [string] $Value)
    if ($Value -match "[`r`n]") { throw 'Unsafe workflow output.' }
    if ($env:GITHUB_OUTPUT) {
        [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "$Name=$Value$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))
    }
}

$event = Read-WeatherIssueJson $EventPath
if ([string]$event.action -notin @('opened','reopened') -or [string]$event.repository.full_name -cne 'sg-log/heartopia-daily' -or
    [string]$event.issue.state -cne 'open' -or [string]$event.issue.user.login -cne 'sg-log' -or
    [string]$event.sender.login -cne 'sg-log' -or [string]$event.issue.author_association -cne 'OWNER' -or
    [long]$event.issue.number -le 0) {
    throw 'Unauthorized weather automation issue.'
}

$expectedTitle = if ($Mode -ceq 'Capture') { '[weather-capture-request]' } else { '[weather-review-result]' }
if ([string]$event.issue.title -cne $expectedTitle) { throw 'Invalid weather automation issue title.' }
$body = [string]$event.issue.body
if ([string]::IsNullOrWhiteSpace($body) -or [Text.UTF8Encoding]::new($false).GetByteCount($body) -gt 49152) {
    throw 'Invalid weather automation issue body.'
}

$parent = Split-Path -Parent $NormalizedPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
if ($Mode -ceq 'Capture') {
    try {
        $options = @{ InputObject=$body; ErrorAction='Stop' }
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind='String' }
        $request = ConvertFrom-Json @options
    } catch { throw 'Invalid capture request JSON.' }
    if (-not (Test-WeatherIssueExactProperties $request @('schemaVersion','requestType','adapter','sourceUrl')) -or
        $request.schemaVersion -ne 1 -or [string]$request.requestType -cne 'weather-evidence-capture' -or
        [string]$request.adapter -notin @('x-official-embed','direct-url')) {
        throw 'Invalid capture request shape.'
    }
    $sourceUrl = [string]$request.sourceUrl
    $uri = $null
    if ($sourceUrl.Length -gt 2048 -or $sourceUrl -match '[\x00-\x20\x7f]' -or
        -not [uri]::TryCreate($sourceUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'https' -or $uri.UserInfo -or -not $uri.IsDefaultPort -or $uri.Fragment) {
        throw 'Invalid capture request URL.'
    }
    if ([string]$request.adapter -ceq 'x-official-embed') {
        if ($uri.DnsSafeHost -notin @('x.com','www.x.com','twitter.com','www.twitter.com') -or
            $uri.AbsolutePath -notmatch '^/(?:i/status|[A-Za-z0-9_]+/status)/[0-9]+(?:/(?:photo|video)/[1-4])?/?$') {
            throw 'Invalid X capture request URL.'
        }
    } elseif ($uri.DnsSafeHost -match '(^localhost$|\.localhost$|\.local$|\.internal$)' -or
        [Net.IPAddress]::TryParse($uri.DnsSafeHost, [ref]([Net.IPAddress]$null))) {
        throw 'Invalid direct capture request host.'
    }
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($NormalizedPath), ($request | ConvertTo-Json -Depth 10) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-WeatherIssueOutput request_kind 'capture'
    Write-WeatherIssueOutput adapter ([string]$request.adapter)
    Write-WeatherIssueOutput source_url $sourceUrl
} else {
    $payload = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($body))
    $validatedReview = & "$PSScriptRoot/weather-review-request.ps1" -ReviewPayloadBase64 $payload -ReviewPath $NormalizedPath
    if ([string]$validatedReview.reviewMode -notin @('private-review-url-visual','artifact-raw-media-visual','artifact-captured-visual')) {
        throw 'Issue automation accepts only approved visual review results.'
    }
    Write-WeatherIssueOutput request_kind 'review'
    Write-WeatherIssueOutput review_payload_base64 $payload
}
Write-WeatherIssueOutput issue_number ([string]$event.issue.number)
[pscustomobject]@{ authorized=$true; mode=$Mode.ToLowerInvariant(); issueNumber=[long]$event.issue.number }
