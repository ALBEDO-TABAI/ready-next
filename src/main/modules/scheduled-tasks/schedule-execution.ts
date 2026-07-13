import type { ScheduleBlockedReason, ScheduledTurnEnvelope } from '../../../shared/scheduled-tasks'
import type { ScheduledTaskDefinition, ScheduledTaskOccurrence } from './schedule-repository'

export interface ScheduledDispatchPayload {
  scopeId: string
  agent: string
  message: string
  requestId: string
  taskId: string
  workspaceRoots: string[]
  envelope: ScheduledTurnEnvelope
}

export interface ScheduleExecutionDeps {
  getSchedule: (id: string) => ScheduledTaskDefinition | null
  scopeExists: (scopeId: string) => boolean
  agentAvailable: (agentId: string) => boolean
  workspaceAvailable: (root: string) => boolean
  pauseSchedule: (id: string, reason: ScheduleBlockedReason) => void
  markDispatching: (occurrenceId: string, runId: string, taskId: string) => boolean
  markDispatched: (occurrenceId: string, runId: string, taskId: string) => void
  markFailed: (occurrenceId: string, errorKind: string, errorMessage: string) => void
  send: (payload: ScheduledDispatchPayload) => Promise<{ success: boolean; error?: string; errorKind?: string }>
  log?: (message: string) => void
}

function blockedReason(
  schedule: ScheduledTaskDefinition,
  deps: ScheduleExecutionDeps,
): ScheduleBlockedReason | null {
  if (!schedule.scopeId || !deps.scopeExists(schedule.scopeId)) return 'blocked_scope_missing'
  if (!deps.agentAvailable(schedule.agentId)) return 'blocked_agent_unavailable'
  if (schedule.workspaceRoots.some((root) => !deps.workspaceAvailable(root))) {
    return 'blocked_workspace_unavailable'
  }
  return null
}

export async function dispatchScheduledOccurrence(
  occurrence: ScheduledTaskOccurrence,
  deps: ScheduleExecutionDeps,
): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  const schedule = deps.getSchedule(occurrence.scheduleId)
  // A durable occurrence was claimed while the schedule was enabled. The
  // definition may be disabled immediately afterwards to stop future times
  // (one-shot and count-limited schedules), but the already-claimed work must
  // still finish. Soft deletion remains unavailable because repository.get()
  // no longer returns the definition.
  if (!schedule) {
    deps.markFailed(occurrence.id, 'schedule_unavailable', 'Scheduled task is unavailable')
    return { success: false, error: 'Scheduled task is unavailable', errorKind: 'schedule_unavailable' }
  }
  const blocked = blockedReason(schedule, deps)
  if (blocked) {
    deps.pauseSchedule(schedule.id, blocked)
    deps.markFailed(occurrence.id, blocked, blocked)
    return { success: false, error: blocked, errorKind: blocked }
  }

  const runId = `run-scheduled-${occurrence.id}`
  const taskId = `task-scheduled-${occurrence.id}`
  if (!deps.markDispatching(occurrence.id, runId, taskId)) {
    return { success: false, error: 'Occurrence is no longer queued', errorKind: 'occurrence_not_queued' }
  }
  const envelope: ScheduledTurnEnvelope = {
    scheduleId: schedule.id,
    occurrenceId: occurrence.id,
    scheduledFor: occurrence.scheduledFor,
    triggeredAt: occurrence.triggeredAt,
    triggerSource: occurrence.triggerSource,
    delayMs: occurrence.delayMs,
    userRequestVerbatim: schedule.instruction,
  }
  deps.log?.(`scheduledTasks.dispatch scheduleId=${schedule.id} occurrenceId=${occurrence.id} runId=${runId}`)
  try {
    const result = await deps.send({
      scopeId: schedule.scopeId!,
      agent: schedule.agentId,
      message: schedule.instruction,
      requestId: runId,
      taskId,
      workspaceRoots: schedule.workspaceRoots,
      envelope,
    })
    if (!result.success) {
      deps.markFailed(occurrence.id, result.errorKind || 'dispatch_failed', result.error || 'Dispatch failed')
      return result
    }
    deps.markDispatched(occurrence.id, runId, taskId)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.markFailed(occurrence.id, 'dispatch_failed', message)
    return { success: false, error: message, errorKind: 'dispatch_failed' }
  }
}
