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
        [System.Security.SecureString] $PostKey,
        [AllowNull()] [object] $EvidenceImage
    )
    $payload = if ($null -ne $EvidenceImage) {
        if (-not (Get-Command ConvertTo-WeatherEvidencePendingPreview -ErrorAction SilentlyContinue)) {
            throw 'Load weather-evidence.ps1 before attaching evidence.'
        }
        (ConvertTo-WeatherEvidencePendingPreview -Candidate $Candidate -EvidenceImage $EvidenceImage).payload
    } else {
        ConvertTo-WeatherPendingPayload -Candidate $Candidate
    }
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

function Invoke-WeatherPrivateApiRequest {
    param(
        [Parameter(Mandatory)] [string] $ApiUrl,
        [Parameter(Mandatory)] [System.Security.SecureString] $AdminKey,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Payload
    )
    $uri = $null
    if (-not [uri]::TryCreate($ApiUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'WEATHER_SAFE:invalidEndpoint'
    }
    if ($AdminKey.Length -eq 0) { throw 'WEATHER_SAFE:emptyAdminKey' }
    $pointer = [IntPtr]::Zero
    $body = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminKey)
        $Payload['adminKey'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $body = [Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 8 -Compress))
        Invoke-RestMethod -Uri $uri.AbsoluteUri -Method Post `
            -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 30 -ErrorAction Stop
    } catch {
        throw 'WEATHER_SAFE:privateApiTransportFailed'
    } finally {
        $Payload.Remove('adminKey')
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($null -ne $body) { [Array]::Clear($body, 0, $body.Length) }
    }
}

function Get-WeatherPendingResponseFailureCode {
    param([AllowNull()] [object] $Response)
    if ($null -eq $Response) { return 'invalidPendingResponse' }
    if ($Response.ok -eq $true -and $null -ne $Response.reports) { return '' }
    if ($Response.ok -eq $false -and [string]$Response.error -match '認証') { return 'adminAuthenticationRejected' }
    if ($Response.ok -eq $false) { return 'pendingApiRejected' }
    'invalidPendingResponse'
}

function Invoke-WeatherEvidenceSubmissionInteractive {
    param(
        [Parameter(Mandatory)] [string] $CandidatePath,
        [Parameter(Mandatory)] [string] $EvidencePath,
        [Parameter(Mandatory)] [string] $CapturedAt,
        [ValidateSet('original','screenshot')] [string] $Kind = 'screenshot',
        [Parameter(Mandatory)] [string] $ResultPath
    )
    $result = [ordered]@{
        attempted = $false; apiSuccess = $false; driveSaved = $false
        pendingRegistered = $false; sha256Match = $false; imageRetrieved = $false
        duplicate = $false; stage = 'localValidation'; failureCode = ''
    }
    $apiInput = $null
    $postKey = $null
    $adminKey = $null
    $apiUrl = $null
    try {
        if (-not (Get-Command New-WeatherEvidenceImage -ErrorAction SilentlyContinue)) {
            throw 'Load weather-evidence.ps1 before interactive submission.'
        }
        $candidate = Get-Content -LiteralPath $CandidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $artifact = New-WeatherEvidenceImage -Path $EvidencePath -Kind $Kind -CapturedAt $CapturedAt
        $preview = ConvertTo-WeatherEvidencePendingPreview -Candidate $candidate -EvidenceImage $artifact
        Write-Host ('Ready: ' + $preview.payload.date + ' / ' + $preview.payload.startSlot +
            ' / evidence ' + $artifact.byteSize + ' bytes / SHA-256 verified.')

        $apiInput = Read-Host 'Existing weather API HTTPS URL (hidden)' -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($apiInput)
            $apiUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
        } finally {
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        }
        $postKey = Read-Host 'POST_KEY (hidden)' -AsSecureString
        $adminKey = Read-Host 'ADMIN_KEY (hidden; verification only)' -AsSecureString
        if ($postKey.Length -eq 0 -or $adminKey.Length -eq 0) { throw 'Keys are required.' }

        $result.stage = 'duplicateCheck'
        $pending = Invoke-WeatherPrivateApiRequest -ApiUrl $apiUrl -AdminKey $adminKey -Payload ([ordered]@{ action = 'pending' })
        $pendingFailure = Get-WeatherPendingResponseFailureCode $pending
        if ($pendingFailure) { throw ('WEATHER_SAFE:' + $pendingFailure) }
        $duplicate = @($pending.reports | Where-Object {
            $_.date -eq $preview.payload.date -and $_.startSlot -eq $preview.payload.startSlot -and
            $_.sourceUrl -ceq $preview.payload.sourceUrl
        }).Count -gt 0
        if ($duplicate) {
            $result.duplicate = $true
            $result.stage = 'duplicateFound'
            return [pscustomobject]$result
        }

        $identity = $preview.payload.date + '|' + $preview.payload.startSlot + '|' + $preview.payload.sourceUrl
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $attemptHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-', '')
        } finally { $sha.Dispose() }
        $marker = Join-Path ([IO.Path]::GetTempPath()) ('heartopia-send-attempt-' + $attemptHash + '.lock')
        if (Test-Path -LiteralPath $marker) { throw 'A prior attempt is recorded. Do not resend.' }
        $guard = [IO.File]::Open($marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $guard.Dispose()

        $result.attempted = $true
        $result.stage = 'submission'
        $receipt = Invoke-WeatherPendingSubmission -Candidate $candidate -EvidenceImage $artifact `
            -Send -ApiUrl $apiUrl -PostKey $postKey
        $result.apiSuccess = $true

        $result.stage = 'pendingVerification'
        $pending = Invoke-WeatherPrivateApiRequest -ApiUrl $apiUrl -AdminKey $adminKey -Payload ([ordered]@{ action = 'pending' })
        $report = @($pending.reports | Where-Object { $_.id -ceq $receipt.id })
        if ($pending.ok -ne $true -or $report.Count -ne 1 -or
            $report[0].date -ne $preview.payload.date -or $report[0].startSlot -ne $preview.payload.startSlot -or
            $report[0].sourceUrl -cne $preview.payload.sourceUrl) { throw 'Pending verification failed.' }
        foreach ($slot in 0..4) {
            if ((@($report[0].slots."slot$slot") -join ',') -cne (@($preview.payload.slots["slot$slot"]) -join ',')) {
                throw 'Pending slot verification failed.'
            }
        }
        if (($report[0] | ConvertTo-Json -Depth 20) -match '"fileId"') { throw 'Drive identifier exposure detected.' }
        $result.pendingRegistered = $true

        $result.stage = 'imageVerification'
        $image = Invoke-WeatherPrivateApiRequest -ApiUrl $apiUrl -AdminKey $adminKey -Payload `
            ([ordered]@{ action = 'weatherEvidence'; reportId = $receipt.id; imageIndex = 0 })
        if ($image.ok -ne $true -or $image.mimeType -ne $artifact.mimeType) { throw 'Evidence retrieval failed.' }
        $decoded = [Convert]::FromBase64String($image.bodyBase64)
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $receivedHash = ([BitConverter]::ToString($sha.ComputeHash($decoded))).Replace('-', '').ToLowerInvariant()
        } finally { $sha.Dispose() }
        if ($receivedHash -cne $artifact.sha256 -or $decoded.Length -ne $artifact.byteSize) {
            throw 'Stored evidence differs from reviewed evidence.'
        }
        $result.driveSaved = $true
        $result.sha256Match = $true
        $result.imageRetrieved = $true
        $result.stage = 'complete'
    } catch {
        if ($_.Exception.Message -match '^WEATHER_SAFE:([A-Za-z0-9]+)$') {
            $result.failureCode = $Matches[1]
        } else {
            $result.failureCode = 'localOrVerificationFailure'
        }
        $result['stopped'] = $true
        Write-Host 'Stopped safely. Do not resend. See the credential-free result.'
    } finally {
        foreach ($secret in @($postKey, $adminKey, $apiInput)) {
            if ($null -ne $secret) { $secret.Dispose() }
        }
        $apiUrl = $null
        $safeJson = ([pscustomobject]$result | ConvertTo-Json)
        [IO.File]::WriteAllText([IO.Path]::GetFullPath($ResultPath), $safeJson, [Text.UTF8Encoding]::new($false))
        Write-Host $safeJson
    }
}
