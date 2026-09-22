import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const workflow = fs.readFileSync('.github/workflows/weather-scheduled-run.yml', 'utf8')
const unifiedSubmit = fs.readFileSync('tools/weather-cloud-submit-unified.ps1', 'utf8')
const discovery = fs.readFileSync('tools/weather-public-discovery.mjs', 'utf8')

test('Apps Script is primary clock and GitHub cron is delayed backup', () => {
  for (const cron of ["30 22 * * *", "30 10 * * *"]) {
    assert.ok(workflow.includes(`cron: '${cron}'`), `missing backup cron ${cron}`)
  }
  for (const oldCron of ["    - cron: '0 22 * * *'", "    - cron: '10 22 * * *'", "    - cron: '0 10 * * *'", "    - cron: '10 10 * * *'"]) {
    assert.equal(workflow.includes(oldCron), false, `legacy cron must not remain scheduled: ${oldCron}`)
  }
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /trigger_origin:/)
  assert.match(workflow, /attempt_kind:/)
  assert.match(workflow, /group: weather-scheduled-run/)
})

test('scheduler guards only a fully successful date-slot and does not short-circuit on source URLs', () => {
  assert.match(workflow, /heartopia-weather-scheduled-success:/)
  assert.match(workflow, /already_succeeded/)
  assert.doesNotMatch(workflow, /heartopia-weather-source-success:/)
  const guard = workflow.indexOf('- name: Check whether this update slot already succeeded')
  const discovery = workflow.indexOf('- name: Discover public weather candidates')
  assert.ok(guard >= 0 && discovery > guard, 'success-marker guard must run before discovery')
  assert.match(workflow, /if \(process\.env\.ALREADY_SUCCEEDED === 'true'\) \{[\s\S]*?core\.setOutput\('notify_failure', 'false'\)[\s\S]*?return/)
})

test('scheduler derives schedule dates from the intended cron time and manual dates from the 06:00 game day', () => {
  assert.match(workflow, /\$scheduledUtc = \[DateTimeOffset\]::new/)
  assert.match(workflow, /if \(\$scheduledUtc -gt \$nowUtc\) \{ \$scheduledUtc = \$scheduledUtc\.AddDays\(-1\) \}/)
  assert.match(workflow, /\$scheduledUtc\.ToOffset\(\[TimeSpan\]::FromHours\(9\)\)\.AddHours\(-6\)/)
  assert.match(workflow, /\$nowJst\.AddHours\(-6\)/)
  assert.match(workflow, /\$nowJst\.Hour -ge 6 -and \$nowJst\.Hour -lt 13/)
})

test('scheduler accepts the current public-discovery schema version', () => {
  const schemaMatch = discovery.match(/schemaVersion:\s*(\d+)/)
  assert.ok(schemaMatch, 'current discovery schemaVersion must be declared')
  const currentSchema = Number(schemaMatch[1])
  const gateMatch = workflow.match(/!\[([^\]]+)\]\.includes\(result\.schemaVersion\)/)
  assert.ok(gateMatch, 'workflow must explicitly validate discovery schema versions')
  const accepted = gateMatch[1].split(',').map(v => Number(v.trim())).filter(Number.isFinite)
  assert.ok(accepted.includes(currentSchema), `workflow must accept discovery schemaVersion ${currentSchema}`)
})

