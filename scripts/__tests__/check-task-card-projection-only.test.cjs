'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-task-card-projection-only.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-o-projection-only-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function writeChatPanel(rootDir, body) {
  writeFile(rootDir, 'src/renderer/components/agent/ChatPanel.tsx', body)
}

const VALID_BODY = `
import { taskProjectionToTaskCardRun } from './task-card-from-projection'
function build(projection, run, persistedRun) {
  return taskProjectionToTaskCardRun({
    scopeId: run.scopeId,
    taskId: projection?.taskId || run.taskId || persistedRun?.taskId || null,
    phase: run.phase,
    title: run.title,
    status: projection?.status,
    taskTitle: projection?.taskTitle ?? null,
    taskSummary: projection?.taskSummary ?? null,
    steps: normalizeProjectionSteps(projection?.steps) ?? [],
    currentStepId: projection?.currentStepId ?? null,
    waitingFor: resolveProjectionWaitingFor(projection),
    resumableActions: projection?.resumableActions ?? [],
    recentArtifacts: projection?.recentArtifacts ?? [],
    taskContinuation: projection?.continuationRef ?? null,
    progress: projection?.progress ?? null,
    blockedReason: projection?.blockedReason ?? null,
    interactionState: projection?.interactionState,
    taskType: projection?.taskType,
    budgetUsagePercent: projection?.budgetUsagePercent,
    budgetWarningLevel: projection?.budgetWarningLevel,
  })
}
`

const SPREAD_BODY = `
import { taskProjectionToTaskCardRun } from './task-card-from-projection'
function build(projection, run) {
  return taskProjectionToTaskCardRun({
    ...run,
    status: projection?.status,
  })
}
`

const RUN_FALLBACK_BODY = `
import { taskProjectionToTaskCardRun } from './task-card-from-projection'
function build(projection, run) {
  return taskProjectionToTaskCardRun({
    scopeId: run.scopeId,
    phase: run.phase,
    resumableActions: projection?.resumableActions || run.resumableActions,
    taskTitle: projection?.taskTitle || null,
    steps: normalizeProjectionSteps(projection?.steps) ?? [],
    waitingFor: resolveProjectionWaitingFor(projection),
    blockedReason: null,
  })
}
`

const SNAPSHOT_NAMED_BODY = `
import { taskProjectionToTaskCardRun } from './task-card-from-projection'
function build(snapshot) {
  return taskProjectionToTaskCardRun({
    scopeId: snapshot.scopeId,
    taskTitle: snapshot.taskTitle,
    steps: snapshot.steps,
  })
}
`

const PROJECTION_RENAMED_BODY = `
import { taskProjectionToTaskCardRun } from './task-card-from-projection'
function build(raw) {
  const projection = raw
  return taskProjectionToTaskCardRun({
    scopeId: projection.scopeId,
    taskTitle: projection.taskTitle,
    taskSummary: projection.taskSummary,
    steps: normalizeProjectionSteps(projection?.steps) ?? [],
    waitingFor: resolveProjectionWaitingFor(projection),
    resumableActions: projection?.resumableActions ?? [],
    recentArtifacts: projection?.recentArtifacts ?? [],
    taskContinuation: projection?.taskContinuation,
    progress: projection?.progress,
    memoryCapture: projection.memoryCapture,
    blockedReason: projection?.blockedReason,
    error: projection.error,
    updatedAt: projection.updatedAt,
    currentStepId: projection.currentStepId || null,
  })
}
`

const BARE_LITERAL_BODY = `
import { taskProjectionToTaskCardRun } from './task-card-from-projection'
function build(scopeId, run) {
  return taskProjectionToTaskCardRun({
    scopeId,
    taskId: run.taskId || null,
    phase: run.phase,
    taskTitle: null,
    taskSummary: null,
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    blockedReason: null,
    status: undefined,
    interactionState: undefined,
    taskType: undefined,
  })
}
`

test('valid projection-sourced constructor passes', (t) => {
  const root = makeHarnessRoot(t)
  writeChatPanel(root, VALID_BODY)
  const res = runIn(root)
  assert.equal(res.status, 0, `expected pass; stderr=${res.stderr}`)
})

test('forbidden spread `...run` fails', (t) => {
  const root = makeHarnessRoot(t)
  writeChatPanel(root, SPREAD_BODY)
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /spread_in_constructor/)
})

test('blacklist field with `|| run.X` fallback fails', (t) => {
  const root = makeHarnessRoot(t)
  writeChatPanel(root, RUN_FALLBACK_BODY)
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /blacklist_field_rhs_not_projection/)
  assert.match(res.stderr, /resumableActions/)
})

test('non-projection identifier `snapshot.X` fails (gate vocabulary)', (t) => {
  const root = makeHarnessRoot(t)
  writeChatPanel(root, SNAPSHOT_NAMED_BODY)
  const res = runIn(root)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /blacklist_field_rhs_not_projection/)
})

test('locally-aliased `projection` (rename pattern) passes', (t) => {
  const root = makeHarnessRoot(t)
  writeChatPanel(root, PROJECTION_RENAMED_BODY)
  const res = runIn(root)
  assert.equal(res.status, 0, `expected pass; stderr=${res.stderr}`)
})

test('bare literals (null/undefined/[]/`none`) pass — inMemoryTaskRuns shape', (t) => {
  const root = makeHarnessRoot(t)
  writeChatPanel(root, BARE_LITERAL_BODY)
  const res = runIn(root)
  assert.equal(res.status, 0, `expected pass; stderr=${res.stderr}`)
})
