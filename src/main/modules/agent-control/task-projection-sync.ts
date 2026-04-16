import type { TaskInteractionState, TaskProjectionRecord, TaskProjectionStore, TaskStep } from './run-contracts'
import type { ScopeRunEventPayload, ScopeRunSummary } from './types'
import type { RecoveryRecord } from './run-contracts'

function resolveTaskId(summary: ScopeRunSummary, payload: ScopeRunEventPayload): string | null {
  return summary.taskId || payload.taskId || summary.taskProjectionId || payload.taskProjectionId || payload.runId || null
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
): TaskProjectionRecord | null {
  const taskId = resolveTaskId(summary, payload)
  if (!taskId) return null

  return {
    taskId,
    scopeId: summary.scopeId,
    runId: payload.runId || previous?.runId || taskId,
    parentTaskId: summary.parentTaskId ?? payload.parentTaskId ?? previous?.parentTaskId ?? null,
    parentStepId: summary.parentStepId ?? payload.parentStepId ?? previous?.parentStepId ?? null,
    taskType: summary.taskType || 'short_task',
    module: payload.module || previous?.module || 'system',
    taskTitle: summary.taskTitle ?? previous?.taskTitle ?? null,
    taskSummary: summary.taskSummary ?? previous?.taskSummary ?? null,
    status: resolveStatus(summary),
    interactionState: resolveInteractionState(summary),
    steps: mapSteps(summary, previous),
    currentStepId: summary.currentStepId || null,
    budget: resolveTaskBudget(summary),
    budgetUsagePercent: summary.budgetUsagePercent ?? summary.executionDiagnostics?.budgetUsagePercent ?? null,
    budgetWarningLevel: summary.budgetWarningLevel ?? summary.executionDiagnostics?.budgetWarningLevel ?? null,
    recoveryHistory: mapRecoveryHistory(summary),
    degradationReason: summary.degradationReason ?? summary.executionDiagnostics?.degradationReason ?? null,
    blockedReason: summary.blockedReason || null,
    resumableActions: summary.resumableActions || [],
    continuationRef: summary.taskContinuation || null,
    recentArtifacts: summary.recentArtifacts || previous?.recentArtifacts || [],
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
  await syncParentProjectionFromChild(store, next)
  return next
}
