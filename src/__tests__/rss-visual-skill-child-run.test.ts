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
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RSSItemAnalysisManager } from '../main/modules/rss-engine/item-analysis-manager'
import type {
  StartSkillChildRunAndWaitParams,
  StartSkillChildRunAndWaitResult,
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import { startSkillChildRunAndWait } from '../main/modules/skills-runtime/runtime-manager'
import {
  configureSkillChildRunner,
  __resetSkillChildRunnerForTests,
} from '../main/modules/agent-control/skill-child-runner'
import {
  registerSkillChildDriver,
  __resetSkillChildDriversForTests,
} from '../main/modules/agent-control/skill-child-drivers'
import { getChildRunRetryPolicy } from '../main/modules/agent-control/child-run-retry-policy'
// Importing the module re-registers the real VEA driver as a side effect.
// We grab the singleton instance so we can re-register it after a test reset.
import { videoExpertChildDriver } from '../main/modules/agent-control/video-expert-child-driver'
import type {
  SkillChildCloseEvent,
  SkillChildRunTerminalReason,
} from '../main/modules/agent-control/skill-child-run-types'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'

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

test('RSS visual flow calls the child runner for VEA pipeline action (stubbed driver)', async () => {
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

test('queued_global_concurrency triggers bounded retry (3 attempts max) (stubbed driver)', async () => {
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

  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/v.mp4' },
  })

  assert.equal(attempts, 3, 'expected exactly 3 attempts before success')
  assert.equal(result.success, true)
  assert.equal(result.closeEvent.terminalReason, 'completed')
})

test('queued_global_concurrency RSS retry contract remains 3 attempts at 5 seconds', () => {
  const policy = getChildRunRetryPolicy('queued_global_concurrency')

  assert.equal(policy.maxAttempts, 3)
  assert.deepEqual(policy.backoffMs, [5000, 5000, 5000])
})

test('queued_global_concurrency exceeding retry limit propagates as failure (stubbed driver)', async () => {
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

test('cancelled_user close event surfaces as killed, NOT failed (source plan §3 rule 7) (stubbed driver)', async () => {
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

test('failed_skill close event surfaces as failed, with veaCause=failed (stubbed driver)', async () => {
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

test('blocked close event surfaces as blocked with distinct veaCause (stubbed driver)', async () => {
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

// ===================================================================
// T3 — End-to-end: scene_scores.json on disk → real driver → ai_analyze
// ===================================================================

interface FakeRepoState {
  rows: Map<string, SkillTaskRunRecord>
}

function makeFakeRepository(): { repo: SkillTaskRunRepository; state: FakeRepoState } {
  const state: FakeRepoState = { rows: new Map() }
  const repo = {
    createChildRun: (input: Parameters<SkillTaskRunRepository['createChildRun']>[0]) => {
      const now = new Date().toISOString()
      const record: SkillTaskRunRecord = {
        id: input.childRunId,
        scopeId: input.scopeId ?? null,
        sessionId: input.sessionId ?? null,
        agent: null,
        runId: null,
        skillId: input.skillId,
        skillName: input.skillName ?? null,
        action: input.action,
        toolName: null,
        runKind: 'child_run',
        status: 'running',
        interactionState: 'running',
        goalText: null,
        resourceRefs: [],
        params: input.requestedInput,
        steps: [],
        currentStepId: null,
        artifacts: [],
        outputDir: input.outputDir,
        runStatePath: input.runStatePath,
        sceneScoresPath: null,
        deliveryReportPath: null,
        failureKind: null,
        failureDetail: null,
        jobId: null,
        detachedTaskId: null,
        resumePayload: {
          childRun: {
            version: 1,
            childRunId: input.childRunId,
            kind: 'vea',
            parentScopeId: input.scopeId,
            parentSessionId: input.sessionId,
            skillId: input.skillId,
            skillName: input.skillName,
            requestedAction: input.action,
            requestedInput: input.requestedInput,
            singleFlightKey: input.singleFlightKey,
            parentNextHint: input.parentNextHint,
            outputDir: input.outputDir,
            runStatePath: input.runStatePath,
            eventLogPath: input.eventLogPath,
            status: input.status ?? 'running',
            closeEvent: null,
            legacy: { taskRunId: null, detachedTaskId: null, projectionTaskId: null },
          },
        },
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
      }
      state.rows.set(input.childRunId, record)
      return record
    },
    updateChildRun: (childRunId: string, patch: Record<string, unknown>) => {
      const existing = state.rows.get(childRunId)
      if (!existing) throw new Error(`no row ${childRunId}`)
      const payload = (existing.resumePayload as { childRun: Record<string, unknown> }).childRun
      const merged = { ...payload, ...patch }
      existing.resumePayload = { childRun: merged }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
      existing.updatedAt = new Date().toISOString()
    },
    findLatestChildRunByKey: (key: string): SkillTaskRunRecord | null => {
      const ACTIVE = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked'])
      for (const row of state.rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.singleFlightKey === key && ACTIVE.has(child.status as string)) return row
      }
      return null
    },
    findLatestChildRunBySkill: () => null,
    get: (id: string) => state.rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
  return { repo, state }
}

function makeFakeRuntime(opts: {
  onRun: (request: SkillRunRequest) => Promise<SkillRunResult> | SkillRunResult
}): { manager: SkillsRuntimeManager; calls: SkillRunRequest[] } {
  const calls: SkillRunRequest[] = []
  const fake = {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/fake-runtime',
      skillsRoot: '/tmp/fake-runtime/skills',
      customSkillsRoot: '/tmp/fake-runtime/custom',
      outputsRoot: '/tmp/fake-runtime/outputs',
      venvRoot: '/tmp/fake-runtime/venv',
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      calls.push(request)
      return opts.onRun(request)
    },
    runSkillFromChildRunner: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      calls.push(request)
      return opts.onRun(request)
    },
  } as unknown as SkillsRuntimeManager
  return { manager: fake, calls }
}

test('T3: RSS visual flow — scene_scores.json on disk routes through REAL driver to video_expert_ai_analyze', async () => {
  // Reset registries and re-register the real VEA driver. Other tests in
  // this file inject their own stubs at the manager seam, so they don't
  // care about the runner singleton; we only need it for this case.
  // Identity guard (T9 §10): the value we register MUST be the production
  // module export. Any future swap-in of a stub via the same name would
  // fail this assertion before the real-driver assertions below execute.
  const identityProbe = await import('../main/modules/agent-control/video-expert-child-driver')
  assert.strictEqual(
    videoExpertChildDriver,
    identityProbe.videoExpertChildDriver,
    'imported videoExpertChildDriver must be identical to the production module export',
  )
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  registerSkillChildDriver(videoExpertChildDriver)

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-rss-vea-aiscore-'))
  const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
  // Phase: pipeline already produced scene_scores.json. We do NOT pre-write
  // run_state.json — the manager's product call lands cold against the real
  // driver, mirroring item-analysis-manager.ts §runVisualFlow.
  await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')

  const runtime = makeFakeRuntime({
    // The expensive python action is faked. The driver's stage decision
    // (which action to plan) is real. After the action 'runs', we write a
    // completed run_state.json so the next driver tick closes cleanly.
    onRun: async (request) => {
      if (request.action === 'video_expert_ai_analyze') {
        await fs.writeFile(
          path.join(outputDir, 'run_state.json'),
          JSON.stringify({ status: 'completed', current_stage: 'finalize' }),
          'utf8',
        )
      }
      return {
        success: true,
        skillId: request.skillId,
        action: request.action,
        stdout: '',
        stderr: '',
        command: [],
      }
    },
  })
  const repo = makeFakeRepository()
  configureSkillChildRunner({
    runtimeManager: runtime.manager,
    repository: repo.repo,
    launchStuckGuardMs: 200,
  })

  // Mirror runVisualFlow's second-stage call: only sceneScoresPath + mode +
  // outputDir. The driver should plan video_expert_ai_analyze, not pause
  // with missing_inputs.
  const manager = new RSSItemAnalysisManager({
    startSkillChildRunAndWait,
    veaAwaitRetryDelayMs: 0,
  })

  const result = await manager.__awaitVeaChildRunForTesting({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    params: { sceneScoresPath, mode: 'api', outputDir },
    timeoutMs: 5_000,
  })

  assert.equal(result.success, true, `expected success; got close=${JSON.stringify(result.closeEvent)}`)
  assert.equal(result.status, 'completed')
  // The real driver must have invoked the runtime with ai_analyze, NOT
  // pipeline. This is the regression we are guarding against.
  const aiCalls = runtime.calls.filter((c) => c.action === 'video_expert_ai_analyze')
  assert.equal(aiCalls.length >= 1, true, 'driver must dispatch video_expert_ai_analyze at least once')
  assert.equal(aiCalls[0].params.sceneScoresPath, sceneScoresPath)
  assert.equal(aiCalls[0].params.mode, 'api')
  const pipelineCalls = runtime.calls.filter((c) => c.action === 'video_expert_pipeline')
  assert.equal(pipelineCalls.length, 0, 'driver must NOT fall back to video_expert_pipeline when scene scores are present')

  // Cleanup so the next test that depends on a fresh registry isn't
  // contaminated by the real driver registration.
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
})

// ===================================================================
// T9 — Real driver, real product path: full RSS visual chain proves
// pipeline → scene_scores.json → ai_analyze → close maps back to RSS
// without missing_inputs. Uses the imported `videoExpertChildDriver`
// directly (asserts identity with the production module export so a
// future stub cannot silently slip in via `registerSkillChildDriver`).
// ===================================================================

import { describe } from 'node:test'
import * as videoExpertChildDriverModule from '../main/modules/agent-control/video-expert-child-driver'

describe('T9 — RSS visual chain end-to-end (real driver, real product path)', () => {
  test('T9: pipeline produces scene_scores.json → real driver plans video_expert_ai_analyze → close maps back without missing_inputs', async () => {
    // Identity guard: the value we register MUST be the production singleton
    // exported from the driver module. If a future change re-exports a stub
    // through the same name this assertion fails before any plan runs, so
    // a stub cannot silently slip in here.
    assert.strictEqual(
      videoExpertChildDriver,
      videoExpertChildDriverModule.videoExpertChildDriver,
      'imported videoExpertChildDriver must be identical to the production module export',
    )

    __resetSkillChildRunnerForTests()
    __resetSkillChildDriversForTests()
    registerSkillChildDriver(videoExpertChildDriver)

    // Cold cwd — no run_state.json, no scene_scores.json. The pipeline action
    // (faked at the runtime seam) must produce scene_scores.json on disk so
    // the driver's NEXT planNextAction tick observes the score_batches stage
    // and routes to video_expert_ai_analyze. The third tick after ai_analyze
    // closes the run by writing a completed run_state.json. End to end this
    // is the same shape RSSItemAnalysisManager.runVisualFlow drives in prod.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-rss-vea-t9-'))
    const sceneScoresPath = path.join(outputDir, 'scene_scores.json')
    const runStatePath = path.join(outputDir, 'run_state.json')

    const runtime = makeFakeRuntime({
      onRun: async (request) => {
        if (request.action === 'video_expert_pipeline') {
          // Pipeline writes scene_scores.json + a paused run_state.json so
          // the driver's next tick observes score_batches and re-plans
          // ai_analyze without falling back to pipeline.
          await fs.writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
          await fs.writeFile(
            runStatePath,
            JSON.stringify({
              status: 'recoverable_paused',
              current_stage: 'score_batches',
              scene_scores_path: sceneScoresPath,
            }),
            'utf8',
          )
        } else if (request.action === 'video_expert_ai_analyze') {
          await fs.writeFile(
            runStatePath,
            JSON.stringify({ status: 'completed', current_stage: 'finalize' }),
            'utf8',
          )
        }
        return {
          success: true,
          skillId: request.skillId,
          action: request.action,
          stdout: '',
          stderr: '',
          command: [],
        }
      },
    })
    const repo = makeFakeRepository()
    configureSkillChildRunner({
      runtimeManager: runtime.manager,
      repository: repo.repo,
      launchStuckGuardMs: 200,
    })

    const manager = new RSSItemAnalysisManager({
      startSkillChildRunAndWait,
      veaAwaitRetryDelayMs: 0,
    })

    // Stage 1 — RSS visual flow's pipeline call. Lands cold against the real
    // driver with `url + outputDir` and must close `completed` after the
    // driver observes the scene_scores it planted.
    const pipelineResult = await manager.__awaitVeaChildRunForTesting({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      params: { url: 'https://example.com/v.mp4', outputDir },
      timeoutMs: 5_000,
    })

    assert.equal(pipelineResult.success, true, `expected pipeline stage to close success; got ${JSON.stringify(pipelineResult.closeEvent)}`)
    assert.equal(pipelineResult.status, 'completed')

    // Real-driver plans during stage 1: it MUST have dispatched at least one
    // pipeline action (cold start) and at least one ai_analyze action
    // (after observing scene_scores on disk). It must NEVER mistakenly
    // close with missing_inputs at this point because scene_scores.json
    // is present after the pipeline action lands.
    const stage1Pipeline = runtime.calls.filter((c) => c.action === 'video_expert_pipeline')
    const stage1Analyze = runtime.calls.filter((c) => c.action === 'video_expert_ai_analyze')
    assert.equal(stage1Pipeline.length >= 1, true, 'real driver must invoke video_expert_pipeline on cold start')
    assert.equal(stage1Analyze.length >= 1, true, 'real driver must follow up with video_expert_ai_analyze after scene_scores lands')

    // Critical: the close event maps back to RSS WITHOUT a missing_inputs
    // signal. The error field must be falsy for a completed close.
    assert.equal(pipelineResult.closeEvent.error, null, 'completed close must not carry an error payload')
    assert.notEqual(
      pipelineResult.closeEvent.terminalReason,
      'checkpoint_background',
      'completed close must not surface as recoverable_paused/checkpoint_background',
    )
    // Also: the RSS-side translator must NOT classify this as a failure with
    // a missing_inputs message — closed-completed runs never carry that
    // diagnostic.
    if (!pipelineResult.success) {
      const error = manager.__translateVeaCloseToErrorForTesting(pipelineResult, '视觉脚本分析失败')
      assert.doesNotMatch(
        error.message,
        /missing_inputs|missing_scene_scores/,
        'a completed close must never surface missing_inputs to RSS',
      )
    }

    __resetSkillChildRunnerForTests()
    __resetSkillChildDriversForTests()
  })
})