test('scheduler reviews each Web or X candidate as same-image unified first, then daily-only', () => {
  assert.match(workflow, /weather-x-embed-evidence\.mjs/)
  assert.match(workflow, /weather-cloud-url-evidence\.mjs/)
  assert.match(workflow, /sourceType -eq 'x'/)
  assert.match(workflow, /sourceType -eq 'web'/)
  assert.match(workflow, /weather-unified-review\.mjs/)
  assert.match(workflow, /weather-direct-daily-panel-review\.mjs/)
  assert.match(workflow, /weeklyCount/)
  assert.match(workflow, /weather-artifact-review-bridge\.ps1/)
  assert.match(workflow, /weather-cloud-submit-unified\.ps1/)
  const unifiedReview = workflow.indexOf('weather-unified-review.mjs')
  const dailyOnlyReview = workflow.indexOf('weather-direct-daily-panel-review.mjs')
  assert.ok(unifiedReview >= 0 && dailyOnlyReview > unifiedReview, 'unified review must run before daily-only review for each candidate')
  assert.match(workflow, /\$completeSearchLimit = \[Math\]::Min\(\$candidates\.Count, 8\)/)
  assert.match(workflow, /Hold current-slot daily-only fallback/)
  assert.match(workflow, /Select complete current-slot daily\+weekly evidence/)
  assert.match(workflow, /No complete daily\+weekly candidate found in the bounded search; select verified daily-only fallback/)
  assert.match(workflow, /\$global:LASTEXITCODE = 0/)
  const fallbackMessage = workflow.indexOf('No complete daily+weekly candidate found in the bounded search; select verified daily-only fallback')
  const resetExit = workflow.indexOf('$global:LASTEXITCODE = 0')
  const selectedOutput = workflow.indexOf('"selected_dir=$env:SELECTED_DIR"')
  assert.ok(fallbackMessage >= 0 && resetExit > fallbackMessage && selectedOutput > resetExit, 'verified fallback must clear stale native exit code before step outputs')
  const completeSelection = workflow.indexOf("$selectionMode = 'daily-weekly'")
  const fallbackSelection = workflow.indexOf("$selectionMode = 'daily-only'")
  assert.ok(completeSelection >= 0 && fallbackSelection > completeSelection, 'complete daily+weekly must be preferred before daily-only fallback')
  assert.doesNotMatch(workflow, /weather-cross-source-review\.mjs|\$dailyDir|\$weeklyDir|weekly-only-review\.json/)
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/)
})

test('current-slot and target-date gates reject stale 00 daily evidence', () => {
  assert.match(workflow, /RUN_SLOT -eq 'morning'\) \{ '06' \} elseif \(\$env:RUN_SLOT -eq 'evening'\) \{ '18' \}/)
  assert.match(workflow, /\[string\]\$review\.targetDate -ceq \$env:TARGET_DATE/)
  assert.match(workflow, /\[string\]\$review\.interpretation\.observedDate -ceq \$env:TARGET_DATE/)
  assert.match(workflow, /\$actualStartSlot -ceq \$expectedStartSlot/)
  assert.match(workflow, /\[string\]\$dailyReview\.targetDate -ceq \$env:TARGET_DATE/)
  assert.match(workflow, /\$dailyStart -ceq \$expectedStartSlot/)
  assert.match(workflow, /\$dailySlots\.Count -eq 5/)
})

test('daily-only submit stores seven blank weeks while unified submit keeps same-image weeks', () => {
  assert.match(unifiedSubmit, /1\.\.7 \| ForEach-Object \{ \$weeks\["week\$_"\] = @\(\) \}/)
  assert.match(unifiedSubmit, /if \(\$days\.Count -eq 0\) \{ return \[pscustomobject\]@\{ weeks = \$weeks; count = 0 \} \}/)
  assert.match(unifiedSubmit, /デイリーのみ（週間は既存維持）/)
  assert.doesNotMatch(unifiedSubmit, /crossSource|週間出典:/)
})

test('failed candidate diagnostics artifact remains enabled', () => {
  assert.match(workflow, /name: Upload failed candidate diagnostics/)
  assert.match(workflow, /name: weather-scheduled-failure-\$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/weather-candidate-\*/)
  assert.match(workflow, /retention-days: 3/)
})

test('failed primary stays quiet while Apps Script retry is the terminal notification point', () => {
  assert.match(workflow, /No public weather candidates found/)
  assert.match(workflow, /No supported public evidence candidate found/)
  assert.match(workflow, /core\.setFailed/)
  assert.match(workflow, /origin === 'apps-script' && attemptKind === 'retry'/)
  assert.match(workflow, /notify_failure/)
})

test('terminal failures include one-click manual recovery without duplicate backup alerts', () => {
  assert.match(workflow, /Notify Discord after terminal failure/)
  assert.match(workflow, /steps\.finalize\.outputs\.notify_failure == 'true'/)
  assert.match(workflow, /heartopia-weather-failure:/)
  assert.match(workflow, /apps-script:retry/)
  assert.match(workflow, /actions\/workflows\/weather-scheduled-run\.yml/)
  assert.match(workflow, /手動で再実行できます/)
})
