import { logAgentMetric } from '../metrics'
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
    blockedReason: '已被新消息接管',
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
  if (deps.writeProjectionTerminalPatch) {
    await deps.writeProjectionTerminalPatch(outcome.projectionPatch || null, terminalReason)
  }
  deps.writeRunCloseMetric(toRunCloseMetric(outcome, terminalReason))
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
