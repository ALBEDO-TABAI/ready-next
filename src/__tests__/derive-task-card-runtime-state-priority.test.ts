import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveTaskCardRuntimeState,
  type TaskCardRunLike,
} from '../renderer/modules/agent/taskCardViewModel'

/**
 * Stage O §1.4 / O4 — `deriveTaskCardRuntimeState` is the single
 * decision point for task-card visualState. Stage O re-orders the
 * priority to match CLAUDE.md §6.13: failed-no-background > background
 * > budget_paused > waiting > done > running. The pre-Stage-O code
 * had budget_paused above background and required `!hasBudgetPaused`
 * for failed; both are fixed here.
 */

function makeRun(partial: Partial<TaskCardRunLike>): TaskCardRunLike {
  return {
    scopeId: 's1',
    title: 't',
    phase: 'tool_running',
    updatedAt: new Date().toISOString(),
    ...partial,
  }
}

test('rank-100 — failed without background → visualState=failed', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'error',
    status: 'failed',
    canResume: true,
  }))
  assert.equal(state.visualState, 'failed')
  assert.deepEqual(state.actionSet, ['retry', 'cancel', 'open_artifact'])
})

test('rank-90 — failed BUT live background → background_running wins', () => {
  // Stage O regression-check: pre-Stage-O code with `!hasLiveBackground`
  // already returned `background_running`, but only because the failed
  // branch was guarded. v3 keeps the guard explicit; this test pins
  // it down to prevent a future code change that would let
  // `failed + background` show as `failed`.
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'error',
    status: 'failed',
    waitingFor: 'background',
  }))
  assert.equal(state.visualState, 'background_running')
})

test('rank-100 — failed + budget_paused (no background) → still failed (Stage O fix)', () => {
  // Stage O regression-check: pre-Stage-O code wrongly required
  // `!hasBudgetPaused` for the failed branch, so a failed task with
  // a stale budget_paused signal would show `budget_paused`. The
  // fixed branch only requires `!hasLiveBackground`.
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'error',
    status: 'failed',
    terminalReason: 'checkpoint_budget',
  }))
  assert.equal(state.visualState, 'failed')
})

test('rank-90 — background + budget_paused → background_running (Stage O fix)', () => {
  // Stage O regression-check: pre-Stage-O code put budget_paused above
  // background, so this case wrongly showed `budget_paused`. Per
  // CLAUDE.md §6.13, background outranks budget_paused.
  const state = deriveTaskCardRuntimeState(makeRun({
    waitingFor: 'background',
    terminalReason: 'checkpoint_budget',
  }))
  assert.equal(state.visualState, 'background_running')
})

test('rank-80 — budget_paused without background → budget_paused', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    terminalReason: 'checkpoint_budget',
    canResume: true,
  }))
  assert.equal(state.visualState, 'budget_paused')
  assert.deepEqual(state.actionSet, ['continue', 'retry', 'cancel'])
})

test('rank-70 — waiting_input without agent handoff', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    waitingFor: 'input',
    interactionState: 'awaiting_clarification',
    status: 'blocked',
  }))
  assert.equal(state.visualState, 'waiting_input')
})

test('rank-50 — done with artifacts → open_artifact action', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'done',
    status: 'done',
    recentArtifacts: [{
      id: 'a1',
      module: 'skill',
      kind: 'folder',
      label: 'output',
      path: '/tmp/x',
      createdAt: new Date().toISOString(),
    }],
  }))
  assert.equal(state.visualState, 'done')
  assert.deepEqual(state.actionSet, ['open_artifact'])
})

test('rank-50 — completed projection ignores stale background continuation', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'done',
    terminalReason: 'done',
    status: 'completed',
    waitingFor: 'none',
    taskContinuation: {
      taskId: 'task-completed',
      blockerType: 'background_running',
      pauseReason: 'background_running',
      outputDir: '/tmp/vea',
      runStatePath: '/tmp/vea/run_state.json',
    },
    recentArtifacts: [{
      id: 'a1',
      module: 'skill',
      kind: 'folder',
      label: 'output',
      path: '/tmp/vea',
      createdAt: new Date().toISOString(),
    }],
  }))
  assert.equal(state.visualState, 'done')
  assert.deepEqual(state.actionSet, ['open_artifact'])
})

test('active foreground phase wins over stale completed projection', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'tool_running',
    status: 'completed',
    taskSummary: '方案草稿已写入，正在准备保存',
    recentArtifacts: [{
      id: 'a1',
      module: 'skill',
      kind: 'artifact',
      label: 'draft',
      path: '/tmp/draft.md',
      createdAt: new Date().toISOString(),
    }],
  }))
  assert.equal(state.visualState, 'running')
  assert.equal(state.statusLabel, '进行中')
  assert.deepEqual(state.actionSet, ['cancel'])
})

test('active responding phase wins over stale completed projection', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'responding',
    status: 'completed',
  }))
  assert.equal(state.visualState, 'running')
  assert.equal(state.statusLabel, '进行中')
  assert.deepEqual(state.actionSet, ['cancel'])
})

test('rank-50 — cancelled projection ignores stale background signals', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'cancelled',
    status: 'killed',
    waitingFor: 'background',
    taskContinuation: {
      taskId: 'task-cancelled',
      blockerType: 'background_running',
      pauseReason: 'background_running',
      outputDir: '/tmp/browser-collection',
      runStatePath: '/tmp/browser-collection/run_state.json',
    },
    canResume: false,
  }))
  assert.equal(state.visualState, 'done')
  assert.equal(state.statusLabel, '已停止')
  assert.deepEqual(state.actionSet, [])
})

test('rank-10 — plain running, no signals', () => {
  const state = deriveTaskCardRuntimeState(makeRun({
    phase: 'tool_running',
    status: 'running',
  }))
  assert.equal(state.visualState, 'running')
  assert.deepEqual(state.actionSet, ['cancel'])
})
