param(
    [Parameter(Mandatory)] [string] $ReviewPayloadBase64,
    [Parameter(Mandatory)] [string] $ReviewPath
)

$ErrorActionPreference = 'Stop'

function Test-ExactProperties {
    param([Parameter(Mandatory)] [object] $Value, [Parameter(Mandatory)] [string[]] $Names)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IEnumerable]) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    $actual.Count -eq $expected.Count -and (($actual -join "`n") -ceq ($expected -join "`n"))
}

if ($ReviewPayloadBase64.Length -gt 65536 -or $ReviewPayloadBase64.Length % 4 -ne 0 -or
    $ReviewPayloadBase64 -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') {
    throw 'Invalid artifact review envelope encoding.'
}
try { $bytes = [Convert]::FromBase64String($ReviewPayloadBase64) }
catch { throw 'Invalid artifact review envelope encoding.' }
if (-not $bytes.Length -or $bytes.Length -gt 49152) { throw 'Invalid artifact review envelope size.' }
try {
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $json = $utf8.GetString($bytes)
    $options = @{ InputObject = $json; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    $review = ConvertFrom-Json @options
} catch { throw 'Invalid artifact review envelope JSON.' }

if ($review.schemaVersion -ne 4 -or
    -not (Test-ExactProperties $review @('schemaVersion','artifact','reviewedImages','pendingEvidenceFile','interpretation')) -or
    -not (Test-ExactProperties $review.artifact @('runId','id','name'))) {
    throw 'Invalid artifact review envelope shape.'
}

$runId = [string]$review.artifact.runId
$artifactId = [string]$review.artifact.id
$artifactName = [string]$review.artifact.name
if ($runId -notmatch '^[1-9][0-9]{0,19}$' -or $artifactId -notmatch '^[1-9][0-9]{0,19}$' -or
    $artifactName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
    throw 'Invalid artifact review artifact binding.'
}

if ($review.reviewedImages -isnot [System.Array] -or @($review.reviewedImages).Count -lt 1 -or @($review.reviewedImages).Count -gt 4) {
    throw 'Invalid artifact review image set.'
}
$seenFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
$pendingEvidence = $null
foreach ($image in @($review.reviewedImages)) {
    if (-not (Test-ExactProperties $image @('file','mimeType','captureSha256'))) {
        throw 'Invalid artifact review image binding.'
    }
    $file = [string]$image.file
    $mimeType = [string]$image.mimeType
    $sha256 = [string]$image.captureSha256
    if ($file -notmatch '^raw-media-[0-3]\.(?:jpg|png)$' -or
        $mimeType -notin @('image/jpeg','image/png') -or
        ($mimeType -ceq 'image/jpeg' -and $file -notmatch '\.jpg$') -or
        ($mimeType -ceq 'image/png' -and $file -notmatch '\.png$') -or
        $sha256 -notmatch '^[a-f0-9]{64}$' -or
        -not $seenFiles.Add($file)) {
        throw 'Invalid artifact review image binding.'
    }
    if ($file -ceq [string]$review.pendingEvidenceFile) { $pendingEvidence = $image }
}
if ([string]$review.pendingEvidenceFile -notmatch '^raw-media-[0-3]\.(?:jpg|png)$' -or $null -eq $pendingEvidence) {
    throw 'Invalid artifact review pending evidence selection.'
}

$interpretation = $review.interpretation
if (-not (Test-ExactProperties $interpretation @('ready','observedDate','startSlot','slots','confidence','summary','unresolved')) -or
    $interpretation.ready -isnot [bool] -or $interpretation.confidence -notin @('high','medium','low') -or
    ($null -ne $interpretation.observedDate -and [string]$interpretation.observedDate -notmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') -or
    $interpretation.startSlot -notin @('00','06','12','18',$null) -or
    $interpretation.slots -isnot [System.Array] -or @($interpretation.slots).Count -ne 5 -or
    $interpretation.unresolved -isnot [System.Array] -or @($interpretation.unresolved).Count -gt 20 -or
    ([string]$interpretation.summary).Length -gt 300) {
    throw 'Invalid artifact weather interpretation.'
}
$allowedWeather = @('晴','雨','流星群','虹','猛暑','雪','桜','月')
$expectedSlots = @('slot0','slot1','slot2','slot3','slot4')
for ($index = 0; $index -lt 5; $index++) {
    $slot = $interpretation.slots[$index]
    if (-not (Test-ExactProperties $slot @('slot','visible','weather','confidence','description')) -or
        [string]$slot.slot -cne $expectedSlots[$index] -or $slot.visible -isnot [bool] -or
        $slot.weather -isnot [System.Array] -or @($slot.weather).Count -gt 4 -or
        @($slot.weather | Select-Object -Unique).Count -ne @($slot.weather).Count -or
        @($slot.weather | Where-Object { $_ -notin $allowedWeather }).Count -or
        $slot.confidence -notin @('high','medium','low') -or $slot.description -isnot [string] -or $slot.description.Length -gt 200) {
        throw 'Invalid artifact weather interpretation.'
    }
}
if ($interpretation.summary -isnot [string] -or
    @($interpretation.unresolved | Where-Object { $_ -isnot [string] -or $_.Length -gt 200 }).Count) {
    throw 'Invalid artifact weather interpretation.'
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
        'evidence_sha256=' + [string]$pendingEvidence.captureSha256
        'review_mode=artifact-raw-media-visual'
        'media_url='
        'media_file=' + [string]$pendingEvidence.file
        'media_mime_type=' + [string]$pendingEvidence.mimeType
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, $outputs + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{
    artifactRunId=$runId
    artifactId=$artifactId
    artifactName=$artifactName
    evidenceSha256=[string]$pendingEvidence.captureSha256
    reviewMode='artifact-raw-media-visual'
    mediaUrl=''
}
