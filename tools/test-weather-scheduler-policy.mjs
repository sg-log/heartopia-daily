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

test('scheduler guards successful slots and fingerprints source sets', () => {
  assert.match(workflow, /heartopia-weather-scheduled-success:/)
  assert.match(workflow, /heartopia-weather-discovery-fingerprint:/)
  assert.match(workflow, /already_succeeded/)
})

test('zero candidates fail so the independent snooze can retry', () => {
  assert.match(workflow, /No weather candidates found/)
  assert.match(workflow, /core\.setFailed/)
  assert.match(workflow, /steps\.slot\.outputs\.is_snooze == 'true'/)
})

test('snooze and manual failures include one-click manual recovery links', () => {
  assert.match(workflow, /Notify Discord after snooze or manual run fails/)
  assert.match(workflow, /actions\/workflows\/weather-scheduled-run\.yml/)
  assert.match(workflow, /次の定時更新を待つか、手動で再実行できます/)
})
