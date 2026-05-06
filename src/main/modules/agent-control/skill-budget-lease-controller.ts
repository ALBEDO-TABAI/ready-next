import { randomUUID } from 'node:crypto'
import type {
  SkillBudgetLeaseDecision,
  SkillBudgetLeaseState,
} from './run-contracts'
import type { SkillProgressScore } from './progress-scorer'
import type { SkillWasteScore } from './waste-scorer'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'
import type { TurnFramePatch } from './turn-frame'

/**
 * Stage M (M2b) — `produceBudgetPatch` is the named producer that emits a
 * `TurnFramePatch.budget` reflecting the current lease state. Steering and
 * dispatch read `frame.budget` only; this helper is the ONLY non-merge path
 * by which `frame.budget` changes (M3 gate enforces).
 *
 * `exhausted` is derived from external scalars — `SkillBudgetLeaseState`
 * itself has no `exhausted` field. Callers pass the two budget signals they
 * already track:
 *   - `budgetWarningLevel`: from `ChatTurnState.budgetWarningLevel`
 *     ('exhausted' is the terminal level).
 *   - `stepBudgetRemainingIterations`: from
 *     `ChatTurnState.stepBudgetState?.remainingIterations`. When ≤ 0, the
 *     step budget is also exhausted.
 *
 * If both are null/undefined the helper assumes not exhausted.
 */
export function produceBudgetPatch(args: {
  lease: SkillBudgetLeaseState | null
  budgetWarningLevel?: 'none' | 'warning' | 'converge' | 'exhausted' | null
  stepBudgetRemainingIterations?: number | null
}): TurnFramePatch {
  const exhausted =
    args.budgetWarningLevel === 'exhausted'
    || (typeof args.stepBudgetRemainingIterations === 'number' && args.stepBudgetRemainingIterations <= 0)
  return {
    budget: {
      leaseEndIteration: args.lease?.currentLeaseEndIteration ?? null,
      hardCapIteration: args.lease?.hardCapIteration ?? null,
      exhausted,
    },
  }
}

export const DEFAULT_SKILL_LEASE_SIZE_ITERATIONS = 20
export const DEFAULT_SKILL_LEASE_MAX_RENEWALS = 10
export const DEFAULT_SKILL_LEASE_HARD_CAP_ITERATIONS = 220

export interface SkillBudgetLeaseEvaluation {
  state: SkillBudgetLeaseState
  decision: SkillBudgetLeaseDecision
  reason: string
}

function hasResumeHandle(snapshot?: SkillTaskSupervisorSnapshot | null): boolean {
  return Boolean(
    snapshot?.resumePayload
      || snapshot?.runStatePath
      || snapshot?.outputDir
      || snapshot?.detachedTaskId
      || snapshot?.taskRunId,
  )
}

function cloneState(state: SkillBudgetLeaseState): SkillBudgetLeaseState {
  return {
    ...state,
    renewedFingerprints: [...state.renewedFingerprints],
  }
}

