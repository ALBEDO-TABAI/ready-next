import type {
  ProjectionTruthSnapshot,
  TaskInteractionState,
  TaskProjectionRecord,
  TaskProjectionStore,
  TaskStep,
} from './run-contracts'
import { buildContinuationStateFromProjection } from './continuation-state'
import { clearContinuationState, rememberContinuationState } from './session-continuity'
import type { ScopeRunEventPayload, ScopeRunSummary } from './types'
import type { RecoveryRecord } from './run-contracts'

function toContinuationUpdatedAt(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function readProjectionTruthPatch(projectionTruth?: ProjectionTruthSnapshot | null): Record<string, unknown> | null {
  let patch: Record<string, unknown> | null = null
  for (const event of projectionTruth?.transcriptEvents || []) {
    if (event.kind !== 'structured_payload' || !event.projectionPatch) continue
    patch = {
      ...(patch || {}),
      ...event.projectionPatch,
    }
  }
  if (projectionTruth?.projectionPatch) {
    patch = {
      ...(patch || {}),
      ...projectionTruth.projectionPatch,
    }
  }
  return patch
}

function resolveTaskId(summary: ScopeRunSummary, payload: ScopeRunEventPayload): string | null {
  return summary.taskId || payload.taskId || summary.taskProjectionId || payload.taskProjectionId || payload.runId || null
}

function isTaskProjectionUniqueRace(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : ''
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'SQLITE_CONSTRAINT'
    || /UNIQUE constraint failed: task_projections\.task_id/.test(message)
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

function mapSteps(summary: ScopeRunSummary, previous?: TaskProjectionRecord | null): TaskStep[] {
  const previousSteps = new Map((previous?.steps || []).map((step) => [step.id, step]))
  return (summary.steps || []).map((step) => {
    const prior = previousSteps.get(step.id)
    return {
      ...prior,
      id: step.id,
      title: step.title || prior?.title,
      description: step.detail || prior?.description || step.title,
      status: step.status ?? prior?.status,
      detail: step.detail ?? prior?.detail ?? null,
      updatedAt: step.updatedAt || prior?.updatedAt,
      childTasks: prior?.childTasks ? prior.childTasks.map((item) => ({ ...item })) : undefined,
    }
  })
}

function resolveStepBudget(summary: ScopeRunSummary) {
  const runtimeStepBudget = summary.executionDiagnostics?.taskBudgetRuntime?.stepBudget
  if (runtimeStepBudget && typeof runtimeStepBudget.maxIterations === 'number') {
    return {
      stepId: runtimeStepBudget.stepId || null,
      maxIterations: runtimeStepBudget.maxIterations,
      remainingIterations: runtimeStepBudget.remainingIterations,
    }
  }
  const candidate = summary.stepBudget || summary.executionDiagnostics?.stepBudget || null
  if (!candidate || typeof candidate.maxIterations !== 'number') return null
  return {
    stepId: candidate.stepId || null,
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

function resolveTaskBudget(summary: ScopeRunSummary) {
  const runtime = summary.executionDiagnostics?.taskBudgetRuntime
  if (runtime) {
    return {
      taskType: runtime.taskType,
      maxIterations: runtime.budget.maxIterations,
      maxToolCalls: runtime.budget.maxToolCalls,
      maxParallelToolGroups: runtime.budget.maxParallelToolGroups,
      reservedToolCalls: runtime.budget.reservedToolCalls || 0,
      iterationsUsed: runtime.usage.iterationsUsed,
      toolCallsUsed: runtime.usage.toolCallsUsed,
      parallelToolGroupsUsed: runtime.usage.parallelToolGroupsUsed,
      stepBudget: resolveStepBudget(summary),
      frozen: runtime.frozen,
      bootstrapBudget: runtime.bootstrapBudget,
    }
  }
  if (!summary.executionDiagnostics?.budget) return null
  return {
    taskType: summary.taskType || 'short_task',
    maxIterations: Number(summary.executionDiagnostics.budget.maxIterations || 0),
    maxToolCalls: Number(summary.executionDiagnostics.budget.maxToolCalls || 0),
    maxParallelToolGroups: Number(summary.executionDiagnostics.budget.maxParallelToolGroups || 0),
    reservedToolCalls: Number(summary.executionDiagnostics.budget.reservedToolCalls || 0),
    iterationsUsed: Number(summary.executionDiagnostics.budget.iterationsUsed || 0),
    toolCallsUsed: Number(summary.executionDiagnostics.budget.toolCallsUsed || 0),
    parallelToolGroupsUsed: Number(summary.executionDiagnostics.budget.parallelToolGroupsUsed || 0),
    stepBudget: resolveStepBudget(summary),
  }
}

function buildArtifactSummary(artifacts: ScopeRunSummary['recentArtifacts'] | undefined): string | null {
  const labels = (artifacts || [])
    .map((artifact) => String(artifact?.label || '').trim())
    .filter(Boolean)
    .slice(-3)
  if (labels.length === 0) return null
  return labels.join('、')
}

function formatChildTaskStatus(status: TaskProjectionRecord['status']): string {
  if (status === 'done') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'blocked') return '待继续'
  if (status === 'queued') return '排队中'
  return '进行中'
}

function stripChildTaskDetail(detail: string | null | undefined): string {
  const raw = String(detail || '').trim()
  if (!raw) return ''
  const marker = ' | 子任务 '
  const markerIndex = raw.indexOf(marker)
  return markerIndex === -1 ? raw : raw.slice(0, markerIndex).trim()
}

function mergeChildTaskIntoParentSteps(
  parent: TaskProjectionRecord,
  child: TaskProjectionRecord,
): TaskStep[] | null {
  if (!child.parentStepId) return null
  let changed = false
  const nextSteps = (parent.steps || []).map((step) => {
    if (step.id !== child.parentStepId) return step
    changed = true
    const childTasks = (step.childTasks || []).filter((item) => item.taskId !== child.taskId)
    const nextChildTasks = [
      ...childTasks,
      {
        taskId: child.taskId,
        taskType: child.taskType,
        status: child.status,
        summary: child.taskSummary || child.blockedReason || null,
        artifactSummary: buildArtifactSummary(child.recentArtifacts),
        updatedAt: child.updatedAt,
      },
    ].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    const baseDetail = stripChildTaskDetail(step.detail)
    const childDetail = nextChildTasks
      .map((item) => {
        const parts = [
          `子任务 ${item.taskId}（${formatChildTaskStatus(item.status)}）`,
          item.summary ? `：${item.summary}` : '',
          item.artifactSummary ? ` · 产物 ${item.artifactSummary}` : '',
        ]
        return parts.join('')
      })
      .join('；')
    return {
      ...step,
      childTasks: nextChildTasks,
      detail: [baseDetail, childDetail].filter(Boolean).join(' | ') || null,
      updatedAt: child.updatedAt || step.updatedAt,
    }
  })
  return changed ? nextSteps : null
}

async function syncParentProjectionFromChild(
  store: TaskProjectionStore,
  child: TaskProjectionRecord,
): Promise<void> {
  if (!child.parentTaskId) return
  const parent = await store.get(child.parentTaskId)
  if (!parent) return
  const nextSteps = mergeChildTaskIntoParentSteps(parent, child)
  if (!nextSteps) return
  await store.update(child.parentTaskId, {
    steps: nextSteps,
    updatedAt: child.updatedAt,
  })
}

export function buildTaskProjectionRecord(
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
  previous?: TaskProjectionRecord | null,
  projectionTruth?: ProjectionTruthSnapshot | null,
): TaskProjectionRecord | null {
  const taskId = resolveTaskId(summary, payload)
  if (!taskId) return null
  const truthPatch = readProjectionTruthPatch(projectionTruth)
  const effectiveSummary: ScopeRunSummary = {
    ...summary,
    taskType: (
      truthPatch?.taskType === 'direct_answer'
      || truthPatch?.taskType === 'short_task'
      || truthPatch?.taskType === 'multi_step_task'
      || truthPatch?.taskType === 'media_task'
      || truthPatch?.taskType === 'continuation'
    )
      ? truthPatch.taskType
      : summary.taskType,
    taskTitle: typeof truthPatch?.taskTitle === 'string' ? truthPatch.taskTitle : summary.taskTitle,
    taskSummary: typeof truthPatch?.taskSummary === 'string' ? truthPatch.taskSummary : summary.taskSummary,
    interactionState: (
      truthPatch?.interactionState === 'running'
      || truthPatch?.interactionState === 'awaiting_clarification'
      || truthPatch?.interactionState === 'awaiting_confirmation'
      || truthPatch?.interactionState === 'human_takeover'
      || truthPatch?.interactionState === 'suspended'
      || truthPatch?.interactionState === 'resuming'
    )
      ? truthPatch.interactionState
      : summary.interactionState,
    steps: Array.isArray(truthPatch?.steps) ? truthPatch.steps as ScopeRunSummary['steps'] : summary.steps,
    currentStepId: typeof truthPatch?.currentStepId === 'string' ? truthPatch.currentStepId : summary.currentStepId,
    waitingFor: (
      truthPatch?.waitingFor === 'input'
      || truthPatch?.waitingFor === 'confirmation'
      || truthPatch?.waitingFor === 'agent_result'
      || truthPatch?.waitingFor === 'background'
      || truthPatch?.waitingFor === 'none'
    )
      ? truthPatch.waitingFor
      : summary.waitingFor,
    resumableActions: Array.isArray(truthPatch?.resumableActions)
      ? truthPatch.resumableActions as ScopeRunSummary['resumableActions']
      : summary.resumableActions,
    taskContinuation: truthPatch?.taskContinuation && typeof truthPatch.taskContinuation === 'object'
      ? truthPatch.taskContinuation as ScopeRunSummary['taskContinuation']
      : summary.taskContinuation,
    blockedReason: typeof truthPatch?.blockedReason === 'string'
      ? truthPatch.blockedReason
      : truthPatch?.blockedReason === null
        ? null
        : summary.blockedReason,
    recentArtifacts: Array.isArray(truthPatch?.recentArtifacts)
      ? truthPatch.recentArtifacts as ScopeRunSummary['recentArtifacts']
      : summary.recentArtifacts,
  }

  return {
    taskId,
    scopeId: effectiveSummary.scopeId,
    runId: payload.runId || previous?.runId || taskId,
    parentTaskId: effectiveSummary.parentTaskId ?? payload.parentTaskId ?? previous?.parentTaskId ?? null,
    parentStepId: effectiveSummary.parentStepId ?? payload.parentStepId ?? previous?.parentStepId ?? null,
    taskType: effectiveSummary.taskType || 'short_task',
    module:
      (typeof truthPatch?.module === 'string' ? truthPatch.module : null)
      || payload.module
      || previous?.module
      || 'system',
    taskTitle: effectiveSummary.taskTitle ?? previous?.taskTitle ?? null,
    taskSummary: effectiveSummary.taskSummary ?? previous?.taskSummary ?? null,
    status: resolveStatus(effectiveSummary),
    interactionState: resolveInteractionState(effectiveSummary),
    steps: mapSteps(effectiveSummary, previous),
    currentStepId: effectiveSummary.currentStepId || null,
    budget: resolveTaskBudget(effectiveSummary),
    budgetUsagePercent: effectiveSummary.budgetUsagePercent ?? effectiveSummary.executionDiagnostics?.budgetUsagePercent ?? null,
    budgetWarningLevel: effectiveSummary.budgetWarningLevel ?? effectiveSummary.executionDiagnostics?.budgetWarningLevel ?? null,
    recoveryHistory: mapRecoveryHistory(effectiveSummary),
    degradationReason: effectiveSummary.degradationReason ?? effectiveSummary.executionDiagnostics?.degradationReason ?? null,
    blockedReason: effectiveSummary.blockedReason || null,
    resumableActions: effectiveSummary.resumableActions || [],
    continuationRef: effectiveSummary.taskContinuation || null,
    recentArtifacts: effectiveSummary.recentArtifacts || previous?.recentArtifacts || [],
    createdAt: previous?.createdAt || payload.timestamp,
    updatedAt: effectiveSummary.updatedAt,
  }
}

export async function syncTaskProjection(
  store: TaskProjectionStore,
  summary: ScopeRunSummary,
  payload: ScopeRunEventPayload,
  projectionTruth?: ProjectionTruthSnapshot | null,
): Promise<TaskProjectionRecord | null> {
  const taskId = resolveTaskId(summary, payload)
  if (!taskId) return null
  const previous = await store.get(taskId)
  let next = buildTaskProjectionRecord(summary, payload, previous, projectionTruth)
  if (!next) return null

  if (previous) {
    await store.update(taskId, next)
  } else {
    try {
      await store.create(next)
    } catch (error) {
      if (!isTaskProjectionUniqueRace(error)) throw error
      const concurrentPrevious = await store.get(taskId)
      if (!concurrentPrevious) throw error
      next = buildTaskProjectionRecord(summary, payload, concurrentPrevious, projectionTruth)
      if (!next) return null
      await store.update(taskId, next)
    }
  }
  if (
    next.status === 'blocked'
    || next.status === 'running'
    || next.interactionState === 'resuming'
    || next.taskType === 'continuation'
  ) {
    rememberContinuationState(next.scopeId, buildContinuationStateFromProjection(next), {
      updatedAt: toContinuationUpdatedAt(next.updatedAt),
    })
  } else {
    clearContinuationState(next.scopeId, next.taskId)
  }
  await syncParentProjectionFromChild(store, next)
  return next
}
