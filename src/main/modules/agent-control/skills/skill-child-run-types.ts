/**
 * Phase 1 — Skill Child Run shapes (source plan §5.2 / §5.3 / §5.4).
 *
 * The child-run vocabulary is the durable boundary between the parent turn
 * loop and a long-running skill. Parent code reads the payload + close
 * event; the child runner owns the rest (stage selection, retries, tool
 * dispatch, abort controller).
 *
 * NOTE: Phase 5 (Team 5) implements the actual driver/runner — these types
 * intentionally stay loose enough that the future driver can extend them
 * without churning the Phase 1 acceptance tests.
 */

import type { TurnFramePatch } from '../runtime-core/turn-frame'
import type { SkillChildRunKind } from './skill-child-run-id'
import type { DeepReadonly } from '../../../../shared/deep-readonly'

// Re-export for downstream consumers so they only need to import from one place.
export type { SkillChildRunKind } from './skill-child-run-id'

export type SkillChildRunStatus =
  | 'queued'
  | 'running'
  | 'recoverable_paused'
  | 'budget_paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'killed'

/**
 * Terminal reason union per source plan §5.4. Order intentionally mirrors
 * the spec so reviewers can diff against the plan without translation.
 *
 * `process_restarted` is set when `startSkillChildRun` finds an existing
 * active row whose in-memory runner is gone (process restart / runner
 * crash). Reconciliation pins the row to `recoverable_paused` so the
 * caller never sees a false-live `reused` claim.
 */
export type SkillChildRunTerminalReason =
  | 'completed'
  | 'checkpoint_budget'
  | 'checkpoint_background'
  | 'queued_global_concurrency'
  | 'launch_stuck'
  | 'blocked_config'
  | 'blocked_external'
  | 'nested_child_run_not_supported'
  | 'cancelled_user'
  | 'failed_skill'
  | 'resume_launch_failed'
  | 'persistence_failed'
  | 'child_process_crashed'
  | 'host_unavailable'
  | 'tool_not_registered'
  | 'input_validation'
  | 'process_restarted'

export type SkillChildRunParentNextHint =
  | 'wait_for_close_event'
  | 'continue_other_work'

/**
 * Source plan §5.4. The single close event that replaces parent-loop
 * repeated force dispatch for long skills.
 */
export interface MutableSkillChildCloseEvent {
  childRunId: string
  skillId: string
  status: Exclude<SkillChildRunStatus, 'queued' | 'running'>
  terminalReason: SkillChildRunTerminalReason
  outputDir: string | null
  runStatePath: string | null
  sceneScoresPath: string | null
  deliveryReportPath: string | null
  progress: {
    stage: string | null
    totalUnits: number | null
    completedUnits: number | null
    coverageRatio: number | null
    overallCoverageRatio?: number | null
    fingerprint: string | null
  }
  framePatch: TurnFramePatch | null
  projectionPatch: unknown | null
  error: {
    kind: string
    message: string
  } | null
}

export type SkillChildCloseEvent = DeepReadonly<MutableSkillChildCloseEvent>

export type TerminalChildCloseStatus = Extract<
  SkillChildCloseEvent['status'],
  'completed' | 'failed' | 'killed'
>

export const TERMINAL_CHILD_CLOSE_STATUSES = new Set<SkillChildCloseEvent['status']>([
  'completed',
  'failed',
  'killed',
])

export function isTerminalChildCloseStatus(
  status: SkillChildCloseEvent['status'],
): status is TerminalChildCloseStatus {
  return TERMINAL_CHILD_CLOSE_STATUSES.has(status)
}

export function isCompletedChildCloseStatus(
  status: SkillChildCloseEvent['status'],
): status is 'completed' {
  return status === 'completed'
}

export function isFailedChildCloseStatus(
  status: SkillChildCloseEvent['status'],
): status is 'failed' {
  return status === 'failed'
}

export function isKilledChildCloseStatus(
  status: SkillChildCloseEvent['status'],
): status is 'killed' {
  return status === 'killed'
}

export function isBlockedChildCloseStatus(
  status: SkillChildCloseEvent['status'],
): status is 'blocked' {
  return status === 'blocked'
}

export function isRetainedLifecycleChildCloseStatus(
  status: SkillChildCloseEvent['status'],
): boolean {
  return isTerminalChildCloseStatus(status) || status === 'blocked'
}

export type ChildWaitResult =
  | {
      kind: 'closed'
      childRunId: string
      closeEvent: SkillChildCloseEvent
    }
  | {
      kind: 'observer_timeout'
      childRunId: string
      elapsedMs: number
    }

