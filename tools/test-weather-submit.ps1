$ErrorActionPreference = 'Stop'

# Shadow transport before loading code: even an accidental default call cannot reach a network.
$script:calls = 0
$script:mode = 'forbid'
$script:wire = $null
function Invoke-RestMethod {
    param($Uri, $Method, $ContentType, $Body, $TimeoutSec, $ErrorAction)
    $script:calls++
    if ($script:mode -eq 'forbid') { throw 'Network forbidden in test' }
    $script:wire = [Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json
    $script:transport = @{uri=$Uri; method=$Method; contentType=$ContentType}
    if ($script:mode -eq 'timeout') { throw 'Synthetic sensitive transport error' }
    if ($script:mode -eq 'rejected') { return @{ok=$false; error='Synthetic sensitive server error'} }
    if ($script:mode -eq 'wrongStatus') { return @{ok=$true; status='approved'; id='mock-id'} }
    return @{ok=$true; status='pending'; id='mock-id'}
}
. "$PSScriptRoot/weather-submit.ps1"
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock] $Action, $Message) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed $Message
}
function New-SubmissionSample {
    $d = New-WeatherDiscoveryCandidate -DiscoverySource 'synthetic' -SearchQuery 'Heartopia weather' `
        -DiscoveredAt '2026-09-10T07:00:00+09:00' -SourceUrl 'https://example.org/post/123' -Memo 'Synthetic test'
    $d = Add-WeatherDiscoveryRetrieval -Candidate $d -Status confirmed -RetrievedAt '2026-09-10T07:01:00+09:00' `
        -RetrievedUrl $d.sourceUrl -Evidence 'Synthetic direct image confirmation' -PostedAt '2026-09-10T06:08:00+09:00'
    $slots = [ordered]@{}
    0..4 | ForEach-Object { $slots["slot$_"] = @{weather=@('晴');evidence=@('image')} }
    $hourly = @{observedDate='2026-09-10';startSlot='06';values=$slots;evidence=@{image='Synthetic five sunny icons';userConfirmed=$false};status='ready';confidence='high';unresolved=@()}
    ConvertTo-WeatherCandidateFromDiscovery -Discovery $d -HourlyForecast $hourly
}
$a = New-SubmissionSample
$before = $a | ConvertTo-Json -Depth 25
$prepared = Invoke-WeatherPendingSubmission -Candidate $a
Assert ($script:calls -eq 0 -and -not $prepared.sent -and $prepared.status -eq 'prepared') 'Default must not call network'
$p = $prepared.payload
Assert (($p.Keys -join ',') -eq 'action,date,startSlot,slots,weeks,memo,sourceUrl,sourceImageUrls') 'Exact payload allowlist'
Assert ($p.sourceUrl -eq $a.sourceUrl -and $p.sourceImageUrls.Count -eq 0) 'Legacy candidate has source and no images'
$imagesSample = New-SubmissionSample
$imagesSample.hourlyForecast.evidence.sourceImageUrls = @('https://example.org/one.png', 'https://example.org/two.png', 'https://example.org/one.png')
$imagePayload = ConvertTo-WeatherPendingPayload $imagesSample
Assert ($imagePayload.sourceImageUrls.Count -eq 2) 'Multiple evidence images deduplicated'
$imagesSample.hourlyForecast.evidence.sourceImageUrls = @('javascript:alert(1)')
Assert-Throws { ConvertTo-WeatherPendingPayload $imagesSample } 'Unsafe evidence URL rejected'
Assert ($p.action -eq 'submit' -and $p.date -eq '2026-09-10' -and $p.startSlot -eq '06') 'Existing submit contract'
0..4 | ForEach-Object { Assert (($p.slots["slot$_"] -join ',') -eq '晴') 'Five sunny slots' }
Assert ($p.weeks.Count -eq 0 -and -not $p.Contains('postKey')) 'No weekly data or key in preview'
Assert ($p.memo.Contains($a.sourceUrl) -and $p.memo.Contains($a.sourceId) -and $p.memo.Contains($a.postedAt)) 'Provenance retained'
Assert (($a | ConvertTo-Json -Depth 25) -ceq $before) 'Input unchanged'
'PASS: ready five-slot payload, provenance, immutable input, default zero network calls'

foreach ($scenario in @('review','missing','issues','unresolved','unconfirmed','memo')) {
    $bad = New-SubmissionSample
    switch ($scenario) {
        'review' { $bad.hourlyForecast.status = 'needsReview' }
        'missing' { $bad.hourlyForecast = $null }
        'issues' { $bad.hourlyForecast.observedDate = 'invalid' }
        'unresolved' { $bad.hourlyForecast.unresolved = @('Explicit hourly conflict') }
        'unconfirmed' { $bad.discovery = Add-WeatherDiscoveryRetrieval -Candidate $bad.discovery -Status failed -RetrievedAt '2026-09-10T07:02:00+09:00' -RetrievedUrl $bad.sourceUrl -Evidence 'Synthetic failure' }
        'memo' { $bad.hourlyForecast.evidence.textAmbiguities = @('x' * 1001) }
    }
    Assert-Throws { Invoke-WeatherPendingSubmission -Candidate $bad -Send -ApiUrl 'https://example.invalid/api' } "Reject $scenario"
}
Assert ($script:calls -eq 0) 'Invalid candidates never reach transport'
'PASS: needsReview, missing, dry-run issues, unresolved, failed retrieval, memo overflow rejected'

