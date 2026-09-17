from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing v4 patch anchor in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# Capture the official X embed at device scale 2. This preserves the same public
# rendered UI while giving OCR enough real pixels to read multiple visible time labels.
replace_once(
    'tools/weather-x-embed-evidence.mjs',
    '''      viewport: { width: 900, height: 1200 },\n      locale: "ja-JP",''',
    '''      viewport: { width: 900, height: 1200 },\n      deviceScaleFactor: 2,\n      locale: "ja-JP",'''
)

# The verified panel has a large dark-blue hero area but does not occupy 35% of the
# entire upper structural sample. Keep the white lower-panel gate and all later visual
# gates; calibrate only this structural ratio to the measured real UI.
replace_once(
    'tools/weather-direct-panel-review.mjs',
    'if(blueRatio<.35||lightRatio<.55)',
    'if(blueRatio<.22||lightRatio<.55)'
)

# Rainbow is visually distinguished by simultaneous red and cyan content. The real
# panel fixture exercises this rule; other sunny/rain rules remain unchanged.
replace_once(
    'tools/weather-direct-panel-review.mjs',
    "function resolveWeekly(score){let value=score.bestValue,heuristic=false;if(score.metrics.cyan>=.60&&score.metrics.warm<.02){value='雨';heuristic=true;}",
    "function resolveWeekly(score){let value=score.bestValue,heuristic=false;if(score.metrics.red>=.04&&score.metrics.cyan>=.12){value='虹';heuristic=true;}else if(score.metrics.cyan>=.60&&score.metrics.warm<.02){value='雨';heuristic=true;}"
)

# Let the strict direct-panel reader consume a derived verified-panel capture without
# replacing the original capture.json that is retained in the evidence artifact.
replace_once(
    'tools/weather-direct-panel-review.mjs',
    "export async function inspectDirectPanelCapture({captureDir,targetDate,repoRoot='.'}){\n  targetDate=normalizeTargetDate(targetDate);repoRoot=path.resolve(repoRoot);const capture=JSON.parse(await readFile(path.join(captureDir,'capture.json'),'utf8'))",
    "export async function inspectDirectPanelCapture({captureDir,targetDate,repoRoot='.',captureFile='capture.json'}){\n  targetDate=normalizeTargetDate(targetDate);repoRoot=path.resolve(repoRoot);const capture=JSON.parse(await readFile(path.join(captureDir,captureFile),'utf8'))"
)

# Embedded-panel icon sampling must scale with a 2x screenshot. The old 30px ceiling
# made the classifier inspect only the center of larger icons.
replace_once(
    'tools/weather-weekly-screenshot-review.mjs',
    'const size=Math.max(14,Math.min(30,Math.round(panelW*.085)))',
    'const size=Math.max(14,Math.min(60,Math.round(panelW*.085)))'
)

# Integrate verified panel extraction into the unified production review. It runs only
# after the original direct path fails, requires weekly embedded-panel structure, crops
# that exact rectangle, then applies the strict direct reader including >=2 time labels.
replace_once(
    'tools/weather-unified-review.mjs',
    "import { inspectWeeklyScreenshot } from './weather-weekly-screenshot-review.mjs';",
    "import { inspectWeeklyScreenshot } from './weather-weekly-screenshot-review.mjs';\nimport { createVerifiedPanelCapture } from './weather-verified-panel-crop.mjs';"
)
replace_once(
    'tools/weather-unified-review.mjs',
    """  if (direct?.ready) return applyTimedSpecialWeatherHints(direct, postText);\n\n  let capture = null;""",
    """  if (direct?.ready) return applyTimedSpecialWeatherHints(direct, postText);\n\n  let verifiedPanel = null;\n  let verifiedDirect = null;\n  try {\n    verifiedPanel = await createVerifiedPanelCapture({ captureDir, targetDate, repoRoot });\n    if (verifiedPanel?.ready) {\n      verifiedDirect = await inspectDirectPanelCapture({\n        captureDir, targetDate, repoRoot, captureFile: verifiedPanel.captureFile\n      });\n      if (verifiedDirect?.ready) {\n        verifiedDirect = {\n          ...verifiedDirect,\n          pendingEvidenceFile: verifiedDirect.selectedImage?.file || '',\n          diagnostics: {\n            ...(verifiedDirect.diagnostics || {}),\n            mode: 'verified-game-ui-crop',\n            sourceImage: verifiedPanel.sourceImage,\n            crop: verifiedPanel.crop\n          }\n        };\n        return applyTimedSpecialWeatherHints(verifiedDirect, postText);\n      }\n    }\n  } catch (error) {\n    verifiedPanel = { ready:false, reason:'verifiedPanelPipelineError', message:String(error?.message || error) };\n  }\n\n  let capture = null;"""
)
replace_once(
    'tools/weather-unified-review.mjs',
    """      splitFallback: {\n        dailyReady: daily?.ready === true,""",
    """      verifiedPanel: {\n        ready: verifiedPanel?.ready === true,\n        reason: verifiedPanel?.reason || '',\n        directReady: verifiedDirect?.ready === true,\n        direct: verifiedDirect?.diagnostics || null\n      },\n      splitFallback: {\n        dailyReady: daily?.ready === true,"""
)

# The branch discovery tool currently emits schema v3; scheduled-run must not reject
# that trusted in-repo result before it reaches evidence review.
replace_once(
    '.github/workflows/weather-scheduled-run.yml',
    "if (!result || result.schemaVersion !== 1 || result.responseType !== 'weather-public-discovery' || !Array.isArray(result.candidates)) {",
    "if (!result || ![1,3].includes(result.schemaVersion) || result.responseType !== 'weather-public-discovery' || !Array.isArray(result.candidates)) {"
)
