$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/weather-candidate.ps1"
. "$PSScriptRoot/weather-discovery.ps1"
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock] $Action, $Message) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed $Message
}
$base = @{ SearchQuery = 'Heartopia weather 2026-09-10'; DiscoveredAt = '2026-09-10T10:00:00+09:00' }
$a = New-WeatherDiscoveryCandidate @base -DiscoverySource 'yahoo-web' -SourceUrl 'https://x.com/example/status/2097794370993017316/photo/1?utm_source=web#image' -Memo 'first'
$b = New-WeatherDiscoveryCandidate @base -DiscoverySource 'yahoo-realtime' -SourceUrl 'https://twitter.com/another/status/2097794370993017316?s=20' -Memo 'second'
$c = New-WeatherDiscoveryCandidate @base -DiscoverySource 'bing' -SourceUrl 'https://x.com/example/status/2097793876748837232'
$merged = @(Merge-WeatherDiscoveryCandidates @($a, $b, $c))
Assert ($merged.Count -eq 2) 'Same ID merges; different IDs remain separate'
Assert ($merged[0].normalizedUrl -eq 'https://x.com/i/status/2097794370993017316') 'Canonical X URL'
Assert ($merged[0].postId -ceq '2097794370993017316') 'ID preserved as exact string'
Assert ($merged[0].discoveryHistory.Count -eq 2) 'All discovery histories retained'
Assert (($merged[0].discoveryHistory.discoverySource -join ',') -eq 'yahoo-web,yahoo-realtime') 'Both sources retained'
Assert ($merged[0].discoveryHistory[1].memo -eq 'second' -and $a.discoveryHistory.Count -eq 1) 'Memo retained and input unchanged'
Assert ($merged[0].retrievalStatus -eq 'discovered') 'Discovery is not confirmation'
'PASS: cross-source dedup, photo/query/legacy normalization, distinct IDs, source history'

$web1 = New-WeatherDiscoveryCandidate @base -DiscoverySource 'other' -SourceUrl 'https://EXAMPLE.org:443/weather?day=10#top'
$web2 = New-WeatherDiscoveryCandidate @base -DiscoverySource 'future-search' -SourceUrl 'https://example.org/weather?day=10'
$web3 = New-WeatherDiscoveryCandidate @base -DiscoverySource 'other' -SourceUrl 'https://example.org/weather?day=11'
$web4 = New-WeatherDiscoveryCandidate @base -DiscoverySource 'other' -SourceUrl 'https://example.org/Weather?day=10'
Assert (@(Merge-WeatherDiscoveryCandidates @($web1, $web2, $web3, $web4)).Count -eq 3) 'Web canonical URL dedup preserves query and path case'
Assert ((ConvertTo-WeatherDiscoveryUrl 'https://x.com.evil.example/u/status/123').postId -eq $null) 'Host boundary'
Assert ((ConvertTo-WeatherDiscoveryUrl 'https://x.com/i/web/status/123/video/1?q=1').postId -eq '123') 'Internal X and video path'
Assert ((ConvertTo-WeatherDiscoveryUrl 'https://x.com/example').postId -eq $null) 'Profile is not a post'
Assert-Throws { ConvertTo-WeatherDiscoveryUrl 'javascript:alert(1)' } 'Reject non-HTTP'
Assert-Throws { ConvertTo-WeatherDiscoveryUrl 'https://user:secret@example.org/' } 'Reject credential URL'
Assert-Throws { ConvertTo-WeatherDiscoveryTime '2026-09-10T10:00:00' } 'Require timezone'
'PASS: general Web, conservative normalization, host boundaries, URL/time validation'

Assert-Throws { ConvertTo-WeatherCandidateFromDiscovery $merged[0] } 'Discovered-only handoff blocked'
$confirmed = Add-WeatherDiscoveryRetrieval -Candidate $merged[0] -Status confirmed -RetrievedAt '2026-09-10T10:01:00+09:00' -RetrievedUrl 'https://x.com/example/status/2097794370993017316' -Evidence 'Synthetic test: direct snapshot and screenshot references' -PostedAt '2026-09-10 06:08 (timezone unconfirmed)'
$failed = Add-WeatherDiscoveryRetrieval -Candidate $confirmed -Status failed -RetrievedAt '2026-09-10T10:02:00+09:00' -RetrievedUrl 'https://x.com/i/flow/login' -Evidence 'Login redirect; no post content'
Assert ($failed.retrievalStatus -eq 'failed' -and $failed.retrievalHistory.Count -eq 2) 'Failure retained separately from discovery'
Assert-Throws { ConvertTo-WeatherCandidateFromDiscovery $failed } 'Latest failure blocks handoff'
Assert-Throws { Add-WeatherDiscoveryRetrieval -Candidate $a -Status confirmed -RetrievedAt '2026-09-10T10:01:00Z' -RetrievedUrl $c.sourceUrl -Evidence 'Wrong post' } 'Wrong resource confirmation blocked'
$again = @(Merge-WeatherDiscoveryCandidates @($confirmed, $b))[0]
Assert ($again.retrievalStatus -eq 'confirmed' -and $again.discoveryHistory.Count -eq 3) 'Later discovery cannot erase confirmation'
$empty = ConvertTo-WeatherCandidateFromDiscovery $confirmed
Assert ($empty.currentWeather.status -eq 'missing' -and $empty.hourlyForecast.status -eq 'missing' -and $empty.weeklyForecast.status -eq 'missing') 'Search results never imply weather'
$sun = [string][char]0x6674
$hourly = @{ observedDate = '2026-09-10'; startSlot = '06'; values = @{ slot0 = @{weather=@($sun); evidence=@('image')} }; evidence = @{image='Synthetic confirmed hourly image'; userConfirmed=$false}; status='ready'; confidence='high'; unresolved=@() }
$candidate = ConvertTo-WeatherCandidateFromDiscovery ($confirmed | ConvertTo-Json -Depth 20 | ConvertFrom-Json) -HourlyForecast $hourly
$r = ConvertTo-SectionedWeatherReportDryRun $candidate
Assert ($null -ne $r.hourlyDryRun.payload -and $r.hourlyDryRun.payload.slots.slot1.Count -eq 0) 'Existing section dry-run and missing slot safety'
Assert ($r.hourlyDryRun.payload.weeks.Count -eq 0 -and -not $r.hourlyDryRun.payload.Contains('postKey')) 'No weekly or secret payload'
Assert ($candidate.postedAt -eq $confirmed.retrievalHistory[-1].postedAt -and $candidate.discovery.discoveryHistory.Count -eq 2) 'Direct postedAt and provenance preserved'
$hourly.unresolved = @('Explicit conflict')
$blocked = ConvertTo-SectionedWeatherReportDryRun (ConvertTo-WeatherCandidateFromDiscovery $confirmed -HourlyForecast $hourly)
Assert ($null -eq $blocked.hourlyDryRun.payload) 'Existing conflict check preserved'
'PASS: retrieval states, guarded handoff, JSON input, provenance, existing hourly dry-run and conflict safety'
