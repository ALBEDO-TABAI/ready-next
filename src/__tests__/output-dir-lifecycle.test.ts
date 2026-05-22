import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  readLifecycle,
  shouldRetain,
  writeLifecycle,
} from '../main/modules/agent-control/output-dir-lifecycle'
import {
  __resetSkillChildRunnerForTests,
  configureSkillChildRunner,
  getSkillChildRunCloseEvent,
  startSkillChildRun,
} from '../main/modules/agent-control/skills/skill-child-runner'
import {
  __resetSkillChildDriversForTests,
  registerSkillChildDriver,
  type SkillChildDriver,
} from '../main/modules/agent-control/skills/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverState,
} from '../main/modules/agent-control/skills/skill-child-run-types'
import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'

function terminalClose(
  skillId: string,
  status: SkillChildCloseEvent['status'],
  terminalReason: SkillChildCloseEvent['terminalReason'],
): SkillChildCloseEvent {
  return {
    childRunId: '',
    skillId,
    status,
    terminalReason,
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
    },
    framePatch: null,
    projectionPatch: null,
    error: null,
  }
}

function registerTerminalDriver(
  skillId: string,
  close: SkillChildCloseEvent,
): void {
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async () => ({}) as SkillChildDriverState,
    planNextAction: async () => close,
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

function makeRuntime(runtimeRoot: string): SkillsRuntimeManager {
  return {
    getRuntimeInfo: () => ({
      runtimeRoot,
      skillsRoot: path.join(runtimeRoot, 'skills'),
      customSkillsRoot: path.join(runtimeRoot, 'custom-skills'),
      outputsRoot: path.join(runtimeRoot, 'outputs'),
      venvRoot: path.join(runtimeRoot, 'python'),
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => ({
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }),
  } as unknown as SkillsRuntimeManager
}

function makeRepository(): SkillTaskRunRepository {
  const rows = new Map<string, SkillTaskRunRecord>()
  return {
    createChildRun: (input: Parameters<SkillTaskRunRepository['createChildRun']>[0]) => {
      const now = new Date().toISOString()
      const record = {
        id: input.childRunId,
        scopeId: input.scopeId,
        sessionId: input.sessionId,
        agent: null,
        runId: null,
        skillId: input.skillId,
        skillName: input.skillName,
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
            kind: 'skill',
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
          },
        },
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
      } satisfies SkillTaskRunRecord
      rows.set(input.childRunId, record)
      return record
    },
    updateChildRun: (childRunId: string, patch: Record<string, unknown>) => {
      const row = rows.get(childRunId)
      if (!row) throw new Error(`missing row ${childRunId}`)
      const payload = (row.resumePayload as { childRun: Record<string, unknown> }).childRun
      row.resumePayload = { childRun: { ...payload, ...patch } }
      row.updatedAt = new Date().toISOString()
    },
    findLatestChildRunByKey: () => null,
    findLatestChildRunBySkill: () => null,
    get: (id: string) => rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
}

function pollUntil<T>(fn: () => T | null | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = fn()
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error('poll timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

async function runTerminalCase(status: SkillChildCloseEvent['status']): Promise<string> {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-lifecycle-runtime-'))
  const outputDir = path.join(runtimeRoot, 'outputs', `skill-${status}`, `run-${status}`)
  const skillId = `skill-${status}`
  const reason = status === 'completed'
    ? 'completed'
    : status === 'killed'
      ? 'cancelled_user'
      : status === 'blocked'
        ? 'blocked_external'
        : status === 'budget_paused'
          ? 'checkpoint_budget'
          : status === 'recoverable_paused'
            ? 'process_restarted'
            : 'failed_skill'
  registerTerminalDriver(skillId, terminalClose(skillId, status, reason))
  configureSkillChildRunner({
    runtimeManager: makeRuntime(runtimeRoot),
    repository: makeRepository(),
    launchStuckGuardMs: 100,
  })
  const launched = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId,
    action: 'run',
    requestedInput: { outputDir },
  })
  await pollUntil(() => getSkillChildRunCloseEvent(launched.childRunId))
  return outputDir
}

test('new child run eventLogPath is under runtime root', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-lifecycle-runtime-'))
  const skillId = 'skill-runtime-log-path'
  registerTerminalDriver(skillId, terminalClose(skillId, 'completed', 'completed'))
  configureSkillChildRunner({
    runtimeManager: makeRuntime(runtimeRoot),
    repository: makeRepository(),
    launchStuckGuardMs: 100,
  })

  const launched = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId,
    action: 'run',
    requestedInput: {},
  })

  assert.equal(
    launched.eventLogPath,
    path.join(runtimeRoot, '.ready', 'child-runs', `${launched.childRunId}.jsonl`),
  )
  assert.equal(launched.eventLogPath.includes(`${path.sep}outputs${path.sep}`), false)
})

test('readLifecycle/writeLifecycle validate the basic shape', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-lifecycle-shape-'))
  const lifecycle = {
    state: 'retained' as const,
    childRunId: 's12345678',
    skillId: 'skill-shape',
    terminalAt: '2026-05-01T01:00:00.000Z',
    terminalReason: 'completed',
    retainUntil: '2026-05-08T01:00:00.000Z',
  }

  writeLifecycle(outputDir, lifecycle)

  assert.deepEqual(readLifecycle(outputDir), lifecycle)
  assert.equal(shouldRetain(lifecycle, new Date('2026-05-02T00:00:00.000Z')), true)
  assert.equal(shouldRetain(lifecycle, new Date('2026-05-09T00:00:00.000Z')), false)
})

test('completed/failed/killed/blocked terminal runs write retained lifecycle', async () => {
  for (const status of ['completed', 'failed', 'killed', 'blocked'] as const) {
    const outputDir = await runTerminalCase(status)
    const lifecycle = readLifecycle(outputDir)
    assert.ok(lifecycle, `${status} should write lifecycle`)
    assert.equal(lifecycle.state, 'retained')
    assert.equal(lifecycle.skillId, `skill-${status}`)
    assert.equal(typeof lifecycle.terminalAt, 'string')
    assert.equal(typeof lifecycle.retainUntil, 'string')
  }
})

test('budget_paused/recoverable_paused runs do not write lifecycle', async () => {
  for (const status of ['budget_paused', 'recoverable_paused'] as const) {
    const outputDir = await runTerminalCase(status)
    assert.equal(readLifecycle(outputDir), null, `${status} should not write lifecycle`)
  }
})
