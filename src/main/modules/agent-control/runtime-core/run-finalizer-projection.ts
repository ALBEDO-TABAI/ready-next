import type { TaskProjectionRecord } from '../contracts/run-contracts'
import { canResumeAsUserPoint } from '../contracts/resume-handle'

export function buildTerminalProjectionPatch(params: {
  nextTaskId: string
  updatedAt: string
}): Partial<TaskProjectionRecord> {
  return {
    status: 'killed',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskSummary: '已被新消息接管',
    blockedReason: null,
    resumableActions: ['none'],
    continuationRef: {
      taskId: params.nextTaskId,
      blockerType: 'superseded'
    },
    updatedAt: params.updatedAt
  }
}

export function buildSupersededChildTerminalProjectionPatch(params: {
  baseContinuationRef: TaskProjectionRecord['continuationRef']
  supersededByChildRunId: string
  steps: TaskProjectionRecord['steps']
}): Partial<TaskProjectionRecord> {
  return {
    status: 'killed',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskSummary: '已由后续技能子任务完成',
    blockedReason: null,
    degradationReason: 'superseded_by_child_run',
    resumableActions: ['none'],
    continuationRef: {
      ...(params.baseContinuationRef || {}),
      blockerType: 'superseded',
      pauseReason: 'superseded',
      supersededByChildRunId: params.supersededByChildRunId
    } as TaskProjectionRecord['continuationRef'] & { supersededByChildRunId: string },
    steps: params.steps
  }
}

export function buildManualSuspendProjectionPatch(params: {
  projection?: TaskProjectionRecord | null
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: TaskProjectionRecord['steps'] | null
  currentStepId?: string | null
  continuationRef?: TaskProjectionRecord['continuationRef'] | null
  budget?: TaskProjectionRecord['budget'] | null
  budgetUsagePercent?: number | null
  budgetWarningLevel?: TaskProjectionRecord['budgetWarningLevel'] | null
  recoveryHistory?: TaskProjectionRecord['recoveryHistory'] | null
  updatedAt: string
}): Partial<TaskProjectionRecord> {
  const projection = params.projection || null
  const continuationRef = params.continuationRef ?? projection?.continuationRef ?? null
  const canResume = canResumeAsUserPoint(continuationRef)
  return {
    status: canResume ? 'recoverable_paused' : 'blocked',
    interactionState: 'suspended',
    waitingFor: 'none',
    taskTitle: params.taskTitle ?? projection?.taskTitle ?? null,
    taskSummary: params.taskSummary ?? projection?.taskSummary ?? '任务已暂停；这是历史记录，不会自动继续。',
    steps: params.steps ?? projection?.steps ?? [],
    currentStepId: params.currentStepId ?? projection?.currentStepId ?? null,
    blockedReason: '任务已暂停；这是历史记录，不会自动继续。',
    degradationReason: projection?.degradationReason ?? null,
    resumableActions: canResume ? ['continue', 'cancel'] : ['cancel'],
    continuationRef,
    budget: params.budget ?? projection?.budget ?? null,
    budgetUsagePercent: params.budgetUsagePercent ?? projection?.budgetUsagePercent ?? null,
    budgetWarningLevel: params.budgetWarningLevel ?? projection?.budgetWarningLevel ?? null,
    recoveryHistory: params.recoveryHistory ?? projection?.recoveryHistory ?? [],
    updatedAt: params.updatedAt
  }
}
