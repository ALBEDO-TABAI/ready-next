import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  isRetryOnlyTurn,
  buildSkillDetectionInputs,
} from '../main/modules/agent-control/skill-detection-inputs'
import {
  buildContinuationStateFromProjection,
  normalizeContinuationIntent,
  parseContinuationControlText,
  selectContinuationProjection,
} from '../main/modules/agent-control/continuation-state'
import type { TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'

// Phase 2 — intent unification end-to-end behavior tests.
//
// These tests cover the user-visible contracts: given the natural Chinese
// phrasings Codex flagged in the audit, the right downstream gates fire.
// Source-pin contract tests live in phase-2-wiring.test.ts; this file is
// the behavioral side.

const RUNTIME_PATH = new URL('../main/modules/agent-control/runtime.ts', import.meta.url)
const SKILL_DETECTION_PATH = new URL('../main/modules/agent-control/skill-detection-inputs.ts', import.meta.url)
const CONTINUATION_STATE_PATH = new URL('../main/modules/agent-control/continuation-state.ts', import.meta.url)

void RUNTIME_PATH

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

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

test('Phase 2.3 — buildSkillDetectionInputs drops contextual when retry-only is detected', () => {
  // Simulate widget pollution: contextualUserInput is a long blob from a
  // prior turn's widget capsule, primaryInstruction is the user's actual
  // bare command "继续".
  const widgetBlob = '### Widget 更新上下文\n--- 文档内容开始 ---\n大段widget内容\n'.repeat(10)
  const inputs = buildSkillDetectionInputs({
    contextualUserInput: widgetBlob,
    primaryInstruction: '继续',
    pureUserText: '继续',
    previousPureUserInputs: [
      '使用 Video Expert Analyzer 分析 inside notion 视频',
    ],
  })

  // Audit Phase 2 §B3 — contextual blob must NOT leak into the inputs the
  // skill matcher scans, otherwise the matcher could false-match on stale
  // skill names embedded in the widget capsule.
  assert.ok(!inputs.includes(widgetBlob), 'widget blob excluded from retry-only inputs')
  // The user's bare retry command must still be there.
  assert.ok(inputs.includes('继续'))
  // Recent goals must be appended for re-discovery.
  assert.ok(inputs.includes('使用 Video Expert Analyzer 分析 inside notion 视频'))
})

test('Phase 2.3 — buildSkillDetectionInputs keeps contextual when NOT retry-only', () => {
  // Behavior unchanged for fresh tasks — contextual stays in the input set.
  const inputs = buildSkillDetectionInputs({
    contextualUserInput: '帮我分析这个视频',
    primaryInstruction: '帮我分析这个视频',
    pureUserText: '帮我分析这个视频',
  })

  assert.deepEqual(inputs, ['帮我分析这个视频'])
})

test('Phase 2.4 — parseContinuationControlText.shouldResolveContinuation catches the new tokens', () => {
  // Audit Phase 2 §B1 — the user's actual sentence "你需要从头跑一轮" must
  // trigger continuation lookup.
  assert.equal(parseContinuationControlText('你需要从头跑一轮').shouldResolveContinuation, true)
  assert.equal(parseContinuationControlText('从头重新跑一次看看').shouldResolveContinuation, true)
  assert.equal(parseContinuationControlText('再跑一遍刚才那个').shouldResolveContinuation, true)
  assert.equal(parseContinuationControlText('重新执行刚才的任务').shouldResolveContinuation, true)
  assert.equal(parseContinuationControlText('重做一次').shouldResolveContinuation, true)

  // Historical contract — keep working.
  assert.equal(parseContinuationControlText('继续刚才那个任务').shouldResolveContinuation, true)
  assert.equal(parseContinuationControlText('接着上次').shouldResolveContinuation, true)

  // Fresh tasks must NOT trigger.
  assert.equal(parseContinuationControlText('帮我看看今天的天气').shouldResolveContinuation, false)
  assert.equal(parseContinuationControlText('启动一个新对话').shouldResolveContinuation, false)
})

test('Phase 2.5 — selectContinuationProjection excludes terminal-status tasks from fallback', () => {
  // Audit Phase 2 §B4 — a recently-touched `done` task must NOT shadow a
  // real blocked one. Old behavior: sortedProjections[0] fallback would
  // return the done task. New behavior: terminal tasks are filtered out
  // before either find or fallback.
  const blocked = makeProjection({
    taskId: 'task-blocked',
    status: 'blocked',
    updatedAt: '2026-04-27T00:00:00.000Z',
    continuationRef: {
      taskId: 'task-blocked',
      executionId: 'exec-blocked',
      blockerType: 'need_confirmation',
    },
  })
  const done = makeProjection({
    taskId: 'task-done',
    status: 'done',
    interactionState: 'running',
    updatedAt: '2026-04-27T05:00:00.000Z', // newer
  })

  const selected = selectContinuationProjection({
    projections: [done, blocked],
    userText: '继续刚才那个任务',
  })

  // Even though `done` has the newer updatedAt, the live `blocked` is picked.
  assert.equal(selected?.taskId, 'task-blocked')
})

test('Phase 2.5 — selectContinuationProjection returns null when only done/cancelled tasks exist (post-screenshot hotfix narrowed terminal set)', () => {
  // Audit Phase 2 §B4 — the old fallback `sortedProjections[0]` returned a
  // closed task as if it were a continuation target. This was the source of
  // "理解需求" turns being falsely surfaced as the latest task. New behavior:
  // null when no live candidate exists, so the upstream gate falls back to
  // fresh-task routing.
  //
  // Screenshot-bug hotfix: `failed` was removed from the terminal set
  // because retry semantics ("再从头重新跑一次") clearly target failed tasks.
  // So this test now only includes done + cancelled to exercise the
  // "no live candidate" fallback path.
  const projections = [
    makeProjection({ taskId: 'task-done', status: 'done' }),
    makeProjection({ taskId: 'task-cancelled', status: 'cancelled' }),
  ]

  const selected = selectContinuationProjection({
    projections,
    userText: '继续刚才那个任务',
  })

  assert.equal(selected, null)
})

test('Phase 2.5 — failed tasks ARE selectable on retry intent (screenshot-bug hotfix)', () => {
  // Companion test: prove the failed-resume path works as the screenshot
  // user case demanded. "再从头重新跑一次看看" against a previously failed
  // VEA pipeline must surface the failed task so the orchestrator can
  // re-arm the reference skill.
  const failed = makeProjection({ taskId: 'task-vea-failed', status: 'failed' })
  const selected = selectContinuationProjection({
    projections: [failed],
    userText: '再从头重新跑一次看看',
  })
  assert.equal(selected?.taskId, 'task-vea-failed')
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

test('Phase 2.5 — explicit Task ID still resolves even on terminal tasks (deliberate user override)', () => {
  // Phase 2.5 only tightens implicit fallback; explicit Task ID is a deliberate
  // user / runtime override (e.g. inspecting a closed task). Honor it.
  const done = makeProjection({ taskId: 'task-done', status: 'done' })

  const selected = selectContinuationProjection({
    projections: [done],
    userText: 'Task ID: task-done',
    explicitTaskId: 'task-done',
  })

  assert.equal(selected?.taskId, 'task-done')
})

test('Phase 2.5 — does not regress: blocked tasks sorted by updatedAt (newer first)', () => {
  // Existing contract from continuation-state-contract.test.ts:103 — must
  // survive the terminal-filter change.
  const older = makeProjection({
    taskId: 'task-older',
    updatedAt: '2026-04-27T00:00:01.000Z',
    continuationRef: {
      taskId: 'task-older',
      executionId: 'exec-older',
      blockerType: 'need_confirmation',
    },
  })
  const newer = makeProjection({
    taskId: 'task-newer',
    updatedAt: '2026-04-27T00:00:03.000Z',
    continuationRef: {
      taskId: 'task-newer',
      executionId: 'exec-newer',
      blockerType: 'need_confirmation',
    },
  })

  const selected = selectContinuationProjection({
    projections: [older, newer],
    userText: '继续刚才那个任务',
  })

  assert.equal(selected?.taskId, 'task-newer')
})

// -----------------------------------------------------------------------------
// Source-pin wiring — these complement the behavioral tests above by guarding
// the contract that ALL three judgers go through the unified lexicon. Without
// these a future inline regex would silently re-introduce the divergence
// problem (audit Phase 2 §B1).
// -----------------------------------------------------------------------------

test('Phase 2 wiring — skill-detection-inputs.ts imports + uses matchesResumeIntent', () => {
  const source = readSource(SKILL_DETECTION_PATH)
  assert.match(source, /from\s+'\.\/resume-lexicon'/)
  assert.match(source, /matchesResumeIntent\(\s*normalized\s*,\s*'strict'\s*\)/)
  assert.match(source, /matchesResumeIntent\(\s*normalized\s*,\s*'liberal'\s*\)/)
  // Hard cap must be 48 (not 32) so liberal extension has room.
  assert.match(source, /normalized\.length\s*>\s*48/)
})

test('Phase 2 wiring — continuation-state.ts imports + uses matchesResumeIntent (anywhere)', () => {
  const source = readSource(CONTINUATION_STATE_PATH)
  assert.match(source, /from\s+'\.\/resume-lexicon'/)
  assert.match(source, /matchesResumeIntent\(sanitizedUserText\s*,\s*'anywhere'\)/)
  // Terminal exclusion helper must exist and be used.
  assert.match(source, /isTerminalProjection/)
  assert.match(source, /liveProjections\.find\(/, 'fallback runs against filtered list')
})

test('Phase 2 wiring — buildSkillDetectionInputs probes retry on primary+pure only, not contextual', () => {
  const source = readSource(SKILL_DETECTION_PATH)
  // The retry probe deliberately excludes contextualUserInput; pin this so
  // a future refactor doesn't reintroduce the widget-pollution path.
  assert.match(
    source,
    /retryProbes\s*=\s*uniqueNonEmpty\(\[\s*params\.primaryInstruction\s*,\s*params\.pureUserText\s*\]\)/,
  )
  // Fallback when primary/pure absent (test fixtures / legacy callers).
  assert.match(
    source,
    /probesForRetryCheck\s*=\s*retryProbes\.length\s*>\s*0\s*\?\s*retryProbes\s*:\s*currentInputs/,
  )
  assert.match(source, /probesForRetryCheck\.some\(\(text\)\s*=>\s*\n\s*isRetryOnlyTurn\(text\)\s*\|\|\s*isConfigRepairTurn\(text\)/)
})
