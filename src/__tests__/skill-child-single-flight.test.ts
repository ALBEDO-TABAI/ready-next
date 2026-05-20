/**
 * Phase 5 — Skill Child Runner single-flight collapse tests.
 *
 * Same scope/session + same target → second start collapses onto the
 * first child run. Different URL or different scope/session → minted
 * separately.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configureSkillChildRunner,
  startSkillChildRun,
  __resetSkillChildRunnerForTests,
} from '../main/modules/agent-control/skills/skill-child-runner'
import {
  registerSkillChildDriver,
  __resetSkillChildDriversForTests,
  type SkillChildDriver,
} from '../main/modules/agent-control/skills/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
} from '../main/modules/agent-control/skills/skill-child-run-types'
import type {
  SkillRunResult,
  SkillsRuntimeManager,
  SkillRunRequest,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'

interface FakeRepoState { rows: Map<string, SkillTaskRunRecord> }

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
      if (!existing) return
      const payload = (existing.resumePayload as { childRun: Record<string, unknown> }).childRun
      const merged = { ...payload, ...patch }
      existing.resumePayload = { childRun: merged }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
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

function makeFakeRuntime(): SkillsRuntimeManager {
  // Single-flight tests only check pre-launch collapse; runSkill is
  // never invoked because the loop is forced to a stall.
  let resolveStall!: () => void
  const stall = new Promise<void>((r) => { resolveStall = r })
  // Keep a reference so test cleanup can release.
  ;(globalThis as Record<string, unknown>).__sf_resolve = resolveStall
  return {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/fake', skillsRoot: '/tmp/fake/s',
      customSkillsRoot: '/tmp/fake/c', outputsRoot: '/tmp/fake/o',
      venvRoot: '/tmp/fake/v',
    }),
    runSkill: async (_request: SkillRunRequest): Promise<SkillRunResult> => {
      await stall
      return { success: true, skillId: '', action: '', stdout: '', stderr: '', command: [] }
    },
    runSkillFromChildRunner: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      await stall
      return { success: true, skillId: request.skillId, action: request.action, stdout: '', stderr: '', command: [] }
    },
  } as unknown as SkillsRuntimeManager
}

function registerStallingDriver(skillId: string): void {
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId, requestedInput: params.requestedInput }),
    // Always returns an action that the (stalled) runtime will hold,
    // keeping the run in 'running' so the single-flight key is active.
    planNextAction: async (state): Promise<SkillChildDriverAction | SkillChildCloseEvent> => ({
      action: 'video_expert_pipeline',
      input: state.requestedInput as Record<string, unknown>,
    }),
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

function setup(): { repo: ReturnType<typeof makeFakeRepository> } {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  const repo = makeFakeRepository()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime(),
    repository: repo.repo,
    launchStuckGuardMs: 60_000, // never trip during this test
  })
  return { repo }
}

test('Phase 5: single-flight — same scope/session/url returns reused', async () => {
  setup()
  registerStallingDriver('video-expert-analyzer')

  const first = await startSkillChildRun({
    scopeId: 'scope-A',
    sessionId: 'session-A',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/video-1' },
  })
  assert.equal(first.status, 'running')
  // tiny yield so the runner gets to action_started
  await new Promise((r) => setTimeout(r, 5))

  const second = await startSkillChildRun({
    scopeId: 'scope-A',
    sessionId: 'session-A',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/video-1' },
  })
  assert.equal(second.status, 'reused')
  assert.equal(second.childRunId, first.childRunId)
})

test('Phase 5: single-flight — different URL = different child run', async () => {
  setup()
  registerStallingDriver('video-expert-analyzer')

  const first = await startSkillChildRun({
    scopeId: 'scope-A',
    sessionId: 'session-A',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/video-1' },
  })
  await new Promise((r) => setTimeout(r, 5))
  const second = await startSkillChildRun({
    scopeId: 'scope-A',
    sessionId: 'session-A',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/video-2' },
  })
  assert.notEqual(second.status, 'reused')
  assert.notEqual(second.childRunId, first.childRunId)
})

test('Phase 5: single-flight — different scope/session = different child run', async () => {
  setup()
  registerStallingDriver('video-expert-analyzer')

  const first = await startSkillChildRun({
    scopeId: 'scope-A',
    sessionId: 'session-A',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/same' },
  })
  await new Promise((r) => setTimeout(r, 5))

  const second = await startSkillChildRun({
    scopeId: 'scope-B',
    sessionId: 'session-A',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/same' },
  })
  assert.notEqual(second.status, 'reused')
  assert.notEqual(second.childRunId, first.childRunId)

  const third = await startSkillChildRun({
    scopeId: 'scope-A',
    sessionId: 'session-C',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/same' },
  })
  assert.notEqual(third.status, 'reused')
  assert.notEqual(third.childRunId, first.childRunId)
})

// =====================================================================
// T4 — Single-flight liveness (B Phase) regression guards.
//
// `startSkillChildRun` must never claim live work for a DB row whose row
// status says `running` when no in-memory runner is actually alive.
// =====================================================================

test('T4 Case A: row running + no in-memory active runner does NOT return reused', async () => {
  // Build a repo whose pre-existing row claims `running` for the canonical
  // single-flight key the runner will compute. The runner must consult the
  // active map; since no runner is alive (fresh setup), the result must NOT
  // be `reused`. The expected outcome is either a durable resume or a
  // `recoverable_paused` reconciliation marker.
  const { repo } = setup()
  registerStallingDriver('video-expert-analyzer')

  // Pre-seed the repository as if the previous process had left a `running`
  // row behind. Use the same digest computation as the runner so the
  // single-flight key matches.
  const url = 'https://example.com/restart-recovered'
  const requestedInput = { url }
  // The runner will compute the digest from {url}-only (no outputDir hint).
  // Just create with a synthetic key — but to align, we let the runner
  // compute its own and instead seed via createChildRun with a key derived
  // identically. Since the runner builds the key as
  // `${scope}|${session}|${skillId}|${digest}`, we seed via a known scope.
  // To avoid replicating digest logic, use the runner once to mint a row,
  // then teardown the runner state and create a new one — the row remains
  // in the repo.
  const seeded = await startSkillChildRun({
    scopeId: 'scope-stale',
    sessionId: 'session-stale',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput,
  })
  assert.equal(seeded.status, 'running')
  // Tiny yield so the runner registers as active before we tear it down.
  await new Promise((r) => setTimeout(r, 5))

  // Tear down the runner singleton WITHOUT clearing the repository. The row
  // remains with status `running`; the in-memory `active` map is now empty.
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime(),
    repository: repo.repo,
    launchStuckGuardMs: 60_000,
  })
  registerStallingDriver('video-expert-analyzer')

  const second = await startSkillChildRun({
    scopeId: 'scope-stale',
    sessionId: 'session-stale',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput,
  })

  // (1) MUST NOT claim live work via 'reused' when nothing is live.
  assert.notEqual(second.status, 'reused',
    'startSkillChildRun must not return reused when active map is empty')
  // (2) Either resumed (status 'running') or pinned to recoverable_paused
  // with terminalReason='process_restarted'. Both are valid; the
  // anti-pattern is silently claiming `reused`.
  assert.ok(
    second.status === 'running'
      || second.status === 'recoverable_paused',
    `unexpected status=${second.status} for stale-row recovery`,
  )
  if (second.status === 'recoverable_paused') {
    assert.ok(second.closeEvent, 'recoverable_paused result must carry a close event')
    assert.equal(second.closeEvent!.terminalReason, 'process_restarted')
  }
})

test('T4 Case B: row running + active runner present DOES return reused', async () => {
  // Same scope/session/url with a still-alive runner — the existing
  // single-flight collapse behavior is preserved.
  setup()
  registerStallingDriver('video-expert-analyzer')

  const first = await startSkillChildRun({
    scopeId: 'scope-live',
    sessionId: 'session-live',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/live' },
  })
  assert.equal(first.status, 'running')
  await new Promise((r) => setTimeout(r, 5))

  const second = await startSkillChildRun({
    scopeId: 'scope-live',
    sessionId: 'session-live',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/live' },
  })
  assert.equal(second.status, 'reused')
  assert.equal(second.childRunId, first.childRunId)
})
