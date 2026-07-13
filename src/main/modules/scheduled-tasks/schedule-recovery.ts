import type { ScheduledTaskOccurrence } from './schedule-repository'

export interface ScheduleRestartRecoveryDeps {
  markInterrupted: (occurrence: ScheduledTaskOccurrence) => void
  enqueue: (occurrence: ScheduledTaskOccurrence) => void
}

export function recoverScheduledOccurrenceAfterRestart(
  occurrence: ScheduledTaskOccurrence,
  deps: ScheduleRestartRecoveryDeps,
): 'interrupted' | 'requeued' {
  if (occurrence.claimStatus === 'dispatching') {
    deps.markInterrupted(occurrence)
    return 'interrupted'
  }
  deps.enqueue(occurrence)
  return 'requeued'
}