$a = New-SubmissionSample
$a.currentWeather = @{value='CURRENT_SENTINEL';status='needsReview';confidence='low';unresolved=@('Capture time unknown')}
$a.weeklyForecast = @{values=@('WEEKLY_SENTINEL');status='needsReview';confidence='low';unresolved=@('Weekday mapping unknown')}
$a | Add-Member -NotePropertyName postKey -NotePropertyValue 'IGNORED_SENTINEL'
$a.hourlyForecast.evidence.textAmbiguities = @('Text range unclear; image unambiguous')
$a.hourlyForecast.evidence.sourceImageUrls = @('https://example.org/panel.png')
$p = ConvertTo-WeatherPendingPayload $a
$json = $p | ConvertTo-Json -Depth 12
Assert ($json -notmatch 'CURRENT_SENTINEL|WEEKLY_SENTINEL|IGNORED_SENTINEL|postKey|currentWeather|weeklyForecast') 'No excluded values or credentials'
Assert ($p.memo.Contains('Text range unclear')) 'Hourly text ambiguities retained'
$key = ConvertTo-SecureString 'synthetic-test-only' -AsPlainText -Force
Invoke-WeatherPendingSubmission -Candidate $a -ApiUrl 'https://example.invalid/api' -PostKey $key | Out-Null
Assert ($script:calls -eq 0) 'URL and key alone cannot enable sending'
Assert-Throws { Invoke-WeatherPendingSubmission -Candidate $a -Send -ApiUrl 'https://example.invalid/api' } 'Missing explicit key'
foreach ($url in @('', 'http://example.invalid/api', 'https://example.invalid/api?postKey=invalid', 'https://user:pass@example.invalid/api', 'https://example.invalid/api#fragment')) {
    Assert-Throws { Invoke-WeatherPendingSubmission -Candidate $a -Send -ApiUrl $url -PostKey $key } 'Invalid endpoint rejected'
}
Assert ($script:calls -eq 0) 'Invalid endpoint/key never calls transport'
$script:mode = 'pending'
$sent = Invoke-WeatherPendingSubmission -Candidate $a -Send -ApiUrl 'https://example.invalid/api' -PostKey $key
Assert ($script:calls -eq 1 -and $sent.status -eq 'pending' -and $sent.id -eq 'mock-id') 'One explicit send and pending confirmation'
Assert ($script:wire.postKey -ceq 'synthetic-test-only' -and $script:wire.action -eq 'submit') 'Explicit key in body only'
Assert ($script:wire.sourceUrl -eq $a.sourceUrl -and $script:wire.sourceImageUrls[0] -eq 'https://example.org/panel.png') 'Evidence survives mocked transport'
Assert ($script:transport.method -eq 'Post' -and $script:transport.contentType -eq 'application/json; charset=utf-8') 'UTF8 JSON POST'
Assert (($sent | ConvertTo-Json) -notmatch 'synthetic-test-only|postKey') 'No key in result'
Assert (@($script:wire.weeks.PSObject.Properties).Count -eq 0 -and $null -eq $script:wire.currentWeather -and $null -eq $script:wire.weeklyForecast) 'No excluded sections on wire'
'PASS: section isolation, explicit key and Send required, endpoint checks, mocked pending response'
foreach ($mode in @('timeout','rejected','wrongStatus')) {
    $script:mode = $mode
    $prior = $script:calls
    Assert-Throws { Invoke-WeatherPendingSubmission -Candidate $a -Send -ApiUrl 'https://example.invalid/api' -PostKey $key } "Reject $mode"
    Assert ($script:calls -eq $prior + 1) 'No automatic retry'
}
'PASS: timeout, API rejection, unexpected status fail closed without retry; all transport mocked'

$script:mode = 'forbid'
$snapshot = @'
uid=1_1 link "post media" url="https://example.org/post/123/photo/1"
uid=1_2 image "panel" url="https://images.example.org/panel.png"
uid=1_3 image "unrelated" url="https://images.example.org/other.png"
uid=1_4 image "panel two" url="http://images.example.org/two.png"
uid=1_5 image "unsafe" url="data:image/png,abc"
uid=1_6 image "private" url="file:///tmp/screenshot.png"
uid=1_7 image "signed" url="https://images.example.org/a?token=secret"
uid=1_8 image "script" url="javascript:alert(1)"
'@
foreach ($case in @(
    @{snapshot=$snapshot;uids=@('1_2');count=1},
    @{snapshot=$snapshot;uids=@('1_2','1_4');count=2},
    @{snapshot=$snapshot;uids=@('1_1','1_5','1_6','1_7','1_8','missing');count=0},
    @{snapshot='';uids=@('1_2');count=0},
    @{snapshot=$snapshot;uids=@();count=0}
)) {
    $sample = New-SubmissionSample
    $d = Add-WeatherDiscoveryRetrieval -Candidate $sample.discovery -Status confirmed `
        -RetrievedAt '2026-09-10T07:02:00+09:00' -RetrievedUrl $sample.sourceUrl -Evidence 'Synthetic panel confirmation' `
        -BrowserSnapshot $case.snapshot -HourlyImageUids $case.uids
    $sample = ConvertTo-WeatherCandidateFromDiscovery -Discovery $d -HourlyForecast $sample.hourlyForecast
    $prepared = Invoke-WeatherPendingSubmission $sample
    Assert ($prepared.payload.sourceImageUrls.Count -eq $case.count) 'Selected snapshot images propagated'
    Assert ($prepared.payload.sourceUrl -eq 'https://example.org/post/123') 'Original post retained'
    Assert ($prepared.payload.sourceImageUrls -notcontains 'https://images.example.org/other.png') 'Unselected image excluded'
    Assert (-not $prepared.sent) 'Image acquisition failure does not break dry-run or enable network'
}
'PASS: snapshot image extraction, selected multiple images, no images/failure, unsafe URLs, original post, issue-free dry-run'
