/**
 * Phase 5 — Skill Child Runner.
 *
 * Owns the child-loop lifecycle. Parent code calls `startSkillChildRun` /
 * `resumeSkillChildRun` / `cancelSkillChildRun` and watches for the close
 * event. Inside the runner:
 *
 *   1. Concurrency cap (`MAX_ACTIVE_VEA_CHILD_RUNS = 3`) — overflow
 *      returns `recoverable_paused / queued_global_concurrency` without
 *      spawning anything.
 *   2. Single-flight collapse via the repository's `singleFlightKey`.
 *   3. Nested-child guard — drivers cannot recursively launch the public
 *      route without `childInternal: true`.
 *   4. Per-child abort controller + cancellation that NEVER maps to
 *      `failed`.
 *   5. Per-child internal budget — separate from the parent turn
 *      iteration counter.
 *   6. Launch-stuck guard — if `started` is written but the first
 *      `action_started` doesn't appear within the guard window the
 *      runner emits `child_process_crashed / launch_stuck`.
 *
 * Side effects (DB writes, JSONL append) are isolated behind the injected
 * `SkillTaskRunRepository` and `SkillsRuntimeManager` — tests pass stubs.
 *
 * Source plan: §3.2 Runtime Decisions, §5.4 Close Events, §5.5 Admission,
 * §Phase 5.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type {
  SkillRunResult,
  SkillsRuntimeManager,
} from '../../skills-runtime/runtime-manager'
import type { SkillTaskRunRepository } from '../../repositories/skill-task-run-repository'
import type { AgentSpawnContext } from '../../../../shared/skill-host-contract'
import type { ScopeRunEventPayload, ScopeRunResumableAction, ScopeRunSkillProgress } from '../contracts/types'
import type { TaskProjectionRecord, TaskProjectionStore, TaskStep } from '../contracts/run-contracts'

import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import { linkParentAbort } from '../link-parent-abort'
import { createSkillChildRunId, getSkillChildRunKind } from './skill-child-run-id'
import {
  appendChildRunEvent,
  deriveLegacyChildRunLogPath,
  deriveRuntimeChildRunLogPath,
} from './skill-child-run-log'
import { writeLifecycle } from '../output-dir-lifecycle'
import { inspectSkillProgressArtifacts } from './skill-progress-artifacts'
import {
  completePendingSkillHandoffs,
  listHandoffValidationRepairTasks,
  listPendingSkillHandoffTasks,
} from './skill-handoff-completion'
import { selectRunStateCandidate } from '../task-projection/run-state-selection'
import { parseRunStateJson } from '../task-projection/run-state-schema'
import {
  recordSkillParentTaskLifecycleEvent,
  type SkillParentTaskLifecycleReason,
  type SkillParentTaskLifecycleState,
} from './skill-task-tracker'
import {
  ChildRunCircuitBreaker,
  shouldCountChildRunCircuitBreakerFailure,
} from '../child-run/child-run-circuit-breaker'
import {
  getSkillChildDriver,
  isChildOwnedSkill,
} from './skill-child-drivers'
import {
  executeSkillActionViaToolGateway,
  type ChildGatewayResult,
} from '../tools-runtime/tool-registry'
import {
  isCompletedChildCloseStatus,
  isKilledChildCloseStatus,
  isRetainedLifecycleChildCloseStatus,
  isTerminalChildCloseStatus,
  type ChildWaitResult,
  type MutableSkillChildCloseEvent,
  type SkillChildCloseEvent,
  type SkillChildDriverState,
  type SkillChildLaunchParams,
  type SkillChildRunParentNextHint,
  type SkillChildRunPayload,
  type SkillChildRunStatus,
  type SkillChildRunTerminalReason,
} from './skill-child-run-types'
import {
  classifySkillChildRunStatus,
  decodeStoredSkillChildCloseEvent,
  isSkillChildRunResumable,
} from './skill-child-state-machine'
import { freezeSkillChildCloseEvent } from './skill-child-close-event-freeze'
import { createSkillChildSubAgent } from './skill-child-sub-agent'
import { mapSubAgentCloseToChildClose } from './skill-child-sub-agent-close-mapping'
import { isSkillChildProgressPayload } from './skill-child-sub-agent-events'
import { createSubAgentCleanupHandle } from '../sub-agent/sub-agent-cleanup'
import { runSubAgent } from '../sub-agent/sub-agent-runner'
import { disposeTimeout } from '../timer-disposal'
import { snapshotTurnFeatureFlags } from '../runtime-core/turn-feature-flags'
import {
  isResumeOnlySkillAction,
  resolveCanonicalChildRunHandle,
} from '../child-run/child-run-handle-resolver'

// =====================================================================
// Tunable constants (source plan §5.5).
// =====================================================================

export const MAX_ACTIVE_VEA_CHILD_RUNS = 3
/** Hard wall on the number of internal actions a single child run can
 *  plan before pausing for the next budget window. The parent turn loop
 *  is capped at 220; the child uses a smaller window so a single child
 *  cannot starve the parent. */
export const MAX_ACTIONS_PER_CHILD_RUN = 24
/** When a child run records `started` but does not record any
 *  `action_started` within this window, the runner declares
 *  `terminalReason='launch_stuck'`. Set generous enough that slow venv
 *  installs aren't misclassified — but tight enough that a wedged spawn
 *  is caught within a turn. */
export const LAUNCH_STUCK_GUARD_MS = 30_000
const PROGRESS_POLL_INTERVAL_MS = 5_000

// =====================================================================
// Public API
// =====================================================================

export interface StartSkillChildRunParams {
  scopeId: string | null
  sessionId: string | null
  skillId: string
  action: string
  requestedInput: Record<string, unknown>
  triggerType?: 'tool' | 'product' | 'agent'
  parentNextHint?: SkillChildRunParentNextHint
  agentContext?: AgentSpawnContext | null
  /** EP3-I4 — the user's original words, forwarded byte-for-byte into the
   *  persisted payload and the driver launch (05 §4 最小传话). */
  userRequestVerbatim?: string | null
  /** Set true ONLY when a registered driver is calling its own internal
   *  action through the runtime. Lets `startSkillChildRun` short-circuit
   *  the nested-child guard. Drivers should prefer the runtime's
   *  internal pathway and never call `startSkillChildRun` reentrantly —
   *  this flag is here as the safety net. */
  childInternal?: boolean
}

export type StartChildRunStatus = 'queued' | 'running' | 'reused' | 'recoverable_paused' | 'failed' | 'completed' | 'blocked' | 'killed'

type FreshSkillChildRunContractFields = Readonly<{
  childCloseEvent: null
  childStatus: 'running'
  parentNextHint: SkillChildRunParentNextHint
}>

export interface StartSkillChildRunResult {
  childRunId: string
  status: StartChildRunStatus
  outputDir: string
  runStatePath: string
  eventLogPath: string
  parentNextHint: SkillChildRunParentNextHint
  freshContractFields: FreshSkillChildRunContractFields | null
  /** null when started normally; non-null when paused-on-launch (concurrency
   *  overflow, nested guard, or any other launch-time refusal). */
  closeEvent: SkillChildCloseEvent | null
}

export interface WaitForSkillChildRunCloseOptions {
  timeoutMs?: number | null
  signal?: AbortSignal
}

export interface ResumeSkillChildRunOptions {
  agentContext?: AgentSpawnContext | null
}

export type CancelSkillChildRunSource = 'nlp' | 'ui_button'

export interface CancelSkillChildRunOptions {
  reason?: string
  source: CancelSkillChildRunSource
}

// =====================================================================
// Runner config + injection
// =====================================================================

export interface SkillChildRunnerConfig {
  runtimeManager: SkillsRuntimeManager
  repository: SkillTaskRunRepository
  taskProjectionStore?: TaskProjectionStore | null
  /** Optional override for the launch-stuck guard. Defaults to the
   *  module-level constant. */
  launchStuckGuardMs?: number
  /** Optional override for the child action budget. */
  maxActionsPerRun?: number
  /** Optional override for the global active-vea cap. */
  maxActiveVeaRuns?: number
  /** Sleep helper — only overridden in tests. */
  sleep?: (ms: number) => Promise<void>
  /** Background artifact polling cadence. Tests may lower this. */
  progressPollIntervalMs?: number
  /** Pushes terminal child-run truth into the same scope-run channel the UI watches. */
  publishScopeRunEvent?: ((payload: ScopeRunEventPayload) => void) | null
}

interface ActiveRun {
  childRunId: string
  skillId: string
  action: string
  scopeId: string | null
  sessionId: string | null
  status: SkillChildRunStatus
  startedAt: string
  controller: AbortController
  closePromise: Promise<SkillChildCloseEvent>
  resolveClose(event: SkillChildCloseEvent): void
  outputDir: string
  runStatePath: string
  eventLogPath: string
  parentNextHint: SkillChildRunParentNextHint
  singleFlightKey: string
  agentContext: AgentSpawnContext | null
  progress: ScopeRunSkillProgress
  blockedReason: string | null
  /**
   * Stage T (W9.1) — last truly-persisted step id (snapshot of
   * `progress.stage` on each `action_completed` event). Used as the
   * `rollback_target` diagnostic value when this run is cancelled.
   * `null` until at least one action has completed; `null` on cancel
   * means "no safe step recorded".
   *
   * This is a DIAGNOSTIC field only — the runner does not auto-roll-back
   * on cancel. Consumers (renderer / debug) can surface it for triage.
   */
  lastSafeStepId: string | null
}

interface ChildRunSummary {
  childRunId: string
  skillId: string
  sessionId: string | null
  scopeId: string | null
  status: SkillChildRunStatus
  startedAt: string
  outputDir: string
  runStatePath: string
  progress: ScopeRunSkillProgress
  blockedReason: string | null
  liveness: 'background' | null
  closeStatus: SkillChildCloseEvent['status'] | null
}

class SkillChildRunner {
  private readonly config: Required<SkillChildRunnerConfig>
  private readonly active = new Map<string, ActiveRun>()
  /** Set to true synchronously around `driver.planNextAction` /
   *  `driver.observeAfterAction` calls. Re-entrant calls into
   *  `startSkillChildRun` without `childInternal: true` while this
   *  is non-zero are rejected with `nested_child_run_not_supported`.
   *  A simple counter is enough — the loop is single-threaded JS, and
   *  the AsyncLocalStorage approach buys nothing here.
   */
  private inDriverDepth = 0
  /** Snapshot of close events for completed runs so callers can read the
   *  result after the loop has finished. Capped at a small ring. */
  private readonly recentCloses = new Map<string, SkillChildCloseEvent>()
  private readonly recentSummaries = new Map<string, ChildRunSummary>()
  private readonly circuitBreaker: ChildRunCircuitBreaker

  constructor(config: SkillChildRunnerConfig) {
    this.config = {
      runtimeManager: config.runtimeManager,
      repository: config.repository,
      taskProjectionStore: config.taskProjectionStore ?? null,
      launchStuckGuardMs: config.launchStuckGuardMs ?? LAUNCH_STUCK_GUARD_MS,
      maxActionsPerRun: config.maxActionsPerRun ?? MAX_ACTIONS_PER_CHILD_RUN,
      maxActiveVeaRuns: config.maxActiveVeaRuns ?? MAX_ACTIVE_VEA_CHILD_RUNS,
      sleep: config.sleep ?? defaultSleep,
      progressPollIntervalMs: config.progressPollIntervalMs ?? PROGRESS_POLL_INTERVAL_MS,
      publishScopeRunEvent: config.publishScopeRunEvent ?? null,
    }
    this.circuitBreaker = new ChildRunCircuitBreaker({
      enabled: snapshotTurnFeatureFlags().childRunCircuitBreakerEnabled,
    })
  }

  // ------------------------------------------------------------------
  // Public entry points
  // ------------------------------------------------------------------

  listActiveRuns(): ChildRunSummary[] {
    const rows = new Map<string, ChildRunSummary>()
    for (const run of this.active.values()) {
      rows.set(run.childRunId, this.summaryFromActive(run))
    }
    for (const summary of this.recentSummaries.values()) {
      if (!rows.has(summary.childRunId)) {
        rows.set(summary.childRunId, { ...summary, progress: { ...summary.progress } })
      }
    }
    return Array.from(rows.values())
  }

