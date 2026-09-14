param(
    [Parameter(Mandatory)] [string] $ReviewPayloadBase64,
    [Parameter(Mandatory)] [string] $ReviewPath
)

$ErrorActionPreference = 'Stop'

function Test-WeatherWorkExactProperties {
    param([Parameter(Mandatory)] [object] $Value, [Parameter(Mandatory)] [string[]] $Names)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IEnumerable]) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    $actual.Count -eq $expected.Count -and (($actual -join "`n") -ceq ($expected -join "`n"))
}

if ($ReviewPayloadBase64.Length -gt 65536 -or $ReviewPayloadBase64.Length % 4 -ne 0 -or
    $ReviewPayloadBase64 -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') {
    throw 'Invalid Work review envelope encoding.'
}
try { $bytes = [Convert]::FromBase64String($ReviewPayloadBase64) }
catch { throw 'Invalid Work review envelope encoding.' }
if (-not $bytes.Length -or $bytes.Length -gt 49152) { throw 'Invalid Work review envelope size.' }
try {
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $json = $utf8.GetString($bytes)
    $options = @{ InputObject = $json; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    $review = ConvertFrom-Json @options
} catch { throw 'Invalid Work review envelope JSON.' }

if ($review.schemaVersion -notin @(1,2) -or
    -not (Test-WeatherWorkExactProperties $review.artifact @('runId','id','name'))) {
    throw 'Invalid Work review envelope shape.'
}
$runId = [string]$review.artifact.runId
$artifactId = [string]$review.artifact.id
$artifactName = [string]$review.artifact.name
$reviewMode = ''
$mediaUrl = ''
$mediaFile = ''
$mediaMimeType = ''
if ($review.schemaVersion -eq 1) {
    if (-not (Test-WeatherWorkExactProperties $review @('schemaVersion','artifact','evidenceSha256','interpretation'))) {
        throw 'Invalid Work review envelope shape.'
    }
    $reviewMode = 'legacy-evidence'
    $evidenceSha256 = [string]$review.evidenceSha256
} else {
    if (-not (Test-WeatherWorkExactProperties $review @('schemaVersion','artifact','selectedMedia','interpretation')) -or
        -not (Test-WeatherWorkExactProperties $review.selectedMedia @('url','file','mimeType','captureSha256'))) {
        throw 'Invalid Work public media review envelope shape.'
    }
    $reviewMode = 'public-media-url-visual'
    $mediaUrl = [string]$review.selectedMedia.url
    $mediaFile = [string]$review.selectedMedia.file
    $mediaMimeType = [string]$review.selectedMedia.mimeType
    $evidenceSha256 = [string]$review.selectedMedia.captureSha256
    $mediaUri = $null
    if ($mediaUrl.Length -gt 2048 -or $mediaUrl -match '[\x00-\x20\x7f]' -or
        -not [uri]::TryCreate($mediaUrl, [UriKind]::Absolute, [ref]$mediaUri) -or
        $mediaUri.Scheme -cne 'https' -or $mediaUri.UserInfo -or -not $mediaUri.IsDefaultPort -or $mediaUri.Fragment -or
        $mediaUri.DnsSafeHost -cne 'pbs.twimg.com' -or
        $mediaUri.AbsolutePath -notmatch '^/(?:media|ext_tw_video_thumb|tweet_video_thumb)/[A-Za-z0-9._~%-]+$' -or
        $mediaFile -notmatch '^raw-media-[0-3]\.(?:jpg|png)$' -or
        $mediaMimeType -notin @('image/jpeg','image/png') -or
        ($mediaMimeType -ceq 'image/jpeg' -and $mediaFile -notmatch '\.jpg$') -or
        ($mediaMimeType -ceq 'image/png' -and $mediaFile -notmatch '\.png$')) {
        throw 'Invalid Work public media binding.'
    }
    $queryNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($part in @($mediaUri.Query.TrimStart('?') -split '&' | Where-Object { $_ })) {
        $pair = $part -split '=', 2
        if ($pair.Count -ne 2 -or -not $queryNames.Add($pair[0]) -or $pair[0] -notin @('format','name') -or
            ($pair[0] -ceq 'format' -and $pair[1] -notin @('jpg','jpeg','png')) -or
            ($pair[0] -ceq 'name' -and $pair[1] -notin @('thumb','small','medium','large','orig'))) {
            throw 'Invalid Work public media binding.'
        }
    }
}
if ($runId -notmatch '^[1-9][0-9]{0,19}$' -or $artifactId -notmatch '^[1-9][0-9]{0,19}$' -or
    $artifactName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
    $evidenceSha256 -notmatch '^[a-f0-9]{64}$' -or $null -eq $review.interpretation) {
    throw 'Invalid Work review artifact binding.'
}

$interpretation = $review.interpretation
if (-not (Test-WeatherWorkExactProperties $interpretation @('ready','observedDate','startSlot','slots','confidence','summary','unresolved')) -or
    $interpretation.ready -isnot [bool] -or $interpretation.confidence -notin @('high','medium','low') -or
    ($null -ne $interpretation.observedDate -and [string]$interpretation.observedDate -notmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') -or
    $interpretation.startSlot -notin @('00','06','12','18',$null) -or
    $interpretation.slots -isnot [System.Array] -or @($interpretation.slots).Count -ne 5 -or
    $interpretation.unresolved -isnot [System.Array] -or @($interpretation.unresolved).Count -gt 20 -or
    ([string]$interpretation.summary).Length -gt 300) {
    throw 'Invalid Work weather interpretation.'
}
$allowedWeather = @('晴','雨','流星群','虹','猛暑','雪','桜','月')
$expectedSlots = @('slot0','slot1','slot2','slot3','slot4')
for ($index = 0; $index -lt 5; $index++) {
    $slot = $interpretation.slots[$index]
    if (-not (Test-WeatherWorkExactProperties $slot @('slot','visible','weather','confidence','description')) -or
        [string]$slot.slot -cne $expectedSlots[$index] -or $slot.visible -isnot [bool] -or
        $slot.weather -isnot [System.Array] -or @($slot.weather).Count -gt 4 -or
        @($slot.weather | Select-Object -Unique).Count -ne @($slot.weather).Count -or
        @($slot.weather | Where-Object { $_ -notin $allowedWeather }).Count -or
        $slot.confidence -notin @('high','medium','low') -or $slot.description -isnot [string] -or $slot.description.Length -gt 200) {
        throw 'Invalid Work weather interpretation.'
    }
}
if ($interpretation.summary -isnot [string] -or
    @($interpretation.unresolved | Where-Object { $_ -isnot [string] -or $_.Length -gt 200 }).Count) {
    throw 'Invalid Work weather interpretation.'
}

$parent = Split-Path -Parent $ReviewPath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[IO.File]::WriteAllText(
    [IO.Path]::GetFullPath($ReviewPath),
    ($review | ConvertTo-Json -Depth 30) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)
if ($env:GITHUB_OUTPUT) {
    $outputs = @(
        'artifact_run_id=' + $runId
        'artifact_id=' + $artifactId
        'artifact_name=' + $artifactName
        'evidence_sha256=' + $evidenceSha256
        'review_mode=' + $reviewMode
        'media_url=' + $mediaUrl
        'media_file=' + $mediaFile
        'media_mime_type=' + $mediaMimeType
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, $outputs + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{ artifactRunId=$runId; artifactId=$artifactId; artifactName=$artifactName; evidenceSha256=$evidenceSha256; reviewMode=$reviewMode; mediaUrl=$mediaUrl }
