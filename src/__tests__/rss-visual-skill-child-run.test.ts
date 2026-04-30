/**
 * Phase 7 — RSS visual flow runs VEA long actions through the child-run
 * runner instead of awaiting `runSkill` directly.
 *
 * The manager exposes `__awaitVeaChildRunForTesting` /
 * `__translateVeaCloseToErrorForTesting` so this test can verify:
 *   1. RSS visual flow calls into the child runner for VEA actions.
 *   2. `queued_global_concurrency` triggers the bounded retry helper.
 *   3. `cancelled_user` close events surface as `killed` (NOT `failed`)
 *      in the manager's translated error — source plan §3 rule 7.
 *
 * The full DB-backed RSS job queue is intentionally out of scope here;
 * the seam under test is the helper that translates VEA close events
 * into the manager's response. The full integration (`runVisualFlow`
 * end-to-end) is exercised by the existing user-acceptance test.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RSSItemAnalysisManager } from '../main/modules/rss-engine/item-analysis-manager'
import type {
  StartSkillChildRunAndWaitParams,
  StartSkillChildRunAndWaitResult,
} from '../main/modules/skills-runtime/runtime-manager'
import type { SkillChildCloseEvent, SkillChildRunTerminalReason } from '../main/modules/agent-control/skill-child-run-types'

function makeCloseEvent(
  status: SkillChildCloseEvent['status'],
  terminalReason: SkillChildRunTerminalReason,
  overrides: Partial<SkillChildCloseEvent> = {},
): SkillChildCloseEvent {
  return {
    childRunId: overrides.childRunId ?? 'vTEST0001',
    skillId: overrides.skillId ?? 'video-expert-analyzer',
    status,
    terminalReason,
    outputDir: overrides.outputDir ?? '/tmp/vea-test',
    runStatePath: overrides.runStatePath ?? '/tmp/vea-test/run_state.json',
    sceneScoresPath: overrides.sceneScoresPath ?? null,
    deliveryReportPath: overrides.deliveryReportPath ?? null,
    progress: overrides.progress ?? {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
    },
    framePatch: overrides.framePatch ?? null,
    projectionPatch: overrides.projectionPatch ?? null,
    error: overrides.error ?? null,
  }
}

test('RSS visual flow calls the child runner for VEA pipeline action', async () => {
  const calls: StartSkillChildRunAndWaitParams[] = []
  const stub = async (
    params: StartSkillChildRunAndWaitParams,
  ): Promise<StartSkillChildRunAndWaitResult> => {
    calls.push(params)
    const close = makeCloseEvent('completed', 'completed')
    return {
      childRunId: close.childRunId,
      status: close.status,
      closeEvent: close,
      success: true,
    }
  }

  const manager = new RSSItemAnalysisManager({ startSkillChildRunAndWait: stub, veaAwaitRetryDelayMs: 0 })

  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/v.mp4', outputDir: '/tmp/vea-test' },
    timeoutMs: 35 * 60 * 1000,
  })

  assert.equal(calls.length, 1, 'manager should dispatch exactly once on a non-retry path')
  assert.equal(calls[0].skillId, 'video-expert-analyzer')
  assert.equal(calls[0].action, 'video_expert_pipeline')
  assert.equal(calls[0].triggerType, 'product')
  assert.equal(result.success, true)
  assert.equal(result.status, 'completed')
})

test('queued_global_concurrency triggers bounded retry (3 attempts max)', async () => {
  let attempts = 0
  const stub = async (): Promise<StartSkillChildRunAndWaitResult> => {
    attempts += 1
    // First two attempts: queued. Third attempt: completed.
    if (attempts < 3) {
      const close = makeCloseEvent('recoverable_paused', 'queued_global_concurrency')
      return {
        childRunId: close.childRunId,
        status: close.status,
        closeEvent: close,
        success: false,
      }
    }
    const close = makeCloseEvent('completed', 'completed')
    return {
      childRunId: close.childRunId,
      status: close.status,
      closeEvent: close,
      success: true,
    }
  }

  const manager = new RSSItemAnalysisManager({ startSkillChildRunAndWait: stub, veaAwaitRetryDelayMs: 0 })

  // Override the retry delay via a fake setTimeout wrapper isn't necessary;
  // the helper sleeps 5s between retries which adds ~10s here. That's fine
  // for a one-off acceptance test. If this becomes flaky we can reduce the
  // module-level VEA_AWAIT_RETRY_DELAY_MS in the future.
  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/v.mp4' },
  })

  assert.equal(attempts, 3, 'expected exactly 3 attempts before success')
  assert.equal(result.success, true)
  assert.equal(result.closeEvent.terminalReason, 'completed')
})

test('queued_global_concurrency exceeding retry limit propagates as failure', async () => {
  let attempts = 0
  const stub = async (): Promise<StartSkillChildRunAndWaitResult> => {
    attempts += 1
    const close = makeCloseEvent('recoverable_paused', 'queued_global_concurrency')
    return {
      childRunId: close.childRunId,
      status: close.status,
      closeEvent: close,
      success: false,
    }
  }

  const manager = new RSSItemAnalysisManager({ startSkillChildRunAndWait: stub, veaAwaitRetryDelayMs: 0 })

  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/v.mp4' },
  })

  assert.equal(attempts, 3, 'helper retries at most 3 times before giving up')
  assert.equal(result.success, false)
  assert.equal(result.closeEvent.terminalReason, 'queued_global_concurrency')
})

test('cancelled_user close event surfaces as killed, NOT failed (source plan §3 rule 7)', async () => {
  const stub = async (): Promise<StartSkillChildRunAndWaitResult> => {
    const close = makeCloseEvent('killed', 'cancelled_user', {
      error: { kind: 'cancelled_user', message: 'user cancelled the run' },
    })
    return {
      childRunId: close.childRunId,
      status: close.status,
      closeEvent: close,
      success: false,
    }
  }

  const manager = new RSSItemAnalysisManager({ startSkillChildRunAndWait: stub, veaAwaitRetryDelayMs: 0 })

  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/v.mp4' },
  })

  assert.equal(result.status, 'killed', 'killed must NOT collapse to failed')
  assert.equal(result.closeEvent.terminalReason, 'cancelled_user')

  // The translated error preserves the killed cause separately so the
  // manager surface can distinguish it from a generic skill failure.
  const error = manager.__translateVeaCloseToErrorForTesting(result, '视觉脚本分析失败')
  assert.equal((error as Error & { veaCause?: string }).veaCause, 'killed')
  assert.notEqual((error as Error & { veaCause?: string }).veaCause, 'failed')
  assert.match(error.message, /已取消/, 'killed close events must surface 已取消 in the message')
})

test('failed_skill close event surfaces as failed, with veaCause=failed', async () => {
  const stub = async (): Promise<StartSkillChildRunAndWaitResult> => {
    const close = makeCloseEvent('failed', 'failed_skill', {
      error: { kind: 'failed_skill', message: 'pipeline crashed at score_batches' },
    })
    return {
      childRunId: close.childRunId,
      status: close.status,
      closeEvent: close,
      success: false,
    }
  }

  const manager = new RSSItemAnalysisManager({ startSkillChildRunAndWait: stub, veaAwaitRetryDelayMs: 0 })
  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/v.mp4' },
  })

  assert.equal(result.status, 'failed')
  const error = manager.__translateVeaCloseToErrorForTesting(result, '视觉脚本分析失败')
  assert.equal((error as Error & { veaCause?: string }).veaCause, 'failed')
})

test('blocked close event surfaces as blocked with distinct veaCause', async () => {
  const stub = async (): Promise<StartSkillChildRunAndWaitResult> => {
    const close = makeCloseEvent('blocked', 'blocked_config', {
      error: { kind: 'blocked_config', message: 'missing provider key' },
    })
    return {
      childRunId: close.childRunId,
      status: close.status,
      closeEvent: close,
      success: false,
    }
  }

  const manager = new RSSItemAnalysisManager({ startSkillChildRunAndWait: stub, veaAwaitRetryDelayMs: 0 })
  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    params: { sceneScoresPath: '/tmp/x/scene_scores.json', mode: 'api' },
  })

  assert.equal(result.status, 'blocked')
  const error = manager.__translateVeaCloseToErrorForTesting(result, '视觉 AI 评分失败')
  assert.equal((error as Error & { veaCause?: string }).veaCause, 'blocked')
  assert.notEqual((error as Error & { veaCause?: string }).veaCause, 'failed')
  assert.match(error.message, /已阻塞/)
})
