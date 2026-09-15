from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8-sig')
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected one match, found {text.count(old)}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# X capture: a verified embed screenshot is a valid fallback when original pbs media URLs are absent.
replace_once(
    'tools/weather-x-embed-evidence.mjs',
    '''    const rawMediaCandidates = collectXPublicMedia([...images, ...networkMedia]);\n    if (!rawMediaCandidates.length) throw new WeatherCloudError("xMediaUrlMissing");\n    const rawMedia = [];''',
    '''    const rawMediaCandidates = collectXPublicMedia([...images, ...networkMedia]);\n    const rawMedia = [];'''
)
replace_once(
    'tools/weather-x-embed-evidence.mjs',
    '''    const evidenceChoice = chooseEmbedEvidence(images);''',
    '''    const evidenceChoice = rawMediaCandidates.length\n      ? chooseEmbedEvidence(images)\n      : { kind: "embed-screenshot", selected: null };'''
)

# Reusable capture workflow: allow zero raw-media files when screenshot evidence exists and expose the count.
replace_once(
    '.github/workflows/weather-cloud-x-embed-evidence.yml',
    '''      raw_media_base64:\n        value: ${{ jobs.capture.outputs.raw_media_base64 }}''',
    '''      raw_media_base64:\n        value: ${{ jobs.capture.outputs.raw_media_base64 }}\n      raw_media_count:\n        value: ${{ jobs.capture.outputs.raw_media_count }}'''
)
replace_once(
    '.github/workflows/weather-cloud-x-embed-evidence.yml',
    '''      raw_media_base64: ${{ steps.metadata.outputs.raw_media_base64 }}''',
    '''      raw_media_base64: ${{ steps.metadata.outputs.raw_media_base64 }}\n      raw_media_count: ${{ steps.metadata.outputs.raw_media_count }}'''
)
replace_once(
    '.github/workflows/weather-cloud-x-embed-evidence.yml',
    '''          if ($rawMedia.Count -lt 1 -or $rawMedia.Count -gt 4) { throw 'Capture did not contain usable public X raw media.' }''',
    '''          if ($rawMedia.Count -gt 4) { throw 'Capture contained too many public X raw media files.' }'''
)
replace_once(
    '.github/workflows/weather-cloud-x-embed-evidence.yml',
    '''          [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "raw_media_base64=$rawMediaBase64$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))''',
    '''          [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "raw_media_base64=$rawMediaBase64$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))\n          [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "raw_media_count=$($rawMedia.Count)$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))'''
)

# Review schema v4: permit the verified rendered evidence screenshot as a reviewed image.
p = Path('tools/weather-artifact-review-request.ps1')
text = p.read_text(encoding='utf-8-sig')
old = "^raw-media-[0-3]\\.(?:jpg|png)$"
new = "^(?:raw-media-[0-3]\\.(?:jpg|png)|evidence\\.jpg)$"
if text.count(old) != 2:
    raise SystemExit(f'artifact review request: expected 2 filename regexes, found {text.count(old)}')
p.write_text(text.replace(old, new), encoding='utf-8')

