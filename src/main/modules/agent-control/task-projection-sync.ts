import type { TaskInteractionState, TaskProjectionRecord, TaskProjectionStore, TaskStep } from './run-contracts'
import type { ScopeRunEventPayload, ScopeRunSummary } from './types'
import type { RecoveryRecord } from './run-contracts'

function resolveTaskId(summary: ScopeRunSummary, payload: ScopeRunEventPayload): string | null {
  return summary.taskProjectionId || payload.taskProjectionId || payload.runId || null
}

function resolveInteractionState(summary: ScopeRunSummary): TaskInteractionState {
  if (summary.interactionState) return summary.interactionState
  if (summary.phase === 'takeover') return 'human_takeover'
  if (summary.waitingFor === 'confirmation') return 'awaiting_confirmation'
  if (summary.waitingFor === 'input') return 'awaiting_clarification'
  if (summary.phase === 'resuming') return 'resuming'
  return 'running'
}

function resolveStatus(summary: ScopeRunSummary): TaskProjectionRecord['status'] {
  if (summary.phase === 'queued') return 'queued'
  if (summary.phase === 'done') return 'done'
  if (summary.phase === 'error') return 'failed'
  if (summary.phase === 'cancelled') return 'cancelled'
  if (
    summary.phase === 'takeover'
    || summary.blockedReason
    || resolveInteractionState(summary) !== 'running'
    || (summary.waitingFor && summary.waitingFor !== 'none')
  ) {
    return 'blocked'
  }
  return 'running'
}

function mapSteps(summary: ScopeRunSummary): TaskStep[] {
  return (summary.steps || []).map((step) => ({
    id: step.id,
    title: step.title,
    description: step.detail || step.title,
    status: step.status,
    detail: step.detail || null,
    updatedAt: step.updatedAt,
  }))
}

function resolveStepBudget(summary: ScopeRunSummary) {
  const candidate = summary.stepBudget || summary.executionDiagnostics?.stepBudget || null
  if (!candidate || typeof candidate.maxIterations !== 'number') return null
  return {
    maxIterations: candidate.maxIterations,
    remainingIterations: candidate.remainingIterations,
  }
}

function mapRecoveryHistory(summary: ScopeRunSummary): RecoveryRecord[] {
  const entries = summary.recoveryHistory || summary.executionDiagnostics?.recoveryHistory || []
  return entries
    .filter((entry): entry is RecoveryRecord =>
      entry != null
      && (
        entry.kind === 'rate_limit'
        || entry.kind === 'context_overflow'
        || entry.kind === 'timeout_model'
        || entry.kind === 'timeout_tool'
        || entry.kind === 'auth'
        || entry.kind === 'transient'
        || entry.kind === 'host_unavailable'
      )
      && (
        entry.source === 'model_request'
        || entry.source === 'tool_execution'
        || entry.source === 'runtime'
      ),
    )
}

export function buildTaskProjectionRecord(
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
  previous?: TaskProjectionRecord | null,
): TaskProjectionRecord | null {
  const taskId = resolveTaskId(summary, payload)
  if (!taskId) return null

  return {
    taskId,
    scopeId: summary.scopeId,
    runId: payload.runId || previous?.runId || taskId,
    taskType: summary.taskType || 'short_task',
    module: payload.module || previous?.module || 'system',
    status: resolveStatus(summary),
    interactionState: resolveInteractionState(summary),
    steps: mapSteps(summary),
    currentStepId: summary.currentStepId || null,
    budget: summary.executionDiagnostics?.budget
      ? {
        taskType: summary.taskType || 'short_task',
        maxIterations: Number(summary.executionDiagnostics.budget.maxIterations || 0),
        maxToolCalls: Number(summary.executionDiagnostics.budget.maxToolCalls || 0),
        maxParallelToolGroups: Number(summary.executionDiagnostics.budget.maxParallelToolGroups || 0),
        stepBudget: resolveStepBudget(summary),
      }
      : null,
    budgetUsagePercent: summary.budgetUsagePercent ?? summary.executionDiagnostics?.budgetUsagePercent ?? null,
    recoveryHistory: mapRecoveryHistory(summary),
    blockedReason: summary.blockedReason || null,
    resumableActions: summary.resumableActions || [],
    continuationRef: summary.taskContinuation || null,
    createdAt: previous?.createdAt || payload.timestamp,
    updatedAt: summary.updatedAt,
  }
}

export async function syncTaskProjection(
  store: TaskProjectionStore,
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
): Promise<TaskProjectionRecord | null> {
  const taskId = resolveTaskId(summary, payload)
  if (!taskId) return null
  const previous = await store.get(taskId)
  const next = buildTaskProjectionRecord(summary, payload, previous)
  if (!next) return null

  if (previous) {
    await store.update(taskId, next)
  } else {
    await store.create(next)
  }
  return next
}
