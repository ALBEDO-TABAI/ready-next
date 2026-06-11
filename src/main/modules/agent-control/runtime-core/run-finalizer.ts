import { logAgentMetric } from '../metrics'
import { collectResponseDigestProof, appendProofRefs } from '../quality/proof-collector'
import { adjudicateTerminalOutcome, appendCheckIns } from '../quality/task-adjudicator'
import { resolveCriteria } from '../quality/criteria-templates'
import type { TaskType } from '../../../../shared/task-types'
import type { TaskProjectionRecord } from '../contracts/run-contracts'

export interface RunCloseMetric {
  runId: string
  terminalReason: string
  initiator: string
  toolCallsUsed: number
  durationMs: number
}

export type RunOutcome =
  | {
    kind: 'done'
    runId: string
    taskId?: string | null
    scopeId?: string | null
    durationMs: number
    toolCallsUsed: number
    initiator: string
    projectionPatch?: Record<string, unknown> | null
    terminalReason?: string | null
    /** EP2-Q3 — the final assistant text as emitted to the user (incl. the
     *  default-text fallback branch). Q4a generates the response-digest
     *  proof from this INSIDE finalizeRunOutcome, before the verdict. */
    finalText?: string | null
  }
  | {
    kind: 'checkpoint'
    runId: string
    taskId?: string | null
    scopeId?: string | null
    continuationHandle: string | null
    durationMs: number
    toolCallsUsed: number
    initiator: string
    projectionPatch?: Record<string, unknown> | null
    terminalReason?: string | null
    /** EP2-Q3 — see the done variant. */
    finalText?: string | null
  }
  | {
    kind: 'error' | 'cancelled' | 'preempted' | 'interrupted'
    runId: string
    taskId?: string | null
    scopeId?: string | null
    durationMs: number
    toolCallsUsed: number
    initiator: string
    terminalReason: string
    projectionPatch?: Record<string, unknown> | null
  }

export interface RunMetaRepositoryLike {
  get(runId: string): unknown | null
  create(input: Record<string, unknown>): unknown
  update(runId: string, patch: Record<string, unknown>): unknown
}

export interface RunFinalizerDeps {
  runMetaRepository?: RunMetaRepositoryLike | null
  writeProjectionTerminalPatch?: (
    projectionPatch: Record<string, unknown> | null,
    terminalReason: string,
  ) => void | Promise<void>
  writeRunCloseMetric: (metric: RunCloseMetric) => void
  /** EP2-Q4a — projection store for shadow adjudication (CheckIn + proofs).
   *  Absent = adjudication skipped (legacy callers unchanged). */
  taskProjectionStore?: {
    get(taskId: string): TaskProjectionRecord | null
    update(taskId: string, patch: Partial<TaskProjectionRecord>, options?: { silent?: boolean; reasonHint?: string }): void
  } | null
  /** EP2-Q4a — injectable clock for the adjudication timestamp. */
  now?: () => Date
}

export function writeRunCloseMetric(metric: RunCloseMetric): void {
  logAgentMetric('run_close', {
    runId: metric.runId,
    terminalReason: metric.terminalReason,
    initiator: metric.initiator,
    toolCallsUsed: metric.toolCallsUsed,
    durationMs: metric.durationMs,
  })
}

export const defaultRunFinalizerDeps: RunFinalizerDeps = {
  writeRunCloseMetric,
}

export function buildTerminalProjectionPatch(params: {
  nextTaskId: string
  updatedAt: string
}): Partial<TaskProjectionRecord> {
  return {
    status: 'killed',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskSummary: '已被新消息接管',
    // killed-by-supersede is terminal, not blocked — blockedReason stays null
    // (legacy supersede contract, see task-projection-supersede.test.ts)
    blockedReason: null,
    resumableActions: ['none'],
    continuationRef: {
      taskId: params.nextTaskId,
      blockerType: 'superseded',
    },
    updatedAt: params.updatedAt,
  }
}

export async function finalizeRunOutcome(outcome: RunOutcome, deps: RunFinalizerDeps): Promise<void> {
  if (outcome.kind === 'done') {
    await writeTerminalOutcome(outcome, deps, 'done', outcome.terminalReason || 'done')
    return
  }

  if (outcome.kind === 'checkpoint') {
    if (!isValidContinuationHandle(outcome.continuationHandle)) {
      writeRunMetaOutcome(outcome, deps, 'error', 'checkpoint_degraded_error')
      deps.writeRunCloseMetric(toRunCloseMetric(outcome, 'checkpoint_degraded_error'))
      throw new Error('checkpoint outcome requires a valid continuation handle')
    }

    await writeTerminalOutcome(outcome, deps, 'checkpoint', outcome.terminalReason || 'checkpoint')
    return
  }

  await writeTerminalOutcome(
    outcome,
    deps,
    statusFromOutcomeKind(outcome.kind),
    outcome.terminalReason,
  )
}