# Bridge: verify either original raw media or the capture evidence screenshot, preserving evidence kind.
p = Path('tools/weather-artifact-review-bridge.ps1')
text = p.read_text(encoding='utf-8-sig')
start = text.index('$capture = Read-Json $capturePath')
end = text.index('$resultDirectory = Split-Path -Parent $CandidatePath')
new_block = r'''$capture = Read-Json $capturePath
if ($capture.status -cne 'captured' -or $null -eq $capture.evidence) {
    throw 'Confirmed capture evidence is required.'
}
$rawMedia = @($capture.rawMedia)

$rawCapturedAt = if (-not [string]::IsNullOrWhiteSpace([string]$capture.capturedAt)) { [string]$capture.capturedAt } else { [string]$capture.evidence.capturedAt }
$verifiedImages = @()
$pendingArtifact = $null
$pendingEvidencePath = ''
foreach ($selected in @($review.reviewedImages)) {
    $file = [string]$selected.file
    $imagePath = Join-Path $evidenceDirectory $file
    if (-not [IO.File]::Exists($imagePath)) { throw 'Reviewed artifact image is missing from the capture artifact.' }

    $expectedMime = ''
    $expectedSha = ''
    $expectedSize = 0L
    $kind = 'original'
    if ($file -ceq [string]$capture.evidence.file) {
        $expectedMime = [string]$capture.evidence.mimeType
        $expectedSha = [string]$capture.evidence.sha256
        $expectedSize = [long]$capture.evidence.byteSize
        $kind = if ([string]$capture.evidence.kind -match 'screenshot$') { 'screenshot' } else { 'original' }
    } else {
        $matches = @($rawMedia | Where-Object {
            [string]$_.file -ceq $file -and
            [string]$_.mimeType -ceq [string]$selected.mimeType -and
            [string]$_.sha256 -ceq [string]$selected.captureSha256
        })
        if ($matches.Count -ne 1) { throw 'Reviewed artifact image does not exactly match capture metadata.' }
        $expectedMime = [string]$matches[0].mimeType
        $expectedSha = [string]$matches[0].sha256
        $expectedSize = [long]$matches[0].byteSize
    }

    $artifact = New-WeatherEvidenceImage -Path $imagePath -Kind $kind -CapturedAt $rawCapturedAt
    if ($artifact.sha256 -cne $expectedSha -or
        $artifact.sha256 -cne [string]$selected.captureSha256 -or
        $artifact.byteSize -ne $expectedSize -or
        $artifact.mimeType -cne $expectedMime -or
        $artifact.mimeType -cne [string]$selected.mimeType) {
        throw 'Reviewed artifact image does not match its Actions capture metadata.'
    }
    $verifiedImages += [pscustomobject]@{
        file = $file
        mimeType = $artifact.mimeType
        byteSize = $artifact.byteSize
        sha256 = $artifact.sha256
        kind = $kind
    }
    if ($file -ceq [string]$review.pendingEvidenceFile) {
        $pendingArtifact = $artifact
        $pendingEvidencePath = $imagePath
    }
}
if ($null -eq $pendingArtifact -or [string]::IsNullOrWhiteSpace($pendingEvidencePath)) {
    throw 'Pending evidence image was not verified.'
}

'''
text = text[:start] + new_block + text[end:]
text = text.replace("kind = 'original'\n    capturedAt = $rawCapturedAt", "kind = $pendingArtifact.kind\n    capturedAt = $rawCapturedAt", 1)
text = text.replace("model = 'artifact-raw-media-visual-review'", "model = 'artifact-captured-visual-review'", 1)
text = text.replace("visualReview = 'artifact-raw-media-images'", "visualReview = 'artifact-captured-images'", 1)
text = text.replace("'review_scope=artifact-raw-media-visual'", "'review_scope=artifact-captured-visual'", 1)
text = text.replace("reviewScope='artifact-raw-media-visual'", "reviewScope='artifact-captured-visual'", 1)
p.write_text(text, encoding='utf-8')

# Issue workflow: private review URL publishing is legacy-only; skip it when no raw media and return a direct artifact binding.
p = Path('.github/workflows/weather-issue-automation.yml')
text = p.read_text(encoding='utf-8')
old_if = "if: ${{ needs.validate_capture.outputs.adapter == 'x-official-embed' && needs.capture_x.result == 'success' }}"
new_if = "if: ${{ needs.validate_capture.outputs.adapter == 'x-official-embed' && needs.capture_x.result == 'success' && needs.capture_x.outputs.raw_media_count != '0' }}"
if text.count(old_if) != 1:
    raise SystemExit(f'issue workflow publish condition matches={text.count(old_if)}')
text = text.replace(old_if, new_if, 1)
marker = '  return_url_artifact:\n'
if marker not in text:
    raise SystemExit('return_url_artifact marker missing')
fallback_job = r'''  return_x_artifact_fallback:
    needs: [validate_capture, capture_x]
    if: ${{ needs.validate_capture.outputs.adapter == 'x-official-embed' && needs.capture_x.result == 'success' && needs.capture_x.outputs.raw_media_count == '0' }}
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Return rendered evidence artifact binding to Issue
        uses: actions/github-script@v7
        env:
          ISSUE_NUMBER: ${{ needs.validate_capture.outputs.issue_number }}
          ARTIFACT_RUN_ID: ${{ needs.capture_x.outputs.artifact_run_id }}
          ARTIFACT_ID: ${{ needs.capture_x.outputs.artifact_id }}
          ARTIFACT_NAME: ${{ needs.capture_x.outputs.artifact_name }}
          EVIDENCE_SHA256: ${{ needs.capture_x.outputs.evidence_sha256 }}
        with:
          script: |
            const record = {
              schemaVersion: 4,
              responseType: 'weather-evidence-artifact',
              requestIssue: Number(process.env.ISSUE_NUMBER),
              artifact: {
                runId: process.env.ARTIFACT_RUN_ID,
                id: process.env.ARTIFACT_ID,
                name: process.env.ARTIFACT_NAME
              },
              reviewImages: [{
                file: 'evidence.jpg',
                mimeType: 'image/jpeg',
                captureSha256: process.env.EVIDENCE_SHA256,
                kind: 'screenshot'
              }]
            }
            await github.rest.issues.createComment({
              ...context.repo,
              issue_number: record.requestIssue,
              body: `<!-- heartopia-weather-artifact-v4 -->\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``
            })

'''
text = text.replace(marker, fallback_job + marker, 1)
p.write_text(text, encoding='utf-8')

print('Applied rendered screenshot fallback patch.')
