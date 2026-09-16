import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const workflow = fs.readFileSync('.github/workflows/weather-scheduled-run.yml', 'utf8')
const notify = fs.readFileSync('.github/workflows/weather-discord-notify.yml', 'utf8')

test('scheduler has primary, snooze, and manual triggers', () => {
  for (const cron of ["0 22 * * *", "10 22 * * *", "0 10 * * *", "10 10 * * *"]) {
    assert.match(workflow, new RegExp(cron.replace(/\*/g, '\\*')))
  }
  assert.match(workflow, /workflow_dispatch:/)
})

test('scheduler guards successful slots and fingerprints source sets', () => {
  assert.match(workflow, /heartopia-weather-scheduled-success:/)
  assert.match(workflow, /heartopia-weather-discovery-fingerprint:/)
  assert.match(workflow, /already_succeeded/)
})

test('zero candidates fail so snooze can retry', () => {
  assert.match(workflow, /No weather candidates found/)
  assert.match(workflow, /core\.setFailed/)
})

test('discord failure watcher includes the scheduled workflow', () => {
  assert.match(notify, /Weather scheduled run/)
})
