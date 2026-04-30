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
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../skills-runtime/runtime-manager'
import type { SkillTaskRunRepository } from '../repositories/skill-task-run-repository'

import { logAgentMetric } from './metrics'
import { createSkillChildRunId, getSkillChildRunKind } from './skill-child-run-id'
import {
  appendChildRunEvent,
  deriveChildRunLogPath,
} from './skill-child-run-log'
import {
  getSkillChildDriver,
  isChildOwnedSkill,
} from './skill-child-drivers'
import type {
  ChildWaitResult,
  SkillChildCloseEvent,
  SkillChildDriverState,
  SkillChildLaunchParams,
  SkillChildRunParentNextHint,
  SkillChildRunPayload,
  SkillChildRunStatus,
  SkillChildRunTerminalReason,
} from './skill-child-run-types'
import {
  classifySkillChildRunStatus,
  decodeStoredSkillChildCloseEvent,
  isSkillChildRunResumable,
} from './skill-child-state-machine'
import { createSkillChildSubAgent } from './skill-child-sub-agent'
import { mapSubAgentCloseToChildClose } from './skill-child-sub-agent-close-mapping'
import { isSkillChildProgressPayload } from './skill-child-sub-agent-events'
import { createSubAgentCleanupHandle } from './sub-agent/sub-agent-cleanup'
import { runSubAgent } from './sub-agent/sub-agent-runner'

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
  /** Set true ONLY when a registered driver is calling its own internal
   *  action through the runtime. Lets `startSkillChildRun` short-circuit
   *  the nested-child guard. Drivers should prefer the runtime's
   *  internal pathway and never call `startSkillChildRun` reentrantly —
   *  this flag is here as the safety net. */
  childInternal?: boolean
}

export type StartChildRunStatus = 'queued' | 'running' | 'reused' | 'recoverable_paused' | 'failed' | 'completed' | 'blocked' | 'killed'

export interface StartSkillChildRunResult {
  childRunId: string
  status: StartChildRunStatus
  outputDir: string
  runStatePath: string
  eventLogPath: string
  parentNextHint: SkillChildRunParentNextHint
  /** null when started normally; non-null when paused-on-launch (concurrency
   *  overflow, nested guard, or any other launch-time refusal). */
  closeEvent: SkillChildCloseEvent | null
}

export interface WaitForSkillChildRunCloseOptions {
  timeoutMs?: number | null
  signal?: AbortSignal
}

// =====================================================================
// Runner config + injection
// =====================================================================

export interface SkillChildRunnerConfig {
  runtimeManager: SkillsRuntimeManager
  repository: SkillTaskRunRepository
  /** Optional override for the launch-stuck guard. Defaults to the
   *  module-level constant. */
  launchStuckGuardMs?: number
  /** Optional override for the child action budget. */
  maxActionsPerRun?: number
  /** Optional override for the global active-vea cap. */
  maxActiveVeaRuns?: number
  /** Sleep helper — only overridden in tests. */
  sleep?: (ms: number) => Promise<void>
}

interface ActiveRun {
  childRunId: string
  skillId: string
  action: string
  scopeId: string | null
  sessionId: string | null
  controller: AbortController
  closePromise: Promise<SkillChildCloseEvent>
  resolveClose(event: SkillChildCloseEvent): void
  outputDir: string
  runStatePath: string
  eventLogPath: string
  parentNextHint: SkillChildRunParentNextHint
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

  constructor(config: SkillChildRunnerConfig) {
    this.config = {
      runtimeManager: config.runtimeManager,
      repository: config.repository,
      launchStuckGuardMs: config.launchStuckGuardMs ?? LAUNCH_STUCK_GUARD_MS,
      maxActionsPerRun: config.maxActionsPerRun ?? MAX_ACTIONS_PER_CHILD_RUN,
      maxActiveVeaRuns: config.maxActiveVeaRuns ?? MAX_ACTIVE_VEA_CHILD_RUNS,
      sleep: config.sleep ?? defaultSleep,
    }
  }

