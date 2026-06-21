import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'
import {
  configureSkillChildRunner,
  __resetSkillChildRunnerForTests,
  startSkillChildRun,
  waitForSkillChildRunClose,
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
import { clearSkillTaskProjection } from '../main/modules/agent-control/skills/skill-task-tracker'
import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRepository,
  SkillTaskRunRecord,
} from '../main/modules/repositories/skill-task-run-repository'

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
            userRequestVerbatim: input.userRequestVerbatim ?? null,
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
      existing.resumePayload = { childRun: { ...payload, ...patch } }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
      if (typeof patch.outputDir === 'string') existing.outputDir = patch.outputDir
      if (typeof patch.runStatePath === 'string') existing.runStatePath = patch.runStatePath
      existing.updatedAt = new Date().toISOString()
    },
    update: (id: string, patch: Partial<SkillTaskRunRecord>) => {
      const existing = state.rows.get(id)
      if (!existing) throw new Error(`no row ${id}`)
      state.rows.set(id, {
        ...existing,
        ...patch,
        updatedAt: patch.updatedAt ?? existing.updatedAt,
      })
    },
    findLatestChildRunByKey: (key: string): SkillTaskRunRecord | null => {
      const active = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused'])
      for (const row of state.rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (child?.singleFlightKey === key && active.has(String(child.status))) return row
      }
      return null
    },
    findChildRunByRunStatePath: (opts: { runStatePath: string; skillId?: string | null }): SkillTaskRunRecord | null => {
      for (const row of state.rows.values()) {
        if (row.runStatePath !== opts.runStatePath) continue
        if (opts.skillId && row.skillId !== opts.skillId) continue
        return row
      }
      return null
    },
    findChildRunByOutputDir: (opts: { outputDir: string; skillId?: string | null }): SkillTaskRunRecord | null => {
      for (const row of state.rows.values()) {
        if (row.outputDir !== opts.outputDir) continue
        if (opts.skillId && row.skillId !== opts.skillId) continue
        return row
      }
      return null
    },
    findLatestChildRunBySkill: () => null,
    get: (id: string) => state.rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
  return { repo, state }
}

function makeFakeTaskProjectionStore(): {
  store: TaskProjectionStore
  rows: Map<string, TaskProjectionRecord>
} {
  const rows = new Map<string, TaskProjectionRecord>()
  return {
    rows,
    store: {
      create(record) {
        rows.set(record.taskId, record)
      },
      update(taskId, patch) {
        const existing = rows.get(taskId)
        if (!existing) throw new Error(`no task projection ${taskId}`)
        rows.set(taskId, { ...existing, ...patch })
      },
      get(taskId) {
        return rows.get(taskId) ?? null
      },
      listByScope(scopeId) {
        return Array.from(rows.values()).filter((record) => record.scopeId === scopeId)
      },
      listByParentTask(parentTaskId) {
        return Array.from(rows.values()).filter((record) => record.parentTaskId === parentTaskId)
      },
    },
  }
}

function makeFakeRuntime(runtimeRoot: string): SkillsRuntimeManager {
  const fake = {
    getRuntimeInfo: () => ({
      runtimeRoot,
      skillsRoot: join(runtimeRoot, 'skills'),
      customSkillsRoot: join(runtimeRoot, 'custom'),
      outputsRoot: join(runtimeRoot, 'outputs'),
      venvRoot: join(runtimeRoot, 'venv'),
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => ({
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }),
    runSkillFromChildRunner: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      return fake.runSkill(request)
    },
  }
  return fake as unknown as SkillsRuntimeManager
}

function makeTerminalClose(
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
    error: status === 'failed'
      ? { kind: 'failed_skill', message: 'simulated failure' }
      : null,
  }
}

function registerClosingDriver(
  skillId: string,
  close: SkillChildCloseEvent,
): void {
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({
      skillId,
      requestedInput: params.requestedInput,
    }),
    planNextAction: async (): Promise<SkillChildDriverAction | SkillChildCloseEvent> => close,
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

async function runTerminalProjectionCase(
  t: { after(fn: () => void): void },
  status: Extract<SkillChildCloseEvent['status'], 'completed' | 'failed' | 'killed'>,
  terminalReason: SkillChildCloseEvent['terminalReason'],
): Promise<TaskProjectionRecord> {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'ready-child-loop-terminal-'))
  t.after(() => {
    rmSync(runtimeRoot, { recursive: true, force: true })
    __resetSkillChildRunnerForTests()
    __resetSkillChildDriversForTests()
    clearSkillTaskProjection()
  })
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  clearSkillTaskProjection()

  const repo = makeFakeRepository()
  const taskProjectionStore = makeFakeTaskProjectionStore()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime(runtimeRoot),
    repository: repo.repo,
    taskProjectionStore: taskProjectionStore.store,
    launchStuckGuardMs: 5_000,
    progressPollIntervalMs: 10,
  })

  const skillId = `test-child-loop-${status}`
  registerClosingDriver(skillId, makeTerminalClose(skillId, status, terminalReason))

  const launch = await startSkillChildRun({
    scopeId: `scope-${status}`,
    sessionId: `session-${status}`,
    skillId,
    action: 'close_immediately',
    requestedInput: { status },
  })
  assert.equal(launch.status, 'running')

  const wait = await waitForSkillChildRunClose(launch.childRunId, { timeoutMs: 2_000 })
  assert.equal(wait.kind, 'closed')
  assert.equal(wait.closeEvent.status, status)

  const taskId = `skill-child:${launch.childRunId}`
  const row = taskProjectionStore.rows.get(taskId)
  assert.ok(row, `expected child projection ${taskId}`)
  assert.equal(row.taskId, taskId)
  assert.equal(row.status, status)
  assert.equal(row.runId, launch.childRunId)
  assert.equal(row.module, 'skill')
  assert.equal(row.interactionState, 'suspended')
  return row
}

test('P1c: completed child close writes an observable terminal child projection', async (t) => {
  await runTerminalProjectionCase(t, 'completed', 'completed')
})

test('P1c: failed child close writes an observable terminal child projection', async (t) => {
  await runTerminalProjectionCase(t, 'failed', 'failed_skill')
})

test('P1c: killed child close writes an observable terminal child projection', async (t) => {
  await runTerminalProjectionCase(t, 'killed', 'cancelled_user')
})
