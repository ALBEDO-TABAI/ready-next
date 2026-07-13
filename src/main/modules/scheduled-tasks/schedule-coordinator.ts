import type {
  ScheduleMissedPolicy,
  ScheduleOccurrenceClaimStatus,
  ScheduleSpecV1,
  ScheduleTriggerSource,
} from '../../../shared/scheduled-tasks'
import { getNextScheduleRun } from './schedule-next-run'
import { reconcileMissedOccurrences } from './schedule-occurrence-state'
import { ScheduleClock } from './schedule-clock'

export interface CoordinatedSchedule {
  id: string
  spec: ScheduleSpecV1
  timezone: string
  nextRunAt: string | null
  missedPolicy: ScheduleMissedPolicy
  claimedExecutionCount: number
}

export interface CoordinatedOccurrence {
  id: string
  scheduleId: string
  scheduledFor: string
  claimStatus: ScheduleOccurrenceClaimStatus
}

export interface ScheduleCoordinatorRepository {
  listEnabled(): CoordinatedSchedule[]
  reconcile(input: {
    scheduleId: string
    triggerSource: Exclude<ScheduleTriggerSource, 'manual'>
    triggeredAt: string
    nextRunAt: string | null
    disableAfterReconcile?: boolean
    occurrences: Array<{
      scheduledFor: string
      claimStatus: 'queued' | 'skipped_missed' | 'skipped_coalesced'
      delayMs: number
    }>
  }): CoordinatedOccurrence[]
  listRecoverable(): CoordinatedOccurrence[]
}

export interface ScheduleCoordinatorDeps {
  repository: ScheduleCoordinatorRepository
  enqueue: (occurrence: CoordinatedOccurrence) => void
  clock?: ScheduleClock
  now?: () => string
  log?: (message: string) => void
}

const MAX_RECONCILE_OCCURRENCES = 10_000

export class ScheduleCoordinator {
  private readonly clock: ScheduleClock
  private started = false
  private reconciling: Promise<void> | null = null
  private pendingSource: Exclude<ScheduleTriggerSource, 'manual'> | null = null

  constructor(private readonly deps: ScheduleCoordinatorDeps) {
    this.clock = deps.clock ?? new ScheduleClock()
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    for (const occurrence of this.deps.repository.listRecoverable()) this.deps.enqueue(occurrence)
    await this.reconcile('startup')
  }

  stop(): void {
    this.started = false
    this.clock.cancel()
  }

  async reschedule(): Promise<void> {
    if (!this.started) return
    await this.reconcile('timer')
  }

  async reconcile(source: Exclude<ScheduleTriggerSource, 'manual'>): Promise<void> {
    if (this.reconciling) {
      this.pendingSource = source
      return this.reconciling
    }
    this.reconciling = (async () => {
      let nextSource: Exclude<ScheduleTriggerSource, 'manual'> | null = source
      while (nextSource) {
        await this.performReconcile(nextSource)
        nextSource = this.pendingSource
        this.pendingSource = null
      }
    })().finally(() => { this.reconciling = null })
    return this.reconciling
  }

  private async performReconcile(source: Exclude<ScheduleTriggerSource, 'manual'>): Promise<void> {
    this.clock.cancel()
    const now = this.deps.now?.() ?? new Date().toISOString()
    let nearest: string | null = null

    for (const schedule of this.deps.repository.listEnabled()) {
      const executionLimit = schedule.spec.kind === 'calendar' ? schedule.spec.count : undefined
      const remainingExecutions = executionLimit === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, executionLimit - schedule.claimedExecutionCount)
      let scheduledFor = schedule.nextRunAt
      const due: string[] = []
      if (!scheduledFor) {
        scheduledFor = getNextScheduleRun({ spec: schedule.spec, timezone: schedule.timezone, after: now })
      } else {
        while (scheduledFor && Date.parse(scheduledFor) <= Date.parse(now)) {
          due.push(scheduledFor)
          if (due.length >= MAX_RECONCILE_OCCURRENCES) {
            throw new Error(`Schedule ${schedule.id} exceeded reconcile limit`)
          }
          scheduledFor = getNextScheduleRun({
            spec: schedule.spec,
            timezone: schedule.timezone,
            after: scheduledFor,
          })
        }
      }

      let decisions = reconcileMissedOccurrences({
        dueScheduledFor: due,
        now,
        recurring: schedule.spec.kind !== 'once',
        policy: schedule.missedPolicy,
      })
      if (Number.isFinite(remainingExecutions)) {
        let queued = 0
        decisions = decisions.filter((decision) => {
          if (decision.status !== 'queued') return true
          queued += 1
          return queued <= remainingExecutions
        })
      }
      const newlyClaimed = decisions.filter((decision) => decision.status === 'queued').length
      const limitReached = Number.isFinite(remainingExecutions)
        && newlyClaimed >= remainingExecutions
      const onceConsumed = schedule.spec.kind === 'once' && due.length > 0
      if (limitReached || onceConsumed) scheduledFor = null
      const claimed = this.deps.repository.reconcile({
        scheduleId: schedule.id,
        triggerSource: source,
        triggeredAt: now,
        nextRunAt: scheduledFor,
        disableAfterReconcile: limitReached || onceConsumed,
        occurrences: decisions.map(({ status, ...item }) => ({ ...item, claimStatus: status })),
      })
      for (const occurrence of claimed) {
        if (occurrence.claimStatus === 'queued') this.deps.enqueue(occurrence)
      }
      if (scheduledFor && (!nearest || Date.parse(scheduledFor) < Date.parse(nearest))) nearest = scheduledFor
    }

    if (!this.started) return
    this.deps.log?.(`scheduledTasks.reconcile source=${source} next=${nearest ?? '<none>'}`)
    this.clock.schedule(nearest, () => { void this.reconcile('timer') })
  }
}
