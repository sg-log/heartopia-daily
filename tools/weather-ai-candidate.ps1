param(
    [Parameter(Mandatory)] [string] $CapturePath,
    [Parameter(Mandatory)] [string] $DiscoveryPath,
    [Parameter(Mandatory)] [string] $InterpretationPath,
    [Parameter(Mandatory)] [string] $EvidencePath,
    [Parameter(Mandatory)] [string] $CandidatePath,
    [Parameter(Mandatory)] [string] $DryRunPath
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-evidence.ps1"

function Read-WeatherAiJson {
    param([Parameter(Mandatory)] [string] $Path)
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $options = @{ InputObject = $json }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    ConvertFrom-Json @options
}

function Write-WeatherAiJson {
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [object] $Value)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText(
        [IO.Path]::GetFullPath($Path),
        ($Value | ConvertTo-Json -Depth 40) + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
}

$capture = Read-WeatherAiJson $CapturePath
$discovery = Read-WeatherAiJson $DiscoveryPath
$review = Read-WeatherAiJson $InterpretationPath
if ($capture.status -cne 'captured' -or $null -eq $capture.evidence) { throw 'Confirmed capture evidence is required.' }
if ($review.status -cne 'completed' -or $null -eq $review.interpretation) { throw 'Completed AI interpretation is required.' }

$kind = if ([string]$capture.evidence.kind -match 'screenshot$') { 'screenshot' } else { 'original' }
$artifact = New-WeatherEvidenceImage -Path $EvidencePath -Kind $kind -CapturedAt ([string]$capture.evidence.capturedAt)
if ($artifact.sha256 -cne [string]$capture.evidence.sha256 -or
    $artifact.sha256 -cne [string]$review.inputSha256 -or
    $artifact.byteSize -ne [long]$capture.evidence.byteSize -or
    $artifact.mimeType -cne [string]$capture.evidence.mimeType) {
    throw 'AI interpretation is not bound to the captured evidence file.'
}

$confirmed = @(Merge-WeatherDiscoveryCandidates -Candidates @($discovery))[0]
if ($confirmed.retrievalStatus -cne 'confirmed' -or -not @($confirmed.retrievalHistory).Count) {
    throw 'Confirmed discovery is required before AI candidate conversion.'
}
if ([string]$capture.sourceUrl -cne [string]$confirmed.sourceUrl -or
    [string]$capture.finalUrl -cne [string]$confirmed.retrievalHistory[-1].retrievedUrl) {
    throw 'Capture and discovery URLs do not match.'
}

$interpretation = $review.interpretation
$issues = New-Object 'System.Collections.Generic.List[string]'
if ($interpretation.ready -ne $true) { $issues.Add('AI判定がreadyではありません') }
if ([string]$interpretation.confidence -cne 'high') { $issues.Add('AI判定の確信度がhighではありません') }
foreach ($issue in @($interpretation.unresolved)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$issue)) { $issues.Add([string]$issue) }
}

$observedDate = [string]$interpretation.observedDate
$parsedDate = [datetime]::MinValue
if (-not [datetime]::TryParseExact($observedDate, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None, [ref]$parsedDate)) {
    $issues.Add('画像からゲーム日をyyyy-MM-ddで確定できません')
}
$startSlot = [string]$interpretation.startSlot
if ($startSlot -notin @('00','06','12','18')) { $issues.Add('画像から開始時刻を確定できません') }

