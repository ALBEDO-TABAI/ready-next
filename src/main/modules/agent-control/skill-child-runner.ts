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
 *      runner emits `infra_error / launch_stuck`.
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
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildDriverState,
  SkillChildLaunchParams,
  SkillChildRunParentNextHint,
  SkillChildRunPayload,
  SkillChildRunStatus,
  SkillChildRunTerminalReason,
} from './skill-child-run-types'

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
      // No driver registered — refuse with infra_error so the parent can
      // pick a different route. Keeping this as a failed close (not a
      // throw) means the caller observes the same channel as a normal
      // refusal.
      return makePausedOnLaunchResult({
        skillId: params.skillId,
        terminalReason: 'infra_error',
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
        return {
          childRunId: existing.id,
          status: 'reused',
          outputDir: existing.outputDir ?? '',
          runStatePath: existing.runStatePath ?? '',
          eventLogPath: deriveEventLogPathFromRecord(existing),
          parentNextHint: existing.resumePayload && (existing.resumePayload as Record<string, unknown>).childRun
            ? ((existing.resumePayload as { childRun: SkillChildRunPayload }).childRun.parentNextHint)
            : (params.parentNextHint ?? 'wait_for_close_event'),
          closeEvent: null,
        }
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
        terminalReason: 'infra_error',
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
        terminalReason: 'infra_error',
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
        terminalReason: 'infra_error',
        status: 'failed',
        errorKind: 'no_payload',
        message: 'Child-run record is missing payload',
        parentNextHint: 'wait_for_close_event',
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
      this.config.repository.updateChildRun(childRunId, { status: 'running' })
    } catch (error) {
      return makePausedOnLaunchResult({
        skillId: payload.skillId,
        terminalReason: 'infra_error',
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
    const active = this.active.get(childRunId)
    if (!active) {
      // Already terminal — return the cached close if we have one.
      const cached = this.recentCloses.get(childRunId)
      if (cached) return cached
      // Otherwise synthesize a killed close.
      const synth = makeCloseEvent({
        childRunId,
        skillId: 'unknown',
        status: 'killed',
        terminalReason: 'cancelled_user',
        outputDir: null,
        runStatePath: null,
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
      return synth
    }
    active.controller.abort(new Error(reason || 'cancelled_user'))
    return active.closePromise
  }

  getCloseEvent(childRunId: string): SkillChildCloseEvent | null {
    return this.recentCloses.get(childRunId) ?? null
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
        terminalReason: 'infra_error',
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
        terminalReason: 'infra_error',
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
    let actionsPlanned = 0
    let state: SkillChildDriverState
    try {
      state = await driver.createInitialState(launchParams)
    } catch (error) {
      const close = makeCloseEvent({
        childRunId: active.childRunId,
        skillId: active.skillId,
        status: 'failed',
        terminalReason: 'infra_error',
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

    // Launch-stuck guard: schedule a timer that synthesizes a close if
    // we never see an action_started.
    const launchStuckTimer = setTimeout(() => {
      if (firstActionStartedAt !== null) return
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

    try {
      while (true) {
        if (active.controller.signal.aborted) {
          const reason = (active.controller.signal.reason as Error | undefined)?.message
            || 'cancelled_user'
          const cancelled = makeCloseEvent({
            childRunId: active.childRunId,
            skillId: active.skillId,
            status: 'killed',
            terminalReason: reason === 'launch_stuck' ? 'launch_stuck' : 'cancelled_user',
            outputDir: active.outputDir,
            runStatePath: active.runStatePath,
            errorKind: reason === 'launch_stuck' ? 'launch_stuck' : 'cancelled_user',
            message: reason,
          })
          clearTimeout(launchStuckTimer)
          this.finalizeRun(active, cancelled)
          return
        }

        let plan: SkillChildDriverAction | SkillChildCloseEvent
        this.inDriverDepth += 1
        try {
          plan = await driver.planNextAction(state)
        } catch (error) {
          const close = makeCloseEvent({
            childRunId: active.childRunId,
            skillId: active.skillId,
            status: 'failed',
            terminalReason: 'infra_error',
            outputDir: active.outputDir,
            runStatePath: active.runStatePath,
            errorKind: 'driver_plan_failed',
            message: errorMessage(error),
          })
          clearTimeout(launchStuckTimer)
          this.finalizeRun(active, close)
          return
        } finally {
          this.inDriverDepth = Math.max(0, this.inDriverDepth - 1)
        }

        if (isCloseEvent(plan)) {
          // Driver decided to terminate.
          const close = { ...plan, childRunId: active.childRunId }
          clearTimeout(launchStuckTimer)
          this.finalizeRun(active, close)
          return
        }

        // Budget check BEFORE the next action. Run-state tells us the
        // run is still in flight, so the right answer is checkpoint
        // background — not failed.
        if (actionsPlanned >= this.config.maxActionsPerRun) {
          const close = makeCloseEvent({
            childRunId: active.childRunId,
            skillId: active.skillId,
            status: 'budget_paused',
            terminalReason: 'checkpoint_budget',
            outputDir: active.outputDir,
            runStatePath: active.runStatePath,
            errorKind: 'checkpoint_budget',
            message: `Child action budget exhausted (max=${this.config.maxActionsPerRun})`,
          })
          clearTimeout(launchStuckTimer)
          this.finalizeRun(active, close)
          return
        }

        actionsPlanned += 1
        const actionStartedAt = new Date().toISOString()
        if (firstActionStartedAt === null) {
          firstActionStartedAt = actionStartedAt
          // First action observed — clear the stuck timer.
          clearTimeout(launchStuckTimer)
        }
        await this.appendEvent(active, {
          type: 'action_started',
          at: actionStartedAt,
          action: plan.action,
          input: plan.input,
        })

        // Dispatch through runtime-manager. childInternal short-circuits
        // any wrap routing; the driver is the source of truth here.
        const request: SkillRunRequest = {
          skillId: active.skillId,
          action: plan.action,
          params: plan.input,
          signal: active.controller.signal,
          triggerType: 'tool',
        }
        let result: SkillRunResult
        try {
          // The runtime-manager exposes `runSkillFromChildRunner` for
          // child-internal calls. If the manager hasn't been upgraded
          // yet, fall back to plain `runSkill` — both have the same
          // signature.
          const fromChild = (this.config.runtimeManager as unknown as {
            runSkillFromChildRunner?: (req: SkillRunRequest) => Promise<SkillRunResult>
          }).runSkillFromChildRunner
          result = fromChild
            ? await fromChild.call(this.config.runtimeManager, request)
            : await this.config.runtimeManager.runSkill(request)
        } catch (error) {
          // A throw from runSkill is treated as infra-level — runtime
          // contract guarantees normal failures come back as
          // `result.success === false`.
          const close = makeCloseEvent({
            childRunId: active.childRunId,
            skillId: active.skillId,
            status: 'failed',
            terminalReason: classifyThrowAsTerminal(error),
            outputDir: active.outputDir,
            runStatePath: active.runStatePath,
            errorKind: 'child_process_crashed',
            message: errorMessage(error),
          })
          this.finalizeRun(active, close)
          return
        }

        const completedAt = new Date().toISOString()
        await this.appendEvent(active, {
          type: 'action_completed',
          at: completedAt,
          action: plan.action,
          result: {
            success: result.success,
            status: result.status ?? null,
            outputDir: result.outputDir ?? null,
            error: result.error ?? null,
          },
        })

        // Skill-declared failure (NOT infra) — close as failed_skill.
        if (!result.success) {
          const close = makeCloseEvent({
            childRunId: active.childRunId,
            skillId: active.skillId,
            status: 'failed',
            terminalReason: 'failed_skill',
            outputDir: active.outputDir,
            runStatePath: active.runStatePath,
            errorKind: 'failed_skill',
            message: result.error || 'skill action returned success=false',
          })
          this.finalizeRun(active, close)
          return
        }

        this.inDriverDepth += 1
        try {
          state = await driver.observeAfterAction(state, result)
        } catch (error) {
          const close = makeCloseEvent({
            childRunId: active.childRunId,
            skillId: active.skillId,
            status: 'failed',
            terminalReason: 'infra_error',
            outputDir: active.outputDir,
            runStatePath: active.runStatePath,
            errorKind: 'driver_observe_failed',
            message: errorMessage(error),
          })
          this.finalizeRun(active, close)
          return
        } finally {
          this.inDriverDepth = Math.max(0, this.inDriverDepth - 1)
        }

        await this.appendEvent(active, {
          type: 'state_observed',
          at: new Date().toISOString(),
          runStatePath: active.runStatePath,
          state: { actionsPlanned },
        })
      }
    } finally {
      // Per-call depth bookkeeping is owned by the inDriverDepth
      // try/finally pairs around each driver call site; nothing to do
      // here. Kept as an extension point.
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
    if (this.recentCloses.has(active.childRunId)) {
      // Already finalized — ignore the duplicate.
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
    this.recentCloses.set(active.childRunId, close)
    if (this.recentCloses.size > 64) {
      // Drop oldest. JS Maps preserve insertion order.
      const firstKey = this.recentCloses.keys().next().value
      if (firstKey) this.recentCloses.delete(firstKey)
    }
    this.active.delete(active.childRunId)
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

function trim(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isCloseEvent(value: unknown): value is SkillChildCloseEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.status === 'string' && typeof v.terminalReason === 'string'
    && 'progress' in v
}

function classifyThrowAsTerminal(error: unknown): SkillChildRunTerminalReason {
  const msg = errorMessage(error).toLowerCase()
  if (msg.includes('aborted') || msg.includes('cancel')) return 'cancelled_user'
  if (msg.includes('crash') || msg.includes('sigkill') || msg.includes('signal')
      || msg.includes('exit code') || msg.includes('out of memory') || msg.includes('oom')
      || msg.includes('spawn')) {
    return 'infra_error'
  }
  return 'infra_error'
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
