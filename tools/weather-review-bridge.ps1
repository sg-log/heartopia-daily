param(
    [Parameter(Mandatory)] [string] $ReviewPath,
    [Parameter(Mandatory)] [string] $ArtifactDirectory,
    [Parameter(Mandatory)] [string] $DownloadedArtifactId,
    [Parameter(Mandatory)] [string] $DownloadedArtifactName,
    [Parameter(Mandatory)] [string] $DownloadedArtifactRunId,
    [Parameter(Mandatory)] [string] $CandidatePath,
    [Parameter(Mandatory)] [string] $DryRunPath,
    [Parameter(Mandatory)] [string] $PendingPreviewPath,
    [string] $RefetchedMediaPath = ''
)

$ErrorActionPreference = 'Stop'

$json = Get-Content -LiteralPath $ReviewPath -Raw -Encoding UTF8
$options = @{ InputObject = $json; ErrorAction = 'Stop' }
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
$review = ConvertFrom-Json @options

$params = @{
    ReviewPath = $ReviewPath
    ArtifactDirectory = $ArtifactDirectory
    DownloadedArtifactId = $DownloadedArtifactId
    DownloadedArtifactName = $DownloadedArtifactName
    DownloadedArtifactRunId = $DownloadedArtifactRunId
    CandidatePath = $CandidatePath
    DryRunPath = $DryRunPath
    PendingPreviewPath = $PendingPreviewPath
}
if ($review.schemaVersion -eq 4) {
    & "$PSScriptRoot/weather-artifact-review-bridge.ps1" @params
} else {
    $params.RefetchedMediaPath = $RefetchedMediaPath
    & "$PSScriptRoot/weather-work-review-bridge.ps1" @params
}
