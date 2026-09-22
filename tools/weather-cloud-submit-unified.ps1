param(
    [Parameter(Mandatory)] [string] $CandidatePath,
    [Parameter(Mandatory)] [string] $CapturePath,
    [Parameter(Mandatory)] [string] $EvidencePath,
    [Parameter(Mandatory)] [string] $ReviewPath,
    [Parameter(Mandatory)] [string] $ResultPath
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"
. "$PSScriptRoot/weather-approved-public-read.ps1"

function Read-UnifiedJson {
    param([Parameter(Mandatory)] [string] $Path)
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $options = @{ InputObject = $json; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    ConvertFrom-Json @options
}

function Get-UnifiedWeeks {
    param([Parameter(Mandatory)] [object] $Review, [Parameter(Mandatory)] [string] $BaseDate)
    if ($Review.schemaVersion -ne 4 -or $Review.interpretation.ready -ne $true) { throw 'WEATHER_SAFE:weeklyReviewNotReady' }
    if ([string]$Review.interpretation.observedDate -cne $BaseDate) { throw 'WEATHER_SAFE:weeklyBaseDateMismatch' }
    $days = @($Review.interpretation.weeklyDays | Where-Object { $null -ne $_ })
    if ($days.Count -gt 0 -and ($days.Count -lt 5 -or $days.Count -gt 7)) { throw 'WEATHER_SAFE:weeklyReviewNotReady' }
    $allowed = @('晴','雨','流星群','虹','猛暑','雪','桜')
    $base = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($BaseDate, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$base)) {
        throw 'WEATHER_SAFE:weeklyBaseDateMismatch'
    }
    $weeks = [ordered]@{}
    1..7 | ForEach-Object { $weeks["week$_"] = @() }
    if ($days.Count -eq 0) { return [pscustomobject]@{ weeks = $weeks; count = 0 } }
    for ($index = 0; $index -lt $days.Count; $index++) {
        $day = $days[$index]
        $expected = $base.AddDays($index + 1).ToString('yyyy-MM-dd')
        if ([string]$day.date -cne $expected -or $day.visible -ne $true -or [string]$day.confidence -cne 'high') {
            throw 'WEATHER_SAFE:weeklyReviewNotReady'
        }
        $values = @($day.weather | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
        if (-not $values.Count -or $values.Count -gt 4 -or @($values | Where-Object { $_ -notin $allowed }).Count) {
            throw 'WEATHER_SAFE:weeklyReviewNotReady'
        }
        $weeks["week$($index + 1)"] = @($values)
    }
    [pscustomobject]@{ weeks = $weeks; count = $days.Count }
}

function Test-UnifiedWeatherMatch {
    param(
        [Parameter(Mandatory)] [object] $Report,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Payload,
        [bool] $IgnoreWeeks = $false
    )
    if ([string]$Report.date -cne [string]$Payload.date -or [string]$Report.startSlot -cne [string]$Payload.startSlot) { return $false }
    foreach ($index in 0..4) {
        if ((@($Report.slots."slot$index") -join ',') -cne (@($Payload.slots["slot$index"]) -join ',')) { return $false }
    }
    if (-not $IgnoreWeeks) {
        foreach ($index in 1..7) {
            $reportWeek = if ($null -eq $Report.weeks) { @() } else { @($Report.weeks."week$index") }
            $payloadWeek = if ($null -eq $Payload.weeks) { @() } else { @($Payload.weeks["week$index"]) }
            if (($reportWeek -join ',') -cne ($payloadWeek -join ',')) { return $false }
        }
    }
    $true
}

function Test-UnifiedReportMatch {
    param(
        [Parameter(Mandatory)] [object] $Report,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Payload,
        [bool] $IgnoreWeeks = $false
    )
    (Test-UnifiedWeatherMatch $Report $Payload -IgnoreWeeks:$IgnoreWeeks) -and [string]$Report.sourceUrl -ceq [string]$Payload.sourceUrl
}

function Invoke-UnifiedPrivateRead {
    param(
        [Parameter(Mandatory)] [string] $ApiUrl,
        [Parameter(Mandatory)] [Security.SecureString] $AdminKey,
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Payload
    )
    $last = $null
    foreach ($attempt in 1..2) {
        $copy = [ordered]@{}
        foreach ($key in $Payload.Keys) { $copy[$key] = $Payload[$key] }
        $last = Invoke-WeatherPrivateApiRequest -ApiUrl $ApiUrl -AdminKey $AdminKey -Payload $copy
        if (-not $last.diagnostic.failureCode) { return $last }
        if ([string]$last.diagnostic.failureCode -cne 'networkError' -or $attempt -eq 2) { return $last }
        Start-Sleep -Seconds 2
    }
    $last
}

function Confirm-UnifiedStoredEvidence {
    param(
        [Parameter(Mandatory)] [object] $Report,
        [Parameter(Mandatory)] [object] $Artifact,
        [Parameter(Mandatory)] [string] $ApiUrl,
        [Parameter(Mandatory)] [Security.SecureString] $AdminKey
    )
    if ([string]$Report.evidenceStatus -cne 'saved' -or @($Report.evidenceImages).Count -ne 1 -or
        [string]$Report.evidenceImages[0].sha256 -cne [string]$Artifact.sha256) { return $false }
    $call = Invoke-UnifiedPrivateRead -ApiUrl $ApiUrl -AdminKey $AdminKey `
        -Payload ([ordered]@{ action='weatherEvidence'; reportId=[string]$Report.id; imageIndex=0 })
    if ($call.diagnostic.failureCode -or $call.data.ok -ne $true -or [string]$call.data.mimeType -cne [string]$Artifact.mimeType) { return $false }
    try { $bytes = [Convert]::FromBase64String([string]$call.data.bodyBase64) } catch { return $false }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $hash -ceq [string]$Artifact.sha256 -and $bytes.Length -eq [long]$Artifact.byteSize
}

function Invoke-UnifiedPendingPost {
    param(
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Payload,
        [Parameter(Mandatory)] [string] $ApiUrl,
        [Parameter(Mandatory)] [Security.SecureString] $PostKey
    )
    $uri = [uri]$ApiUrl
    $request = [ordered]@{}
    foreach ($key in $Payload.Keys) { $request[$key] = $Payload[$key] }
    $pointer = [IntPtr]::Zero
    $body = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($PostKey)
        $request['postKey'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $body = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 12 -Compress))
        $call = Invoke-WeatherJsonHttpRequest -Uri $uri -Body $body
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $request.Remove('postKey')
        if ($null -ne $body) { [Array]::Clear($body, 0, $body.Length) }
    }
    if ($call.diagnostic.failureCode) { Throw-WeatherApiDiagnostic $call.diagnostic }
    if ($call.data.ok -ne $true -or [string]$call.data.status -cne 'pending' -or [string]::IsNullOrWhiteSpace([string]$call.data.id)) {
        throw 'WEATHER_SAFE:invalidApiResponse'
    }
    [pscustomobject]@{ id=[string]$call.data.id; duplicate=($call.data.duplicate -eq $true); diagnostic=$call.diagnostic }
}

function Find-UnifiedPendingAfterNetworkError {
    param(
        [Parameter(Mandatory)] [System.Collections.IDictionary] $Payload,
        [Parameter(Mandatory)] [object] $Artifact,
        [Parameter(Mandatory)] [string] $ApiUrl,
        [Parameter(Mandatory)] [Security.SecureString] $AdminKey,
        [bool] $IgnoreWeeks = $false
    )
    $sawExactReport = $false
    foreach ($delaySeconds in @(0, 2, 4)) {
        if ($delaySeconds -gt 0) { Start-Sleep -Seconds $delaySeconds }
        $call = Invoke-UnifiedPrivateRead -ApiUrl $ApiUrl -AdminKey $AdminKey -Payload ([ordered]@{action='pending'})
        if ($call.diagnostic.failureCode) {
            if ([string]$call.diagnostic.failureCode -ceq 'networkError') { continue }
            throw 'WEATHER_SAFE:pendingLookupFailed'
        }
        if ($call.data.ok -ne $true) { throw 'WEATHER_SAFE:pendingLookupFailed' }
        $matches = @($call.data.reports | Where-Object { Test-UnifiedReportMatch $_ $Payload -IgnoreWeeks:$IgnoreWeeks })
        if ($matches.Count -gt 1) { throw 'WEATHER_SAFE:duplicateConflict' }
        if ($matches.Count -eq 1) {
            $sawExactReport = $true
            if (Confirm-UnifiedStoredEvidence $matches[0] $Artifact $ApiUrl $AdminKey) { return $matches[0] }
        }
    }
    if ($sawExactReport) { throw 'WEATHER_SAFE:evidenceVerificationFailed' }
    $null
}

$result = [ordered]@{
    attempted=$false; apiSuccess=$false; driveSaved=$false; pendingRegistered=$false
    sha256Match=$false; imageRetrieved=$false; duplicate=$false; reportId=''
    stage='localValidation'; failureCode=''; weeklyCount=0
}
$postKey = $null
$adminKey = $null
$failure = $false
try {
    $candidate = Read-UnifiedJson $CandidatePath
    $capture = Read-UnifiedJson $CapturePath
    $review = Read-UnifiedJson $ReviewPath
    if ($capture.status -cne 'captured' -or $null -eq $capture.evidence) { throw 'WEATHER_SAFE:captureNotConfirmed' }
    $kind = if ([string]$capture.evidence.kind -match 'screenshot$') { 'screenshot' } else { 'original' }
    $artifact = New-WeatherEvidenceImage -Path $EvidencePath -Kind $kind -CapturedAt ([string]$capture.evidence.capturedAt)
    if ($artifact.sha256 -cne [string]$capture.evidence.sha256 -or $artifact.byteSize -ne [long]$capture.evidence.byteSize -or $artifact.mimeType -cne [string]$capture.evidence.mimeType) {
        throw 'WEATHER_SAFE:evidenceChanged'
    }
    $reviewed = @($review.reviewedImages | Where-Object { [string]$_.file -ceq [string]$review.pendingEvidenceFile })
    if ($reviewed.Count -ne 1 -or [string]$reviewed[0].captureSha256 -cne [string]$artifact.sha256) { throw 'WEATHER_SAFE:evidenceMismatch' }

    $preview = ConvertTo-WeatherEvidencePendingPreview -Candidate $candidate -EvidenceImage $artifact
    $weekly = Get-UnifiedWeeks -Review $review -BaseDate ([string]$candidate.hourlyForecast.observedDate)
    $preview.payload.weeks = $weekly.weeks
    $result.weeklyCount = $weekly.count
    $ignoreWeeksForDuplicate = $weekly.count -eq 0
    $weeklyMemo = if ($weekly.count -gt 0) { "週間:$($weekly.count)日判読済み" } else { 'デイリーのみ（週間は既存維持）' }
    $preview.payload.memo = ([string]$preview.payload.memo).Replace('現在・週間:送信対象外', $weeklyMemo)
    $weeklySourceUrl = [string]$review.sources.weekly.sourceUrl
    if ($weekly.count -gt 0 -and -not [string]::IsNullOrWhiteSpace($weeklySourceUrl) -and $weeklySourceUrl -cne [string]$preview.payload.sourceUrl) {
        $preview.payload.memo = (([string]$preview.payload.memo).Trim() + " 週間別出典:$weeklySourceUrl").Trim()
    }
    if (([string]$preview.payload.memo).Length -gt 1000) { throw 'WEATHER_SAFE:memoTooLong' }

    $apiUrl = Get-WeatherApiUrlFromSiteConfig
    $postPlain = [string]$env:WEATHER_POST_KEY
    $adminPlain = [string]$env:WEATHER_ADMIN_KEY
    $env:WEATHER_POST_KEY = $null
    $env:WEATHER_ADMIN_KEY = $null
    if ([string]::IsNullOrEmpty($postPlain) -or [string]::IsNullOrEmpty($adminPlain)) { throw 'WEATHER_SAFE:missingKeys' }
    $postKey = ConvertTo-SecureString $postPlain -AsPlainText -Force
    $adminKey = ConvertTo-SecureString $adminPlain -AsPlainText -Force
    $postPlain = $null
    $adminPlain = $null

    $result.stage = 'duplicateCheck'
    $pendingCall = Invoke-UnifiedPrivateRead -ApiUrl $apiUrl -AdminKey $adminKey -Payload ([ordered]@{action='pending'})
    if ($pendingCall.diagnostic.failureCode -or $pendingCall.data.ok -ne $true) { throw 'WEATHER_SAFE:pendingLookupFailed' }
    $pendingReports = @($pendingCall.data.reports)
    $sameSource = @($pendingReports | Where-Object {
        [string]$_.date -ceq [string]$preview.payload.date -and [string]$_.startSlot -ceq [string]$preview.payload.startSlot -and [string]$_.sourceUrl -ceq [string]$preview.payload.sourceUrl
    })
    if ($sameSource.Count -gt 1) { throw 'WEATHER_SAFE:duplicateConflict' }
    if ($sameSource.Count -eq 1) {
        if (-not (Test-UnifiedReportMatch $sameSource[0] $preview.payload -IgnoreWeeks:$ignoreWeeksForDuplicate)) { throw 'WEATHER_SAFE:duplicateConflict' }
        if (-not (Confirm-UnifiedStoredEvidence $sameSource[0] $artifact $apiUrl $adminKey)) { throw 'WEATHER_SAFE:duplicateConflict' }
        $result.duplicate=$true; $result.reportId=[string]$sameSource[0].id; $result.apiSuccess=$true
        $result.driveSaved=$true; $result.pendingRegistered=$true; $result.sha256Match=$true; $result.imageRetrieved=$true; $result.stage='complete'
    } else {
        $contentPending = @($pendingReports | Where-Object { Test-UnifiedWeatherMatch $_ $preview.payload -IgnoreWeeks:$ignoreWeeksForDuplicate })
        if ($contentPending.Count) {
            $result.duplicate=$true; $result.reportId=[string]$contentPending[0].id; $result.apiSuccess=$true; $result.pendingRegistered=$true; $result.stage='contentDuplicatePending'
        } else {
            $approvedCall = Invoke-WeatherPublicApprovedRead -ApiUrl $apiUrl
            if ($approvedCall.diagnostic.failureCode -or $approvedCall.data.ok -ne $true) { throw 'WEATHER_SAFE:approvedLookupFailed' }
            $contentApproved = @($approvedCall.data.reports | Where-Object { Test-UnifiedWeatherMatch $_ $preview.payload -IgnoreWeeks:$ignoreWeeksForDuplicate })
            if ($contentApproved.Count) {
                $result.duplicate=$true; $result.reportId=''; $result.apiSuccess=$true; $result.stage='contentDuplicateApproved'
            } else {
                $result.attempted = $true
                $result.stage = 'submission'
                $receipt = $null
                try {
                    $receipt = Invoke-UnifiedPendingPost -Payload $preview.payload -ApiUrl $apiUrl -PostKey $postKey
                } catch {
                    if ($_.Exception.Message -cne 'WEATHER_SAFE:networkError') { throw }
                    # Ambiguous timeout: never POST again. The server may already have committed the pending row.
                    $result.stage = 'submissionRecovery'
                    $recovered = Find-UnifiedPendingAfterNetworkError -Payload $preview.payload -Artifact $artifact -ApiUrl $apiUrl -AdminKey $adminKey -IgnoreWeeks:$ignoreWeeksForDuplicate
                    if ($null -eq $recovered) { throw 'WEATHER_SAFE:networkError' }
                    $result.apiSuccess=$true; $result.duplicate=$false; $result.reportId=[string]$recovered.id
                    $result.pendingRegistered=$true; $result.driveSaved=$true; $result.sha256Match=$true; $result.imageRetrieved=$true; $result.stage='complete'
                }
                if ($null -ne $receipt) {
                    $result.apiSuccess=$true; $result.duplicate=$receipt.duplicate; $result.reportId=$receipt.id
                    $result.stage = 'pendingVerification'
                    $verifyCall = Invoke-UnifiedPrivateRead -ApiUrl $apiUrl -AdminKey $adminKey -Payload ([ordered]@{action='pending'})
                    if ($verifyCall.diagnostic.failureCode -or $verifyCall.data.ok -ne $true) { throw 'WEATHER_SAFE:pendingVerificationFailed' }
                    $stored = @($verifyCall.data.reports | Where-Object { [string]$_.id -ceq [string]$receipt.id })
                    if ($stored.Count -ne 1 -or -not (Test-UnifiedReportMatch $stored[0] $preview.payload)) { throw 'WEATHER_SAFE:pendingVerificationFailed' }
                    $result.pendingRegistered = $true
                    if (-not (Confirm-UnifiedStoredEvidence $stored[0] $artifact $apiUrl $adminKey)) { throw 'WEATHER_SAFE:evidenceVerificationFailed' }
                    $result.driveSaved=$true; $result.sha256Match=$true; $result.imageRetrieved=$true; $result.stage='complete'
                }
            }
        }
    }
} catch {
    $failure = $true
    if ($_.Exception.Message -match '^WEATHER_SAFE:([A-Za-z0-9]+)$') { $result.failureCode = $Matches[1] }
    else { $result.failureCode = 'localOrVerificationFailure' }
    $result['stopped'] = $true
} finally {
    foreach ($secret in @($postKey,$adminKey)) { if ($null -ne $secret) { $secret.Dispose() } }
    $parent = Split-Path -Parent $ResultPath
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $safeJson = [pscustomobject]$result | ConvertTo-Json
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($ResultPath), $safeJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output $safeJson
}
if (-not $failure -and $env:GITHUB_OUTPUT) {
    $outputs = @(
        'report_id=' + [string]$result.reportId
        'duplicate=' + $result.duplicate.ToString().ToLowerInvariant()
        'pending_registered=' + $result.pendingRegistered.ToString().ToLowerInvariant()
        'drive_saved=' + $result.driveSaved.ToString().ToLowerInvariant()
        'sha256_match=' + $result.sha256Match.ToString().ToLowerInvariant()
        'weekly_count=' + [string]$result.weeklyCount
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, $outputs + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
if ($failure) { throw ('WEATHER_SAFE:' + $result.failureCode) }
