import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const workflow = fs.readFileSync('.github/workflows/weather-scheduled-run.yml', 'utf8')

test('scheduler has primary, snooze, and manual triggers', () => {
  for (const cron of ["0 22 * * *", "10 22 * * *", "0 10 * * *", "10 10 * * *"]) {
    assert.ok(workflow.includes(`cron: '${cron}'`), `missing cron ${cron}`)
  }
  assert.match(workflow, /workflow_dispatch:/)
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

test('no usable public candidates fail so the independent snooze can retry', () => {
  assert.match(workflow, /No public weather candidates found/)
  assert.match(workflow, /No supported public evidence candidate found/)
  assert.match(workflow, /core\.setFailed/)
  assert.match(workflow, /steps\.slot\.outputs\.is_snooze == 'true'/)
})

test('snooze and manual failures include one-click manual recovery links', () => {
  assert.match(workflow, /Notify Discord after snooze or manual run fails/)
  assert.match(workflow, /actions\/workflows\/weather-scheduled-run\.yml/)
  assert.match(workflow, /次の定時更新を待つか、手動で再実行できます/)
})
