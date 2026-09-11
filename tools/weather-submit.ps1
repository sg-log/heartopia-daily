# Opt-in transport for the existing submit/pending API. Dot-sourcing performs no network I/O.
. "$PSScriptRoot/weather-candidate.ps1"
. "$PSScriptRoot/weather-discovery.ps1"

function ConvertTo-WeatherPendingPayload {
    param([Parameter(Mandatory)] [object] $Candidate)

    # Recheck direct retrieval and rebuild provenance; never trust a supplied dry-run payload.
    if ($null -eq $Candidate.discovery) { throw 'Confirmed discovery is required.' }
    $checked = ConvertTo-WeatherCandidateFromDiscovery -Discovery $Candidate.discovery `
        -CurrentWeather $Candidate.currentWeather -HourlyForecast $Candidate.hourlyForecast `
        -WeeklyForecast $Candidate.weeklyForecast
    $result = ConvertTo-SectionedWeatherReportDryRun -Candidate $checked
    $dry = $result.hourlyDryRun
    if ($result.hourlyForecast.status -ne 'ready' -or $dry.status -ne '登録可能候補' -or
        @($dry.issues).Count -ne 0 -or $null -eq $dry.payload) {
        throw 'Hourly forecast is not eligible: ready and an issue-free dry-run are required.'
    }

    # Preserve the existing minimal provenance/evidence memo; full discovery stays local.
    $memo = [string]$dry.payload.memo
    $ambiguities = @($result.hourlyForecast.evidence.textAmbiguities | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($ambiguities.Count) { $memo += ' 本文曖昧さ:' + ($ambiguities -join ' / ') }
    $memo += ' 時間別未解決:0 現在・週間:送信対象外'
    if ($memo.Length -gt 1000) { throw 'Pending memo exceeds 1000 characters; shorten evidence without dropping unresolved facts.' }

    # Allowlist: no candidate fields, current/weekly values, credentials or approval action.
    $slots = [ordered]@{}
    0..4 | ForEach-Object { $slots["slot$_"] = @($dry.payload.slots["slot$_"]) }
    $images = @($checked.hourlyForecast.evidence.sourceImageUrls | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
    if ($images.Count -gt 8) { throw 'At most eight source images are supported.' }
    foreach ($image in $images) {
        $imageUri = $null
        if ($image -isnot [string] -or $image.Length -gt 2000 -or
            -not [uri]::TryCreate($image, [UriKind]::Absolute, [ref]$imageUri) -or
            $imageUri.Scheme -notin @('http', 'https') -or $imageUri.UserInfo -or $imageUri.Fragment -or $image -match '[\s<>"\x27\\]') {
            throw 'Source images must be public HTTP(S) URLs without credentials or fragments.'
        }
    }
    [ordered]@{
        action = 'submit'; date = $dry.payload.date; startSlot = $dry.payload.startSlot
        slots = $slots; weeks = @{}; memo = $memo
        sourceUrl = $checked.sourceUrl; sourceImageUrls = @($images)
    }
}

function Invoke-WeatherPendingSubmission {
    param(
        [Parameter(Mandatory)] [object] $Candidate,
        [switch] $Send,
        [string] $ApiUrl,
        [System.Security.SecureString] $PostKey
    )
    $payload = ConvertTo-WeatherPendingPayload -Candidate $Candidate
    if (-not $Send) {
        return [pscustomobject]@{ status = 'prepared'; sent = $false; payload = $payload }
    }
    $uri = $null
    if (-not [uri]::TryCreate($ApiUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'Supply an HTTPS API URL without credentials, query or fragment.'
    }
    if ($null -eq $PostKey -or $PostKey.Length -eq 0) { throw 'Explicit PostKey is required for Send.' }

    $request = [ordered]@{}
    foreach ($key in $payload.Keys) { $request[$key] = $payload[$key] }
    $keyPointer = [IntPtr]::Zero
    $body = $null
    try {
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PostKey)
        $request['postKey'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        $body = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 10 -Compress))
        # No retry: a timeout can occur after the server already appended a pending row.
        $response = Invoke-RestMethod -Uri $uri.AbsoluteUri -Method Post `
            -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 30 -ErrorAction Stop
    } catch {
        # Never echo raw transport errors, request bodies or server error text containing secrets.
        throw 'Submission outcome unknown. Check pending manually before retrying; no automatic retry was made.'
    } finally {
        if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
        $request.Remove('postKey')
        if ($null -ne $body) { [Array]::Clear($body, 0, $body.Length) }
    }
    if ($response.ok -isnot [bool] -or $response.ok -ne $true -or
        $response.status -cne 'pending' -or [string]::IsNullOrWhiteSpace([string]$response.id)) {
        throw 'API did not confirm pending registration. Check pending manually before retrying.'
    }
    [pscustomobject]@{ status = 'pending'; sent = $true; id = [string]$response.id }
}