export function createSkillBudgetLeaseState(params?: {
  iteration?: number
  now?: string
  leaseSizeIterations?: number
  maxRenewals?: number
  hardCapIterations?: number
}): SkillBudgetLeaseState {
  const iteration = Math.max(0, Math.round(params?.iteration || 0))
  const leaseSizeIterations = Math.max(1, Math.round(params?.leaseSizeIterations || DEFAULT_SKILL_LEASE_SIZE_ITERATIONS))
  const hardCapIterations = Math.max(leaseSizeIterations, Math.round(params?.hardCapIterations || DEFAULT_SKILL_LEASE_HARD_CAP_ITERATIONS))
  return {
    leaseId: `sbl-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    createdAt: params?.now || new Date().toISOString(),
    leaseSizeIterations,
    maxRenewals: Math.max(0, Math.round(params?.maxRenewals ?? DEFAULT_SKILL_LEASE_MAX_RENEWALS)),
    hardCapIterations,
    renewalsUsed: 0,
    currentLeaseEndIteration: Math.min(iteration + leaseSizeIterations, hardCapIterations),
    hardCapIteration: iteration + hardCapIterations,
    lastFingerprint: null,
    renewedFingerprints: [],
    leasesWithoutFingerprintChange: 0,
    repeatedUnchangedObservations: 0,
    repeatedRecoverableErrors: 0,
    repeatedRecoverableErrorKind: null,
    repeatedToolCallStreak: 0,
    pidOnlyRenewalsUsed: 0,
    decision: 'active',
    reason: null,
    progressScore: 0,
    wasteScore: 0,
  }
}

export function evaluateSkillBudgetLease(params: {
  state: SkillBudgetLeaseState
  iteration: number
  progress: SkillProgressScore
  waste: SkillWasteScore
  snapshot?: SkillTaskSupervisorSnapshot | null
}): SkillBudgetLeaseEvaluation {
  const state = cloneState(params.state)
  const iteration = Math.max(0, Math.round(params.iteration))
  const snapshot = params.snapshot || null
  state.progressScore = params.progress.score
  state.wasteScore = params.waste.score
  state.repeatedUnchangedObservations = params.waste.repeatedUnchangedObservation
    ? state.repeatedUnchangedObservations + 1
    : 0
  state.repeatedToolCallStreak = params.waste.repeatedToolCallStreak || 0
  if (params.waste.recoverableErrorKind) {
    state.repeatedRecoverableErrors = state.repeatedRecoverableErrorKind === params.waste.recoverableErrorKind
      ? state.repeatedRecoverableErrors + params.waste.recoverableErrorCount
      : params.waste.recoverableErrorCount
    state.repeatedRecoverableErrorKind = params.waste.recoverableErrorKind
  } else {
    state.repeatedRecoverableErrors = 0
    state.repeatedRecoverableErrorKind = null
  }

  const finish = (decision: SkillBudgetLeaseDecision, reason: string): SkillBudgetLeaseEvaluation => {
    state.decision = decision
    state.reason = reason
    if (params.progress.fingerprint) state.lastFingerprint = params.progress.fingerprint
    return { state, decision, reason }
  }

  if (snapshot?.closeAllowed && snapshot.status === 'completed') return finish('close', 'supervisor_close_allowed')
  if (snapshot?.closeAllowed && snapshot.status === 'failed') return finish('pause', 'supervisor_failed')
  if (snapshot?.closeAllowed && snapshot.status === 'killed') return finish('pause', 'supervisor_cancelled')
  if (state.repeatedToolCallStreak >= 3) return finish('pause', 'tool_repetition')
  if (state.repeatedUnchangedObservations >= 3) return finish('pause', 'unchanged_observation_repeated')
  if (state.repeatedRecoverableErrors >= 3) return finish('pause', 'recoverable_error_repeated')
  if (snapshot?.ambiguous) return finish('pause', 'supervisor_ambiguous')
  if (snapshot?.stale && !snapshot.hasLiveWork && !snapshot.hasRecentProgress) return finish('pause', 'supervisor_stale_without_activity')

  const atLeaseBoundary = iteration >= state.currentLeaseEndIteration - 2
  const canRenew = state.renewalsUsed < state.maxRenewals
    && state.currentLeaseEndIteration < state.hardCapIteration
    && iteration < state.hardCapIteration
  const fingerprint = params.progress.fingerprint
  const fingerprintAlreadyRenewed = Boolean(fingerprint && state.renewedFingerprints.includes(fingerprint))
  const realProgress = params.progress.score >= 2
    && params.waste.score <= 1
    && params.progress.milestoneChanged
    && Boolean(fingerprint)
    && !fingerprintAlreadyRenewed

  if (realProgress && canRenew) {
    state.renewalsUsed += 1
    if (fingerprint) state.renewedFingerprints.push(fingerprint)
    state.currentLeaseEndIteration = Math.min(
      state.currentLeaseEndIteration + state.leaseSizeIterations,
      state.hardCapIteration,
    )
    state.leasesWithoutFingerprintChange = 0
    return finish('renew', 'progress_fingerprint_changed')
  }

  if (
    atLeaseBoundary
    && snapshot?.hasLiveWork
    && hasResumeHandle(snapshot)
    && params.progress.score < 2
  ) {
    const pidOnly = snapshot.sourceObservations.some((item) => item.source === 'pid' && item.live)
      && !snapshot.hasRecentProgress
    if (pidOnly && state.pidOnlyRenewalsUsed < 1 && canRenew) {
      state.pidOnlyRenewalsUsed += 1
      state.renewalsUsed += 1
      state.currentLeaseEndIteration = Math.min(
        state.currentLeaseEndIteration + state.leaseSizeIterations,
        state.hardCapIteration,
      )
      state.leasesWithoutFingerprintChange = 0
      return finish('renew', 'pid_alive_short_renewal')
    }
    return finish('handoff_background', 'live_work_weak_progress')
  }

  if (atLeaseBoundary) {
    state.leasesWithoutFingerprintChange = params.progress.fingerprintChanged
      ? 0
      : state.leasesWithoutFingerprintChange + 1
    if (params.progress.score < 2 && !snapshot?.hasLiveWork) {
      return finish('pause', 'lease_expired_without_progress')
    }
    if (state.leasesWithoutFingerprintChange >= 2) {
      return finish('pause', 'two_leases_without_fingerprint_change')
    }
  }

  return finish('active', 'within_current_lease')
}