  async startSkillChildRun(params: StartSkillChildRunParams): Promise<StartSkillChildRunResult> {
    const driver = getSkillChildDriver(params.skillId)
    if (!driver) {
      // No driver registered — refuse with tool_not_registered so the parent can
      // pick a different route. Keeping this as a failed close (not a
      // throw) means the caller observes the same channel as a normal
      // refusal.
      return makePausedOnLaunchResult({
        skillId: params.skillId,
        terminalReason: 'tool_not_registered',
        status: 'failed',
        errorKind: 'no_driver_registered',
        message: `No skill child driver registered for ${params.skillId}`,
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      })
    }

    // Nested-child guard. Drivers must NOT recurse through the public
    // route — the only legal nested call is one explicitly tagged
    // `childInternal: true`. The guard fires only when this start is
    // synchronously initiated from inside a driver call (planNextAction
    // / observeAfterAction); independent concurrent launches are fine.
    if (params.childInternal !== true && this.inDriverDepth > 0) {
      return makePausedOnLaunchResult({
        skillId: params.skillId,
        terminalReason: 'nested_child_run_not_supported',
        status: 'failed',
        errorKind: 'nested_child_run',
        message: 'Cannot launch a new child run from inside a driver loop without childInternal',
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      })
    }

    const runtimeInfo = this.config.runtimeManager.getRuntimeInfo()
    const canonicalHandle = resolveCanonicalChildRunHandle({
      skillId: params.skillId,
      action: params.action,
      requestedInput: params.requestedInput,
      runtimeOutputsRoot: runtimeInfo.outputsRoot,
    })
    if (!canonicalHandle.ok && isResumeOnlySkillAction(params.skillId, params.action)) {
      return makePausedOnLaunchResult({
        skillId: params.skillId,
        terminalReason: 'blocked_external',
        status: 'blocked',
        errorKind: canonicalHandle.reason,
        message: `Cannot launch resume-only skill action without a trusted continuation handle (${canonicalHandle.reason})`,
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      })
    }
    const requestedInput = canonicalHandle.ok ? canonicalHandle.input : params.requestedInput

    // Single-flight collapse.
    const requestedOutputDir = canonicalHandle.ok
      ? trim(canonicalHandle.outputDir)
      : trim(requestedInput.outputDir as unknown)
    const runStatePathHint = canonicalHandle.ok && canonicalHandle.runStatePath
      ? canonicalHandle.runStatePath
      : requestedOutputDir ? join(requestedOutputDir, 'run_state.json') : null
    const targetDigest = computeTargetDigest({
      runStatePath: runStatePathHint,
      outputDir: requestedOutputDir,
      requestedInput,
    })
    const singleFlightKey = `${params.scopeId ?? '∅'}|${params.sessionId ?? '∅'}|${params.skillId}|${targetDigest}`

    try {
      const existing = this.config.repository.findLatestChildRunByKey(singleFlightKey)
      if (existing) {
        const existingPayload = (existing.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
        const recoveredOrReused = await this.reconcileExistingChildRun({
          existing,
          existingPayload: existingPayload ?? null,
          params,
        })
        if (recoveredOrReused) return recoveredOrReused
        // Fall through — record was unrecoverable; mint a new child run.
      }
      const targetExisting = this.findExistingChildRunForExactTarget({
        runStatePath: runStatePathHint,
        outputDir: requestedOutputDir,
        skillId: params.skillId,
      })
      if (targetExisting) {
        const targetPayload = (targetExisting.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
        const recoveredOrResumed = await this.reconcileExactTargetChildRun({
          existing: targetExisting,
          existingPayload: targetPayload ?? null,
          params,
        })
        if (recoveredOrResumed) return recoveredOrResumed
      }
    } catch (error) {
      // Repo unavailable — fall through and try to start, the create()
      // call will fail with a clear error if it's truly broken.
      logAgentMetric('skill_child_runner_lookup_error', {
        skillId: params.skillId,
        error: errorMessage(error),
      })
    }

    const breakerCheck = this.circuitBreaker.check(singleFlightKey)
    if (!breakerCheck.allowed) {
      logAgentMetric(TOOL_ERROR_METRICS.childRunCircuitBreak, {
        phase: 'blocked',
        skillId: params.skillId,
        singleFlightKey,
        remainingMs: breakerCheck.remainingMs,
        cooldownUntil: new Date(breakerCheck.cooldownUntil).toISOString(),
      })
      return makePausedOnLaunchResult({
        skillId: params.skillId,
        terminalReason: 'host_unavailable',
        status: 'failed',
        errorKind: 'child_run_circuit_breaker_open',
        message: `Child-run circuit breaker cooling down for this target (${breakerCheck.remainingMs}ms remaining)`,
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      })
    }

    // Concurrency cap (VEA-only — other kinds aren't gated yet).
    const isVeaKind = getSkillChildRunKind(`v${'0'.repeat(8)}`) === 'vea' && (
      params.skillId === 'video-expert-analyzer'
    )
    if (isVeaKind && this.countActiveVeaRuns() >= this.config.maxActiveVeaRuns) {
      return makePausedOnLaunchResult({
        skillId: params.skillId,
        terminalReason: 'queued_global_concurrency',
        status: 'recoverable_paused',
        errorKind: 'queued_global_concurrency',
        message: `Global VEA concurrency cap reached (max=${this.config.maxActiveVeaRuns})`,
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      })
    }

    // Mint identity + paths.
    const childRunId = createSkillChildRunId(isVeaKind ? 'vea' : 'skill')
    const outputDir = requestedOutputDir
      || join(runtimeInfo.outputsRoot, params.skillId, childRunId)
    const runStatePath = runStatePathHint || join(outputDir, 'run_state.json')
    const eventLogPath = deriveRuntimeChildRunLogPath(
      runtimeInfo.runtimeRoot,
      childRunId,
    )

    // Best-effort create the directory tree before the first append.
    try {
      mkdirSync(dirname(eventLogPath), { recursive: true })
    } catch {
      // ignore — the first appendChildRunEvent will surface the error.
    }

    // Persist the child-run row.
    try {
      this.config.repository.createChildRun({
        childRunId,
        scopeId: params.scopeId,
        sessionId: params.sessionId,
        skillId: params.skillId,
        skillName: null,
        action: params.action,
        requestedInput,
        singleFlightKey,
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
        outputDir,
        runStatePath,
        eventLogPath,
        status: 'running',
        userRequestVerbatim: params.userRequestVerbatim ?? null,
      })
    } catch (error) {
      return makePausedOnLaunchResult({
        skillId: params.skillId,
        terminalReason: 'persistence_failed',
        status: 'failed',
        errorKind: 'repository_create_failed',
        message: errorMessage(error),
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      })
    }

    const launchParams: SkillChildLaunchParams = {
      skillId: params.skillId,
      action: params.action,
      scopeId: params.scopeId,
      sessionId: params.sessionId,
      requestedInput,
      parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      agentContext: params.agentContext ?? null,
      outputDir,
      // EP3-I4 — verbatim rides the launch byte-for-byte (05 §4).
      userRequestVerbatim: params.userRequestVerbatim ?? null,
    }

    return this.beginRunLoop({
      childRunId,
      params,
      launchParams,
      outputDir,
      runStatePath,
      eventLogPath,
      singleFlightKey,
    })
  }

  async resumeSkillChildRun(
    childRunId: string,
    options: ResumeSkillChildRunOptions = {},
  ): Promise<StartSkillChildRunResult> {
    const record = this.config.repository.get(childRunId)
    if (!record) {
      return makePausedOnLaunchResult({
        skillId: 'unknown',
        terminalReason: 'resume_launch_failed',
        status: 'failed',
        errorKind: 'no_record',
        message: `No child-run record for id ${childRunId}`,
        parentNextHint: 'wait_for_close_event',
      })
    }
    const payload = (record.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
    if (!payload) {
      return makePausedOnLaunchResult({
        skillId: record.skillId,
        terminalReason: 'resume_launch_failed',
        status: 'failed',
        errorKind: 'no_payload',
        message: 'Child-run record is missing payload',
        parentNextHint: 'wait_for_close_event',
      })
    }
    const statusClass = classifySkillChildRunStatus(payload.status)
    if (!isSkillChildRunResumable(payload.status)) {
      if (statusClass === 'active') {
        const active = this.active.get(childRunId)
        if (!active) {
          return this.resumePayloadChildRun({
            childRunId,
            record,
            payload,
            agentContext: options.agentContext ?? null,
            completePendingHandoffsBeforePlan: this.hasCompletableHandoffTasks(payload.outputDir),
          })
        }
        return {
          childRunId,
          status: 'reused',
          outputDir: active.outputDir,
          runStatePath: active.runStatePath,
          eventLogPath: active.eventLogPath,
          parentNextHint: active.parentNextHint,
          freshContractFields: null,
          closeEvent: null,
        }
      }
      const storedClose = payload.closeEvent ? decodeStoredSkillChildCloseEvent(payload.closeEvent) : null
      const completedArtifactClose = this.resolveCompletedArtifactClose(childRunId, payload, storedClose)
      if (completedArtifactClose) {
        await this.persistResolvedCloseFromArtifacts({
          record,
          payload,
          close: completedArtifactClose,
        })
        return {
          childRunId,
          status: 'completed',
          outputDir: completedArtifactClose.outputDir ?? payload.outputDir,
          runStatePath: completedArtifactClose.runStatePath ?? payload.runStatePath,
          eventLogPath: this.deriveEventLogPathFromRecord(record),
          parentNextHint: payload.parentNextHint,
          freshContractFields: null,
          closeEvent: completedArtifactClose,
        }
      }
      const blockedHandoffResume = this.resolveBlockedHandoffResume(payload, storedClose, options)
      if (blockedHandoffResume) {
        return this.resumePayloadChildRun({
          childRunId,
          record,
          payload,
          agentContext: blockedHandoffResume.agentContext,
          completePendingHandoffsBeforePlan: true,
        })
      }
      return makeResumeRefusalResult({
        childRunId,
        skillId: payload.skillId,
        status: payload.status,
        terminalReason: storedClose?.terminalReason ?? defaultTerminalReasonForStatus(payload.status),
        outputDir: payload.outputDir,
        runStatePath: payload.runStatePath,
        eventLogPath: this.deriveEventLogPathFromRecord(record),
        errorKind: statusClass === 'blocked' ? 'still_blocked' : 'terminal_not_resumable',
        message: statusClass === 'blocked'
          ? 'Child run is blocked and cannot be resumed directly'
          : 'Child run is already terminal and cannot be resumed',
        parentNextHint: payload.parentNextHint,
      })
    }
    return this.resumePayloadChildRun({
      childRunId,
      record,
      payload,
      agentContext: options.agentContext ?? null,
      completePendingHandoffsBeforePlan: this.hasCompletableHandoffTasks(payload.outputDir),
    })
  }

  private resolveCompletedArtifactClose(
    childRunId: string,
    payload: SkillChildRunPayload,
    storedClose: SkillChildCloseEvent | null,
  ): SkillChildCloseEvent | null {
    if (payload.skillId !== 'video-expert-analyzer') return null
    if (payload.status !== 'blocked') return null
    if (storedClose?.terminalReason !== 'blocked_external') return null
    if (!payload.outputDir) return null
    if (!isVeaDeliveryComplete(payload.outputDir)) return null
    const artifactProgress = inspectSkillProgressArtifacts({
      outputDir: payload.outputDir,
      sceneScoresPath: join(payload.outputDir, 'scene_scores.json'),
    })
    if (!artifactProgress.sceneScoresPath) return null
    if (artifactProgress.totalScenes === null || artifactProgress.totalScenes <= 0) return null
    if (artifactProgress.completedScenes !== artifactProgress.totalScenes) return null
    const deliveryReportPath = join(payload.outputDir, 'delivery_report.json')
    if (!existsSync(deliveryReportPath)) return null
    const completed = artifactProgress.completedScenes
    const total = artifactProgress.totalScenes
    const fingerprint = buildChildProgressFingerprint({
      stage: 'completed',
      completed,
      total,
      coverage: 1,
      overallCoverage: 1,
      updatedAt: new Date().toISOString(),
    })
    return freezeSkillChildCloseEvent({
      childRunId,
      skillId: payload.skillId,
      status: 'completed',
      terminalReason: 'completed',
      outputDir: payload.outputDir,
      runStatePath: payload.runStatePath || join(payload.outputDir, 'run_state.json'),
      sceneScoresPath: artifactProgress.sceneScoresPath,
      deliveryReportPath,
      progress: {
        stage: 'completed',
        totalUnits: total,
        completedUnits: completed,
        coverageRatio: 1,
        overallCoverageRatio: 1,
        fingerprint,
      },
      framePatch: null,
      projectionPatch: null,
      error: null,
    })
  }

  private async persistResolvedCloseFromArtifacts(args: {
    record: NonNullable<ReturnType<SkillTaskRunRepository['get']>>
    payload: SkillChildRunPayload
    close: SkillChildCloseEvent
  }): Promise<void> {
    const eventLogPath = this.deriveEventLogPathFromRecord(args.record)
    if (eventLogPath) {
      // Stage T (W9.1) — Worker Event Ledger. This caller resolves a close
      // from artifacts (no live ActiveRun in scope), so `rollback_target`
      // can only be set if the persisted record carried a `lastSafeStepId`
      // — which today it does not, so cancel terminal events from this
      // path emit `rollback_target: null` (diagnostic null-marker).
      const ledger = deriveCloseEventLedgerKind(args.close)
      await appendChildRunEvent({
        logPath: eventLogPath,
        event: {
          type: 'close',
          at: new Date().toISOString(),
          ts: Date.now(),
          event_kind: ledger.event_kind,
          terminal_reason: args.close.terminalReason,
          ...(ledger.isCancel ? { rollback_target: null } : {}),
          close: args.close,
        },
      })
    }
    this.persistTerminalClose(args.payload.childRunId, args.close)
    recordSkillParentTaskLifecycleEvent({
      scopeId: args.payload.parentScopeId ?? undefined,
      sessionId: args.payload.parentSessionId ?? undefined,
      skillId: args.payload.skillId,
      action: args.payload.requestedAction,
      state: lifecycleStateForChildClose(args.close),
      reason: lifecycleReasonForChildClose(args.close),
      message: closeMessage(args.close),
      stepId: childProjectionStepId(args.payload.childRunId),
      outputDir: args.close.outputDir ?? args.payload.outputDir,
      runStatePath: args.close.runStatePath ?? args.payload.runStatePath,
      sceneScoresPath: args.close.sceneScoresPath,
      deliveryReportPath: args.close.deliveryReportPath,
      childRunId: args.payload.childRunId,
      progressFingerprint: args.close.progress.fingerprint,
      progress: mergeProgressFromClose(emptyChildProgress(), args.close.progress),
    })
  }

  private resolveBlockedHandoffResume(
    payload: SkillChildRunPayload,
    storedClose: SkillChildCloseEvent | null,
    options: ResumeSkillChildRunOptions,
  ): { agentContext: AgentSpawnContext } | null {
    if (payload.status !== 'blocked') return null
    if (storedClose?.terminalReason !== 'blocked_external') return null
    const agentContext = options.agentContext ?? null
    if (!agentContext) return null
    if (!payload.outputDir) return null
    if (!this.hasCompletableHandoffTasks(payload.outputDir)
        && !isVeaFinalizeResumeCandidate(payload.skillId, payload.outputDir)) return null
    return { agentContext }
  }

  private hasCompletableHandoffTasks(outputDir: string | null | undefined): boolean {
    if (!outputDir) return false
    try {
      return listPendingSkillHandoffTasks(outputDir).length > 0
        || listHandoffValidationRepairTasks(outputDir).length > 0
    } catch {
      return false
    }
  }

  private async resumePayloadChildRun(args: {
    childRunId: string
    record: NonNullable<ReturnType<SkillTaskRunRepository['get']>>
    payload: SkillChildRunPayload
    agentContext: AgentSpawnContext | null
    completePendingHandoffsBeforePlan?: boolean
  }): Promise<StartSkillChildRunResult> {
    const { childRunId, record, payload } = args
    const params: StartSkillChildRunParams = {
      scopeId: payload.parentScopeId ?? record.scopeId ?? null,
      sessionId: payload.parentSessionId ?? record.sessionId ?? null,
      skillId: payload.skillId,
      action: payload.requestedAction,
      requestedInput: payload.requestedInput,
      parentNextHint: payload.parentNextHint,
      agentContext: args.agentContext,
      userRequestVerbatim: payload.userRequestVerbatim ?? null,
    }
    const launchParams: SkillChildLaunchParams = {
      skillId: payload.skillId,
      action: payload.requestedAction,
      scopeId: params.scopeId,
      sessionId: params.sessionId,
      requestedInput: payload.requestedInput,
      parentNextHint: payload.parentNextHint,
      agentContext: args.agentContext,
      outputDir: payload.outputDir,
      // EP3-I4 — resume restores the persisted words, never re-derives.
      userRequestVerbatim: payload.userRequestVerbatim ?? null,
    }
    const eventLogPath = this.deriveEventLogPathFromRecord(record)
    try {
      this.prepareResumeLifecycle(childRunId)
    } catch (error) {
      return makePausedOnLaunchResult({
        skillId: payload.skillId,
        terminalReason: 'persistence_failed',
        status: 'failed',
        errorKind: 'repository_update_failed',
        message: errorMessage(error),
        parentNextHint: payload.parentNextHint,
      })
    }

    return this.beginRunLoop({
      childRunId,
      params,
      launchParams,
      outputDir: payload.outputDir,
      runStatePath: payload.runStatePath,
      eventLogPath,
      singleFlightKey: payload.singleFlightKey,
      resume: true,
      completePendingHandoffsBeforePlan: args.completePendingHandoffsBeforePlan === true,
    })
  }

  async cancelSkillChildRun(
    childRunId: string,
    reasonOrOptions?: string | CancelSkillChildRunOptions,
  ): Promise<SkillChildCloseEvent> {
    const cancelOptions = normalizeCancelSkillChildRunOptions(reasonOrOptions)
    // Compatible with multi-lifecycle resume: if the row was resumed and is
    // active again, this targets the new ActiveRun's controller (active.get
    // returns the resumed entry). The old paused close in `recentCloses` is
    // not consulted here.
    const active = this.active.get(childRunId)
    logAgentMetric('skill_child_run_cancel_requested', {
      childRunId,
      skillId: active?.skillId ?? null,
      source: cancelOptions.source,
      hasActiveRun: Boolean(active),
    })
    if (!active) {
      // Already terminal — return the cached close if we have one.
      const cached = this.recentCloses.get(childRunId)

      // Try the durable record before falling back to a synthesized close.
      // When the row exists, the cancel close event MUST use the row's real
      // skillId, outputDir, runStatePath — synthesizing `'unknown'` for a
      // persisted row is a class-of-bug we explicitly guard against.
      const record = this.tryGetRecord(childRunId)
      const payload = (record?.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
      if (cached && isTerminalChildCloseStatus(cached.status)) {
        if (isKilledChildCloseStatus(cached.status)) {
          this.publishInactiveChildRunClose({ record, payload, close: cached })
        }
        return cached
      }
      // If the record already has a stored terminal close, return it.
      if (payload?.closeEvent && (
          payload.status === 'completed'
          || payload.status === 'failed'
          || payload.status === 'killed'
        )) {
        const decodedClose = decodeStoredSkillChildCloseEvent(payload.closeEvent)
        this.recentCloses.set(childRunId, decodedClose)
        if (isKilledChildCloseStatus(decodedClose.status)) {
          this.publishInactiveChildRunClose({ record, payload, close: decodedClose })
        }
        return decodedClose
      }

      const synth = makeCloseEvent({
        childRunId,
        skillId: payload?.skillId ?? record?.skillId ?? 'unknown',
        status: 'killed',
        terminalReason: 'cancelled_user',
        outputDir: payload?.outputDir ?? record?.outputDir ?? null,
        runStatePath: payload?.runStatePath ?? record?.runStatePath ?? null,
        errorKind: 'cancelled_user',
        message: cancelOptions.reason || 'cancelled before launch',
      })
      try {
        this.config.repository.updateChildRun(childRunId, {
          status: 'killed',
          closeEvent: synth,
        })
        this.markChildRunInteractionSuspended(childRunId)
        this.publishInactiveChildRunClose({
          record,
          payload,
          close: synth,
        })
      } catch {
        // already gone — ignore.
      }
      this.recentCloses.set(childRunId, synth)
      return synth
    }
    active.controller.abort(new Error(cancelOptions.reason || 'cancelled_user'))
    return active.closePromise
  }

  getCloseEvent(childRunId: string): SkillChildCloseEvent | null {
    // A run is currently in flight for this childRunId — any cached or
    // persisted close belongs to an earlier round and is therefore stale.
    // Return `null` so callers continue polling until the live run reaches
    // its real terminal state (which finalizeRun then exposes here).
    if (this.active.has(childRunId)) return null
    const cached = this.recentCloses.get(childRunId)
    if (cached) return cached
    // Durable fallback — read the persisted close from the repository
    // when the in-memory ring has evicted it (or the runner singleton
    // was reconfigured mid-process). The close event is written under
    // `resumePayload.childRun.closeEvent` by `finalizeRun`.
    const record = this.tryGetRecord(childRunId)
    if (!record) return null
    const payload = (record.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
    if (!payload) return null
    if (payload.closeEvent) {
      const decodedClose = decodeStoredSkillChildCloseEvent(payload.closeEvent)
      // Prime the in-memory ring so subsequent reads stay cheap.
      this.recentCloses.set(childRunId, decodedClose)
      return decodedClose
    }
    return null
  }

  waitForClose(
    childRunId: string,
    options: WaitForSkillChildRunCloseOptions,
  ): Promise<ChildWaitResult> {
    const close = this.getCloseEvent(childRunId)
    if (close) {
      return Promise.resolve({
        kind: 'closed',
        childRunId,
        closeEvent: close,
      })
    }
    const active = this.active.get(childRunId)
    return waitForClosePromise(childRunId, active?.closePromise ?? null, options)
  }

  private tryGetRecord(childRunId: string): ReturnType<SkillTaskRunRepository['get']> | null {
    try {
      return this.config.repository.get(childRunId)
    } catch (error) {
      logAgentMetric('skill_child_runner_lookup_error', {
        childRunId,
        error: errorMessage(error),
      })
      return null
    }
  }

  // ------------------------------------------------------------------
  // Internal: existing-row reconciliation
  // ------------------------------------------------------------------

  private findExistingChildRunForExactTarget(opts: {
    runStatePath: string | null
    outputDir: string | null
    skillId: string
  }): ReturnType<SkillTaskRunRepository['get']> | null {
    if (opts.runStatePath) {
      for (const runStatePath of pathLookupVariants(opts.runStatePath)) {
        const byRunState = this.config.repository.findChildRunByRunStatePath({
          runStatePath,
          skillId: opts.skillId,
        })
        if (byRunState) return byRunState
      }
    }
    if (opts.outputDir) {
      for (const outputDir of pathLookupVariants(opts.outputDir)) {
        const byOutputDir = this.config.repository.findChildRunByOutputDir({
          outputDir,
          skillId: opts.skillId,
        })
        if (byOutputDir) return byOutputDir
      }
    }
    return null
  }

  private async reconcileExactTargetChildRun(opts: {
    existing: ReturnType<SkillTaskRunRepository['get']> & object
    existingPayload: SkillChildRunPayload | null
    params: StartSkillChildRunParams
  }): Promise<StartSkillChildRunResult | null> {
    const { existing, existingPayload, params } = opts
    if (!existingPayload) return null
    if (existingPayload.skillId !== params.skillId) return null
    if (existingPayload.requestedAction !== params.action) return null
    const statusClass = classifySkillChildRunStatus(existingPayload.status)
    if (statusClass === 'active' || statusClass === 'paused') {
      return this.reconcileExistingChildRun(opts)
    }
    if (
      existingPayload.status === 'blocked'
      && existingPayload.skillId === 'video-expert-analyzer'
      && existingPayload.outputDir
      && (
        this.hasCompletableHandoffTasks(existingPayload.outputDir)
        || isVeaFinalizeResumeCandidate(existingPayload.skillId, existingPayload.outputDir)
      )
    ) {
      return this.resumeSkillChildRun(existing.id, {
        agentContext: params.agentContext ?? null,
      })
    }
    return null
  }

  /**
   * Decide what to do when `findLatestChildRunByKey` returned an existing row.
   *
   * Returns a `StartSkillChildRunResult` when the existing row is either
   * genuinely live (`reused`), terminal-with-stored-close (terminal summary),
   * durably resumed (`running`), or marked `recoverable_paused/process_restarted`.
   *
   * Returns `null` when the row is unrecoverable in a way that should fall
   * through to a fresh child run.
   *
   * The DB-row-says-running-but-no-active-runner branch is the false-live
   * path this method exists to kill: if `recentCloses` evicts and the
   * runner singleton has no record of the row, we MUST not claim it as
   * `reused`.
   */
  private async reconcileExistingChildRun(opts: {
    existing: ReturnType<SkillTaskRunRepository['get']> & object
    existingPayload: SkillChildRunPayload | null
    params: StartSkillChildRunParams
  }): Promise<StartSkillChildRunResult | null> {
    const { existing, existingPayload, params } = opts

    // (1) Active in-memory runner present — genuine live work.
    const liveRunner = this.active.get(existing.id)
    if (liveRunner) {
      return {
        childRunId: existing.id,
        status: 'reused',
        outputDir: existing.outputDir ?? '',
        runStatePath: existing.runStatePath ?? '',
        eventLogPath: this.deriveEventLogPathFromRecord(existing),
        parentNextHint: existingPayload?.parentNextHint
          ?? params.parentNextHint ?? 'wait_for_close_event',
        freshContractFields: null,
        closeEvent: null,
      }
    }

    // (2) Row is terminal with a stored close event — surface terminal summary.
    // (`findLatestChildRunByKey` filters by ACTIVE statuses today, so this
    // branch is defensive against the filter being relaxed later.)
    const persistedStatus = existingPayload?.status
    const persistedClose = existingPayload?.closeEvent
      ? decodeStoredSkillChildCloseEvent(existingPayload.closeEvent)
      : null
    if (persistedStatus
        && (persistedStatus === 'completed'
            || persistedStatus === 'failed'
            || persistedStatus === 'killed')
        && persistedClose) {
      return {
        childRunId: existing.id,
        status: persistedStatus,
        outputDir: existing.outputDir ?? '',
        runStatePath: existing.runStatePath ?? '',
        eventLogPath: this.deriveEventLogPathFromRecord(existing),
        parentNextHint: existingPayload!.parentNextHint
          ?? params.parentNextHint ?? 'wait_for_close_event',
        freshContractFields: null,
        closeEvent: persistedClose,
      }
    }

    // (3) Row is active per the DB but no in-memory runner exists. This is
    // the "process restarted / runner crashed mid-flight" case. Try a
    // durable resume if the payload carries enough handles; otherwise
    // mark the row `recoverable_paused/process_restarted`.
    const driver = getSkillChildDriver(existing.skillId)
    const eventLogPath = this.deriveEventLogPathFromRecord(existing)
    const canResume = !!driver
      && !!existingPayload
      && typeof existingPayload.outputDir === 'string'
      && existingPayload.outputDir.length > 0
      && typeof existingPayload.runStatePath === 'string'
      && existingPayload.runStatePath.length > 0
      && eventLogPath.length > 0

    if (canResume) {
      const payload = existingPayload!
      const launchParams: SkillChildLaunchParams = {
        skillId: payload.skillId,
        action: payload.requestedAction,
        scopeId: payload.parentScopeId ?? params.scopeId,
        sessionId: payload.parentSessionId ?? params.sessionId,
        requestedInput: payload.requestedInput,
        parentNextHint: payload.parentNextHint,
        agentContext: params.agentContext ?? null,
        outputDir: payload.outputDir,
        // EP3-I4 — resume restores the persisted words, never re-derives.
        userRequestVerbatim: payload.userRequestVerbatim ?? null,
      }
      const resumeStartParams: StartSkillChildRunParams = {
        scopeId: payload.parentScopeId ?? params.scopeId,
        sessionId: payload.parentSessionId ?? params.sessionId,
        skillId: payload.skillId,
        action: payload.requestedAction,
        requestedInput: payload.requestedInput,
        parentNextHint: payload.parentNextHint,
        agentContext: params.agentContext ?? null,
        userRequestVerbatim: payload.userRequestVerbatim ?? null,
      }
      try {
        this.prepareResumeLifecycle(existing.id)
      } catch (error) {
        logAgentMetric('skill_child_runner_resume_update_failed', {
          childRunId: existing.id,
          error: errorMessage(error),
        })
        // Fall through to recoverable_paused below.
        return this.markRowProcessRestarted(existing.id, payload)
      }
      return this.beginRunLoop({
        childRunId: existing.id,
        params: resumeStartParams,
        launchParams,
        outputDir: payload.outputDir,
        runStatePath: payload.runStatePath,
        eventLogPath,
        singleFlightKey: payload.singleFlightKey,
        resume: true,
      })
    }

    // No driver / insufficient handles — pin to recoverable_paused with
    // terminalReason='process_restarted'.
    return this.markRowProcessRestarted(existing.id, existingPayload)
  }

  /**
   * Reset all in-memory and persisted state that would leak across the
   * resume boundary. Centralized here so any future lifecycle transition
   * (pause-detach, fork-from-snapshot) goes through the same gate.
   */
  private prepareResumeLifecycle(childRunId: string): void {
    // 1. Drop the previous lifecycle's close from the in-memory ring so
    //    finalize for the resumed lifecycle won't see a stale entry. The
    //    identity guard in finalizeRun already handles this for the active
    //    map; here we keep recentCloses semantically aligned.
    this.recentCloses.delete(childRunId)
    // 2. Clear the row's stored closeEvent so any cross-process load via
    //    loadSkillRunContract doesn't read the previous paused close as
    //    if it were the current state. Status flips to 'running' atomically
    //    with the close clear.
    this.config.repository.updateChildRun(childRunId, {
      status: 'running',
      closeEvent: null,
    })
  }

  /**
   * Mark a stale row as `recoverable_paused/process_restarted` and return
   * a non-reused result that surfaces the recoverable state to the caller.
   */
  private markRowProcessRestarted(
    childRunId: string,
    existingPayload: SkillChildRunPayload | null,
  ): StartSkillChildRunResult {
    const close = makeCloseEvent({
      childRunId,
      skillId: existingPayload?.skillId ?? 'unknown',
      status: 'recoverable_paused',
      terminalReason: 'process_restarted',
      outputDir: existingPayload?.outputDir ?? null,
      runStatePath: existingPayload?.runStatePath ?? null,
      errorKind: 'process_restarted',
      message: 'In-memory runner missing for an active row; reconciled as recoverable_paused.',
    })
    try {
      this.config.repository.updateChildRun(childRunId, {
        status: 'recoverable_paused',
        closeEvent: close,
      })
    } catch (error) {
      logAgentMetric('skill_child_runner_reconcile_persist_failed', {
        childRunId,
        error: errorMessage(error),
      })
    }
    this.recentCloses.set(childRunId, close)
    if (this.recentCloses.size > 64) {
      const firstKey = this.recentCloses.keys().next().value
      if (firstKey) this.recentCloses.delete(firstKey)
    }
    return {
      childRunId,
      status: 'recoverable_paused',
      outputDir: existingPayload?.outputDir ?? '',
      runStatePath: existingPayload?.runStatePath ?? '',
      eventLogPath: existingPayload?.eventLogPath ?? '',
      parentNextHint: existingPayload?.parentNextHint ?? 'wait_for_close_event',
      freshContractFields: null,
      closeEvent: close,
    }
  }

  // ------------------------------------------------------------------
  // Internal: the actual loop
  // ------------------------------------------------------------------

  private async beginRunLoop(params: {
    childRunId: string
    params: StartSkillChildRunParams
    launchParams: SkillChildLaunchParams
    outputDir: string
    runStatePath: string
    eventLogPath: string
    singleFlightKey: string
    resume?: boolean
    completePendingHandoffsBeforePlan?: boolean
  }): Promise<StartSkillChildRunResult> {
    const { childRunId, launchParams, outputDir, runStatePath, eventLogPath } = params
    const driver = getSkillChildDriver(params.params.skillId)
    if (!driver) {
      // Should not happen — we checked above. Defensive close.
      const close = makeCloseEvent({
        childRunId,
        skillId: params.params.skillId,
        status: 'failed',
        terminalReason: 'tool_not_registered',
        outputDir,
        runStatePath,
        errorKind: 'no_driver_registered',
        message: 'driver disappeared mid-launch',
      })
      this.persistTerminalClose(childRunId, close)
      return {
        childRunId,
        status: 'failed',
        outputDir,
        runStatePath,
        eventLogPath,
        parentNextHint: launchParams.parentNextHint,
        freshContractFields: null,
        closeEvent: close,
      }
    }

    const controller = new AbortController()
    const startedAt = new Date().toISOString()
    let resolveClose!: (event: SkillChildCloseEvent) => void
    const closePromise = new Promise<SkillChildCloseEvent>((resolve) => {
      resolveClose = resolve
    })

    const active: ActiveRun = {
      childRunId,
      skillId: params.params.skillId,
      action: params.params.action,
      scopeId: params.params.scopeId,
      sessionId: params.params.sessionId,
      status: 'running',
      startedAt,
      controller,
      closePromise,
      resolveClose,
      outputDir,
      runStatePath,
      eventLogPath,
      parentNextHint: launchParams.parentNextHint,
      singleFlightKey: params.singleFlightKey,
      agentContext: params.params.agentContext ?? null,
      progress: emptyChildProgress(),
      blockedReason: null,
      // Stage T (W9.1) — Worker Event Ledger: lastSafeStepId starts null
      // and is updated on each successful `action_completed`.
      lastSafeStepId: null,
    }
    this.active.set(childRunId, active)
    this.rememberChildRunSummary(this.summaryFromActive(active))
    this.publishProjectionLaunch(active)

    // Kick off async loop. The promise we return resolves AFTER the
    // close event is recorded so callers can `await` either the result
    // or `getCloseEvent` to get the same shape.
    void this.runLoop(active, driver, launchParams, {
      resume: params.resume === true,
      completePendingHandoffsBeforePlan: params.completePendingHandoffsBeforePlan === true,
    }).catch((error) => {
      // Last-ditch — runLoop is supposed to surface its own close via
      // `finalizeRun`. If it throws past that, synthesize a failure.
      const close = makeCloseEvent({
        childRunId,
        skillId: params.params.skillId,
        status: 'failed',
        terminalReason: 'child_process_crashed',
        outputDir,
        runStatePath,
        errorKind: 'runner_uncaught',
        message: errorMessage(error),
      })
      // Round-1 (Codex) — finalizeRun is now async; fire-and-forget here
      // is fine because this `.catch` is itself the last-ditch path.
      void this.finalizeRun(active, close)
    })

    return {
      childRunId,
      status: 'running',
      outputDir,
      runStatePath,
      eventLogPath,
      parentNextHint: launchParams.parentNextHint,
      freshContractFields: params.resume === true
        ? {
            childCloseEvent: null,
            childStatus: 'running',
            parentNextHint: launchParams.parentNextHint,
          }
        : null,
      closeEvent: null,
    }
  }

  private async runLoop(
    active: ActiveRun,
    driver: ReturnType<typeof getSkillChildDriver>,
    launchParams: SkillChildLaunchParams,
    options: {
      resume: boolean
      completePendingHandoffsBeforePlan?: boolean
    },
  ): Promise<void> {
    if (!driver) return // typescript narrowing; checked at caller
    let firstActionStartedAt: string | null = null
    let state: SkillChildDriverState
    try {
      state = await driver.createInitialState(launchParams)
    } catch (error) {
      const close = makeCloseEvent({
        childRunId: active.childRunId,
        skillId: active.skillId,
        status: 'failed',
        terminalReason: 'child_process_crashed',
        outputDir: active.outputDir,
        runStatePath: active.runStatePath,
        errorKind: 'driver_init_failed',
        message: errorMessage(error),
      })
      await this.finalizeRun(active, close)
      return
    }

    await this.appendEvent(active, {
      type: 'started',
      at: active.startedAt,
      childRunId: active.childRunId,
      input: { ...launchParams.requestedInput, __resume: options.resume || undefined },
    })

    if (options.completePendingHandoffsBeforePlan === true) {
      const handoffReady = await this.completePendingHandoffsBeforePlan(active)
      if (!handoffReady) return
    }

    let isLaunchStuckFired = false
    const actionResults: SkillRunResult[] = []

    // Launch-stuck guard: schedule a timer that synthesizes a close if
    // we never see an action_started.
    const launchStuckTimer = setTimeout(() => {
      if (firstActionStartedAt !== null) return
      isLaunchStuckFired = true
      const close = makeCloseEvent({
        childRunId: active.childRunId,
        skillId: active.skillId,
        status: 'failed',
        terminalReason: 'launch_stuck',
        outputDir: active.outputDir,
        runStatePath: active.runStatePath,
        errorKind: 'launch_stuck',
        message: `No action_started within ${this.config.launchStuckGuardMs}ms`,
      })
      active.controller.abort(new Error('launch_stuck'))
      // Round-1 (Codex) — finalizeRun is now async. Timer callback is sync;
      // fire-and-forget is acceptable because launch_stuck is itself a
      // best-effort recovery path (the controller has already been aborted).
      void this.finalizeRun(active, close)
    }, this.config.launchStuckGuardMs)
    // Don't keep the process alive on this timer.
    if (typeof launchStuckTimer.unref === 'function') launchStuckTimer.unref()

    const cleanup = createSubAgentCleanupHandle(active.childRunId)
    cleanup.register(() => clearTimeout(launchStuckTimer))
    const parentAbortLink = linkParentAbort(this.getParentAbortSignal(active), active.controller)
    cleanup.register(() => parentAbortLink.dispose())
    const stopProgressPoll = this.startProgressPoll(active)
    if (stopProgressPoll) cleanup.register(stopProgressPoll)
    const subagent = createSkillChildSubAgent({
      childRunId: active.childRunId,
      outputDir: active.outputDir,
      runStatePath: active.runStatePath,
      driver,
      initialState: state,
      executeAction: async (action) => {
        try {
          const actionHandle = resolveCanonicalChildRunHandle({
            skillId: active.skillId,
            action: action.action,
            requestedInput: action.input,
            runtimeOutputsRoot: this.config.runtimeManager.getRuntimeInfo().outputsRoot,
            durableHandles: {
              outputDir: active.outputDir,
              runStatePath: active.runStatePath,
            },
          })
          const actionInput = actionHandle.ok ? actionHandle.input : action.input
          const gatewayResult = await executeSkillActionViaToolGateway({
            skillId: active.skillId,
            action: action.action,
            input: actionInput,
            childRunId: active.childRunId,
            scopeId: active.scopeId,
            sessionId: active.sessionId,
            outputDir: active.outputDir || null,
            runStatePath: active.runStatePath || null,
            childInternal: true,
            agentContext: active.agentContext,
            signal: parentAbortLink.childSignal,
            runtimeManager: this.config.runtimeManager,
          })
          const result = gatewayResult.skillRunResult
          if (!result) {
            throw makeGatewayExecutionError(gatewayResult)
          }
          const recoveredResult = await this.completePendingHandoffsAfterBlockedAction(active, result)
          actionResults.push(recoveredResult)
          return recoveredResult
        } catch (error) {
          throw makeSkillActionExecutionError(error, active.controller.signal)
        }
      },
      parentScopeId: active.scopeId,
      parentSessionId: active.sessionId,
      maxActions: this.config.maxActionsPerRun,
      runDriverCall: (call) => this.runDriverCall(call),
    })

    for await (const event of runSubAgent(subagent, {
      abortSignal: parentAbortLink.childSignal,
      cleanup,
      parentScopeId: active.scopeId,
      parentSessionId: active.sessionId,
    })) {
      if (event.type === 'progress' && isSkillChildProgressPayload(event.payload)) {
        if (event.payload.kind === 'action_started') {
          const actionStartedAt = new Date().toISOString()
          if (firstActionStartedAt === null) {
            firstActionStartedAt = actionStartedAt
          }
          await this.appendEvent(active, {
            type: 'action_started',
            at: actionStartedAt,
            action: event.payload.actionName,
            input: event.payload.actionInput,
          })
          continue
        }

        if (event.payload.kind === 'action_completed') {
          const result = actionResults.shift()
          // Stage T (W9.1) — Worker Event Ledger. On each successful
          // action_completed, snapshot the action name as `lastSafeStepId`
          // so a subsequent cancel terminal event can carry it as
          // `rollback_target` for diagnostic display. Failed actions do
          // not advance the safe step.
          if (event.payload.success) {
            active.lastSafeStepId = event.payload.actionName
          }
          await this.appendEvent(active, {
            type: 'action_completed',
            at: new Date().toISOString(),
            event_kind: 'progress',
            action: event.payload.actionName,
            result: {
              success: event.payload.success,
              status: result?.status ?? null,
              outputDir: result?.outputDir ?? null,
              error: result?.error ?? null,
              durationMs: event.payload.durationMs,
            },
          })
          await this.refreshActiveProgress(active, {
            appendEvent: false,
          })
          continue
        }

        await this.refreshActiveProgress(active, {
          payloadStage: event.payload.stage,
          payloadFingerprint: event.payload.fingerprint,
          appendEvent: true,
        })
        continue
      }

      if (event.type === 'terminal') {
        const abortReason = (active.controller.signal.reason as Error | undefined)?.message
          || (typeof active.controller.signal.reason === 'string' ? active.controller.signal.reason : null)
        const close = mapSubAgentCloseToChildClose(event.closeEvent, {
          childRunId: active.childRunId,
          skillId: active.skillId,
          outputDir: active.outputDir,
          runStatePath: active.runStatePath,
          progress: toCloseProgress(active.progress),
          isUserCancel: active.controller.signal.aborted
            && !isLaunchStuckFired
            && abortReason !== 'process_restarted',
          isParentSessionAbort: abortReason === 'process_restarted',
          isLaunchStuckFired,
        })
        await this.finalizeRun(active, mergeCloseWithLastProgress(close, active.progress))
        return
      }
    }
  }

  private async runDriverCall<T>(call: () => Promise<T>): Promise<T> {
    this.inDriverDepth += 1
    try {
      return await call()
    } finally {
      this.inDriverDepth = Math.max(0, this.inDriverDepth - 1)
    }
  }

  private async completePendingHandoffsAfterBlockedAction(
    active: ActiveRun,
    result: SkillRunResult,
  ): Promise<SkillRunResult> {
    const outputs = result.outputs ?? {}
    const outputDir = pickString(result.outputDir)
      ?? pickString(outputs.outputDir)
      ?? pickString(outputs.output_dir)
      ?? active.outputDir
    if (!outputDir) return result
    if (!this.hasCompletableHandoffTasks(outputDir)) return result
    if (!active.agentContext) return result
    try {
      const completed = await completePendingSkillHandoffs({
        outputDir,
        agentContext: active.agentContext,
      })
      if (completed.length === 0) return result
      logAgentMetric('skill_child_handoff_completed', {
        childRunId: active.childRunId,
        skillId: active.skillId,
        action: result.action,
        outputDir,
        tasks: completed.map((item) => item.name),
      })
      return {
        ...result,
        success: true,
        status: 'done',
        outputDir,
        error: undefined,
        stdout: [
          result.stdout,
          `completed handoff tasks: ${completed.map((item) => item.name).join(', ')}`,
        ].filter(Boolean).join('\n'),
      }
    } catch (error) {
      logAgentMetric('skill_child_handoff_completion_failed', {
        childRunId: active.childRunId,
        skillId: active.skillId,
        action: result.action,
        outputDir,
        error: errorMessage(error),
      })
      return result
    }
  }

  private async completePendingHandoffsBeforePlan(active: ActiveRun): Promise<boolean> {
    if (!active.agentContext) {
      const close = makeCloseEvent({
        childRunId: active.childRunId,
        skillId: active.skillId,
        status: 'blocked',
        terminalReason: 'blocked_external',
        outputDir: active.outputDir,
        runStatePath: active.runStatePath,
        errorKind: 'handoff_agent_context_missing',
        message: 'Pending skill handoff requires the active agent context before resume.',
      })
      await this.finalizeRun(active, close)
      return false
    }
    try {
      const completed = await completePendingSkillHandoffs({
        outputDir: active.outputDir,
        agentContext: active.agentContext,
      })
      if (completed.length > 0) {
        await this.appendEvent(active, {
          type: 'checkpoint',
          at: new Date().toISOString(),
          reason: 'handoff_completed_before_resume',
          state: {
            tasks: completed.map((item) => item.name),
          },
        })
        logAgentMetric('skill_child_handoff_completed', {
          childRunId: active.childRunId,
          skillId: active.skillId,
          action: active.action,
          outputDir: active.outputDir,
          tasks: completed.map((item) => item.name),
          phase: 'resume',
        })
      }
      return true
    } catch (error) {
      logAgentMetric('skill_child_handoff_completion_failed', {
        childRunId: active.childRunId,
        skillId: active.skillId,
        action: active.action,
        outputDir: active.outputDir,
        error: errorMessage(error),
        phase: 'resume',
      })
      const close = makeCloseEvent({
        childRunId: active.childRunId,
        skillId: active.skillId,
        status: 'blocked',
        terminalReason: 'blocked_external',
        outputDir: active.outputDir,
        runStatePath: active.runStatePath,
        errorKind: 'handoff_completion_failed',
        message: errorMessage(error),
      })
      await this.finalizeRun(active, close)
      return false
    }
  }

  private getParentAbortSignal(active: ActiveRun): AbortSignal | null {
    const repository = this.config.repository as SkillTaskRunRepository & {
      getSessionAbortSignal?: (scopeId: string | null, sessionId: string | null) => AbortSignal | null
    }
    return repository.getSessionAbortSignal?.(active.scopeId, active.sessionId) ?? null
  }

  private async appendEvent(
    active: ActiveRun,
    event: Parameters<typeof appendChildRunEvent>[0]['event'],
  ): Promise<void> {
    try {
      await appendChildRunEvent({ logPath: active.eventLogPath, event })
    } catch (error) {
      logAgentMetric('skill_child_runner_log_failed', {
        childRunId: active.childRunId,
        error: errorMessage(error),
      })
    }
  }

  private startProgressPoll(active: ActiveRun): (() => void) | null {
    const intervalMs = Math.max(0, this.config.progressPollIntervalMs)
    if (intervalMs <= 0) return null
    const maxIntervalMs = Math.max(intervalMs, 10_000)
    let stopped = false
    let nextDelayMs = intervalMs
    let timer: NodeJS.Timeout | null = null
    const schedule = (delayMs: number) => {
      timer = setTimeout(async () => {
        timer = null
        if (stopped || this.active.get(active.childRunId) !== active) return
        const changed = await this.refreshActiveProgress(active, { appendEvent: false })
        if (stopped || this.active.get(active.childRunId) !== active) return
        nextDelayMs = changed ? intervalMs : Math.min(maxIntervalMs, Math.max(intervalMs, nextDelayMs * 2))
        schedule(nextDelayMs)
      }, delayMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    schedule(intervalMs)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  private async refreshActiveProgress(
    active: ActiveRun,
    options: {
      payloadStage?: string | null
      payloadFingerprint?: string | null
      appendEvent: boolean
    },
  ): Promise<boolean> {
    const observedAt = new Date().toISOString()
    const snapshot = readChildProgressSnapshot({
      skillId: active.skillId,
      childRunId: active.childRunId,
      strictChildRunId: requiresChildOwnedRunState(active.skillId, active.action),
      outputDir: active.outputDir,
      runStatePath: active.runStatePath,
      payloadStage: options.payloadStage ?? null,
      payloadFingerprint: options.payloadFingerprint ?? null,
      observedAt,
      previous: active.progress,
    })
    const handleChanged = Boolean(
      snapshot.outputDir && snapshot.outputDir !== active.outputDir
      || snapshot.runStatePath && snapshot.runStatePath !== active.runStatePath,
    )
    const progressChanged = !sameProgress(active.progress, snapshot.progress)
    if (!handleChanged && !progressChanged) return false

    if (snapshot.outputDir) active.outputDir = snapshot.outputDir
    if (snapshot.runStatePath) active.runStatePath = snapshot.runStatePath
    active.progress = snapshot.progress
    active.blockedReason = snapshot.progress.lastError
    try {
      this.config.repository.updateChildRun(active.childRunId, {
        outputDir: active.outputDir,
        runStatePath: active.runStatePath,
      })
    } catch (error) {
      logAgentMetric('skill_child_runner_progress_handle_update_failed', {
        childRunId: active.childRunId,
        error: errorMessage(error),
      })
    }
    this.rememberChildRunSummary(this.summaryFromActive(active))
    this.publishProjectionProgress(active)
    if (options.appendEvent || handleChanged) {
      await this.appendEvent(active, {
        type: 'state_observed',
        at: observedAt,
        runStatePath: active.runStatePath,
        state: {
          stage: snapshot.progress.stage,
          completed: snapshot.progress.completed,
          total: snapshot.progress.total,
          coverage: snapshot.progress.coverage,
          overallCoverage: snapshot.progress.overallCoverage ?? null,
          fingerprint: snapshot.progress.fingerprint,
          updatedAt: snapshot.progress.updatedAt,
          lastError: snapshot.progress.lastError,
          detail: snapshot.progress.detail,
          activityUpdatedAt: snapshot.progress.activityUpdatedAt,
        },
      })
    }
    return true
  }

  private publishProjectionLaunch(active: ActiveRun): void {
    recordSkillParentTaskLifecycleEvent({
      scopeId: active.scopeId ?? undefined,
      sessionId: active.sessionId ?? undefined,
      skillId: active.skillId,
      action: active.action,
      state: 'background_running',
      reason: 'background_running',
      message: '技能任务已在后台启动',
      stepId: childProjectionStepId(active.childRunId),
      outputDir: active.outputDir,
      runStatePath: active.runStatePath,
      childRunId: active.childRunId,
      progress: active.progress,
    })
    this.upsertChildTaskProjection({
      active,
      state: 'background_running',
      reason: 'background_running',
      message: '技能任务已在后台启动',
      progress: active.progress,
    })
  }

  private publishProjectionProgress(active: ActiveRun): void {
    recordSkillParentTaskLifecycleEvent({
      scopeId: active.scopeId ?? undefined,
      sessionId: active.sessionId ?? undefined,
      skillId: active.skillId,
      action: active.action,
      state: 'background_running',
      reason: 'background_running',
      message: progressMessage(active.progress),
      stepId: childProjectionStepId(active.childRunId),
      outputDir: active.outputDir,
      runStatePath: active.runStatePath,
      childRunId: active.childRunId,
      progressFingerprint: active.progress.fingerprint,
      progress: active.progress,
    })
    this.upsertChildTaskProjection({
      active,
      state: 'background_running',
      reason: 'background_running',
      message: progressMessage(active.progress),
      progress: active.progress,
    })
  }

  private publishProjectionClose(active: ActiveRun, close: SkillChildCloseEvent): void {
    const state = lifecycleStateForChildClose(close)
    const reason = lifecycleReasonForChildClose(close)
    const progress = mergeProgressFromClose(active.progress, close.progress)
    recordSkillParentTaskLifecycleEvent({
      scopeId: active.scopeId ?? undefined,
      sessionId: active.sessionId ?? undefined,
      skillId: active.skillId,
      action: active.action,
      state,
      reason,
      message: close.error?.message || closeMessage(close),
      stepId: childProjectionStepId(active.childRunId),
      outputDir: close.outputDir ?? active.outputDir,
      runStatePath: close.runStatePath ?? active.runStatePath,
      sceneScoresPath: close.sceneScoresPath,
      deliveryReportPath: close.deliveryReportPath,
      childRunId: active.childRunId,
      progressFingerprint: progress.fingerprint,
      progress,
    })
    this.upsertChildTaskProjection({
      active,
      state,
      reason,
      message: close.error?.message || closeMessage(close),
      progress,
      close,
    })
    this.publishScopeRunClose(active, close, {
      state,
      reason,
      message: close.error?.message || closeMessage(close),
      progress,
    })
  }

  private publishScopeRunClose(
    active: ActiveRun,
    close: SkillChildCloseEvent,
    args: {
      state: SkillParentTaskLifecycleState
      reason: SkillParentTaskLifecycleReason
      message: string
      progress: ScopeRunSkillProgress
    },
  ): void {
    const publish = this.config.publishScopeRunEvent
    if (!publish) return
    const scopeId = active.scopeId || active.sessionId
    if (!scopeId) return
    const taskId = childTaskProjectionTaskId(active.childRunId)
    const now = new Date().toISOString()
    const snapshot = buildChildTaskProjectionRecord({
      active,
      state: args.state,
      reason: args.reason,
      message: args.message,
      progress: args.progress,
      close,
      scopeId,
      taskId,
      previous: null,
      now,
    })
    const terminalReason = turnTerminalReasonFromChildClose(close)
    try {
      publish({
        type: 'finished',
        scopeId,
        agent: 'assistant',
        runId: active.childRunId,
        taskId,
        taskProjectionId: taskId,
        phase: scopeRunPhaseFromTerminalReason(terminalReason),
        terminalReason,
        module: 'skill',
        executionKind: 'job',
        taskTitle: snapshot.taskTitle || `技能子任务 · ${active.skillId}`,
        taskSummary: snapshot.taskSummary || args.message,
        taskType: snapshot.taskType,
        interactionState: snapshot.interactionState,
        steps: snapshot.steps.map((step) => ({
          id: step.id,
          title: step.title || step.description || '技能子任务',
          status: step.status || childProjectionStepStatusForState(args.state),
          detail: step.detail,
          updatedAt: step.updatedAt || now,
        })),
        currentStepId: snapshot.currentStepId,
        waitingFor: snapshot.waitingFor,
        resumableActions: snapshot.resumableActions,
        recentArtifacts: snapshot.recentArtifacts,
        artifactRefs: snapshot.recentArtifacts,
        taskContinuation: snapshot.continuationRef,
        progress: snapshot.progress,
        blockedReason: snapshot.blockedReason,
        error: snapshot.status === 'failed' ? args.message : undefined,
        timestamp: now,
      })
    } catch (error) {
      logAgentMetric('skill_child_scope_run_event_publish_failed', {
        childRunId: active.childRunId,
        error: errorMessage(error),
      })
    }
  }

  private upsertChildTaskProjection(args: {
    active: ActiveRun
    state: SkillParentTaskLifecycleState
    reason: SkillParentTaskLifecycleReason
    message: string
    progress: ScopeRunSkillProgress
    close?: SkillChildCloseEvent | null
  }): void {
    const store = this.config.taskProjectionStore
    if (!store) return
    const scopeId = args.active.scopeId || args.active.sessionId
    if (!scopeId) return
    const taskId = childTaskProjectionTaskId(args.active.childRunId)
    const now = new Date().toISOString()
    const apply = (previous: TaskProjectionRecord | null): void => {
      const next = buildChildTaskProjectionRecord({
        active: args.active,
        state: args.state,
        reason: args.reason,
        message: args.message,
        progress: args.progress,
        close: args.close ?? null,
        scopeId,
        taskId,
        previous,
        now,
      })
      try {
        if (previous) {
          const result = store.update(taskId, next)
          if (isPromiseLike(result)) {
            result.catch((error) => this.logChildProjectionError('update', args.active.childRunId, error))
          }
          return
        }
        const result = store.create(next)
        if (isPromiseLike(result)) {
          result.catch(async (error) => {
            if (!isTaskProjectionUniqueRace(error)) {
              this.logChildProjectionError('create', args.active.childRunId, error)
              return
            }
            const raced = await store.get(taskId)
            if (!raced) return
            await store.update(taskId, buildChildTaskProjectionRecord({
              active: args.active,
              state: args.state,
              reason: args.reason,
              message: args.message,
              progress: args.progress,
              close: args.close ?? null,
              scopeId,
              taskId,
              previous: raced,
              now,
            }))
          })
        }
      } catch (error) {
        if (!previous && isTaskProjectionUniqueRace(error)) {
          const raced = store.get(taskId)
          if (isPromiseLike(raced)) {
            void raced.then((record) => {
              if (!record) return
              return store.update(taskId, buildChildTaskProjectionRecord({
                active: args.active,
                state: args.state,
                reason: args.reason,
                message: args.message,
                progress: args.progress,
                close: args.close ?? null,
                scopeId,
                taskId,
                previous: record,
                now,
              }))
            }).catch((raceError) => this.logChildProjectionError('race_update', args.active.childRunId, raceError))
          } else if (raced) {
            try {
              const result = store.update(taskId, buildChildTaskProjectionRecord({
                active: args.active,
                state: args.state,
                reason: args.reason,
                message: args.message,
                progress: args.progress,
                close: args.close ?? null,
                scopeId,
                taskId,
                previous: raced,
                now,
              }))
              if (isPromiseLike(result)) {
                result.catch((raceError) => this.logChildProjectionError('race_update', args.active.childRunId, raceError))
              }
            } catch (raceError) {
              this.logChildProjectionError('race_update', args.active.childRunId, raceError)
            }
          }
          return
        }
        this.logChildProjectionError(previous ? 'update' : 'create', args.active.childRunId, error)
      }
    }

    try {
      const previous = store.get(taskId)
      if (isPromiseLike(previous)) {
        void previous.then(apply).catch((error) => this.logChildProjectionError('get', args.active.childRunId, error))
      } else {
        apply(previous)
      }
    } catch (error) {
      this.logChildProjectionError('get', args.active.childRunId, error)
    }
  }

  private logChildProjectionError(phase: string, childRunId: string, error: unknown): void {
    logAgentMetric('skill_child_projection_persist_failed', {
      phase,
      childRunId,
      error: errorMessage(error),
    })
  }

  private summaryFromActive(active: ActiveRun): ChildRunSummary {
    return {
      childRunId: active.childRunId,
      skillId: active.skillId,
      sessionId: active.sessionId,
      scopeId: active.scopeId,
      status: active.status,
      startedAt: active.startedAt,
      outputDir: active.outputDir,
      runStatePath: active.runStatePath,
      progress: { ...active.progress },
      blockedReason: active.blockedReason,
      liveness: 'background',
      closeStatus: null,
    }
  }

  private summaryFromClose(active: ActiveRun, close: SkillChildCloseEvent): ChildRunSummary {
    const progress = mergeProgressFromClose(active.progress, close.progress)
    return {
      childRunId: active.childRunId,
      skillId: active.skillId,
      sessionId: active.sessionId,
      scopeId: active.scopeId,
      status: close.status,
      startedAt: active.startedAt,
      outputDir: close.outputDir ?? active.outputDir,
      runStatePath: close.runStatePath ?? active.runStatePath,
      progress,
      blockedReason: close.error?.message || progress.lastError || null,
      liveness: null,
      closeStatus: close.status,
    }
  }

  private rememberChildRunSummary(summary: ChildRunSummary): void {
    this.recentSummaries.set(summary.childRunId, {
      ...summary,
      progress: { ...summary.progress },
    })
    if (this.recentSummaries.size > 64) {
      const firstKey = this.recentSummaries.keys().next().value
      if (firstKey) this.recentSummaries.delete(firstKey)
    }
  }

  private async finalizeRun(active: ActiveRun, close: SkillChildCloseEvent): Promise<void> {
    // Identity guard — only the lifecycle that owns the current `active` map
    // entry may finalize. Two protections in one:
    //   1. Same-lifecycle race (abort + driver throw): the second call sees
    //      `active.get(id)` returning undefined (first call deleted) and bails.
    //   2. Cross-lifecycle resume: the previous lifecycle's ActiveRun is no
    //      longer in the map (replaced by the resumed one), so its delayed
    //      finalize bails out without overwriting the new lifecycle's state.
    if (this.active.get(active.childRunId) !== active) {
      return
    }
    const frozenClose = freezeSkillChildCloseEvent(close as MutableSkillChildCloseEvent)
    // Stage T (W9.1) — Worker Event Ledger. Tag the terminal close event
    // with `event_kind` + `terminal_reason`; on cancel, also fill
    // `rollback_target` from the active run's `lastSafeStepId` (`null` if
    // no action ever completed). Diagnostic field only — finalize does
    // NOT trigger any rollback action.
    const ledger = deriveCloseEventLedgerKind(frozenClose)
    const isCancelTerminal = frozenClose.terminalReason === 'cancelled_user'
    // Round-1 (Codex) fix — await the ledger append BEFORE resolving the
    // close awaiters. Previously this was `void this.appendEvent(...)` then
    // an immediate `active.resolveClose(...)` at the bottom, which let
    // close-promise consumers proceed before the terminal close record
    // hit the JSONL ledger. Awaiting it here closes the ordering gap;
    // resolveClose at the end of this method now fires only after the
    // ledger, repository write, projection publish, and retained-lifecycle
    // write are all settled.
    await this.appendEvent(active, {
      type: 'close',
      at: new Date().toISOString(),
      ts: Date.now(),
      event_kind: ledger.event_kind,
      terminal_reason: frozenClose.terminalReason,
      // cancel branch: emit rollback_target only on cancelled terminal.
      ...(isCancelTerminal ? { rollback_target: active.lastSafeStepId ?? null } : {}),
      close: frozenClose,
    })
    try {
      this.config.repository.updateChildRun(active.childRunId, {
        status: frozenClose.status,
        closeEvent: frozenClose,
      })
      this.markChildRunInteractionSuspended(active.childRunId)
    } catch (error) {
      logAgentMetric('skill_child_runner_finalize_failed', {
        childRunId: active.childRunId,
        error: errorMessage(error),
      })
    }
    this.publishProjectionClose(active, frozenClose)
    this.rememberChildRunSummary(this.summaryFromClose(active, frozenClose))
    // Delete the active entry BEFORE recordCloses + resolveClose so any
    // re-entrant finalize attempt (or a downstream lookup that races
    // resolveClose) cannot find this lifecycle's `active` and accidentally
    // double-resolve or overwrite a freshly-resumed lifecycle's state.
    this.active.delete(active.childRunId)
    this.recentCloses.set(active.childRunId, frozenClose)
    if (this.recentCloses.size > 64) {
      // Drop oldest. JS Maps preserve insertion order.
      const firstKey = this.recentCloses.keys().next().value
      if (firstKey) this.recentCloses.delete(firstKey)
    }
    if (shouldCountChildRunCircuitBreakerFailure(frozenClose)) {
      const breakerResult = this.circuitBreaker.recordFailure(active.singleFlightKey)
      if (breakerResult.opened) {
        logAgentMetric(TOOL_ERROR_METRICS.childRunCircuitBreak, {
          phase: 'opened',
          childRunId: active.childRunId,
          skillId: active.skillId,
          singleFlightKey: active.singleFlightKey,
          cooldownUntil: breakerResult.cooldownUntil
            ? new Date(breakerResult.cooldownUntil).toISOString()
            : null,
        })
      }
    }
    this.writeRetainedLifecycle(active, frozenClose)
    active.resolveClose(frozenClose)
  }

  private persistTerminalClose(childRunId: string, close: SkillChildCloseEvent): void {
    const frozenClose = freezeSkillChildCloseEvent(close as MutableSkillChildCloseEvent)
    try {
      this.config.repository.updateChildRun(childRunId, {
        status: frozenClose.status,
        closeEvent: frozenClose,
      })
      this.markChildRunInteractionSuspended(childRunId)
    } catch {
      // best effort
    }
    this.recentCloses.set(childRunId, frozenClose)
  }

  private publishInactiveChildRunClose(args: {
    record: ReturnType<SkillTaskRunRepository['get']>
    payload: SkillChildRunPayload | null | undefined
    close: SkillChildCloseEvent
  }): void {
    const record = args.record
    const payload = args.payload
    const scopeId = payload?.parentScopeId ?? record?.scopeId ?? record?.sessionId ?? null
    if (!scopeId) return
    const skillId = payload?.skillId ?? record?.skillId ?? args.close.skillId
    const action = payload?.requestedAction ?? record?.action ?? 'unknown'
    const outputDir = args.close.outputDir ?? payload?.outputDir ?? record?.outputDir ?? ''
    const runStatePath = args.close.runStatePath ?? payload?.runStatePath ?? record?.runStatePath ?? ''
    const active: ActiveRun = {
      childRunId: args.close.childRunId,
      skillId,
      action,
      scopeId,
      sessionId: payload?.parentSessionId ?? record?.sessionId ?? null,
      status: args.close.status,
      startedAt: record?.createdAt ?? record?.updatedAt ?? new Date().toISOString(),
      controller: new AbortController(),
      closePromise: Promise.resolve(args.close),
      resolveClose: () => {},
      outputDir,
      runStatePath,
      eventLogPath: payload?.eventLogPath ?? (record ? this.deriveEventLogPathFromRecord(record) : ''),
      parentNextHint: payload?.parentNextHint ?? 'wait_for_close_event',
      singleFlightKey: payload?.singleFlightKey ?? `${scopeId}:${skillId}:${args.close.childRunId}`,
      agentContext: null,
      progress: emptyChildProgress(),
      blockedReason: null,
      lastSafeStepId: null,
    }
    const state = lifecycleStateForChildClose(args.close)
    const reason = lifecycleReasonForChildClose(args.close)
    const message = args.close.error?.message || closeMessage(args.close)
    const taskId = childTaskProjectionTaskId(args.close.childRunId)
    const now = new Date().toISOString()
    const store = this.config.taskProjectionStore
    const publish = (previous: TaskProjectionRecord | null): void => {
      const progress = mergeProgressFromClose(previous?.progress ?? emptyChildProgress(), args.close.progress)
      active.progress = progress
      recordSkillParentTaskLifecycleEvent({
        scopeId,
        sessionId: active.sessionId ?? undefined,
        skillId,
        action,
        state,
        reason,
        message,
        stepId: childProjectionStepId(args.close.childRunId),
        outputDir,
        runStatePath,
        sceneScoresPath: args.close.sceneScoresPath,
        deliveryReportPath: args.close.deliveryReportPath,
        childRunId: args.close.childRunId,
        progressFingerprint: progress.fingerprint,
        progress,
      })
      if (store) {
        const next = buildChildTaskProjectionRecord({
          active,
          state,
          reason,
          message,
          progress,
          close: args.close,
          scopeId,
          taskId,
          previous,
          now,
        })
        if (previous) {
          store.update(taskId, next)
        } else {
          store.create(next)
        }
        this.updateInactiveChildRunProjectionSiblings({
          store,
          active,
          state,
          reason,
          message,
          progress,
          close: args.close,
          scopeId,
          canonicalTaskId: taskId,
          now,
        })
      }
      this.publishScopeRunClose(active, args.close, {
        state,
        reason,
        message,
        progress,
      })
      this.rememberChildRunSummary(this.summaryFromClose(active, args.close))
    }
    if (!store) {
      publish(null)
      return
    }
    const previous = store.get(taskId)
    if (isPromiseLike(previous)) {
      void previous.then(publish).catch((error) => this.logChildProjectionError('inactive_cancel_get', args.close.childRunId, error))
      return
    }
    publish(previous)
  }

  private updateInactiveChildRunProjectionSiblings(args: {
    store: TaskProjectionStore
    active: ActiveRun
    state: SkillParentTaskLifecycleState
    reason: SkillParentTaskLifecycleReason
    message: string
    progress: ScopeRunSkillProgress
    close: SkillChildCloseEvent
    scopeId: string
    canonicalTaskId: string
    now: string
  }): void {
    const update = (records: TaskProjectionRecord[]): void => {
      for (const previous of records) {
        if (previous.taskId === args.canonicalTaskId) continue
        if (!taskProjectionReferencesChildRun(previous, args.active.childRunId)) continue
        if (isTerminalTaskProjectionStatus(previous.status)) continue
        const next = buildChildTaskProjectionRecord({
          active: args.active,
          state: args.state,
          reason: args.reason,
          message: args.message,
          progress: args.progress,
          close: args.close,
          scopeId: args.scopeId,
          taskId: previous.taskId,
          previous,
          now: args.now,
        })
        args.store.update(previous.taskId, next)
      }
    }
    try {
      const records = args.store.listByScope(args.scopeId)
      if (isPromiseLike(records)) {
        void records.then(update).catch((error) => this.logChildProjectionError('inactive_cancel_siblings', args.active.childRunId, error))
        return
      }
      update(records)
    } catch (error) {
      this.logChildProjectionError('inactive_cancel_siblings', args.active.childRunId, error)
    }
  }

  private markChildRunInteractionSuspended(childRunId: string): void {
    try {
      this.config.repository.update(childRunId, {
        interactionState: 'suspended',
      })
    } catch {
      // The close payload is the source of truth; interaction state cleanup is best effort.
    }
  }

  private countActiveVeaRuns(): number {
    let count = 0
    for (const run of this.active.values()) {
      if (run.skillId === 'video-expert-analyzer') count += 1
    }
    return count
  }

  private deriveEventLogPathFromRecord(record: {
    resumePayload?: unknown
    outputDir?: string | null
    id: string
    createdAt?: string | null
  }): string {
    const payload = (record.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
    if (payload?.eventLogPath) return payload.eventLogPath
    const createdAtMs = record.createdAt ? Date.parse(record.createdAt) : null
    const runtimePath = deriveRuntimeChildRunLogPath(
      this.config.runtimeManager.getRuntimeInfo().runtimeRoot,
      record.id,
    )
    if (isNonEmptyFileForRecordSync(runtimePath, createdAtMs)) return runtimePath
    if (record.outputDir) {
      const legacyPath = deriveLegacyChildRunLogPath(record.outputDir, record.id)
      if (isNonEmptyFileForRecordSync(legacyPath, createdAtMs)) return legacyPath
    }
    return ''
  }

  private writeRetainedLifecycle(active: ActiveRun, close: SkillChildCloseEvent): void {
    if (!isRetainedLifecycleChildCloseStatus(close.status)) {
      return
    }
    const terminalAt = new Date().toISOString()
    try {
      writeLifecycle(active.outputDir, {
        state: 'retained',
        childRunId: active.childRunId,
        skillId: active.skillId,
        terminalAt,
        terminalReason: close.terminalReason,
        retainUntil: new Date(
          Date.parse(terminalAt) + getOutputDirRetentionDays() * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
    } catch (error) {
      logAgentMetric(TOOL_ERROR_METRICS.childRunnerLifecycleWriteFailed, {
        childRunId: active.childRunId,
        error: errorMessage(error),
      })
    }
  }
}

// =====================================================================
// Singleton plumbing — Team 6 imports the bare functions.
// =====================================================================

let runnerInstance: SkillChildRunner | null = null

export const __breaksInvariants = [
  'singleton.skill-child-runner.never-reset-mid-session',
] as const

export function configureSkillChildRunner(config: SkillChildRunnerConfig): SkillChildRunner {
  runnerInstance = new SkillChildRunner(config)
  return runnerInstance
}

export function getSkillChildRunner(): SkillChildRunner | null {
  return runnerInstance
}

/** Test-only — drop the singleton so the next configure call starts
 *  fresh and the global `active` map is empty. */
export function __resetSkillChildRunnerForTests(): void {
  runnerInstance = null
}

export async function startSkillChildRun(
  params: StartSkillChildRunParams,
): Promise<StartSkillChildRunResult> {
  const runner = ensureRunner()
  return runner.startSkillChildRun(params)
}

export async function resumeSkillChildRun(
  childRunId: string,
  options?: ResumeSkillChildRunOptions,
): Promise<StartSkillChildRunResult> {
  const runner = ensureRunner()
  return runner.resumeSkillChildRun(childRunId, options)
}

export async function cancelSkillChildRun(
  childRunId: string,
  reasonOrOptions?: string | CancelSkillChildRunOptions,
): Promise<SkillChildCloseEvent> {
  const runner = ensureRunner()
  return runner.cancelSkillChildRun(childRunId, reasonOrOptions)
}

export function getSkillChildRunCloseEvent(childRunId: string): SkillChildCloseEvent | null {
  const runner = runnerInstance
  if (!runner) return null
  return runner.getCloseEvent(childRunId)
}

export function waitForSkillChildRunClose(
  childRunId: string,
  options: WaitForSkillChildRunCloseOptions,
): Promise<ChildWaitResult> {
  const runner = ensureRunner()
  return runner.waitForClose(childRunId, options)
}

export { isChildOwnedSkill }

function ensureRunner(): SkillChildRunner {
  if (!runnerInstance) {
    throw new Error(
      'SkillChildRunner not configured. Call configureSkillChildRunner({ runtimeManager, repository }) during boot.',
    )
  }
  return runnerInstance
}

// =====================================================================
// Internal helpers
// =====================================================================

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emptyChildProgress(): ScopeRunSkillProgress {
  return {
    stage: null,
    completed: null,
    total: null,
    coverage: null,
    overallCoverage: null,
    fingerprint: null,
    updatedAt: null,
    lastError: null,
  }
}

function childProjectionStepId(childRunId: string): string {
  return `child_run:${childRunId}`
}

function childTaskProjectionTaskId(childRunId: string): string {
  return `skill-child:${childRunId}`
}

function taskProjectionReferencesChildRun(record: TaskProjectionRecord, childRunId: string): boolean {
  const ref = record.continuationRef as { childRunId?: unknown } | null | undefined
  return record.runId === childRunId
    || record.taskId === childTaskProjectionTaskId(childRunId)
    || ref?.childRunId === childRunId
}

function isTerminalTaskProjectionStatus(status: TaskProjectionRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === 'function')
}

/**
 * Stage T (W9.1) — Worker Event Ledger. Derive `event_kind` (and the
 * `cancelled` terminal trigger predicate) from a `SkillChildCloseEvent`.
 * Diagnostic-only — caller layers the result onto the JSONL `close`
 * event before append.
 */
function deriveCloseEventLedgerKind(
  close: SkillChildCloseEvent,
): { event_kind: 'cancelled' | 'completed' | 'failed'; isCancel: boolean } {
  if (close.terminalReason === 'cancelled_user') {
    return { event_kind: 'cancelled', isCancel: true }
  }
  if (isCompletedChildCloseStatus(close.status)) {
    return { event_kind: 'completed', isCancel: false }
  }
  // status: 'blocked' / 'failed' / 'killed' — all non-cancel terminal
  // outcomes map to 'failed' for ledger purposes.
  return { event_kind: 'failed', isCancel: false }
}

function isTaskProjectionUniqueRace(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : ''
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'SQLITE_CONSTRAINT'
    || /UNIQUE constraint failed: task_projections\.task_id/.test(message)
}

function childProjectionStatusForState(
  state: SkillParentTaskLifecycleState,
): TaskProjectionRecord['status'] {
  if (state === 'background_running') return 'running'
  if (state === 'budget_paused' || state === 'blocked') return 'blocked'
  if (state === 'failed') return 'failed'
  if (state === 'cancelled') return 'killed'
  return 'completed'
}

function childProjectionStepStatusForState(state: SkillParentTaskLifecycleState): NonNullable<TaskStep['status']> {
  if (state === 'background_running') return 'running'
  if (state === 'budget_paused' || state === 'blocked') return 'blocked'
  if (state === 'failed' || state === 'cancelled') return 'error'
  return 'done'
}

function childProjectionWaitingForState(state: SkillParentTaskLifecycleState): TaskProjectionRecord['waitingFor'] {
  if (state === 'background_running' || state === 'budget_paused') return 'background'
  if (state === 'blocked') return 'input'
  return 'none'
}

function childProjectionActionsForStatus(
  status: TaskProjectionRecord['status'],
): ScopeRunResumableAction[] {
  if (status === 'running' || status === 'blocked') return ['continue', 'cancel']
  if (status === 'failed') return ['retry', 'cancel']
  if (status === 'completed') return ['open_artifact']
  return ['none']
}

function turnTerminalReasonFromChildClose(close: SkillChildCloseEvent): NonNullable<ScopeRunEventPayload['terminalReason']> {
  if (isCompletedChildCloseStatus(close.status)) return 'done'
  if (isKilledChildCloseStatus(close.status)) return close.terminalReason === 'cancelled_user'
    ? 'cancelled_user'
    : 'cancelled_runtime'
  switch (close.terminalReason) {
    case 'checkpoint_budget':
      return 'checkpoint_budget'
    case 'checkpoint_background':
    case 'queued_global_concurrency':
    case 'launch_stuck':
    case 'process_restarted':
      return 'checkpoint_background'
    case 'blocked_config':
      return 'blocked_config'
    case 'blocked_external':
      return 'blocked_external'
    case 'cancelled_user':
      return 'cancelled_user'
    case 'failed_skill':
    case 'child_process_crashed':
    case 'host_unavailable':
    case 'nested_child_run_not_supported':
      return 'failed_skill'
    case 'resume_launch_failed':
      return 'resume_launch_failed'
    case 'persistence_failed':
      return 'persistence_failed'
    case 'tool_not_registered':
    case 'input_validation':
      return 'blocked_tool_error'
    case 'completed':
      return 'done'
    default:
      return 'checkpoint_user_input'
  }
}

function scopeRunPhaseFromTerminalReason(
  terminalReason: NonNullable<ScopeRunEventPayload['terminalReason']>,
): ScopeRunEventPayload['phase'] {
  if (terminalReason === 'done') return 'done'
  if (terminalReason === 'cancelled_user' || terminalReason === 'cancelled_runtime') return 'cancelled'
  if (
    terminalReason === 'failed_skill'
    || terminalReason === 'resume_launch_failed'
    || terminalReason === 'persistence_failed'
    || terminalReason === 'blocked_tool_error'
  ) {
    return 'error'
  }
  return 'checkpoint'
}

function childProjectionArtifacts(args: {
  active: ActiveRun
  close?: SkillChildCloseEvent | null
  now: string
}): NonNullable<TaskProjectionRecord['recentArtifacts']> {
  const outputDir = args.close?.outputDir ?? args.active.outputDir
  const runStatePath = args.close?.runStatePath ?? args.active.runStatePath
  const sceneScoresPath = args.close?.sceneScoresPath ?? null
  const inferredDeliveryReportPath = outputDir ? join(outputDir, 'delivery_report.json') : null
  const deliveryReportPath = args.close?.deliveryReportPath
    ?? (inferredDeliveryReportPath && existsSync(inferredDeliveryReportPath) ? inferredDeliveryReportPath : null)
  const items = [
    outputDir
      ? { key: 'outputDir', path: outputDir, label: '输出目录', kind: 'output_dir' }
      : null,
    runStatePath
      ? { key: 'runStatePath', path: runStatePath, label: 'run_state.json', kind: 'run_state' }
      : null,
    sceneScoresPath
      ? { key: 'sceneScoresPath', path: sceneScoresPath, label: 'scene_scores.json', kind: 'scene_scores' }
      : null,
    deliveryReportPath
      ? { key: 'deliveryReportPath', path: deliveryReportPath, label: 'delivery_report.json', kind: 'delivery_report' }
      : null,
  ].filter((item): item is { key: string; path: string; label: string; kind: string } => Boolean(item))

  return items.map((item) => ({
    id: `${args.active.childRunId}:${item.key}`,
    module: 'skill',
    kind: item.kind,
    label: item.label,
    path: item.path,
    createdAt: args.now,
    meta: {
      outputKey: item.key,
      childRunId: args.active.childRunId,
      skillId: args.active.skillId,
      action: args.active.action,
      outputDir,
      runStatePath,
      ...(deliveryReportPath ? { deliveryReportPath } : {}),
    },
  }))
}

function buildChildTaskProjectionRecord(args: {
  active: ActiveRun
  state: SkillParentTaskLifecycleState
  reason: SkillParentTaskLifecycleReason
  message: string
  progress: ScopeRunSkillProgress
  close: SkillChildCloseEvent | null
  scopeId: string
  taskId: string
  previous: TaskProjectionRecord | null
  now: string
}): TaskProjectionRecord {
  const status = childProjectionStatusForState(args.state)
  const stepId = childProjectionStepId(args.active.childRunId)
  const outputDir = args.close?.outputDir ?? args.active.outputDir
  const runStatePath = args.close?.runStatePath ?? args.active.runStatePath
  const step: TaskStep = {
    id: stepId,
    title: '技能子任务',
    description: args.message,
    status: childProjectionStepStatusForState(args.state),
    detail: args.message,
    updatedAt: args.now,
  }
  const previousSteps = (args.previous?.steps || []).filter((item) => item.id !== stepId)
  return {
    taskId: args.taskId,
    scopeId: args.scopeId,
    runId: args.active.childRunId,
    parentTaskId: args.previous?.parentTaskId ?? null,
    parentStepId: args.previous?.parentStepId ?? null,
    taskType: args.previous?.taskType ?? 'short_task',
    module: 'skill',
    taskTitle: args.previous?.taskTitle ?? `技能子任务 · ${args.active.skillId}`,
    taskSummary: args.message,
    status,
    interactionState: 'suspended',
    waitingFor: childProjectionWaitingForState(args.state),
    steps: [...previousSteps, step],
    currentStepId: stepId,
    budget: args.previous?.budget ?? null,
    budgetUsagePercent: args.previous?.budgetUsagePercent ?? null,
    budgetWarningLevel: args.previous?.budgetWarningLevel ?? null,
    recoveryHistory: args.previous?.recoveryHistory ?? [],
    degradationReason: args.previous?.degradationReason ?? null,
    blockedReason: status === 'blocked' || status === 'failed' ? args.message : null,
    resumableActions: childProjectionActionsForStatus(status),
    continuationRef: {
      ...(args.previous?.continuationRef || {}),
      taskId: args.taskId,
      stepId,
      blockerType: args.reason,
      todoId: stepId,
      todoTitle: '技能子任务',
      pauseReason: args.reason,
      childRunId: args.active.childRunId,
      skillId: args.active.skillId,
      action: args.active.action,
      outputDir,
      runStatePath,
      progressFingerprint: args.progress.fingerprint,
      progress: { ...args.progress },
    } as TaskProjectionRecord['continuationRef'] & { progress: ScopeRunSkillProgress },
    progress: { ...args.progress },
    recentArtifacts: childProjectionArtifacts({
      active: args.active,
      close: args.close,
      now: args.now,
    }),
    createdAt: args.previous?.createdAt ?? args.active.startedAt ?? args.now,
    updatedAt: args.now,
  }
}

function progressMessage(progress: ScopeRunSkillProgress): string {
  if (progress.detail) {
    return `技能任务进行中 · ${progress.detail}`
  }
  if (progress.stage && progress.completed !== null && progress.total !== null) {
    return `技能任务进行中 · ${progress.stage} · ${progress.completed}/${progress.total}`
  }
  if (progress.stage) return `技能任务进行中 · ${progress.stage}`
  return '技能任务进行中'
}

function sameProgress(left: ScopeRunSkillProgress, right: ScopeRunSkillProgress): boolean {
  return left.stage === right.stage
    && left.completed === right.completed
    && left.total === right.total
    && left.coverage === right.coverage
    && (left.overallCoverage ?? null) === (right.overallCoverage ?? null)
    && left.fingerprint === right.fingerprint
    && left.updatedAt === right.updatedAt
    && left.lastError === right.lastError
    && (left.detail ?? null) === (right.detail ?? null)
    && (left.activityUpdatedAt ?? null) === (right.activityUpdatedAt ?? null)
    && JSON.stringify(left.handoff ?? null) === JSON.stringify(right.handoff ?? null)
}

function requiresChildOwnedRunState(skillId: string, action: string): boolean {
  return skillId === 'video-expert-analyzer' && action === 'video_expert_pipeline'
}

function closeMessage(close: SkillChildCloseEvent): string {
  switch (close.status) {
    case 'completed':
      return '技能任务已完成'
    case 'blocked':
      return '技能任务等待继续处理'
    case 'failed':
      return '技能任务失败'
    case 'killed':
      return '技能任务已取消'
    case 'budget_paused':
    case 'recoverable_paused':
      return '技能任务已暂停，可继续执行'
  }
}

function lifecycleStateForChildClose(
  close: SkillChildCloseEvent,
): 'background_running' | 'budget_paused' | 'blocked' | 'done' | 'failed' | 'cancelled' {
  switch (close.status) {
    case 'completed':
      return 'done'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'cancelled'
    case 'budget_paused':
    case 'recoverable_paused':
      return 'budget_paused'
  }
}

function lifecycleReasonForChildClose(
  close: SkillChildCloseEvent,
): 'background_running' | 'background_handoff' | 'budget_exhausted' | 'recoverable_paused' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'primitive_observation' | 'supervisor_close' {
  switch (close.status) {
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'cancelled'
    case 'budget_paused':
      return 'budget_exhausted'
    case 'recoverable_paused':
      return 'recoverable_paused'
  }
}

function readChildProgressSnapshot(args: {
  skillId: string
  childRunId: string
  strictChildRunId: boolean
  outputDir: string
  runStatePath: string
  payloadStage: string | null
  payloadFingerprint: string | null
  observedAt: string
  previous: ScopeRunSkillProgress
}): {
  outputDir: string
  runStatePath: string
  progress: ScopeRunSkillProgress
} {
  const selected = selectRunStateCandidate({
    explicitRunStatePath: args.runStatePath,
    rootDir: args.outputDir,
    expectedChildRunId: args.strictChildRunId ? args.childRunId : null,
    fileName: 'run_state.json',
    searchDepth: 1,
  })
  const selectedRunStatePath = selected.path || (args.strictChildRunId ? '' : args.runStatePath)
  const selectedOutputDir = selectedRunStatePath ? dirname(selectedRunStatePath) : args.outputDir
  const runState = readProgressRunState(selectedRunStatePath)
  const artifactProgress = inspectSkillProgressArtifacts({
    outputDir: selectedOutputDir,
    sceneScoresPath: selectedOutputDir ? join(selectedOutputDir, 'scene_scores.json') : null,
  })
  const stage = runState.stage ?? args.payloadStage ?? args.previous.stage
  const normalizedStage = String(stage || '').trim().toLowerCase()
  const preferRunStateUnits = normalizedStage === 'prepare'
  const completed = preferRunStateUnits
    ? (runState.completed ?? artifactProgress.completedScenes ?? args.previous.completed)
    : (artifactProgress.completedScenes ?? runState.completed ?? args.previous.completed)
  const total = preferRunStateUnits
    ? (runState.total ?? artifactProgress.totalScenes ?? args.previous.total)
    : (artifactProgress.totalScenes ?? runState.total ?? args.previous.total)
  const coverage = preferRunStateUnits
    ? (runState.coverage ?? artifactProgress.coverageRatio ?? args.previous.coverage)
    : (artifactProgress.coverageRatio ?? runState.coverage ?? args.previous.coverage)
  const activity = artifactProgress.activity
  const handoff = artifactProgress.handoff ?? null
  const handoffDetail = artifactProgress.handoffDetail ?? null
  const activityCoverage = activityCoverageRatio(activity)
  const shouldUseActivityDetail = !stage || String(stage).toLowerCase() === 'score_batches'
  const activityDetail = (shouldUseActivityDetail || handoffDetail)
    ? formatArtifactActivityDetail(activity)
    : null
  const detail = [activityDetail, handoffDetail].filter((item): item is string => Boolean(item)).join('；') || null
  const activityUpdatedAt = activity?.updatedAt ?? args.previous.activityUpdatedAt ?? null
  const runCompleted = isProgressCompleteStatus(runState.status) || isProgressCompleteStatus(stage)
  const lastError = runCompleted ? null : (runState.lastError ?? args.previous.lastError)
  const overallCoverage = deriveOverallCoverage({
    skillId: args.skillId,
    outputDir: selectedOutputDir,
    status: runState.status,
    stage,
    completed,
    total,
    coverage,
    activityCoverage,
    previous: args.previous.overallCoverage ?? null,
  })
  const updatedAt = latestIso(runState.updatedAt, activityUpdatedAt) ?? args.previous.updatedAt ?? args.observedAt
  const fingerprint = args.payloadFingerprint
    ?? activity?.fingerprint
    ?? runState.fingerprint
    ?? buildChildProgressFingerprint({ stage, completed, total, coverage, overallCoverage, updatedAt, detail, activityUpdatedAt })
    ?? args.previous.fingerprint
  return {
    outputDir: selectedOutputDir,
    runStatePath: selectedRunStatePath,
    progress: {
      stage,
      completed,
      total,
      coverage,
      overallCoverage,
      fingerprint,
      updatedAt,
      lastError,
      ...(detail ? { detail } : {}),
      ...(activityUpdatedAt ? { activityUpdatedAt } : {}),
      handoff,
    },
  }
}

function isProgressCompleteStatus(value: string | null | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'success'
}

function buildChildProgressFingerprint(args: {
  stage: string | null
  completed: number | null
  total: number | null
  coverage: number | null
  overallCoverage?: number | null
  updatedAt: string | null
  detail?: string | null
  activityUpdatedAt?: string | null
}): string | null {
  if (
    !args.stage
    && args.completed === null
    && args.total === null
    && args.coverage === null
    && args.overallCoverage === null
    && !args.updatedAt
    && !args.detail
    && !args.activityUpdatedAt
  ) {
    return null
  }
  const parts = [
    args.stage ?? '',
    args.completed ?? '',
    args.total ?? '',
    args.coverage ?? '',
    args.overallCoverage ?? '',
    args.updatedAt ?? '',
  ]
  if (args.detail || args.activityUpdatedAt) {
    parts.push(args.detail ?? '', args.activityUpdatedAt ?? '')
  }
  return parts.join('|')
}

function clampRatio(value: number | null | undefined): number | null {
  if (!Number.isFinite(Number(value))) return null
  return Math.max(0, Math.min(1, Number(value)))
}

function stageRatio(args: {
  completed: number | null
  total: number | null
  coverage: number | null
  activityCoverage?: number | null
}): number | null {
  const coverage = clampRatio(args.coverage)
  const activityCoverage = clampRatio(args.activityCoverage)
  if (coverage !== null || activityCoverage !== null) {
    return Math.max(coverage ?? 0, activityCoverage ?? 0)
  }
  if (args.total && args.total > 0 && args.completed !== null) {
    return clampRatio(args.completed / args.total)
  }
  return null
}

function readObjectJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function isVeaDeliveryComplete(outputDir: string): boolean {
  const report = readObjectJson(join(outputDir, 'delivery_report.json'))
  const status = String(report?.status || '').toLowerCase()
  if (status !== 'completed' && status !== 'complete' && status !== 'success') return false
  const requiredOutputs = report?.required_outputs
  if (!requiredOutputs || typeof requiredOutputs !== 'object' || Array.isArray(requiredOutputs)) return true
  for (const value of Object.values(requiredOutputs as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if ((value as Record<string, unknown>).ok === false) return false
  }
  return true
}

function isVeaFinalizeResumeCandidate(skillId: string, outputDir: string): boolean {
  if (skillId !== 'video-expert-analyzer') return false
  if (isVeaDeliveryComplete(outputDir)) return false
  const state = readProgressRunState(join(outputDir, 'run_state.json'))
  return state.status === 'blocked' && state.stage === 'finalize'
}

function deriveVeaOverallCoverage(args: {
  outputDir: string
  status: string | null | undefined
  stage: string | null
  completed: number | null
  total: number | null
  coverage: number | null
  activityCoverage?: number | null
  previous: number | null
}): number | null {
  const status = String(args.status || '').toLowerCase()
  const stage = String(args.stage || '').toLowerCase()
  if (status === 'completed' || stage === 'completed' || isVeaDeliveryComplete(args.outputDir)) return 1
  const ratio = stage === 'prepare' && args.total && args.total > 0 && args.completed !== null
    ? clampRatio(args.completed / args.total) ?? 0
    : stageRatio(args) ?? 0
  let overall: number | null = null
  if (stage === 'prepare') {
    overall = ratio * 0.2
  } else if (stage === 'score_batches') {
    overall = 0.2 + ratio * 0.65
  } else if (stage === 'merge_validate') {
    overall = 0.85 + ratio * 0.05
  } else if (stage === 'finalize') {
    overall = listPendingSkillHandoffTasks(args.outputDir).length > 0
      ? 0.92
      : Math.min(0.98, 0.9 + ratio * 0.08)
  }
  if (overall === null) return args.previous
  const clamped = Math.round(Math.max(0, Math.min(1, overall)) * 10_000) / 10_000
  return args.previous === null ? clamped : Math.max(args.previous, clamped)
}

function deriveOverallCoverage(args: {
  skillId: string
  outputDir: string
  status: string | null | undefined
  stage: string | null
  completed: number | null
  total: number | null
  coverage: number | null
  activityCoverage?: number | null
  previous: number | null
}): number | null {
  if (args.skillId === 'video-expert-analyzer') {
    return deriveVeaOverallCoverage(args)
  }
  return args.previous ?? stageRatio(args)
}

function readProgressRunState(runStatePath: string | null): Partial<ScopeRunSkillProgress> & { status?: string | null } {
  if (!runStatePath) return {}
  try {
    const parsed = parseRunStateJson(readFileSync(runStatePath, 'utf8'), { path: runStatePath, emitMetric: true })
    if (!parsed.ok) return {}
    const rec = parsed.value.raw
    return {
      status: pickString(rec.status),
      stage: pickString(rec.current_stage)
        ?? pickString(rec.currentStage)
        ?? pickString(rec.current_step)
        ?? pickString(rec.currentStep),
      completed: pickNumber(rec.completed_scenes ?? rec.completedScenes ?? rec.completed),
      total: pickNumber(rec.total_scenes ?? rec.totalScenes ?? rec.total),
      coverage: pickNumber(rec.coverage_ratio ?? rec.coverageRatio ?? rec.coverage),
      fingerprint: pickString(rec.fingerprint ?? rec.progress_fingerprint ?? rec.progressFingerprint),
      updatedAt: pickString(rec.updated_at ?? rec.updatedAt ?? rec.lastUpdated),
      lastError: pickString(rec.last_error ?? rec.lastError ?? rec.error),
    }
  } catch {
    return {}
  }
}

function latestIso(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null
  if (!right) return left
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (!Number.isFinite(leftMs)) return right
  if (!Number.isFinite(rightMs)) return left
  return rightMs > leftMs ? right : left
}

function activityCoverageRatio(activity: ReturnType<typeof inspectSkillProgressArtifacts>['activity']): number | null {
  if (!activity || activity.totalUnits <= 0) return null
  return clampRatio(activity.completedUnits / activity.totalUnits)
}

function formatArtifactActivityDetail(activity: ReturnType<typeof inspectSkillProgressArtifacts>['activity']): string | null {
  if (!activity) return null
  if (activity.unitLabel === 'batch') {
    const sceneText = activity.estimatedCompletedScenes !== undefined && activity.totalScenes !== undefined
      ? `，约 ${activity.estimatedCompletedScenes}/${activity.totalScenes} 场景`
      : ''
    return `评分批次 ${activity.completedUnits}/${activity.totalUnits}${sceneText}`
  }
  return activity.summary || `${activity.completedUnits}/${activity.totalUnits} ${activity.unitLabel}`
}

function toCloseProgress(progress: ScopeRunSkillProgress): SkillChildCloseEvent['progress'] {
  return {
    stage: progress.stage,
    completedUnits: progress.completed,
    totalUnits: progress.total,
    coverageRatio: progress.coverage,
    overallCoverageRatio: progress.overallCoverage ?? null,
    fingerprint: progress.fingerprint,
  }
}

function mergeProgressFromClose(
  previous: ScopeRunSkillProgress,
  closeProgress: SkillChildCloseEvent['progress'],
): ScopeRunSkillProgress {
  return {
    stage: closeProgress.stage ?? previous.stage,
    completed: closeProgress.completedUnits ?? previous.completed,
    total: closeProgress.totalUnits ?? previous.total,
    coverage: closeProgress.coverageRatio ?? previous.coverage,
    overallCoverage: closeProgress.overallCoverageRatio ?? previous.overallCoverage ?? null,
    fingerprint: closeProgress.fingerprint ?? previous.fingerprint,
    updatedAt: previous.updatedAt,
    lastError: previous.lastError,
    ...(previous.detail ? { detail: previous.detail } : {}),
    ...(previous.activityUpdatedAt ? { activityUpdatedAt: previous.activityUpdatedAt } : {}),
  }
}

function mergeCloseWithLastProgress(
  close: SkillChildCloseEvent,
  progress: ScopeRunSkillProgress,
): SkillChildCloseEvent {
  const mergedProgress = toCloseProgress(mergeProgressFromClose(progress, close.progress))
  if (
    mergedProgress.stage === close.progress.stage
    && mergedProgress.completedUnits === close.progress.completedUnits
    && mergedProgress.totalUnits === close.progress.totalUnits
    && mergedProgress.coverageRatio === close.progress.coverageRatio
    && mergedProgress.fingerprint === close.progress.fingerprint
  ) {
    return close
  }
  return freezeSkillChildCloseEvent({
    ...(close as MutableSkillChildCloseEvent),
    progress: mergedProgress,
  })
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function pickNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function waitForClosePromise(
  childRunId: string,
  closePromise: Promise<SkillChildCloseEvent> | null,
  options: WaitForSkillChildRunCloseOptions,
): Promise<ChildWaitResult> {
  if (options.signal?.aborted) {
    return Promise.reject(makeAbortError(options.signal.reason))
  }
  const timeoutMs = normalizeObserverTimeoutMs(options.timeoutMs)

  return new Promise<ChildWaitResult>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const startedAt = Date.now()
    const onAbort = () => finish(() => reject(makeAbortError(options.signal?.reason)))
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      disposeTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      complete()
    }

    if (closePromise) {
      closePromise.then((close) => {
        finish(() => resolve({
          kind: 'closed',
          childRunId,
          closeEvent: close,
        }))
      }, (error) => {
        finish(() => reject(error))
      })
    } else if (timeoutMs === null) {
      finish(() => resolve({
        kind: 'observer_timeout',
        childRunId,
        elapsedMs: 0,
      }))
      return
    }

    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        finish(() => resolve({
          kind: 'observer_timeout',
          childRunId,
          elapsedMs: Date.now() - startedAt,
        }))
      }, timeoutMs)
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function normalizeObserverTimeoutMs(timeoutMs: number | null | undefined): number | null {
  if (typeof timeoutMs !== 'number') return null
  if (!Number.isFinite(timeoutMs)) return null
  return Math.max(0, timeoutMs)
}

function makeAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' && reason ? reason : 'wait aborted')
  error.name = 'AbortError'
  return error
}

function normalizeCancelSkillChildRunOptions(
  reasonOrOptions?: string | CancelSkillChildRunOptions,
): CancelSkillChildRunOptions {
  if (typeof reasonOrOptions === 'string') {
    return { reason: reasonOrOptions, source: 'nlp' }
  }
  if (reasonOrOptions && typeof reasonOrOptions === 'object') {
    return {
      reason: reasonOrOptions.reason,
      source: reasonOrOptions.source,
    }
  }
  return { source: 'nlp' }
}

function trim(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function makeSkillActionExecutionError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    const abortError = new Error(errorMessage(signal.reason) || errorMessage(error) || 'cancelled_user')
    abortError.name = 'cancelled_user'
    return abortError
  }
  const originalName = error instanceof Error ? error.name : ''
  const name =
    originalName === 'ProcessExitError' || originalName === 'ChildProcessTerminationError'
      ? 'child_process_crashed'
      : originalName === 'ZodError' || originalName === 'SchemaValidationError'
        ? 'input_validation'
        : originalName === 'ToolHostUnavailableError'
          ? 'host_unavailable'
          : originalName === 'failed_skill'
            || originalName === 'child_process_crashed'
            || originalName === 'input_validation'
            || originalName === 'host_unavailable'
            || originalName === 'tool_not_registered'
            ? originalName
            : 'child_process_crashed'
  const wrapped = new Error(errorMessage(error))
  wrapped.name = name
  return wrapped
}

function makeGatewayExecutionError(result: ChildGatewayResult): Error {
  const data = result.data && typeof result.data === 'object'
    ? result.data as Record<string, unknown>
    : {}
  const errorKind = typeof data.errorKind === 'string' ? data.errorKind : null
  const reason = typeof data.reason === 'string' ? data.reason : null
  const message = typeof data.message === 'string' && data.message.trim().length > 0
    ? data.message
    : result.text || 'Child gateway did not return a skill run result'
  const error = new Error(message)
  error.name = reason === 'tool_not_registered'
    ? 'tool_not_registered'
    : errorKind || 'host_unavailable'
  return error
}

interface ComputeDigestArgs {
  runStatePath: string | null
  outputDir: string | null
  requestedInput: Record<string, unknown>
}

function computeTargetDigest(args: ComputeDigestArgs): string {
  const candidate = args.runStatePath
    ? canonicalizePathLike(args.runStatePath)
    : args.outputDir
      ? canonicalizePathLike(args.outputDir)
      : null
  if (candidate) return shortHash(candidate)
  const url = trim(args.requestedInput.url as unknown)
  if (url) return shortHash(`url:${url}`)
  // Fall back to a hash of the JSON; same input = same digest.
  return shortHash(stableStringify(args.requestedInput))
}

function normalizePathLike(input: string): string {
  // Resolve simple path normalization without forcing absolute (the runner
  // doesn't always have a reliable cwd).
  if (!input) return ''
  return isAbsolute(input) ? input.replace(/\\/g, '/').replace(/\/+$/, '') : input.replace(/\\/g, '/').replace(/\/+$/, '')
}

function canonicalizePathLike(input: string): string {
  const normalized = normalizePathLike(input)
  if (!normalized || !isAbsolute(normalized)) return normalized
  try {
    return normalizePathLike(realpathSync.native(normalized))
  } catch (error) {
    // silent-catch: failed realpath only downgrades lookup to normalized path variants.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return normalized
  }
  const parent = dirname(normalized)
  if (!parent || parent === normalized) return normalized
  const canonicalParent = canonicalizePathLike(parent)
  return normalizePathLike(join(canonicalParent, basename(normalized)))
}

function pathLookupVariants(input: string): string[] {
  const variants: string[] = []
  const push = (value: string) => {
    const normalized = normalizePathLike(value)
    if (!normalized || variants.includes(normalized)) return
    variants.push(normalized)
  }
  push(input)
  push(canonicalizePathLike(input))
  for (const variant of [...variants]) {
    if (variant.startsWith('/tmp/')) push(`/private/tmp/${variant.slice('/tmp/'.length)}`)
    if (variant.startsWith('/private/tmp/')) push(`/tmp/${variant.slice('/private/tmp/'.length)}`)
  }
  return variants
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function stableStringify(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(',')}]`
  const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function makePausedOnLaunchResult(opts: {
  skillId: string
  terminalReason: SkillChildRunTerminalReason
  status: SkillChildRunStatus
  errorKind: string
  message: string
  parentNextHint: SkillChildRunParentNextHint
}): StartSkillChildRunResult {
  // No childRunId is minted for refusals BEFORE row creation. Use a
  // synthetic id so callers always have a string to log; the close event
  // carries the same id so the two stay aligned.
  const synthId = `r-${randomUUID().slice(0, 8)}`
  const close = makeCloseEvent({
    childRunId: synthId,
    skillId: opts.skillId,
    status: opts.status,
    terminalReason: opts.terminalReason,
    outputDir: null,
    runStatePath: null,
    errorKind: opts.errorKind,
    message: opts.message,
  })
  return {
    childRunId: synthId,
    status: opts.status === 'recoverable_paused'
      ? 'recoverable_paused'
      : opts.status === 'completed'
        ? 'completed'
        : opts.status === 'killed'
          ? 'killed'
          : opts.status === 'blocked'
            ? 'blocked'
            : 'failed',
    outputDir: '',
    runStatePath: '',
    eventLogPath: '',
    parentNextHint: opts.parentNextHint,
    freshContractFields: null,
    closeEvent: close,
  }
}

function isNonEmptyFileForRecordSync(file: string, createdAtMs: number | null): boolean {
  try {
    if (!existsSync(file)) return false
    const stat = statSync(file)
    if (!stat.isFile() || stat.size <= 0) return false
    if (createdAtMs !== null && Number.isFinite(createdAtMs)) {
      return stat.mtimeMs >= createdAtMs - 1_000
    }
    return true
  } catch {
    return false
  }
}

function getOutputDirRetentionDays(): number {
  const raw = process.env.READY_OUTPUT_DIR_RETENTION_DAYS
  if (!raw) return 7
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return 7
  return parsed
}

function makeResumeRefusalResult(opts: {
  childRunId: string
  skillId: string
  terminalReason: SkillChildRunTerminalReason
  status: SkillChildRunStatus
  outputDir: string
  runStatePath: string
  eventLogPath: string
  errorKind: string
  message: string
  parentNextHint: SkillChildRunParentNextHint
}): StartSkillChildRunResult {
  const close = makeCloseEvent({
    childRunId: opts.childRunId,
    skillId: opts.skillId,
    status: opts.status === 'queued' || opts.status === 'running'
      ? 'recoverable_paused'
      : opts.status,
    terminalReason: opts.terminalReason,
    outputDir: opts.outputDir,
    runStatePath: opts.runStatePath,
    errorKind: opts.errorKind,
    message: opts.message,
  })
  return {
    childRunId: opts.childRunId,
    status: startStatusForChildStatus(opts.status),
    outputDir: opts.outputDir,
    runStatePath: opts.runStatePath,
    eventLogPath: opts.eventLogPath,
    parentNextHint: opts.parentNextHint,
    freshContractFields: null,
    closeEvent: close,
  }
}

function startStatusForChildStatus(status: SkillChildRunStatus): StartChildRunStatus {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'killed':
      return 'killed'
    case 'blocked':
      return 'blocked'
    case 'recoverable_paused':
    case 'budget_paused':
      return 'recoverable_paused'
    case 'queued':
    case 'running':
      return 'reused'
    case 'failed':
      return 'failed'
  }
}

function defaultTerminalReasonForStatus(status: SkillChildRunStatus): SkillChildRunTerminalReason {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'killed':
      return 'cancelled_user'
    case 'blocked':
      return 'blocked_external'
    case 'failed':
      return 'failed_skill'
    case 'budget_paused':
      return 'checkpoint_budget'
    case 'recoverable_paused':
    case 'queued':
    case 'running':
      return 'checkpoint_background'
  }
}

interface MakeCloseArgs {
  childRunId: string
  skillId: string
  status: SkillChildRunStatus
  terminalReason: SkillChildRunTerminalReason
  outputDir: string | null
  runStatePath: string | null
  errorKind: string | null
  message: string | null
}

function makeCloseEvent(args: MakeCloseArgs): SkillChildCloseEvent {
  // The narrowed type excludes 'queued' / 'running' — defensively treat
  // those as paused if a caller passes them.
  const narrowedStatus: Exclude<SkillChildRunStatus, 'queued' | 'running'> = (
    args.status === 'queued' || args.status === 'running'
      ? 'recoverable_paused'
      : args.status
  )
  return freezeSkillChildCloseEvent({
    childRunId: args.childRunId,
    skillId: args.skillId,
    status: narrowedStatus,
    terminalReason: args.terminalReason,
    outputDir: args.outputDir,
    runStatePath: args.runStatePath,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      overallCoverageRatio: null,
      fingerprint: null,
    },
    framePatch: null,
    projectionPatch: null,
    error: args.errorKind && args.message
      ? { kind: args.errorKind, message: args.message }
      : null,
  })
}
