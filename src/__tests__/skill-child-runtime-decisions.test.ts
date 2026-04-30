/**
 * Phase 5 — Skill Child Runner runtime-decision tests.
 *
 *   - MAX_ACTIVE_VEA_CHILD_RUNS = 3 (4th launch returns
 *     `recoverable_paused` + `terminalReason='queued_global_concurrency'`).
 *   - launch-stuck: child writes `started` but no `action_started`
 *     within the guard window → `terminalReason='launch_stuck'`.
 *   - skill-declared failure (`success: false`) vs infra throw
 *     (process crash) split between `failed_skill` and `infra_error`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configureSkillChildRunner,
  startSkillChildRun,
  getSkillChildRunCloseEvent,
  __resetSkillChildRunnerForTests,
  MAX_ACTIVE_VEA_CHILD_RUNS,
} from '../main/modules/agent-control/skill-child-runner'
import {
  registerSkillChildDriver,
  __resetSkillChildDriversForTests,
  type SkillChildDriver,
} from '../main/modules/agent-control/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
} from '../main/modules/agent-control/skill-child-run-types'
import type {
  SkillRunResult,
  SkillRunRequest,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'

// --------- Fakes ---------

function makeFakeRepository(): SkillTaskRunRepository {
  const rows = new Map<string, SkillTaskRunRecord>()
  return {
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
      rows.set(input.childRunId, record)
      return record
    },
    updateChildRun: (childRunId: string, patch: Record<string, unknown>) => {
      const existing = rows.get(childRunId)
      if (!existing) return
      const payload = (existing.resumePayload as { childRun: Record<string, unknown> }).childRun
      const merged = { ...payload, ...patch }
      existing.resumePayload = { childRun: merged }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
    },
    findLatestChildRunByKey: (key: string) => {
      const ACTIVE = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked'])
      for (const row of rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.singleFlightKey === key && ACTIVE.has(child.status as string)) return row
      }
      return null
    },
    findLatestChildRunBySkill: () => null,
    get: (id: string) => rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
}

function makeStallingRuntime(): SkillsRuntimeManager {
  let resolveStall!: () => void
  const stall = new Promise<void>((r) => { resolveStall = r })
  ;(globalThis as Record<string, unknown>).__rt_resolve = resolveStall
  return {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/fake', skillsRoot: '/tmp/fake/s',
      customSkillsRoot: '/tmp/fake/c', outputsRoot: '/tmp/fake/o',
      venvRoot: '/tmp/fake/v',
    }),
    runSkill: async (_req: SkillRunRequest): Promise<SkillRunResult> => {
      await stall
      return { success: true, skillId: '', action: '', stdout: '', stderr: '', command: [] }
    },
  } as unknown as SkillsRuntimeManager
}

function registerLooping(skillId: string): void {
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId, requestedInput: params.requestedInput }),
    planNextAction: async (): Promise<SkillChildDriverAction | SkillChildCloseEvent> => ({
      action: 'do_thing',
      input: {},
    }),
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

function pollUntil<T>(fn: () => T | null | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      const value = fn()
      if (value) return resolve(value)
      if (Date.now() - start > timeoutMs) return reject(new Error('pollUntil timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

// --------- Tests ---------

test('Phase 5: VEA concurrency cap — 4th run returns recoverable_paused + queued_global_concurrency', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeStallingRuntime(),
    repository: makeFakeRepository(),
    launchStuckGuardMs: 60_000, // don't trip
  })
  registerLooping('video-expert-analyzer')

  const launches = []
  for (let i = 0; i < MAX_ACTIVE_VEA_CHILD_RUNS; i++) {
    launches.push(await startSkillChildRun({
      scopeId: `scope-${i}`,
      sessionId: `session-${i}`,
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { url: `https://example.com/${i}` },
    }))
  }
  for (const result of launches) {
    assert.equal(result.status, 'running')
  }

  // Yield briefly so the runner registers each active run.
  await new Promise((r) => setTimeout(r, 10))

  const overflow = await startSkillChildRun({
    scopeId: 'scope-overflow',
    sessionId: 'session-overflow',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/overflow' },
  })
  assert.equal(overflow.status, 'recoverable_paused')
  assert.ok(overflow.closeEvent)
  assert.equal(overflow.closeEvent!.terminalReason, 'queued_global_concurrency')
})

test('Phase 5: launch-stuck — started but no action_started within guard window', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeStallingRuntime(),
    repository: makeFakeRepository(),
    launchStuckGuardMs: 50,
  })
  // Driver that never returns an action plan — keeps planNextAction
  // hanging so the runner records `started` but never reaches
  // `action_started`.
  let resolveDriver!: () => void
  const stall = new Promise<void>((r) => { resolveDriver = r })
  registerSkillChildDriver({
    skillId: 'test-skill-stuck',
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId: 'test-skill-stuck', requestedInput: params.requestedInput }),
    planNextAction: async () => {
      await stall
      return { action: 'do_thing', input: {} } as SkillChildDriverAction
    },
    observeAfterAction: async (state) => state,
  })
  const launch = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-stuck',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/stuck' },
  })

  const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId), 1_500)
  assert.equal(close.terminalReason, 'launch_stuck')
  // Now release the driver so the test can exit cleanly.
  resolveDriver()
})

test('Phase 5: skill_failure (success:false) vs infra_error (throw) split correctly', async () => {
  // Skill-declared failure
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: {
      getRuntimeInfo: () => ({
        runtimeRoot: '/tmp/fake', skillsRoot: '/tmp/fake/s',
        customSkillsRoot: '/tmp/fake/c', outputsRoot: '/tmp/fake/o',
        venvRoot: '/tmp/fake/v',
      }),
      runSkill: async (): Promise<SkillRunResult> => ({
        success: false,
        skillId: 'test-skill-split',
        action: 'do_thing',
        stdout: '',
        stderr: '',
        command: [],
        error: 'skill said no',
      }),
    } as unknown as SkillsRuntimeManager,
    repository: makeFakeRepository(),
    launchStuckGuardMs: 5_000,
  })
  registerLooping('test-skill-split')
  const a = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-split',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/a' },
  })
  const closeA = await pollUntil(() => getSkillChildRunCloseEvent(a.childRunId))
  assert.equal(closeA.terminalReason, 'failed_skill')

  // Infra throw (process crash shape)
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: {
      getRuntimeInfo: () => ({
        runtimeRoot: '/tmp/fake', skillsRoot: '/tmp/fake/s',
        customSkillsRoot: '/tmp/fake/c', outputsRoot: '/tmp/fake/o',
        venvRoot: '/tmp/fake/v',
      }),
      runSkill: async () => {
        throw new Error('child process crashed (signal SIGKILL)')
      },
    } as unknown as SkillsRuntimeManager,
    repository: makeFakeRepository(),
    launchStuckGuardMs: 5_000,
  })
  registerLooping('test-skill-split')
  const b = await startSkillChildRun({
    scopeId: 'scope-2',
    sessionId: 'session-2',
    skillId: 'test-skill-split',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/b' },
  })
  const closeB = await pollUntil(() => getSkillChildRunCloseEvent(b.childRunId))
  assert.equal(closeB.terminalReason, 'infra_error')
})