  // ------------------------------------------------------------------
  // Public entry points
  // ------------------------------------------------------------------

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

    // Single-flight collapse.
    const requestedOutputDir = trim(params.requestedInput.outputDir as unknown)
    const runStatePathHint = requestedOutputDir ? join(requestedOutputDir, 'run_state.json') : null
    const targetDigest = computeTargetDigest({
      runStatePath: runStatePathHint,
      outputDir: requestedOutputDir,
      requestedInput: params.requestedInput,
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
    } catch (error) {
      // Repo unavailable — fall through and try to start, the create()
      // call will fail with a clear error if it's truly broken.
      logAgentMetric('skill_child_runner_lookup_error', {
        skillId: params.skillId,
        error: errorMessage(error),
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
      || join(this.config.runtimeManager.getRuntimeInfo().outputsRoot, params.skillId, childRunId)
    const runStatePath = join(outputDir, 'run_state.json')
    const eventLogPath = deriveChildRunLogPath(outputDir, childRunId)

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
        requestedInput: params.requestedInput,
        singleFlightKey,
        parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
        outputDir,
        runStatePath,
        eventLogPath,
        status: 'running',
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
      requestedInput: params.requestedInput,
      parentNextHint: params.parentNextHint ?? 'wait_for_close_event',
      outputDir,
    }

    return this.beginRunLoop({
      childRunId,
      params,
      launchParams,
      outputDir,
      runStatePath,
      eventLogPath,
    })
  }

  async resumeSkillChildRun(childRunId: string): Promise<StartSkillChildRunResult> {
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
        return {
          childRunId,
          status: 'reused',
          outputDir: payload.outputDir,
          runStatePath: payload.runStatePath,
          eventLogPath: payload.eventLogPath,
          parentNextHint: payload.parentNextHint,
          closeEvent: null,
        }
      }
      const storedClose = payload.closeEvent ? decodeStoredSkillChildCloseEvent(payload.closeEvent) : null
      return makeResumeRefusalResult({
        childRunId,
        skillId: payload.skillId,
        status: payload.status,
        terminalReason: storedClose?.terminalReason ?? defaultTerminalReasonForStatus(payload.status),
        outputDir: payload.outputDir,
        runStatePath: payload.runStatePath,
        eventLogPath: payload.eventLogPath,
        errorKind: statusClass === 'blocked' ? 'still_blocked' : 'terminal_not_resumable',
        message: statusClass === 'blocked'
          ? 'Child run is blocked and cannot be resumed directly'
          : 'Child run is already terminal and cannot be resumed',
        parentNextHint: payload.parentNextHint,
      })
    }
    const params: StartSkillChildRunParams = {
      scopeId: payload.parentScopeId ?? record.scopeId ?? null,
      sessionId: payload.parentSessionId ?? record.sessionId ?? null,
      skillId: payload.skillId,
      action: payload.requestedAction,
      requestedInput: payload.requestedInput,
      parentNextHint: payload.parentNextHint,
    }
    const launchParams: SkillChildLaunchParams = {
      skillId: payload.skillId,
      action: payload.requestedAction,
      scopeId: params.scopeId,
      sessionId: params.sessionId,
      requestedInput: payload.requestedInput,
      parentNextHint: payload.parentNextHint,
      outputDir: payload.outputDir,
    }
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
      eventLogPath: payload.eventLogPath,
      resume: true,
    })
  }

  async cancelSkillChildRun(childRunId: string, reason?: string): Promise<SkillChildCloseEvent> {
    // Compatible with multi-lifecycle resume: if the row was resumed and is
    // active again, this targets the new ActiveRun's controller (active.get
    // returns the resumed entry). The old paused close in `recentCloses` is
    // not consulted here.
    const active = this.active.get(childRunId)
    if (!active) {
      // Already terminal — return the cached close if we have one.
      const cached = this.recentCloses.get(childRunId)
      if (cached) return cached

      // Try the durable record before falling back to a synthesized close.
      // When the row exists, the cancel close event MUST use the row's real
      // skillId, outputDir, runStatePath — synthesizing `'unknown'` for a
      // persisted row is a class-of-bug we explicitly guard against.
      const record = this.tryGetRecord(childRunId)
      const payload = (record?.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
      // If the record already has a stored terminal close, return it.
      if (payload?.closeEvent && (
          payload.status === 'completed'
          || payload.status === 'failed'
          || payload.status === 'killed'
        )) {
        const decodedClose = decodeStoredSkillChildCloseEvent(payload.closeEvent)
        this.recentCloses.set(childRunId, decodedClose)
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
        message: reason || 'cancelled before launch',
      })
      try {
        this.config.repository.updateChildRun(childRunId, {
          status: 'killed',
          closeEvent: synth,
        })
      } catch {
        // already gone — ignore.
      }
      this.recentCloses.set(childRunId, synth)
      return synth
    }
    active.controller.abort(new Error(reason || 'cancelled_user'))
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
        eventLogPath: deriveEventLogPathFromRecord(existing),
        parentNextHint: existingPayload?.parentNextHint
          ?? params.parentNextHint ?? 'wait_for_close_event',
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
        eventLogPath: deriveEventLogPathFromRecord(existing),
        parentNextHint: existingPayload!.parentNextHint
          ?? params.parentNextHint ?? 'wait_for_close_event',
        closeEvent: persistedClose,
      }
    }

    // (3) Row is active per the DB but no in-memory runner exists. This is
    // the "process restarted / runner crashed mid-flight" case. Try a
    // durable resume if the payload carries enough handles; otherwise
    // mark the row `recoverable_paused/process_restarted`.
    const driver = getSkillChildDriver(existing.skillId)
    const canResume = !!driver
      && !!existingPayload
      && typeof existingPayload.outputDir === 'string'
      && existingPayload.outputDir.length > 0
      && typeof existingPayload.runStatePath === 'string'
      && existingPayload.runStatePath.length > 0
      && typeof existingPayload.eventLogPath === 'string'
      && existingPayload.eventLogPath.length > 0

    if (canResume) {
      const payload = existingPayload!
      const launchParams: SkillChildLaunchParams = {
        skillId: payload.skillId,
        action: payload.requestedAction,
        scopeId: payload.parentScopeId ?? params.scopeId,
        sessionId: payload.parentSessionId ?? params.sessionId,
        requestedInput: payload.requestedInput,
        parentNextHint: payload.parentNextHint,
        outputDir: payload.outputDir,
      }
      const resumeStartParams: StartSkillChildRunParams = {
        scopeId: payload.parentScopeId ?? params.scopeId,
        sessionId: payload.parentSessionId ?? params.sessionId,
        skillId: payload.skillId,
        action: payload.requestedAction,
        requestedInput: payload.requestedInput,
        parentNextHint: payload.parentNextHint,
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
        eventLogPath: payload.eventLogPath,
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
    resume?: boolean
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
        closeEvent: close,
      }
    }

    const controller = new AbortController()
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
      controller,
      closePromise,
      resolveClose,
      outputDir,
      runStatePath,
      eventLogPath,
      parentNextHint: launchParams.parentNextHint,
    }
    this.active.set(childRunId, active)

    // Kick off async loop. The promise we return resolves AFTER the
    // close event is recorded so callers can `await` either the result
    // or `getCloseEvent` to get the same shape.
    void this.runLoop(active, driver, launchParams, params.resume === true).catch((error) => {
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
      this.finalizeRun(active, close)
    })

    return {
      childRunId,
      status: 'running',
      outputDir,
      runStatePath,
      eventLogPath,
      parentNextHint: launchParams.parentNextHint,
      closeEvent: null,
    }
  }

  private async runLoop(
    active: ActiveRun,
    driver: ReturnType<typeof getSkillChildDriver>,
    launchParams: SkillChildLaunchParams,
    resume: boolean,
  ): Promise<void> {
    if (!driver) return // typescript narrowing; checked at caller
    const startedAt = new Date().toISOString()
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
      this.finalizeRun(active, close)
      return
    }

    await this.appendEvent(active, {
      type: 'started',
      at: startedAt,
      childRunId: active.childRunId,
      input: { ...launchParams.requestedInput, __resume: resume || undefined },
    })

    let isLaunchStuckFired = false
    let actionsStarted = 0
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
      this.finalizeRun(active, close)
    }, this.config.launchStuckGuardMs)
    // Don't keep the process alive on this timer.
    if (typeof launchStuckTimer.unref === 'function') launchStuckTimer.unref()

    const cleanup = createSubAgentCleanupHandle(active.childRunId)
    cleanup.register(() => clearTimeout(launchStuckTimer))
    const subagent = createSkillChildSubAgent({
      childRunId: active.childRunId,
      outputDir: active.outputDir,
      runStatePath: active.runStatePath,
      driver,
      initialState: state,
      executeAction: async (action) => {
        const request: SkillRunRequest = {
          skillId: active.skillId,
          action: action.action,
          params: {
            ...action.input,
            __childRunContext: {
              childRunId: active.childRunId,
              scopeId: active.scopeId,
              sessionId: active.sessionId,
              outputDir: active.outputDir || null,
              runStatePath: active.runStatePath || null,
            },
          },
          signal: active.controller.signal,
          triggerType: 'tool',
          sessionId: active.sessionId ?? undefined,
        }
        const runFromChild = (this.config.runtimeManager as unknown as {
          runSkillFromChildRunner?: (request: SkillRunRequest) => Promise<SkillRunResult>
        }).runSkillFromChildRunner
        try {
          const result = runFromChild
            ? await runFromChild.call(this.config.runtimeManager, request)
            : await this.config.runtimeManager.runSkill(request)
          actionResults.push(result)
          return result
        } catch (error) {
          throw makeSkillActionExecutionError(error, active.controller.signal)
        }
      },
      parentScopeId: active.scopeId,
      parentSessionId: active.sessionId,
      maxActions: this.config.maxActionsPerRun,
      runDriverCall: (call) => this.runDriverCall(call),
    })

    try {
      for await (const event of runSubAgent(subagent, {
        abortSignal: active.controller.signal,
        cleanup,
        parentScopeId: active.scopeId,
        parentSessionId: active.sessionId,
      })) {
        if (event.type === 'progress' && isSkillChildProgressPayload(event.payload)) {
          if (event.payload.kind === 'action_started') {
            const actionStartedAt = new Date().toISOString()
            actionsStarted = event.payload.actionIndex
            if (firstActionStartedAt === null) {
              firstActionStartedAt = actionStartedAt
              // First action observed — clear the stuck timer.
              clearTimeout(launchStuckTimer)
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
            await this.appendEvent(active, {
              type: 'action_completed',
              at: new Date().toISOString(),
              action: event.payload.actionName,
              result: {
                success: event.payload.success,
                status: result?.status ?? null,
                outputDir: result?.outputDir ?? null,
                error: result?.error ?? null,
                durationMs: event.payload.durationMs,
              },
            })
            continue
          }

          await this.appendEvent(active, {
            type: 'state_observed',
            at: new Date().toISOString(),
            runStatePath: active.runStatePath,
            state: {
              actionsPlanned: actionsStarted,
              stage: event.payload.stage,
              fingerprint: event.payload.fingerprint,
            },
          })
          continue
        }

        if (event.type === 'terminal') {
          clearTimeout(launchStuckTimer)
          const abortReason = (active.controller.signal.reason as Error | undefined)?.message
            || (typeof active.controller.signal.reason === 'string' ? active.controller.signal.reason : null)
          const close = mapSubAgentCloseToChildClose(event.closeEvent, {
            childRunId: active.childRunId,
            skillId: active.skillId,
            outputDir: active.outputDir,
            runStatePath: active.runStatePath,
            isUserCancel: active.controller.signal.aborted
              && !isLaunchStuckFired
              && abortReason !== 'process_restarted',
            isParentSessionAbort: abortReason === 'process_restarted',
            isLaunchStuckFired,
          })
          this.finalizeRun(active, close)
          return
        }
      }
    } finally {
      clearTimeout(launchStuckTimer)
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

  private finalizeRun(active: ActiveRun, close: SkillChildCloseEvent): void {
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
    void this.appendEvent(active, {
      type: 'close',
      at: new Date().toISOString(),
      close,
    })
    try {
      this.config.repository.updateChildRun(active.childRunId, {
        status: close.status,
        closeEvent: close,
      })
    } catch (error) {
      logAgentMetric('skill_child_runner_finalize_failed', {
        childRunId: active.childRunId,
        error: errorMessage(error),
      })
    }
    // Delete the active entry BEFORE recordCloses + resolveClose so any
    // re-entrant finalize attempt (or a downstream lookup that races
    // resolveClose) cannot find this lifecycle's `active` and accidentally
    // double-resolve or overwrite a freshly-resumed lifecycle's state.
    this.active.delete(active.childRunId)
    this.recentCloses.set(active.childRunId, close)
    if (this.recentCloses.size > 64) {
      // Drop oldest. JS Maps preserve insertion order.
      const firstKey = this.recentCloses.keys().next().value
      if (firstKey) this.recentCloses.delete(firstKey)
    }
    active.resolveClose(close)
  }

  private persistTerminalClose(childRunId: string, close: SkillChildCloseEvent): void {
    try {
      this.config.repository.updateChildRun(childRunId, {
        status: close.status,
        closeEvent: close,
      })
    } catch {
      // best effort
    }
    this.recentCloses.set(childRunId, close)
  }

  private countActiveVeaRuns(): number {
    let count = 0
    for (const run of this.active.values()) {
      if (run.skillId === 'video-expert-analyzer') count += 1
    }
    return count
  }
}

// =====================================================================
// Singleton plumbing — Team 6 imports the bare functions.
// =====================================================================

let runnerInstance: SkillChildRunner | null = null

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
): Promise<StartSkillChildRunResult> {
  const runner = ensureRunner()
  return runner.resumeSkillChildRun(childRunId)
}