$values = [ordered]@{}
$slots = @($interpretation.slots)
if ($slots.Count -ne 5) { $issues.Add('時間別5枠が揃っていません') }
$allowed = @('晴','雨','流星群','虹','猛暑','雪','桜','月')
for ($index = 0; $index -lt 5; $index++) {
    $key = "slot$index"
    $slot = if ($index -lt $slots.Count) { $slots[$index] } else { $null }
    $weather = @()
    if ($null -eq $slot -or [string]$slot.slot -cne $key) {
        $issues.Add("${key}: 順序付き判定がありません")
    } else {
        $weather = @($slot.weather | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($slot.visible -ne $true) { $issues.Add("${key}: 画像内で全体を確認できません") }
        if ([string]$slot.confidence -cne 'high') { $issues.Add("${key}: 確信度がhighではありません") }
        if ([string]::IsNullOrWhiteSpace([string]$slot.description)) { $issues.Add("${key}: 可視根拠の説明がありません") }
        if (-not $weather.Count) { $issues.Add("${key}: 天気を判読できません") }
        if ($weather.Count -gt 4 -or @($weather | Select-Object -Unique).Count -ne $weather.Count -or
            @($weather | Where-Object { $_ -notin $allowed }).Count) {
            $issues.Add("${key}: 許可されていない天気判定です")
            $weather = @()
        }
    }
    $slotValue = [ordered]@{ weather = @($weather); evidence = @('image') }
    if ($startSlot -in @('00','06','12','18') -and $weather -contains '月') {
        $hour = (([int]$startSlot + 6 * $index) % 24)
        if ($hour -notin @(0,18)) { $issues.Add("${key}: 月アイコンの時刻が18時または00時ではありません") }
        else { $slotValue['nightSunnyConfirmed'] = $true }
    }
    $values[$key] = $slotValue
}

$summary = [string]$interpretation.summary
if ([string]::IsNullOrWhiteSpace($summary)) { $issues.Add('画像判読の要約がありません') }
if ($summary.Length -gt 300) { $issues.Add('画像判読の要約が長すぎます') }
$evidenceDescription = if ([string]$review.model -ceq 'work-public-media-url-visual-review') {
    'Workはcapture時に収集された公開media URLを直接視認。画像バイト列のSHA-256はGitHub Actionsがcapture artifactとStage2再取得で照合（' + $artifact.sha256 + '）: ' + $summary
} else {
    'AIが保存済み画像を判読（SHA-256 ' + $artifact.sha256 + '）: ' + $summary
}
$hourly = [ordered]@{
    observedDate = $observedDate
    startSlot = $startSlot
    values = $values
    evidence = [ordered]@{
        image = $evidenceDescription
        reviewedImageSha256 = $artifact.sha256
        userConfirmed = $false
    }
    status = $(if ($issues.Count) { 'needsReview' } else { 'ready' })
    confidence = $(if ([string]$interpretation.confidence -in @('high','medium','low')) { [string]$interpretation.confidence } else { 'low' })
    unresolved = @($issues.ToArray())
}

$candidate = ConvertTo-WeatherCandidateFromDiscovery -Discovery $confirmed `
    -CurrentWeather $null -HourlyForecast ([pscustomobject]$hourly) -WeeklyForecast $null
$candidate | Add-Member -NotePropertyName aiReview -NotePropertyValue ([pscustomobject]@{
    model = [string]$review.model
    responseId = [string]$review.responseId
    inputSha256 = $artifact.sha256
    interpretation = $interpretation
})
$dryRun = ConvertTo-SectionedWeatherReportDryRun -Candidate $candidate

if (-not $issues.Count -and ($dryRun.hourlyForecast.status -cne 'ready' -or
    $dryRun.hourlyDryRun.status -cne '登録可能候補' -or @($dryRun.hourlyDryRun.issues).Count)) {
    throw 'Existing candidate dry-run rejected an AI result marked ready.'
}
Write-WeatherAiJson -Path $CandidatePath -Value $candidate
Write-WeatherAiJson -Path $DryRunPath -Value $dryRun

$ready = $dryRun.hourlyForecast.status -ceq 'ready' -and $dryRun.hourlyDryRun.status -ceq '登録可能候補'
if ($env:GITHUB_OUTPUT) {
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, ('ready=' + $ready.ToString().ToLowerInvariant() + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{ ready = $ready; status = $dryRun.hourlyDryRun.status; issues = @($dryRun.hourlyDryRun.issues) }
