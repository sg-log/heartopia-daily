# Pure data functions: no browser, network, file writes, or weather inference.
function ConvertTo-WeatherDiscoveryUrl {
    param([Parameter(Mandatory)] [string] $Url)
    $uri = $null
    if (-not [uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo) {
        throw 'An absolute HTTP(S) URL without credentials is required.'
    }
    $builder = New-Object System.UriBuilder($uri)
    $builder.Fragment = ''
    $normalized = $builder.Uri.AbsoluteUri
    $postId = $null
    $sourceType = 'web'
    if ($uri.Host -in @('x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com')) {
        $sourceType = 'x'
        if ($uri.AbsolutePath -match '^/(?:[A-Za-z0-9_]+/status|i/status|i/web/status)/([0-9]+)(?:/(?:photo|video)/[0-9]+)?/?$') {
            $postId = $Matches[1]
            # Account-independent canonical form, including legacy twitter.com URLs.
            $normalized = 'https://x.com/i/status/' + $postId
        }
    }
    [pscustomobject]@{
        normalizedUrl = $normalized; sourceType = $sourceType; postId = $postId
        sourceId = $(if ($postId) { $postId } else { $normalized })
        key = $(if ($postId) { 'x:' + $postId } else { 'url:' + $normalized })
    }
}

function ConvertTo-WeatherDiscoveryTime {
    param([Parameter(Mandatory)] [string] $Value)
    $time = [datetimeoffset]::MinValue
    if ($Value -notmatch 'T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$' -or
        -not [datetimeoffset]::TryParse($Value, [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$time)) {
        throw 'Use an ISO timestamp with an explicit timezone.'
    }
    $time.ToUniversalTime().ToString('o')
}

function New-WeatherDiscoveryCandidate {
    param(
        [Parameter(Mandatory)] [string] $DiscoverySource,
        [Parameter(Mandatory)] [string] $SearchQuery,
        [Parameter(Mandatory)] [string] $DiscoveredAt,
        [Parameter(Mandatory)] [string] $SourceUrl,
        [string] $Memo = ''
    )
    if ([string]::IsNullOrWhiteSpace($DiscoverySource) -or [string]::IsNullOrWhiteSpace($SearchQuery)) { throw 'Discovery source and query are required.' }
    $url = ConvertTo-WeatherDiscoveryUrl $SourceUrl
    $time = ConvertTo-WeatherDiscoveryTime $DiscoveredAt
    [pscustomobject]@{
        discoverySource = $DiscoverySource; searchQuery = $SearchQuery; discoveredAt = $time
        sourceUrl = $SourceUrl; normalizedUrl = $url.normalizedUrl
        sourceType = $url.sourceType; sourceId = $url.sourceId; postId = $url.postId
        retrievalStatus = 'discovered'; memo = $Memo
        discoveryHistory = @([pscustomobject]@{
            discoverySource = $DiscoverySource; searchQuery = $SearchQuery
            discoveredAt = $time; sourceUrl = $SourceUrl; memo = $Memo
        })
        retrievalHistory = @()
    }
}

function Merge-WeatherDiscoveryCandidates {
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Candidates)
    # Ordinal keys preserve case-sensitive general Web paths and queries.
    $groups = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    $order = @()
    foreach ($candidate in $Candidates) {
        $url = ConvertTo-WeatherDiscoveryUrl $candidate.sourceUrl
        if (-not $groups.ContainsKey($url.key)) {
            $copy = $candidate | ConvertTo-Json -Depth 30 | ConvertFrom-Json
            $copy.normalizedUrl = $url.normalizedUrl
            $copy.sourceType = $url.sourceType
            $copy.sourceId = $url.sourceId
            $copy.postId = $url.postId
            $copy.discoveryHistory = @()
            $copy.retrievalHistory = @()
            $groups.Add($url.key, $copy)
            $order += $url.key
        }
        $item = $groups[$url.key]
        $item.discoveryHistory = @($item.discoveryHistory) + @($candidate.discoveryHistory)
        $item.retrievalHistory = @($item.retrievalHistory) + @($candidate.retrievalHistory)
    }
    foreach ($key in $order) {
        $item = $groups[$key]
        $item.retrievalHistory = @($item.retrievalHistory | Sort-Object { [datetimeoffset]$_.retrievedAt })
        $item.retrievalStatus = if ($item.retrievalHistory.Count) { $item.retrievalHistory[-1].status } else { 'discovered' }
        $item
    }
}

function Add-WeatherDiscoveryRetrieval {
    param(
        [Parameter(Mandatory)] [object] $Candidate,
        [Parameter(Mandatory)] [ValidateSet('confirmed', 'failed')] [string] $Status,
        [Parameter(Mandatory)] [string] $RetrievedAt,
        [Parameter(Mandatory)] [string] $RetrievedUrl,
        [Parameter(Mandatory)] [string] $Evidence,
        [string] $PostedAt = ''
    )
    $expected = ConvertTo-WeatherDiscoveryUrl $Candidate.sourceUrl
    $actual = ConvertTo-WeatherDiscoveryUrl $RetrievedUrl
    if ($Status -eq 'confirmed' -and $expected.key -cne $actual.key) { throw 'Confirmed retrieval must match the discovered resource.' }
    if ([string]::IsNullOrWhiteSpace($Evidence)) { throw 'Record direct browser evidence or the retrieval failure reason.' }
    $copy = $Candidate | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $copy.retrievalHistory = @($copy.retrievalHistory) + @([pscustomobject]@{
        status = $Status; retrievedAt = (ConvertTo-WeatherDiscoveryTime $RetrievedAt)
        retrievedUrl = $RetrievedUrl; evidence = $Evidence; postedAt = $PostedAt
    })
    Merge-WeatherDiscoveryCandidates -Candidates @($copy)
}

function ConvertTo-WeatherCandidateFromDiscovery {
    param(
        [Parameter(Mandatory)] [object] $Discovery,
        [AllowNull()] [object] $CurrentWeather,
        [AllowNull()] [object] $HourlyForecast,
        [AllowNull()] [object] $WeeklyForecast
    )
    $item = Merge-WeatherDiscoveryCandidates -Candidates @($Discovery)
    if ($item.retrievalStatus -ne 'confirmed' -or -not $item.retrievalHistory.Count) {
        throw 'Direct browser confirmation is required before section handoff.'
    }
    $last = $item.retrievalHistory[-1]
    $expected = ConvertTo-WeatherDiscoveryUrl $item.sourceUrl
    $actual = ConvertTo-WeatherDiscoveryUrl $last.retrievedUrl
    if ($expected.key -cne $actual.key -or [string]::IsNullOrWhiteSpace($last.evidence)) { throw 'Invalid direct retrieval record.' }
    # AI supplies sections from direct evidence; discovery snippets never become weather.
    [pscustomobject]@{
        sourceType = $item.sourceType; sourceUrl = $last.retrievedUrl
        sourceId = $item.sourceId; postedAt = $last.postedAt; memo = $item.memo
        discovery = $item
        currentWeather = (Resolve-WeatherCandidateSection $CurrentWeather)
        hourlyForecast = (Resolve-WeatherCandidateSection $HourlyForecast)
        weeklyForecast = (Resolve-WeatherCandidateSection $WeeklyForecast)
    }
}
