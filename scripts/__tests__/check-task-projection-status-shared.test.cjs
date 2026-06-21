'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-task-projection-status-shared.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-status-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writeValidHarness(root) {
  writeFile(root, 'src/shared/ipc-contracts/task-projection.ts', `
import type { SkillChildRunStatus } from '../skill-child-run-status'
export type TaskProjectionStatus = SkillChildRunStatus
`)
  writeFile(root, 'src/shared/skill-child-run-status.ts', `
export const SKILL_CHILD_RUN_STATUSES = ['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked', 'completed', 'failed', 'killed'] as const
`)
  writeFile(root, 'src/renderer/types/electron.d.ts', `
type TaskProjectionStatusData = 'queued' | 'running' | 'recoverable_paused' | 'budget_paused' | 'blocked' | 'completed' | 'failed' | 'killed'
`)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-sync.ts', `
function resolveStatus(summary: any): any {
  if (summary.phase === 'cancelled') return 'killed'
  if (summary.phase === 'done') return 'completed'
  return 'running'
}
`)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-reconciler.ts', `
export const target = { status: 'completed' }
`)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-child-runner.ts', `
function childProjectionStatusForState(state: any): any {
  if (state === 'cancelled') return 'killed'
  if (state === 'done') return 'completed'
  return 'running'
}
`)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-task-tracker.ts', `
function lifecycleProjectionStatus(state: any): any {
  if (state === 'cancelled') return 'killed'
  if (state === 'done') return 'completed'
  return 'running'
}
function eventProjectionStatus(status: any): any {
  if (status === 'done') return 'completed'
  return 'running'
}
`)
  writeFile(root, 'src/main/modules/migrations.ts', `
export const migrations = [{
  name: '043_migrate_task_projection_status_to_child_status',
  up: () => \`
    WHEN 'done' THEN 'completed'
    WHEN 'cancelled' THEN 'killed'
  \`,
}]
`)
}

test('gate passes when projection status shares child-run vocabulary', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /check-task-projection-status-shared: ok/)
})

test('gate fails when wire status stops aliasing the child-run status type', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  writeFile(root, 'src/shared/ipc-contracts/task-projection.ts', `
export type TaskProjectionStatus = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /wire_import_missing|wire_alias_missing/)
})

test('gate fails when renderer wire type still includes old terminal statuses', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  writeFile(root, 'src/renderer/types/electron.d.ts', `
type TaskProjectionStatusData = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /renderer_status_missing|renderer_old_status/)
})

test('gate fails when a projection writer returns old terminal statuses', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-sync.ts', `
function resolveStatus(summary: any): any {
  if (summary.phase === 'cancelled') return 'cancelled'
  if (summary.phase === 'done') return 'done'
  return 'running'
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /sync_terminal_mapping_missing|sync_old_terminal_mapping/)
})

test('gate fails when migration 043 is missing', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  writeFile(root, 'src/main/modules/migrations.ts', `export const migrations = []`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /migration_missing/)
})

test('gate allows task step done status inside reconciler step patches', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-reconciler.ts', `
function patchParentStepsFromCompletedChild(record: any, childRunId: string, now: string): TaskProjectionRecord['steps'] {
  return record.steps.map((step: any) => {
    if (step.id !== childRunId) return step
    return {
      ...step,
      status: 'done',
      updatedAt: now,
    }
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('gate still fails when reconciler writes old projection terminal status', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  writeFile(root, 'src/main/modules/agent-control/task-projection/task-projection-reconciler.ts', `
export const target = { status: 'done' }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /reconciler_old_status_write/)
})
