'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-run-state-schema-single-source.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-schema-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writeSchema(root) {
  writeFile(root, 'src/main/modules/agent-control/task-projection/run-state-schema.ts', `
export function parseRunStateJson(): void {}
export function validateRunStateRecord(): void {}
export function isRunStateDoneStatus(): void {}
export function isRunStateFailedStatus(): void {}
export function isRunStateFailedOrCancelledStatus(): void {}
export function isRunStateBlockedStatus(): void {}
export function isRunStateRunningStatus(): void {}
export function isRunStateReadyToFinalizeStatus(): void {}
`)
}

test('gate passes when run_state readers use the schema parser', (t) => {
  const root = makeHarnessRoot(t)
  writeSchema(root)
  writeFile(root, 'src/main/modules/agent-control/task-projection/run-state-selection.ts', `
import { parseRunStateJson } from './run-state-schema'
export function read(path: string) {
  return parseRunStateJson(readFileSync(path, 'utf8'), { path })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /check-run-state-schema-single-source: ok/)
})

test('gate fails when schema parser export is missing', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/task-projection/run-state-schema.ts', `
export function validateRunStateRecord(): void {}
export function isRunStateDoneStatus(): void {}
export function isRunStateFailedStatus(): void {}
export function isRunStateFailedOrCancelledStatus(): void {}
export function isRunStateBlockedStatus(): void {}
export function isRunStateRunningStatus(): void {}
export function isRunStateReadyToFinalizeStatus(): void {}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /parser_missing/)
})

test('gate fails when schema status helpers are missing', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/task-projection/run-state-schema.ts', `
export function parseRunStateJson(): void {}
export function validateRunStateRecord(): void {}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /status_helper_missing/)
})

test('gate flags direct run_state JSON.parse(readFileSync(...)) readers', (t) => {
  const root = makeHarnessRoot(t)
  writeSchema(root)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-running-projection.ts', `
const RUN_STATE_FILENAME = 'run_state.json'
export function readRunState(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /direct_run_state_json_parse/)
})

test('gate flags copied run_state status sets in live readers', (t) => {
  const root = makeHarnessRoot(t)
  writeSchema(root)
  writeFile(root, 'src/main/modules/agent-control/video-expert-child-driver.ts', `
const COMPLETED_STATUSES = new Set(['completed', 'success', 'done', 'succeeded', 'complete'])
export function ok(status: string) { return COMPLETED_STATUSES.has(status) }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /local_run_state_status_set/)
})

test('gate ignores non-run_state JSON helpers in scanned files', (t) => {
  const root = makeHarnessRoot(t)
  writeSchema(root)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-child-runner.ts', `
export function readDelivery(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
