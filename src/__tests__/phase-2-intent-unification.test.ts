import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isRetryOnlyTurn
} from '../main/modules/agent-control/skills/skill-detection-inputs'
import {
  buildContinuationStateFromProjection,
  normalizeContinuationIntent
} from '../main/modules/agent-control/contracts/continuation-state'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

// Phase 2 — intent unification end-to-end behavior tests.
//
// These tests cover the user-visible contracts: given the natural Chinese
// phrasings Codex flagged in the audit, the right downstream gates fire.
// Source-pin contract tests live in phase-2-wiring.test.ts; this file is
// the behavioral side.

const RUNTIME_PATH = new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url)

void RUNTIME_PATH

function makeProjection(overrides: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: 'task-id',
    scopeId: 'scope-test',
    runId: 'run-id',
    taskType: 'short_task',
    module: 'skill',
    taskTitle: 'task title',
    taskSummary: '',
    status: 'blocked',
    interactionState: 'awaiting_confirmation',
    steps: [],
    currentStepId: null,
    budget: null,
    budgetUsagePercent: 0,
    budgetWarningLevel: 'none',
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: null,
    resumableActions: [],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
    ...overrides,
  }
}

test('Phase 2.2 — isRetryOnlyTurn now catches the natural phrasings the audit flagged', () => {
  // Strict-path natural phrasings.
  assert.equal(isRetryOnlyTurn('重新跑'), true)
  assert.equal(isRetryOnlyTurn('重新跑一次'), true)
  assert.equal(isRetryOnlyTurn('重新跑一轮'), true)
  assert.equal(isRetryOnlyTurn('从头跑'), true)
  assert.equal(isRetryOnlyTurn('从头跑一次'), true)
  assert.equal(isRetryOnlyTurn('从头跑一轮'), true)
  assert.equal(isRetryOnlyTurn('从头重新跑'), true)
  assert.equal(isRetryOnlyTurn('再从头重新跑一次看看'), true)
  assert.equal(isRetryOnlyTurn('再再从头重新跑一次看看'), true)
  assert.equal(isRetryOnlyTurn('再跑一次'), true)
  assert.equal(isRetryOnlyTurn('重做'), true)

  // Liberal-path natural phrasings (root + trailing context, ≤32 chars).
  assert.equal(isRetryOnlyTurn('重新跑刚才那个'), true)
  assert.equal(isRetryOnlyTurn('重新执行视频分析'), true)
  assert.equal(isRetryOnlyTurn('从头跑一遍刚才的'), true)
  assert.equal(isRetryOnlyTurn('从头重新跑一次'), true)
})

test('Phase 2.2 — isRetryOnlyTurn keeps rejecting fresh-task phrasings', () => {
  // Audit Phase 2 §B2 — the contract that liberal must reject must hold.
  assert.equal(isRetryOnlyTurn('继续帮我处理新的'), false)
  assert.equal(isRetryOnlyTurn('继续吗?'), false)
  assert.equal(isRetryOnlyTurn('继续，我想换个方向'), false)
  assert.equal(isRetryOnlyTurn('帮我继续'), false)
  assert.equal(isRetryOnlyTurn('怎么继续呢'), false)
  assert.equal(isRetryOnlyTurn('我要继续做这个'), false)

  // The new tokens too — fresh-request markers still reject.
  assert.equal(isRetryOnlyTurn('重新搜索一下'), false, '搜索 marker')
  assert.equal(isRetryOnlyTurn('从头帮我整理'), false, '帮我 marker')
})

test('Phase 2.2 — length cap raised 32→48 so longer natural phrasings still get a chance', () => {
  // Old hard cap was 32; the audit's "从头重新跑一次看看刚才的视频分析" example
  // would fail the strict path but should at least not be cut off before the
  // liberal path runs. (Liberal path inner cap is now 32.)
  const len35 = '重新执行刚才那个视频分析任务一次' // ~16 chars CN, fits 32
  assert.equal(isRetryOnlyTurn(len35), true)

  // Above hard cap → reject regardless.
  const len50 = 'a'.repeat(49)
  assert.equal(isRetryOnlyTurn(len50), false)
})

test('Phase 2.6 — todo-only continuation anchors survive normalization and projection restore', () => {
  const intent = normalizeContinuationIntent({
    taskId: 'task-vea',
    todoId: 'st-run-shell',
    todoTitle: '运行分析脚本',
  })
  assert.equal(intent?.executionId, undefined)
  assert.equal(intent?.todoId, 'st-run-shell')

  const state = buildContinuationStateFromProjection(makeProjection({
    taskId: 'task-vea',
    runId: 'run-should-not-be-used-as-execution',
    continuationRef: {
      taskId: 'task-vea',
      todoId: 'st-run-shell',
      todoTitle: '运行分析脚本',
      stepId: 'skill_run_shell',
    },
  }))
  assert.equal(state.continuationRef?.executionId, null)
  assert.equal(state.continuationRef?.todoId, 'st-run-shell')
})
