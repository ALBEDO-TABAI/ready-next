import { mkdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MemorySession } from '@openai/agents'
import type { AgentInputItem } from '@openai/agents'
import type { TaskBudgetRuntime } from '../contracts/run-contracts'
import type { TurnTerminalReason } from './turn-frame'
import { normalizeSessionSnapshotForSeed } from '../compaction/compact-agent-input'
import { restoreContinuationTaskBudgetRuntime } from '../task-projection/run-budget-policy'
import { readResumeKind } from '../contracts/resume-handle'
import type { ResumeKind } from '../contracts/resume-handle'
import type {
  AgentSdkBudgetCheckpoint,
  AgentSdkBudgetCheckpointLoadResult,
  AgentSdkBudgetCheckpointRestore,
  AgentSdkExecutionOptions,
  AgentSdkSession,
  BeginRunResult,
  RunHandle
} from './agent-sdk-types'
import {
  MAX_ORPHAN_RUNS,
  PREEMPT_SETTLE_TIMEOUT_MS,
  asRecord,
  continuationRunStatePath,
  errorMessage,
  nonEmptyString,
  raceWithTimeout,
  safeContinuationPathSegment,
  stringField
} from './agent-sdk-utils'
import { log } from './agent-sdk-provider'
import { AgentSdkSessionManager } from './agent-sdk-session'
import { AgentSdkCompactor } from './agent-sdk-compactor'
import type { AbortInitiator } from '../contracts/run-contracts-internal'

export interface RunLifecycleHost {
  readonly sessionManager: AgentSdkSessionManager
  readonly compactor: AgentSdkCompactor
  readonly cancelPendingToolActions: ((agent: string, sessionId?: string) => void) | null
}