function statusFromOutcomeKind(kind: Exclude<RunOutcome['kind'], 'done' | 'checkpoint'>): string {
  if (kind === 'error') return 'error'
  if (kind === 'interrupted') return 'interrupted'
  return 'cancelled'
}

async function writeTerminalOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: string,
  terminalReason: string,
): Promise<void> {
  writeRunMetaOutcome(outcome, deps, status, terminalReason)
  recordShadowAdjudication(outcome, deps, status, terminalReason)
  if (deps.writeProjectionTerminalPatch) {
    await deps.writeProjectionTerminalPatch(outcome.projectionPatch || null, terminalReason)
  }
  deps.writeRunCloseMetric(toRunCloseMetric(outcome, terminalReason))
}

/**
 * EP2-Q4a — shadow adjudication INSIDE the finalize funnel. Ordering hard
 * clause: the response-digest proof lands on the projection FIRST, then the
 * adjudicator judges with the refreshed proof set — a direct_answer run can
 * never be structurally zero-proof at judging time. Shadow semantics: the
 * verdict NEVER mutates lifecycle status/terminal state; divergence between
 * verdict and the actual terminal status is recorded as the
 * `adjudicator_shadow_divergence` metric (Q4b promotion evidence).
 * Failures degrade to a metric — adjudication never blocks finalize.
 */
function recordShadowAdjudication(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: string,
  terminalReason: string,
): void {
  const store = deps.taskProjectionStore
  const taskId = outcome.taskId
  if (!store || !taskId) return
  try {
    const projection = store.get(taskId)
    if (!projection) return
    const now = deps.now ? deps.now() : new Date()

    // ① response digest proof FIRST (Q3 collector; empty finalText → null)
    const finalText = outcome.kind === 'done' || outcome.kind === 'checkpoint' ? outcome.finalText : null
    const digestProof = collectResponseDigestProof(finalText ?? null, now)
    const proofRefs = digestProof
      ? appendProofRefs(projection.proofRefs ?? [], [digestProof])
      : (Array.isArray(projection.proofRefs) ? projection.proofRefs : [])

    // ② verdict SECOND, judging the refreshed proof set
    const criteria = resolveCriteria(projection.taskType as TaskType, String(projection.module || 'system'))
    const { verdict, checkIn } = adjudicateTerminalOutcome({
      terminalStatus: status,
      terminalReason,
      criteria: criteria.items,
      proofs: proofRefs,
      now,
    })

    // ③ CheckIn + proofs land on the projection — lifecycle fields untouched
    store.update(taskId, {
      proofRefs,
      checkins: appendCheckIns(projection.checkins ?? [], checkIn),
    }, { silent: true, reasonHint: 'shadow_adjudication' })

    // ④ divergence metric when the verdict disagrees with the actual terminal
    if (status === 'done' && verdict !== 'accept') {
      logAgentMetric('adjudicator_shadow_divergence', {
        runId: outcome.runId,
        taskId,
        taskType: projection.taskType,
        verdict,
        actualStatus: status,
        terminalReason,
        proofCount: checkIn.proofCount,
        blockers: checkIn.blockers,
      })
    }
  } catch (error) {
    logAgentMetric('adjudication_failed', {
      runId: outcome.runId,
      taskId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

function writeRunMetaOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: string,
  terminalReason: string,
): void {
  const repository = deps.runMetaRepository
  if (!repository) return
  const patch = {
    runId: outcome.runId,
    taskId: outcome.taskId ?? null,
    scopeId: outcome.scopeId ?? null,
    status,
    terminalReason,
    initiator: outcome.initiator,
    durationMs: outcome.durationMs,
  }
  if (repository.get(outcome.runId)) {
    repository.update(outcome.runId, patch)
  } else {
    repository.create(patch)
  }
}

function toRunCloseMetric(
  outcome: RunOutcome,
  terminalReason: string,
): RunCloseMetric {
  return {
    runId: outcome.runId,
    terminalReason,
    initiator: outcome.initiator,
    toolCallsUsed: outcome.toolCallsUsed,
    durationMs: outcome.durationMs,
  }
}

function isValidContinuationHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.trim().length > 0
}
