import type { RSSDigestStore } from '../database/rss-digest-store'
import { ScheduleCoordinator } from '../scheduled-tasks/schedule-coordinator'
import { ScheduleClock } from '../scheduled-tasks/schedule-clock'
import { getNextScheduleRuns } from '../scheduled-tasks/schedule-next-run'
import { RSSDigestSettingsSchema, type RSSDigestSettings, type RSSDigestFetch } from '../../../shared/rss-digests'

export function digestBoundaries(now: number, timezone: string, localTime: string): { previous: number; latest: number; next: number } {
  // The horizon only locates calendar occurrences; editions never advance by a fixed 24 hours.
  const runs = getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'daily', localTime }, timezone, after: new Date(now - 4 * 86400000).toISOString(), count: 8 }).map(Date.parse)
  const due = runs.filter((at) => at <= now)
  return { previous: due[due.length - 2], latest: due[due.length - 1], next: runs.find((at) => at > now)! }
}

export class RSSDigestService {
  private readonly coordinator: ScheduleCoordinator
  constructor(private readonly deps: { store: RSSDigestStore; now(): number; timezone(): string; notify(): void; fetches?(): RSSDigestFetch[]; clock?: ScheduleClock }) {
    this.coordinator = new ScheduleCoordinator({ now: () => new Date(deps.now()).toISOString(), clock: deps.clock,
      // Publication and advancing the schedule are synchronous in one database transaction, so no detached occurrence needs recovery.
      repository: { listRecoverable: () => [], listEnabled: () => {
        const state = deps.store.schedule()
        return state?.enabled ? [{ id: 'rss-daily', spec: { kind: 'calendar', frequency: 'daily', localTime: state.localTime }, timezone: state.timezone,
          nextRunAt: state.nextRunAt, missedPolicy: 'coalesce_latest', coalesceMaxDelayMs: null, claimedExecutionCount: 0 }] : []
      }, reconcile: (input) => {
        const state = deps.store.schedule()!
        const occurrence = input.occurrences.find((o) => o.claimStatus === 'queued')
        const cutoff = occurrence ? Date.parse(occurrence.scheduledFor) : null
        const previous = cutoff === null ? 0 : digestBoundaries(cutoff, state.timezone, state.localTime).previous
        deps.store.reconcileDaily(cutoff, previous, input.nextRunAt, deps.now(), deps.fetches?.() || [])
        deps.notify()
        return []
      } }, enqueue: () => {},
    })
  }
  private initialize(): void {
    const state = this.deps.store.schedule(), timezone = this.deps.timezone(), now = this.deps.now()
    if (!state || state.timezone !== timezone || state.error) {
      const settings = state || { enabled: true, localTime: '08:00' }, boundaries = digestBoundaries(now, timezone, settings.localTime)
      const last = this.deps.store.lastDailyEnd()
      this.deps.store.configureSchedule(settings, timezone, new Date(last !== null && last >= boundaries.latest ? boundaries.next : boundaries.latest).toISOString())
    }
  }
  async start(): Promise<void> { this.initialize(); await this.coordinator.start() }
  stop(): void { this.coordinator.stop() }
  async resume(): Promise<void> { this.initialize(); await this.coordinator.reconcile('resume') }
  async configure(input: RSSDigestSettings): Promise<void> {
    const settings = RSSDigestSettingsSchema.parse(input), timezone = this.deps.timezone(), boundaries = digestBoundaries(this.deps.now(), timezone, settings.localTime)
    // Editing delivery time changes the next future deadline, not the identity of an already published edition.
    this.deps.store.configureSchedule(settings, timezone, new Date(boundaries.next).toISOString())
    await this.coordinator.reschedule(); this.deps.notify()
  }
}
