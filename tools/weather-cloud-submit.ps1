param(
    [Parameter(Mandatory)] [string] $CandidatePath,
    [Parameter(Mandatory)] [string] $CapturePath,
    [Parameter(Mandatory)] [string] $EvidencePath,
    [Parameter(Mandatory)] [string] $ResultPath
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"

function Read-WeatherCloudSubmitJson {
    param([Parameter(Mandatory)] [string] $Path)
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $options = @{ InputObject = $json }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    ConvertFrom-Json @options
}

function Test-WeatherCloudReportMatch {
    param([Parameter(Mandatory)] [object] $Report, [Parameter(Mandatory)] [System.Collections.IDictionary] $Payload)
    if ($Report.date -ne $Payload.date -or $Report.startSlot -ne $Payload.startSlot -or $Report.sourceUrl -cne $Payload.sourceUrl) { return $false }
    foreach ($index in 0..4) {
        if ((@($Report.slots."slot$index") -join ',') -cne (@($Payload.slots["slot$index"]) -join ',')) { return $false }
    }
    $true
}

function Confirm-WeatherCloudStoredEvidence {
    param(
        [Parameter(Mandatory)] [object] $Report,
        [Parameter(Mandatory)] [object] $Artifact,
        [Parameter(Mandatory)] [string] $ApiUrl,
        [Parameter(Mandatory)] [Security.SecureString] $AdminKey
    )
    if ($Report.evidenceStatus -cne 'saved' -or @($Report.evidenceImages).Count -ne 1 -or
        [string]$Report.evidenceImages[0].sha256 -cne $Artifact.sha256) { return $false }
    $call = Invoke-WeatherPrivateApiRequest -ApiUrl $ApiUrl -AdminKey $AdminKey `
        -Payload ([ordered]@{ action='weatherEvidence'; reportId=[string]$Report.id; imageIndex=0 })
    if ($call.diagnostic.failureCode -or $call.data.ok -ne $true -or $call.data.mimeType -cne $Artifact.mimeType) { return $false }
    try { $bytes = [Convert]::FromBase64String([string]$call.data.bodyBase64) }
    catch { return $false }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $hash -ceq $Artifact.sha256 -and $bytes.Length -eq $Artifact.byteSize
}

$result = [ordered]@{
    attempted=$false; apiSuccess=$false; driveSaved=$false; pendingRegistered=$false
    sha256Match=$false; imageRetrieved=$false; duplicate=$false
    reportId=''
    stage='localValidation'; failureCode=''; httpStatus=0; contentType=''; jsonParsed=$false; ok=$null; apiStage=''
}
$postKey = $null; $adminKey = $null; $failure = $false
try {
    $candidate = Read-WeatherCloudSubmitJson $CandidatePath
    $capture = Read-WeatherCloudSubmitJson $CapturePath
    if ($capture.status -cne 'captured' -or $null -eq $capture.evidence) { throw 'WEATHER_SAFE:captureNotConfirmed' }
    $kind = if ([string]$capture.evidence.kind -match 'screenshot$') { 'screenshot' } else { 'original' }
    $artifact = New-WeatherEvidenceImage -Path $EvidencePath -Kind $kind -CapturedAt ([string]$capture.evidence.capturedAt)
    if ($artifact.sha256 -cne [string]$capture.evidence.sha256 -or
        $artifact.byteSize -ne [long]$capture.evidence.byteSize -or
        $artifact.mimeType -cne [string]$capture.evidence.mimeType) {
        throw 'WEATHER_SAFE:evidenceChanged'
    }
    $preview = ConvertTo-WeatherEvidencePendingPreview -Candidate $candidate -EvidenceImage $artifact
    $apiUrl = Get-WeatherApiUrlFromSiteConfig

    $postPlain = [string]$env:WEATHER_POST_KEY
    $adminPlain = [string]$env:WEATHER_ADMIN_KEY
    $env:WEATHER_POST_KEY = $null; $env:WEATHER_ADMIN_KEY = $null
    if ([string]::IsNullOrEmpty($postPlain) -or [string]::IsNullOrEmpty($adminPlain)) { throw 'WEATHER_SAFE:missingKeys' }
    $postKey = ConvertTo-SecureString $postPlain -AsPlainText -Force
    $adminKey = ConvertTo-SecureString $adminPlain -AsPlainText -Force
    $postPlain = $null; $adminPlain = $null

    $result.stage = 'duplicateCheck'
    $pendingCall = Invoke-WeatherPrivateApiRequest -ApiUrl $apiUrl -AdminKey $adminKey -Payload ([ordered]@{action='pending'})
    foreach ($name in @('httpStatus','contentType','jsonParsed','ok','apiStage')) { $result[$name] = $pendingCall.diagnostic.$name }
    if ($pendingCall.diagnostic.failureCode) { throw ('WEATHER_SAFE:' + $pendingCall.diagnostic.failureCode) }
    $pendingFailure = Get-WeatherPendingResponseFailureCode $pendingCall.data
    if ($pendingFailure) { throw ('WEATHER_SAFE:' + $pendingFailure) }
    $matches = @($pendingCall.data.reports | Where-Object {
        $_.date -eq $preview.payload.date -and $_.startSlot -eq $preview.payload.startSlot -and $_.sourceUrl -ceq $preview.payload.sourceUrl
    })
    if ($matches.Count -gt 1) { throw 'WEATHER_SAFE:duplicateConflict' }
    if ($matches.Count -eq 1) {
        if (-not (Test-WeatherCloudReportMatch $matches[0] $preview.payload)) { throw 'WEATHER_SAFE:duplicateConflict' }
        $result.duplicate = $true
        $result.reportId = [string]$matches[0].id
        $result.stage = 'duplicateVerification'
        if (-not (Confirm-WeatherCloudStoredEvidence $matches[0] $artifact $apiUrl $adminKey)) { throw 'WEATHER_SAFE:duplicateConflict' }
        $result.apiSuccess=$true; $result.driveSaved=$true; $result.pendingRegistered=$true
        $result.sha256Match=$true; $result.imageRetrieved=$true; $result.stage='complete'
    } else {
        $result.attempted = $true
        $result.stage = 'submission'
        $receipt = Invoke-WeatherPendingSubmission -Candidate $candidate -EvidenceImage $artifact -Send -ApiUrl $apiUrl -PostKey $postKey
        foreach ($name in @('httpStatus','contentType','jsonParsed','ok','apiStage')) { $result[$name] = $receipt.diagnostic.$name }
        $result.apiSuccess = $true
        $result.duplicate = $receipt.duplicate
        $result.reportId = [string]$receipt.id

        $result.stage = 'pendingVerification'
        $pendingCall = Invoke-WeatherPrivateApiRequest -ApiUrl $apiUrl -AdminKey $adminKey -Payload ([ordered]@{action='pending'})
        if ($pendingCall.diagnostic.failureCode) { throw ('WEATHER_SAFE:' + $pendingCall.diagnostic.failureCode) }
        $reports = @($pendingCall.data.reports | Where-Object { $_.id -ceq $receipt.id })
        if ($pendingCall.data.ok -ne $true -or $reports.Count -ne 1 -or
            -not (Test-WeatherCloudReportMatch $reports[0] $preview.payload)) { throw 'WEATHER_SAFE:pendingVerificationFailed' }
        if (($reports[0] | ConvertTo-Json -Depth 20) -match '"fileId"') { throw 'WEATHER_SAFE:driveIdExposed' }
        $result.pendingRegistered = $true
        $result.stage = 'imageVerification'
        if (-not (Confirm-WeatherCloudStoredEvidence $reports[0] $artifact $apiUrl $adminKey)) { throw 'WEATHER_SAFE:evidenceVerificationFailed' }
        $result.driveSaved=$true; $result.sha256Match=$true; $result.imageRetrieved=$true; $result.stage='complete'
    }
} catch {
    $failure = $true
    foreach ($name in @('httpStatus','contentType','jsonParsed','ok','apiStage')) {
        if ($_.Exception.Data.Contains($name)) { $result[$name] = $_.Exception.Data[$name] }
    }
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
if ($failure) { throw ('WEATHER_SAFE:' + $result.failureCode) }
