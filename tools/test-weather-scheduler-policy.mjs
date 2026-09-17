import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const workflow = fs.readFileSync('.github/workflows/weather-scheduled-run.yml', 'utf8')

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
})

test('scheduler connects public Web and X through unified daily plus weekly review and one pending submit', () => {
  assert.match(workflow, /weather-x-embed-evidence\.mjs/)
  assert.match(workflow, /weather-cloud-url-evidence\.mjs/)
  assert.match(workflow, /sourceType -eq 'x'/)
  assert.match(workflow, /sourceType -eq 'web'/)
  assert.match(workflow, /weather-unified-review\.mjs/)
  assert.match(workflow, /weeklyCount/)
  assert.match(workflow, /weather-artifact-review-bridge\.ps1/)
  assert.match(workflow, /weather-cloud-submit-unified\.ps1/)
  assert.match(workflow, /デイリー＋週間天気pending/)
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/)
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
