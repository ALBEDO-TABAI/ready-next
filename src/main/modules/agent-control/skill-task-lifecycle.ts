import type {
  ScopeRunResumableAction,
  ScopeRunTaskContinuation,
} from './types'
import type {
  SkillTaskLifecycleReason,
  SkillTaskLifecycleSignal,
  SkillTaskLifecycleState,
} from './run-contracts'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function setStringField(
  target: ScopeRunTaskContinuation,
  key: keyof ScopeRunTaskContinuation,
  value: unknown,
): void {
  const next = nonEmpty(value)
  if (next) target[key] = next
}

function readResumeString(
  snapshot: SkillTaskSupervisorSnapshot,
  key: string,
): string | null {
  return snapshot.resumePayload ? nonEmpty(snapshot.resumePayload[key]) : null
}

export function isRelevantSkillTaskSnapshot(snapshot: SkillTaskSupervisorSnapshot | null | undefined): boolean {
  if (!snapshot) return false
  if (snapshot.taskRunId || snapshot.detachedTaskId || snapshot.skillId) return true
  if (snapshot.runStatePath || snapshot.outputDir || snapshot.progressFingerprint) return true
  return Boolean(snapshot.resumePayload && Object.keys(snapshot.resumePayload).length > 0)
}

function buildTaskContinuation(
  snapshot: SkillTaskSupervisorSnapshot,
  reason: SkillTaskLifecycleReason,
): ScopeRunTaskContinuation {
  const continuation: ScopeRunTaskContinuation = {}
  const taskRunId = snapshot.taskRunId || readResumeString(snapshot, 'taskRunId')
  const detachedTaskId = snapshot.detachedTaskId || readResumeString(snapshot, 'detachedTaskId')
  const taskId = taskRunId || detachedTaskId || readResumeString(snapshot, 'taskId')

  setStringField(continuation, 'taskId', taskId)
  setStringField(continuation, 'taskRunId', taskRunId)
  setStringField(continuation, 'detachedTaskId', detachedTaskId)
  setStringField(continuation, 'jobId', readResumeString(snapshot, 'jobId'))
  setStringField(continuation, 'skillId', snapshot.skillId || readResumeString(snapshot, 'skillId'))
  setStringField(continuation, 'action', snapshot.action || readResumeString(snapshot, 'action'))
  setStringField(continuation, 'outputDir', snapshot.outputDir || readResumeString(snapshot, 'outputDir'))
  setStringField(continuation, 'runStatePath', snapshot.runStatePath || readResumeString(snapshot, 'runStatePath'))
  setStringField(continuation, 'progressFingerprint', snapshot.progressFingerprint)
  setStringField(continuation, 'pauseReason', snapshot.pauseReason || reason)
  setStringField(continuation, 'blockerType', reason)
  setStringField(continuation, 'todoTitle', snapshot.action || snapshot.skillId)

  return continuation
}

function hasContinuationHandle(continuation: ScopeRunTaskContinuation): boolean {
  return Boolean(
    continuation.taskId
      || continuation.taskRunId
      || continuation.detachedTaskId
      || continuation.runStatePath
      || continuation.outputDir
      || continuation.skillId,
  )
}

function buildBlockedReason(snapshot: SkillTaskSupervisorSnapshot, fallback: string): string {
  const blocker = snapshot.blockers.find((item) => nonEmpty(item))
  if (blocker) return blocker
  if (snapshot.progress.currentStage) return `${fallback} · ${snapshot.progress.currentStage}`
  return fallback
}

function buildCheckpointSignal(params: {
  snapshot: SkillTaskSupervisorSnapshot
  reason: SkillTaskLifecycleReason
  state: SkillTaskLifecycleState
  blockedReason: string
  actions: ScopeRunResumableAction[]
}): SkillTaskLifecycleSignal | null {
  const taskContinuation = buildTaskContinuation(params.snapshot, params.reason)
  if (!hasContinuationHandle(taskContinuation)) return null
  return {
    state: params.state,
    reason: params.reason,
    phase: 'checkpoint',
    interactionState: 'suspended',
    waitingFor: 'background',
    resumableActions: params.actions,
    blockedReason: params.blockedReason,
    taskContinuation,
  }
}

export function buildSkillTaskLifecycleSignal(params: {
  snapshot: SkillTaskSupervisorSnapshot | null | undefined
  reason: SkillTaskLifecycleReason
}): SkillTaskLifecycleSignal | null {
  const { reason } = params
  if (!params.snapshot || !isRelevantSkillTaskSnapshot(params.snapshot)) return null
  const snapshot = params.snapshot

  if (snapshot.closeAllowed && snapshot.status === 'done') {
    return {
      state: 'done',
      reason: 'completed',
      phase: 'done',
      interactionState: 'running',
      waitingFor: 'none',
      resumableActions: ['none'],
      blockedReason: null,
      taskContinuation: null,
    }
  }

  if (snapshot.closeAllowed && snapshot.status === 'cancelled') {
    const taskContinuation = buildTaskContinuation(snapshot, 'cancelled')
    return {
      state: 'cancelled',
      reason: 'cancelled',
      phase: 'cancelled',
      interactionState: 'suspended',
      waitingFor: 'none',
      resumableActions: ['none'],
      blockedReason: null,
      taskContinuation: hasContinuationHandle(taskContinuation) ? taskContinuation : null,
    }
  }

  if (snapshot.closeAllowed && snapshot.status === 'failed') {
    const taskContinuation = buildTaskContinuation(snapshot, 'failed')
    return {
      state: 'failed',
      reason: 'failed',
      phase: 'error',
      interactionState: 'suspended',
      waitingFor: 'none',
      resumableActions: ['retry', 'cancel'],
      blockedReason: buildBlockedReason(snapshot, '技能任务失败'),
      taskContinuation: hasContinuationHandle(taskContinuation) ? taskContinuation : null,
    }
  }

  if (reason === 'budget_exhausted') {
    return buildCheckpointSignal({
      snapshot,
      reason,
      state: 'budget_paused',
      actions: ['continue', 'retry', 'cancel'],
      blockedReason: buildBlockedReason(snapshot, '本轮预算已用完，技能任务已暂停，可继续执行'),
    })
  }

  if (snapshot.status === 'blocked') {
    return buildCheckpointSignal({
      snapshot,
      reason: 'blocked',
      state: 'blocked',
      actions: ['continue', 'cancel'],
      blockedReason: buildBlockedReason(snapshot, '技能任务等待继续处理'),
    })
  }

  if (snapshot.status === 'recoverable_paused') {
    return buildCheckpointSignal({
      snapshot,
      reason: 'recoverable_paused',
      state: 'budget_paused',
      actions: ['continue', 'retry', 'cancel'],
      blockedReason: buildBlockedReason(snapshot, '技能任务未在后台运行，可继续执行'),
    })
  }

  if (snapshot.hasLiveWork || snapshot.hasRecentProgress || snapshot.status === 'background_running' || snapshot.status === 'running') {
    return buildCheckpointSignal({
      snapshot,
      reason: 'background_running',
      state: 'background_running',
      actions: ['continue', 'cancel'],
      blockedReason: buildBlockedReason(snapshot, '技能任务仍在后台运行'),
    })
  }

  return null
}