/** Stamp the abort initiator onto the run handle and build the abort error carried with it. */
export function createInitiatorAbort(
  runHandle: RunHandle,
  initiator: AbortInitiator,
  message: string
): Error {
  runHandle.abortInitiator = initiator
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/**
 * Run lifecycle service extracted from AgentSdkRuntime (V3 Phase 4).
 *
 * Stateless: owns no run/session state. All collaborators are reached through
 * {@link RunLifecycleHost}. `finalizeRun` here only releases the current run
 * and drains pending compaction — it is NOT `finalizeRunOutcome`
 * (run-finalizer.ts), which writes the terminal ledger and visible close-out.
 */
export class AgentSdkRunLifecycle {
  constructor(private readonly host: RunLifecycleHost) {}

  createRunHandle(params: {
    runId: string
    runGeneration: number
    abortController: AbortController
    capturedSession: MemorySession
  }): RunHandle {
    let resolveSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    return {
      ...params,
      abortInitiator: null,
      settled,
      resolveSettled
    }
  }

  async beginRun(params: {
    name: string
    runId: string
    sessionId?: string
  }): Promise<BeginRunResult> {
    const idleSession = this.host.sessionManager.get(params.name)
    if (
      idleSession &&
      !idleSession.currentRun &&
      this.host.sessionManager.activeLockCount(params.name) === 0
    ) {
      if (idleSession.orphanCount >= MAX_ORPHAN_RUNS) {
        return {
          ok: false,
          reason: 'orphan_limit',
          message: '上一轮仍在取消中，请稍后重试。'
        }
      }
      idleSession.generation += 1
      const abortController = new AbortController()
      const runHandle = this.createRunHandle({
        runId: params.runId,
        runGeneration: idleSession.generation,
        abortController,
        capturedSession: idleSession.sdkSession
      })
      idleSession.currentRun = runHandle
      return {
        ok: true,
        session: idleSession,
        runHandle,
        abortController,
        runGeneration: idleSession.generation
      }
    }

    let started: Extract<BeginRunResult, { ok: true }> | null = null
    let capturedOld: RunHandle | null = null
    let myGeneration = 0
    let blockedByOrphans = false

    await this.host.sessionManager.withSessionLock(params.name, async () => {
      const session = this.host.sessionManager.get(params.name)
      if (!session) return
      if (session.orphanCount >= MAX_ORPHAN_RUNS) {
        blockedByOrphans = true
        return
      }
      if (!session.currentRun) {
        session.generation += 1
        const abortController = new AbortController()
        const runHandle = this.createRunHandle({
          runId: params.runId,
          runGeneration: session.generation,
          abortController,
          capturedSession: session.sdkSession
        })
        session.currentRun = runHandle
        started = {
          ok: true,
          session,
          runHandle,
          abortController,
          runGeneration: session.generation
        }
        return
      }

      capturedOld = session.currentRun
      try {
        this.host.cancelPendingToolActions?.(params.name, params.sessionId)
      } catch (error) {
        log(`preempt cancelPendingToolActions failed: ${errorMessage(error)}`)
      }
      session.generation += 1
      myGeneration = session.generation
      if (capturedOld.abortController) {
        capturedOld.abortController.abort(
          createInitiatorAbort(capturedOld, 'preempted', 'process_restarted')
        )
        capturedOld.abortController = null
      }
      log(`preempted previous SDK run agent=${params.name}`)
    })

    if (started) return started

    if (blockedByOrphans) {
      return {
        ok: false,
        reason: 'orphan_limit',
        message: '上一轮仍在取消中，请稍后重试。'
      }
    }

    const oldRun = capturedOld as RunHandle | null
    if (oldRun) {
      await raceWithTimeout(oldRun.settled, PREEMPT_SETTLE_TIMEOUT_MS)
    }

    return this.host.sessionManager.withSessionLock(params.name, async () => {
      let session = this.host.sessionManager.get(params.name)
      if (!session || session.generation !== myGeneration) {
        return {
          ok: false,
          reason: 'superseded',
          message: '本轮已被更新的发送接管。',
          currentRunId: session?.currentRun?.runId ?? null
        }
      }
      if (oldRun && session.currentRun === oldRun) {
        const carried = normalizeSessionSnapshotForSeed(await oldRun.capturedSession.getItems())
        session = {
          sdkSession: new MemorySession({ sessionId: params.name, initialItems: carried }),
          systemPrompt: session.systemPrompt,
          generation: session.generation,
          currentRun: null,
          orphanCount: session.orphanCount + 1,
          pendingCompact: session.pendingCompact,
          contextWindowTokens: session.contextWindowTokens,
          lastUsageTokens: session.lastUsageTokens
        }
        this.host.sessionManager.set(params.name, session)
      }
      const abortController = new AbortController()
      const runHandle = this.createRunHandle({
        runId: params.runId,
        runGeneration: session.generation,
        abortController,
        capturedSession: session.sdkSession
      })
      session.currentRun = runHandle
      return {
        ok: true,
        session,
        runHandle,
        abortController,
        runGeneration: session.generation
      }
    })
  }

  async finalizeRun(name: string, session: AgentSdkSession, runHandle: RunHandle): Promise<void> {
    try {
      await this.host.sessionManager.withSessionLock(name, async () => {
        const latest = this.host.sessionManager.get(name)
        if (latest === session && latest.currentRun?.runId === runHandle.runId) {
          latest.currentRun = null
          await this.host.compactor.drainPendingCompact(latest)
          return
        }
        if (latest && latest !== session && latest.orphanCount > 0) {
          latest.orphanCount -= 1
        }
      })
    } finally {
      runHandle.resolveSettled()
    }
  }

  async writeBudgetCheckpointState(params: {
    agentName: string
    sessionId?: string
    runId: string
    taskId: string
    taskBudgetRuntime: TaskBudgetRuntime
    runHandle: RunHandle
    usedTools: string[]
    requiredCapabilityGroups: string[]
    requiredToolNames: string[]
    lastUserMessage: string
    terminalReason?: Extract<TurnTerminalReason, 'checkpoint_budget' | 'checkpoint_steered'>
    blockerType?: string
    pauseReason?: string
    blockedReason?: string
    waitingFor?: 'background' | 'none'
    resumeKind?: ResumeKind
    /** Candidate delivery must checkpoint only committed content + canonical receipts. */
    sessionSnapshotOverride?: AgentInputItem[] | null
  }): Promise<AgentSdkBudgetCheckpoint> {
    const outputDir = join(
      tmpdir(),
      'ready-agent-continuations',
      safeContinuationPathSegment(params.taskId),
      safeContinuationPathSegment(params.runId)
    )
    await mkdir(outputDir, { recursive: true })
    const runStatePath = join(outputDir, 'run_state.json')
    const sessionSnapshot = normalizeSessionSnapshotForSeed(
      params.sessionSnapshotOverride ?? await params.runHandle.capturedSession.getItems()
    )
    const now = new Date().toISOString()
    const terminalReason = params.terminalReason || 'checkpoint_budget'
    const resumeKind = params.resumeKind || 'snapshot'
    const blockedReason =
      params.blockedReason ||
      (resumeKind === 'paused' ? '本轮工具预算已用完，已保存续跑检查点。' : '已保存内部恢复快照。')
    const defaultPauseReason = resumeKind === 'paused' ? 'budget_exhausted' : 'snapshot'
    const state = {
      version: 1,
      kind: 'agent_sdk_budget_checkpoint',
      resumeKind,
      scopeId: params.sessionId || null,
      taskId: params.taskId,
      runId: params.runId,
      agentName: params.agentName,
      taskType: params.taskBudgetRuntime.taskType,
      budgetRuntime: params.taskBudgetRuntime,
      terminalReason,
      lastUserMessageSummary: params.lastUserMessage.slice(0, 500),
      sessionSnapshot,
      usedToolNames: [...params.usedTools],
      requiredCapabilityGroups: [...params.requiredCapabilityGroups],
      requiredToolNames: [...params.requiredToolNames],
      createdAt: now,
      updatedAt: now
    }
    await writeFile(runStatePath, JSON.stringify(state, null, 2), 'utf8')
    return {
      outputDir,
      runStatePath,
      projectionPatch: {
        interactionState: 'suspended',
        waitingFor: params.waitingFor || 'background',
        resumableActions: resumeKind === 'paused' ? ['continue', 'retry', 'cancel'] : ['none'],
        blockedReason,
        taskContinuation: {
          taskId: params.taskId,
          resumeKind,
          blockerType: params.blockerType || defaultPauseReason,
          pauseReason: params.pauseReason || defaultPauseReason,
          outputDir,
          runStatePath
        }
      }
    }
  }

  async loadBudgetCheckpointState(
    options?: AgentSdkExecutionOptions
  ): Promise<AgentSdkBudgetCheckpointLoadResult> {
    const runStatePath = continuationRunStatePath(options)
    if (!runStatePath) return { status: 'absent' }
    let raw = ''
    try {
      raw = await readFile(runStatePath, 'utf8')
    } catch {
      // silent-catch: unreadable durable state is returned as an explicit invalid result.
      return { status: 'invalid', runStatePath, reason: 'unreadable' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      // silent-catch: corrupt durable state is returned as an explicit invalid result.
      return { status: 'invalid', runStatePath, reason: 'corrupt' }
    }
    const record = asRecord(parsed)
    if (stringField(record, 'kind') !== 'agent_sdk_budget_checkpoint') {
      return { status: 'invalid', runStatePath, reason: 'wrong_kind' }
    }
    if (readResumeKind(record?.resumeKind) !== 'paused') {
      return { status: 'invalid', runStatePath, reason: 'wrong_resume_kind' }
    }
    const recordTaskId = stringField(record, 'taskId')
    const requestedTaskIds = [
      nonEmptyString(options?.taskId),
      nonEmptyString(options?.continuationIntent?.taskId),
      nonEmptyString(options?.continuationState?.taskId)
    ].filter((value): value is string => Boolean(value))
    if (
      !recordTaskId ||
      requestedTaskIds.length === 0 ||
      requestedTaskIds.some((taskId) => taskId !== recordTaskId)
    ) {
      return { status: 'invalid', runStatePath, reason: 'task_mismatch' }
    }
    const recordScopeId = stringField(record, 'scopeId')
    const requestedScopeId =
      nonEmptyString(options?.publicSessionId) || nonEmptyString(options?.continuationState?.scopeId)
    if (!recordScopeId || !requestedScopeId || recordScopeId !== requestedScopeId) {
      return { status: 'invalid', runStatePath, reason: 'scope_mismatch' }
    }
    const budgetRuntime = asRecord(record?.budgetRuntime) as unknown as TaskBudgetRuntime | null
    if (!budgetRuntime?.budget || !budgetRuntime.usage) {
      return { status: 'invalid', runStatePath, reason: 'invalid_budget' }
    }
    const rawSnapshot = Array.isArray(record?.sessionSnapshot)
      ? (record.sessionSnapshot as AgentInputItem[])
      : []
    const restoredBudget = restoreContinuationTaskBudgetRuntime({
      taskType: budgetRuntime.taskType,
      projectionBudget: null,
      projectionBudgetRuntime: budgetRuntime
    }).runtime
    if (!restoredBudget) {
      return { status: 'invalid', runStatePath, reason: 'invalid_budget' }
    }
    return {
      status: 'loaded',
      restore: {
        sessionSnapshot: normalizeSessionSnapshotForSeed(rawSnapshot),
        taskBudgetRuntime: { ...restoredBudget, frozen: false },
        requiredCapabilityGroups: Array.isArray(record?.requiredCapabilityGroups)
          ? record.requiredCapabilityGroups.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        requiredToolNames: Array.isArray(record?.requiredToolNames)
          ? record.requiredToolNames.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        usedToolNames: Array.isArray(record?.usedToolNames)
          ? record.usedToolNames.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        runStatePath
      }
    }
  }
}
