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

if (-not (Test-WeatherWorkExactProperties $review @('schemaVersion','artifact','evidenceSha256','interpretation')) -or
    $review.schemaVersion -ne 1 -or
    -not (Test-WeatherWorkExactProperties $review.artifact @('runId','id','name'))) {
    throw 'Invalid Work review envelope shape.'
}
$runId = [string]$review.artifact.runId
$artifactId = [string]$review.artifact.id
$artifactName = [string]$review.artifact.name
$evidenceSha256 = [string]$review.evidenceSha256
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
    ) -join [Environment]::NewLine
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, $outputs + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
[pscustomobject]@{ artifactRunId=$runId; artifactId=$artifactId; artifactName=$artifactName; evidenceSha256=$evidenceSha256 }
