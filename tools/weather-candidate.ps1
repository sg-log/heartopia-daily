# Load with dot-sourcing. This file performs no I/O or API requests.
function Resolve-WeatherCandidateSection {
    param([AllowNull()] [object] $Section)
    if ($null -eq $Section) {
        return [pscustomobject]@{ value = $null; values = @(); evidence = @{}; status = 'missing'; confidence = 'low'; unresolved = @() }
    }
    # Preserve metadata without mutating the input. Extraction supplies image facts/conflicts.
    $copy = [ordered]@{}
    if ($Section -is [System.Collections.IDictionary]) {
        foreach ($key in $Section.Keys) { $copy[$key] = $Section[$key] }
    } else {
        foreach ($property in $Section.PSObject.Properties) { $copy[$property.Name] = $property.Value }
    }
    foreach ($key in @('value', 'values', 'evidence')) {
        if (-not $copy.Contains($key)) { $copy[$key] = $null }
    }
    $issues = @($Section.unresolved | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    $status = [string]$Section.status
    if ($status -notin @('ready', 'needsReview', 'missing')) {
        $issues += 'status: ready / needsReview / missing が必要です'
        $status = 'needsReview'
    }
    $confidence = [string]$Section.confidence
    if ($confidence -notin @('high', 'medium', 'low')) {
        $confidence = 'low'
        $issues += 'confidence: high / medium / low が必要です'
    }
    if ($status -eq 'ready') {
        if ($confidence -ne 'high') { $issues += 'ready: high の根拠が必要です' }
        if ([string]::IsNullOrWhiteSpace([string]$Section.evidence.image)) { $issues += 'ready: 画像の根拠が必要です' }
        if ($null -eq $copy.value -and ($null -eq $copy.values -or @($copy.values).Count -eq 0)) { $issues += 'ready: 読み取った値が必要です' }
    }
    if ($issues.Count) { $status = 'needsReview' }
    $copy['status'] = $status
    $copy['confidence'] = $confidence
    $copy['unresolved'] = @($issues)
    [pscustomobject]$copy
}

function ConvertTo-SectionedWeatherReportDryRun {
    param([Parameter(Mandatory)] [object] $Candidate)
    $sections = [ordered]@{}
    foreach ($name in @('currentWeather', 'hourlyForecast', 'weeklyForecast')) {
        $sections[$name] = Resolve-WeatherCandidateSection $Candidate.$name
    }
    $hourly = $sections.hourlyForecast
    $result = [pscustomobject]@{
        status = '要確認'; issues = @('hourlyForecast: ready ではありません'); timeline = @(); payload = $null
    }
    if ($hourly.status -eq 'ready') {
        # Only hourly data enters the unchanged legacy safety validator.
        $legacy = [pscustomobject]@{
            sourceType = $Candidate.sourceType; sourceUrl = $Candidate.sourceUrl
            sourceId = $Candidate.sourceId; postedAt = $Candidate.postedAt
            observedDate = $hourly.observedDate; startSlot = $hourly.startSlot
            slots = $hourly.values; evidence = $hourly.evidence
            confidence = $hourly.confidence; unresolved = $hourly.unresolved
            memo = $Candidate.memo
        }
        $result = ConvertTo-WeatherReportDryRun -Candidate $legacy
        if ($null -eq $result.payload) {
            $hourly.status = 'needsReview'
            $hourly.unresolved = @($hourly.unresolved) + @($result.issues)
        }
    }
    [pscustomobject]@{
        sourceType = $Candidate.sourceType; sourceUrl = $Candidate.sourceUrl
        sourceId = $Candidate.sourceId; postedAt = $Candidate.postedAt; memo = $Candidate.memo
        currentWeather = $sections.currentWeather
        hourlyForecast = $hourly
        weeklyForecast = $sections.weeklyForecast
        hourlyDryRun = $result
    }
}

function ConvertTo-WeatherReportDryRun {
    param([Parameter(Mandatory)] [object] $Candidate)

    $issues = New-Object 'System.Collections.Generic.List[string]'
    $allowed = @('晴', '雨', '流星群', '虹', '猛暑', '雪', '桜')
    $starts = @('00', '06', '12', '18')
    $date = [datetime]::MinValue
    if (-not [datetime]::TryParseExact([string]$Candidate.observedDate, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$date)) {
        $issues.Add('observedDate: 観測日が不明または不正です')
    }
    $start = [string]$Candidate.startSlot
    $startHour = 0
    if ($start -in $starts) { $startHour = [int]$start }
    if ($start -notin $starts) { $issues.Add('startSlot: 00 / 06 / 12 / 18 が必要です') }
    if ($Candidate.confidence -ne 'high') { $issues.Add('confidence: high の候補のみ変換できます') }
    foreach ($field in @('sourceType', 'sourceUrl', 'sourceId')) {
        if ([string]::IsNullOrWhiteSpace([string]$Candidate.$field)) { $issues.Add("${field}: 必須です") }
    }
    $uri = $null
    if (-not [uri]::TryCreate([string]$Candidate.sourceUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https')) {
        $issues.Add('sourceUrl: HTTP(S) URLが必要です')
    }
    if (@($Candidate.unresolved | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count) {
        $issues.Add('unresolved: 未解決事項があります')
    }

    $slots = [ordered]@{}
    $timeline = @()
    $count = 0
    # observedDate is a game date; its 00:00 occurs on the following calendar day.
    $apiDate = $date
    if ($start -eq '00' -and $date -ne [datetime]::MinValue) { $apiDate = $date.AddDays(1) }
    for ($i = 0; $i -lt 5; $i++) {
        $key = "slot$i"
        $slot = $Candidate.slots.$key
        $values = @()
        $hour = (($startHour + 6 * $i) % 24)
        foreach ($value in @($slot.weather)) {
            if ([string]::IsNullOrWhiteSpace([string]$value)) { continue }
            $weather = [string]$value
            if ($weather -in @('月', '🌙', '夜晴')) {
                if ($hour -notin @(0, 18) -or $slot.nightSunnyConfirmed -ne $true) {
                    $issues.Add("${key}: 月を晴に変換する根拠が不足しています")
                    continue
                }
                $weather = '晴'
            }
            if ($weather -eq '晴れ') { $weather = '晴' }
            if ($weather -notin $allowed) { $issues.Add("${key}: 未対応の天気です"); continue }
            if ($weather -notin $values) { $values += $weather }
        }
        if ($values.Count -gt 4) { $issues.Add("${key}: 天気は最大4種類です") }
        if ($values.Count) {
            $hasEvidence = $false
            foreach ($kind in @($slot.evidence)) {
                if ($kind -in @('text', 'image') -and -not [string]::IsNullOrWhiteSpace([string]$Candidate.evidence.$kind)) {
                    $hasEvidence = $true
                }
            }
            if (-not $hasEvidence) { $issues.Add("${key}: 本文または画像の根拠が必要です（推測のみは不可）") }
            $count++
        }
        $slots[$key] = @($values)
        if ($date -ne [datetime]::MinValue -and $start -in $starts) {
            $at = $apiDate.AddHours([int]$start + 6 * $i)
            $timeline += [pscustomobject]@{ slot = $key; calendarTime = $at.ToString('yyyy-MM-dd HH:mm'); gameDate = $at.AddHours(-6).ToString('yyyy-MM-dd') }
        }
    }
    if (-not $count) { $issues.Add('slots: 根拠のある天気が1枠以上必要です') }
    $memo = "出典:$($Candidate.sourceUrl) sourceType:$($Candidate.sourceType) sourceId:$($Candidate.sourceId) 投稿日時:$($Candidate.postedAt) 観測ゲーム日:$($Candidate.observedDate) 確信度:$($Candidate.confidence) 本文根拠:$($Candidate.evidence.text) 画像根拠:$($Candidate.evidence.image) ユーザー確認:$($Candidate.evidence.userConfirmed) メモ:$($Candidate.memo)"
    if ($memo.Length -gt 1000) { $issues.Add('memo: APIの1000文字制限を超えます') }
    $payload = $null
    if ($issues.Count -eq 0) {
        $payload = [ordered]@{ action = 'submit'; date = $apiDate.ToString('yyyy-MM-dd'); startSlot = $start; slots = $slots; weeks = @{}; memo = $memo }
    }
    [pscustomobject]@{
        status = $(if ($issues.Count) { '要確認' } else { '登録可能候補' })
        issues = @($issues.ToArray())
        timeline = $timeline
        payload = $payload
    }
}