/**
 * Source plan §5.2. Stored under `skill_task_runs.resumePayload.childRun`
 * during initial migration; a dedicated column may be promoted later if
 * tests show JSON queries are unsafe.
 */
export interface SkillChildRunPayload {
  version: 1
  childRunId: string
  kind: SkillChildRunKind
  parentScopeId: string | null
  parentSessionId: string | null
  skillId: string
  skillName: string | null
  requestedAction: string
  requestedInput: Record<string, unknown>
  /**
   * Canonical single-flight key derived from
   * `scope/session + skillId + targetDigest`. Same key plus active status
   * returns the existing child run instead of starting a duplicate.
   */
  singleFlightKey: string
  parentNextHint: SkillChildRunParentNextHint
  outputDir: string
  runStatePath: string
  eventLogPath: string
  status: SkillChildRunStatus
  closeEvent: SkillChildCloseEvent | null
  /**
   * Bridge handles to legacy parent-visible state. New child runs may be
   * created from a recovered legacy row; in that case these fields point
   * at the legacy projection / task-run / detached-task ids.
   */
  legacy: {
    taskRunId: string | null
    detachedTaskId: string | null
    projectionTaskId: string | null
  }
}

/**
 * Source plan §5.3 — append-only JSONL event log shapes. Parent code may
 * surface the path; parent code must NOT parse the log to choose the next
 * VEA step.
 *
 * Stage T (W9.1) — Worker Event Ledger augmentation. Every variant now
 * also carries:
 *   - `event_kind`: one of `'started' | 'progress' | 'budget_warning' |
 *     'paused' | 'resumed' | 'cancelled' | 'completed' | 'failed'` —
 *     coarse kind for diagnostic / dashboard consumers (not used by
 *     parent-loop logic).
 *   - `ts`: numeric epoch-ms timestamp (peer to the existing `at` ISO
 *     string, retained for back-compat).
 *   - `terminal_reason?`: only set on terminal events; mirrors the
 *     close event's `terminalReason` for at-a-glance triage.
 *   - `rollback_target?: string | null`: ONLY filled on cancel terminal
 *     events — the runner's `lastSafeStepId` snapshot (`null` if no safe
 *     step was ever recorded). This is a diagnostic-only field; the
 *     runner explicitly does NOT auto-roll-back on cancel.
 */
export type SkillChildRunEventLedgerKind =
  | 'started'
  | 'progress'
  | 'budget_warning'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'completed'
  | 'failed'

interface SkillChildRunEventLedgerFields {
  event_kind?: SkillChildRunEventLedgerKind
  ts?: number
  terminal_reason?: string
  rollback_target?: string | null
}

export type SkillChildRunEvent =
  | ({
      type: 'started'
      at: string
      childRunId: string
      input: Record<string, unknown>
    } & SkillChildRunEventLedgerFields)
  | ({
      type: 'action_started'
      at: string
      action: string
      input: Record<string, unknown>
    } & SkillChildRunEventLedgerFields)
  | ({
      type: 'action_completed'
      at: string
      action: string
      result: Record<string, unknown>
    } & SkillChildRunEventLedgerFields)
  | ({
      type: 'state_observed'
      at: string
      runStatePath: string
      state: Record<string, unknown>
    } & SkillChildRunEventLedgerFields)
  | ({
      type: 'checkpoint'
      at: string
      reason: string
      state: Record<string, unknown>
    } & SkillChildRunEventLedgerFields)
  | ({
      type: 'close'
      at: string
      close: SkillChildCloseEvent
    } & SkillChildRunEventLedgerFields)

/**
 * Phase 1 placeholder for the per-run driver state. Phase 5 fills the real
 * shape (stage cursor, retry counters, cached run_state digest, etc.).
 */
export interface SkillChildDriverState {
  /** Free-form for now — the driver owns interpretation. */
  [key: string]: unknown
}

/**
 * Inputs to the child runner's launch path. The child-run id and event log
 * path are minted by the runner, so callers only describe intent.
 */
export interface SkillChildLaunchParams {
  skillId: string
  action: string
  scopeId: string | null
  sessionId: string | null
  requestedInput: Record<string, unknown>
  parentNextHint: SkillChildRunParentNextHint
  agentContext?: import('../../../../shared/skill-host-contract').AgentSpawnContext | null
  /** Optional pre-existing output dir for legacy resume. */
  outputDir?: string
}

/**
 * The atomic unit a driver returns for the runner to execute. The runner
 * is responsible for tool admission and dispatch; the driver only chooses
 * which action to run next from the current state.
 */
export interface SkillChildDriverAction {
  action: string
  input: Record<string, unknown>
}
