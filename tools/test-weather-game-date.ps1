$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-candidate.ps1"

function Assert($condition, $message) {
    if (-not $condition) { throw $message }
}

$slots = [ordered]@{}
0..4 | ForEach-Object {
    $slots["slot$_"] = @{ weather = @('晴'); evidence = @('image') }
}
$candidate = [pscustomobject]@{
    sourceType = 'x'
    sourceUrl = 'https://x.com/i/status/2100325752185159960'
    sourceId = '2100325752185159960'
    postedAt = '2026-09-17 18:00 (synthetic regression)'
    observedDate = '2026-09-17'
    startSlot = '00'
    slots = $slots
    evidence = @{ text = ''; image = 'verified game UI'; userConfirmed = $false }
    confidence = 'high'
    unresolved = @()
    memo = 'Heartopia game date changes at 06:00.'
}

$result = ConvertTo-WeatherReportDryRun $candidate
Assert ($null -ne $result.payload) '00-start candidate must remain eligible.'
Assert ($result.payload.date -ceq '2026-09-17') 'Pending/API date must remain the observed Heartopia game date.'
Assert ($result.payload.startSlot -ceq '00') 'Start slot must remain 00.'
Assert ($result.timeline[0].calendarTime -ceq '2026-09-18 00:00') 'Diagnostic calendar time must preserve the real following-midnight timestamp.'
Assert ($result.timeline[0].gameDate -ceq '2026-09-17') 'Following-midnight 00:00 still belongs to the 2026-09-17 game day before the 06:00 reset.'
Assert ($result.timeline[1].calendarTime -ceq '2026-09-18 06:00') 'Next slot must be 06:00 on the following calendar day.'
Assert ($result.timeline[1].gameDate -ceq '2026-09-18') '06:00 begins the next game day.'

Write-Host 'PASS: Heartopia 06:00 game-date boundary preserved for 00-start pending payload.'
