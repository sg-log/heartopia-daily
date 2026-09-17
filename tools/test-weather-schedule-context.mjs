import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workflowPath = '.github/workflows/weather-scheduled-run.yml'
const workflow = fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n')

function resolveStepScript() {
  const marker = '      - name: Resolve JST update slot\n'
  const stepStart = workflow.indexOf(marker)
  assert.notEqual(stepStart, -1, 'Resolve JST update slot step is missing')
  const runStart = workflow.indexOf('        run: |\n', stepStart)
  assert.notEqual(runStart, -1, 'Resolve step run block is missing')
  const bodyStart = runStart + '        run: |\n'.length
  const nextStep = workflow.indexOf('\n      - name:', bodyStart)
  assert.notEqual(nextStep, -1, 'Resolve step does not have a following step')
  return workflow.slice(bodyStart, nextStep).split('\n').map(line => line.replace(/^          /, '')).join('\n')
}

const resolverScript = resolveStepScript()
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'

function resolveContext({ nowUtc, eventName, schedule = '', slot = 'auto', targetDate = '', origin = 'manual', attemptKind = 'manual' }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartopia-weather-slot-'))
  const scriptPath = path.join(tempDir, 'resolve.ps1')
  const outputPath = path.join(tempDir, 'github-output.txt')
  try {
    fs.writeFileSync(scriptPath, resolverScript, 'utf8')
    fs.writeFileSync(outputPath, '', 'utf8')
    const shellArgs = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath]
    execFileSync(shell, shellArgs, {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        WEATHER_RESOLVE_NOW_UTC: nowUtc,
        EVENT_NAME: eventName,
        EVENT_SCHEDULE: schedule,
        MANUAL_SLOT: slot,
        MANUAL_TARGET_DATE: targetDate,
        MANUAL_ORIGIN: origin,
        MANUAL_ATTEMPT_KIND: attemptKind
      },
      stdio: 'pipe'
    })
    const outputBuffer = fs.readFileSync(outputPath)
    const output = outputBuffer[0] === 0xff && outputBuffer[1] === 0xfe
      ? outputBuffer.subarray(2).toString('utf16le')
      : outputBuffer.toString('utf8')
    return Object.fromEntries(
      output
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          const separator = line.indexOf('=')
          return [line.slice(0, separator), line.slice(separator + 1)]
        })
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

test('delayed evening backup resolves from its scheduled UTC time', () => {
  const result = resolveContext({
    nowUtc: '2026-09-17T15:12:00Z',
    eventName: 'schedule',
    schedule: '30 10 * * *'
  })
  assert.deepEqual(result, {
    target_date: '2026-09-17',
    slot: 'evening',
    is_snooze: 'true',
    origin: 'github-backup',
    attempt_kind: 'backup',
    run_key: '2026-09-17-evening'
  })
})

test('morning backup at 08:00 JST resolves to the current game date', () => {
  const result = resolveContext({
    nowUtc: '2026-09-17T23:00:00Z',
    eventName: 'schedule',
    schedule: '30 22 * * *'
  })
  assert.equal(result.target_date, '2026-09-18')
  assert.equal(result.slot, 'morning')
})

test('delayed morning backup crossing a UTC date keeps the original 07:30 JST game date', () => {
  const result = resolveContext({
    nowUtc: '2026-09-18T16:15:00Z',
    eventName: 'schedule',
    schedule: '30 22 * * *'
  })
  assert.equal(result.target_date, '2026-09-18')
  assert.equal(result.slot, 'morning')
  assert.equal(result.run_key, '2026-09-18-morning')
})

test('manual auto at 00:14 JST uses the previous game date and evening slot', () => {
  const result = resolveContext({
    nowUtc: '2026-09-17T15:14:00Z',
    eventName: 'workflow_dispatch'
  })
  assert.equal(result.target_date, '2026-09-17')
  assert.equal(result.slot, 'evening')
  assert.equal(result.run_key, '2026-09-17-evening')
})

test('manual explicit target date remains authoritative', () => {
  const result = resolveContext({
    nowUtc: '2026-09-17T15:14:00Z',
    eventName: 'workflow_dispatch',
    targetDate: '2026-09-20'
  })
  assert.equal(result.target_date, '2026-09-20')
  assert.equal(result.slot, 'evening')
  assert.equal(result.run_key, '2026-09-20-evening')
})

test('legacy cron events use the same scheduled-time game-date resolution', () => {
  const cases = [
    ['0 22 * * *', '2026-09-17T23:00:00Z', '2026-09-18', 'morning'],
    ['10 22 * * *', '2026-09-17T23:00:00Z', '2026-09-18', 'morning'],
    ['0 10 * * *', '2026-09-17T15:12:00Z', '2026-09-17', 'evening'],
    ['10 10 * * *', '2026-09-17T15:12:00Z', '2026-09-17', 'evening']
  ]
  for (const [schedule, nowUtc, targetDate, slot] of cases) {
    const result = resolveContext({ nowUtc, eventName: 'schedule', schedule })
    assert.equal(result.target_date, targetDate, schedule)
    assert.equal(result.slot, slot, schedule)
    assert.equal(result.origin, 'github-legacy', schedule)
    assert.equal(result.attempt_kind, 'backup', schedule)
  }
})
