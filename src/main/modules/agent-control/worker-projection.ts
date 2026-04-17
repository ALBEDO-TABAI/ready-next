import type { RunProjectionPatch, TaskInteractionState } from './run-contracts'
import type { ScopeRunEventPayload, ScopeRunTaskStep } from './types'

function cloneSteps(steps: ScopeRunTaskStep[] | null | undefined): ScopeRunTaskStep[] {
  return (steps || []).map((step) => ({ ...step }))
}

export function buildWorkerOverviewSteps(params: {
  items: Array<{ id: string; title: string }>
  currentStepId?: string | null
  completedStepIds?: string[]
  blockedStepId?: string | null
  updatedAt?: string
}): ScopeRunTaskStep[] {
  const completed = new Set(params.completedStepIds || [])
  const currentStepId = params.currentStepId || null
  const blockedStepId = params.blockedStepId || null
  const updatedAt = params.updatedAt || new Date().toISOString()

  return params.items.map((item) => ({
    id: item.id,
    title: item.title,
    status: blockedStepId === item.id
      ? 'blocked'
      : completed.has(item.id)
        ? 'done'
        : currentStepId === item.id
          ? 'running'
          : 'pending',
    updatedAt,
  }))
}

export function buildWorkerParentProjectionPatch(params: {
  taskTitle: string
  taskSummary: string
  steps: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: ScopeRunEventPayload['waitingFor']
  resumableActions?: ScopeRunEventPayload['resumableActions']
  blockedReason?: string | null
}): RunProjectionPatch {
  return {
    taskTitle: params.taskTitle,
    taskSummary: params.taskSummary,
    steps: cloneSteps(params.steps),
    currentStepId: params.currentStepId || null,
    waitingFor: params.waitingFor || 'none',
    resumableActions: params.resumableActions || ['cancel'],
    blockedReason: params.blockedReason || null,
  }
}

export function buildWorkerChildProjectionPatch(params: {
  module: NonNullable<ScopeRunEventPayload['module']>
  taskTitle: string
  taskSummary: string
  steps?: ScopeRunTaskStep[] | null
  currentStepId?: string | null
  waitingFor?: ScopeRunEventPayload['waitingFor']
  resumableActions?: ScopeRunEventPayload['resumableActions']
  blockedReason?: string | null
  interactionState?: TaskInteractionState
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
}): Record<string, unknown> {
  return {
    module: params.module,
    taskTitle: params.taskTitle,
    taskSummary: params.taskSummary,
    steps: cloneSteps(params.steps),
    currentStepId: params.currentStepId || null,
    waitingFor: params.waitingFor || 'none',
    resumableActions: params.resumableActions || ['cancel'],
    blockedReason: params.blockedReason || null,
    interactionState: params.interactionState || 'running',
    recentArtifacts: params.recentArtifacts || [],
  }
}
