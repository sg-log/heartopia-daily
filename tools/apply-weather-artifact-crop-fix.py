from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old in text:
        p.write_text(text.replace(old, new, 1), encoding='utf-8')
        return
    if new in text:
        return
    raise SystemExit(f'missing artifact crop patch anchor in {path}')


request = 'tools/weather-artifact-review-request.ps1'
allowed_old = "^(?:raw-media-[0-3]\\.(?:jpg|png)|evidence\\.jpg)$"
allowed_new = "^(?:raw-media-[0-3]\\.(?:jpg|png)|evidence\\.jpg|verified-weather-panel\\.jpg)$"
replace_once(request, allowed_old, allowed_new)
replace_once(request, allowed_old, allowed_new)
replace_once(
    request,
    "$reviewMode = if ([string]$pendingEvidence.file -ceq 'evidence.jpg') { 'artifact-captured-visual' } else { 'artifact-raw-media-visual' }",
    "$reviewMode = if ([string]$pendingEvidence.file -in @('evidence.jpg','verified-weather-panel.jpg')) { 'artifact-captured-visual' } else { 'artifact-raw-media-visual' }"
)

bridge = 'tools/weather-artifact-review-bridge.ps1'
replace_once(
    bridge,
    """        $expectedMime = [string]$matches[0].mimeType
        $expectedSha = [string]$matches[0].sha256
        $expectedSize = [long]$matches[0].byteSize
    }

    $artifact = New-WeatherEvidenceImage -Path $imagePath -Kind $kind -CapturedAt $rawCapturedAt""",
    """        $expectedMime = [string]$matches[0].mimeType
        $expectedSha = [string]$matches[0].sha256
        $expectedSize = [long]$matches[0].byteSize
        if ([string]$matches[0].sourceScope -ceq 'verified-game-ui-crop') { $kind = 'screenshot' }
    }

    $artifact = New-WeatherEvidenceImage -Path $imagePath -Kind $kind -CapturedAt $rawCapturedAt"""
)