export async function cancelSkillChildRun(
  childRunId: string,
  reason?: string,
): Promise<SkillChildCloseEvent> {
  const runner = ensureRunner()
  return runner.cancelSkillChildRun(childRunId, reason)
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
      if (timeout) clearTimeout(timeout)
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

interface ComputeDigestArgs {
  runStatePath: string | null
  outputDir: string | null
  requestedInput: Record<string, unknown>
}

function computeTargetDigest(args: ComputeDigestArgs): string {
  const candidate = args.runStatePath
    ? normalizePathLike(args.runStatePath)
    : args.outputDir
      ? normalizePathLike(args.outputDir)
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

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function stableStringify(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(',')}]`
  const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function deriveEventLogPathFromRecord(record: { resumePayload?: unknown; outputDir?: string | null; id: string }): string {
  const payload = (record.resumePayload as { childRun?: SkillChildRunPayload } | null)?.childRun
  if (payload?.eventLogPath) return payload.eventLogPath
  if (record.outputDir) return deriveChildRunLogPath(record.outputDir, record.id)
  return ''
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
    closeEvent: close,
  }
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
  return {
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
      fingerprint: null,
    },
    framePatch: null,
    projectionPatch: null,
    error: args.errorKind && args.message
      ? { kind: args.errorKind, message: args.message }
      : null,
  }
}
