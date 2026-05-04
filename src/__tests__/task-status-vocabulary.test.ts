import assert from 'node:assert/strict'
import test from 'node:test'

import {
  childRunToPhase,
  childRunToProjectionStatus,
  childRunToTaskActions,
  childRunToWaitingFor,
  phaseToUserLabel,
  projectionStatusToUserLabel,
} from '../renderer/modules/agent/task-status-vocabulary'
import type { ScopeRunState } from '../renderer/modules/agent/types'
import type {
  ActiveChildRunSummaryData,
  TaskProjectionRecordData,
} from '../renderer/types/electron'

const TASK_CARD_PHASE_CASES: Array<[ScopeRunState['phase'] | undefined, string]> = [
  ['planning', '规划中'],
  ['tool_running', '进行中'],
  ['responding', '进行中'],
  ['resuming', '进行中'],
  ['checkpoint', '等待继续'],
  ['takeover', '等待继续'],
  ['done', '已完成'],
  ['error', '失败'],
  ['cancelled', '已停止'],
  ['queued', '待处理'],
  ['idle', '待处理'],
  [undefined, '待处理'],
]

const TASK_PANEL_PHASE_CASES: Array<[ScopeRunState['phase'] | undefined, string]> = [
  ['queued', '排队中'],
  ['planning', '规划'],
  ['tool_running', '执行工具'],
  ['checkpoint', '检查点'],
  ['takeover', '人工接管'],
  ['resuming', '恢复中'],
  ['responding', '生成回复'],
  ['done', '完成'],
  ['error', '失败'],
  ['cancelled', '已取消'],
  ['idle', '待命'],
  [undefined, '待命'],
]

test('phaseToUserLabel taskCard surface preserves existing labels', () => {
  for (const [phase, expected] of TASK_CARD_PHASE_CASES) {
    assert.equal(phaseToUserLabel(phase, 'taskCard'), expected, `phase=${phase}`)
  }
  // default surface == 'taskCard'
  for (const [phase, expected] of TASK_CARD_PHASE_CASES) {
    assert.equal(phaseToUserLabel(phase), expected, `phase=${phase} (default surface)`)
  }
})

test('phaseToUserLabel taskPanel surface preserves existing labels', () => {
  for (const [phase, expected] of TASK_PANEL_PHASE_CASES) {
    assert.equal(phaseToUserLabel(phase, 'taskPanel'), expected, `phase=${phase}`)
  }
})

test('projectionStatusToUserLabel taskCard surface preserves existing labels', () => {
  const cases: Array<[TaskProjectionRecordData['status'] | undefined, string | null]> = [
    ['queued', '排队中'],
    ['running', '进行中'],
    ['blocked', '等待继续'],
    ['done', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已停止'],
    [undefined, null],
  ]
  for (const [status, expected] of cases) {
    assert.equal(projectionStatusToUserLabel(status, 'taskCard'), expected, `status=${status}`)
    // default surface
    assert.equal(projectionStatusToUserLabel(status), expected, `status=${status} (default surface)`)
  }
})

test('projectionStatusToUserLabel taskPanel surface preserves existing TaskPanel labels', () => {
  const cases: Array<[TaskProjectionRecordData['status'] | undefined, string]> = [
    ['queued', '排队中'],
    ['running', '进行中'],
    ['blocked', '待继续'],
    ['done', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
    [undefined, '待命'],
  ]
  for (const [status, expected] of cases) {
    assert.equal(projectionStatusToUserLabel(status, 'taskPanel'), expected, `status=${status}`)
  }
})

function row(overrides: Partial<ActiveChildRunSummaryData> = {}): ActiveChildRunSummaryData {
  return {
    childRunId: 'vcr_test',
    skillId: 'video-expert-analyzer-vnext',
    sessionId: null,
    scopeId: null,
    status: overrides.status ?? 'running',
    startedAt: '2026-05-02T00:00:00.000Z',
    outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json',
    progress: { detail: 'x' } as ActiveChildRunSummaryData['progress'],
    blockedReason: null,
    liveness: 'background',
    closeStatus: null,
    ...overrides,
  }
}

test('childRunToProjectionStatus maps closeStatus + status combinations', () => {
  // closeStatus wins over status
  assert.equal(childRunToProjectionStatus(row({ closeStatus: 'completed', status: 'running' })), 'done')
  assert.equal(childRunToProjectionStatus(row({ closeStatus: 'failed', status: 'running' })), 'failed')
  assert.equal(childRunToProjectionStatus(row({ closeStatus: 'killed', status: 'running' })), 'cancelled')
  assert.equal(childRunToProjectionStatus(row({ closeStatus: 'blocked', status: 'running' })), 'blocked')

  // status fallback when closeStatus null
  assert.equal(childRunToProjectionStatus(row({ closeStatus: null, status: 'completed' })), 'done')
  assert.equal(childRunToProjectionStatus(row({ closeStatus: null, status: 'failed' })), 'failed')
  assert.equal(childRunToProjectionStatus(row({ closeStatus: null, status: 'killed' })), 'cancelled')
  assert.equal(childRunToProjectionStatus(row({ closeStatus: null, status: 'blocked' })), 'blocked')

  // default running
  assert.equal(childRunToProjectionStatus(row({ closeStatus: null, status: 'running' })), 'running')
  assert.equal(childRunToProjectionStatus(row({ closeStatus: null, status: 'starting' })), 'running')
})

test('childRunToPhase maps to ScopeRunState phase', () => {
  assert.equal(childRunToPhase(row({ closeStatus: 'completed' })), 'done')
  assert.equal(childRunToPhase(row({ status: 'completed' })), 'done')
  assert.equal(childRunToPhase(row({ closeStatus: 'failed' })), 'error')
  assert.equal(childRunToPhase(row({ status: 'failed' })), 'error')
  assert.equal(childRunToPhase(row({ closeStatus: 'killed' })), 'cancelled')
  assert.equal(childRunToPhase(row({ status: 'killed' })), 'cancelled')
  // default — running, blocked, etc all map to checkpoint
  assert.equal(childRunToPhase(row({ closeStatus: null, status: 'running' })), 'checkpoint')
  assert.equal(childRunToPhase(row({ closeStatus: null, status: 'blocked' })), 'checkpoint')
})

test('childRunToWaitingFor reflects projection status', () => {
  assert.equal(childRunToWaitingFor(row({ closeStatus: null, status: 'running' })), 'background')
  assert.equal(childRunToWaitingFor(row({ closeStatus: null, status: 'blocked' })), 'input')
  assert.equal(childRunToWaitingFor(row({ closeStatus: 'completed' })), 'none')
  assert.equal(childRunToWaitingFor(row({ closeStatus: 'failed' })), 'none')
  assert.equal(childRunToWaitingFor(row({ closeStatus: 'killed' })), 'none')
})

test('childRunToTaskActions reflects projection status', () => {
  assert.deepEqual(childRunToTaskActions(row({ closeStatus: 'completed' })), ['open_artifact'])
  assert.deepEqual(childRunToTaskActions(row({ closeStatus: 'failed' })), ['retry', 'cancel', 'open_artifact'])
  assert.deepEqual(childRunToTaskActions(row({ closeStatus: 'killed' })), ['none'])
  assert.deepEqual(
    childRunToTaskActions(row({ closeStatus: null, status: 'running' })),
    ['continue', 'cancel', 'open_artifact'],
  )
  assert.deepEqual(
    childRunToTaskActions(row({ closeStatus: null, status: 'blocked' })),
    ['continue', 'cancel', 'open_artifact'],
  )
})
