import { Temporal } from '@js-temporal/polyfill'
import type { RSSDigestStore } from '../database/rss-digest-store'
import { RSSDigestSettingsSchema, type RSSDigestSettings, type RSSDigestFetch } from '../../../shared/rss-digests'

/** One RSS deadline; the retired Agent scheduler is not restored. */
export class RSSDigestClock {
  private handle: NodeJS.Timeout | null = null
  constructor(private readonly deps: { now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}) {}
  schedule(at: string | null, callback: () => void): void {
    this.cancel()
    if (at) this.handle = (this.deps.setTimer || setTimeout)(() => { this.handle = null; callback() }, Math.min(2_147_000_000, Math.max(0, Date.parse(at) - (this.deps.now?.() ?? Date.now()))))
  }
  cancel(): void { if (this.handle) (this.deps.clearTimer || clearTimeout)(this.handle); this.handle = null }
}

export function digestBoundaries(now: number, timezone: string, localTime: string): { previous: number; latest: number; next: number } {
  const date = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone).toPlainDate()
  const [hour, minute] = localTime.split(':').map(Number)
  const runs = [-2, -1, 0, 1, 2].map((offset) => {
    const day = date.add({ days: offset }), desired = day.toPlainDateTime({ hour, minute })
    let candidate = Temporal.ZonedDateTime.from({ timeZone: timezone, year: day.year, month: day.month, day: day.day, hour, minute }, { disambiguation: 'compatible' })
    if (Temporal.PlainDateTime.compare(candidate.toPlainDateTime(), desired) > 0) {
      while (Temporal.PlainDateTime.compare(candidate.subtract({ minutes: 1 }).toPlainDateTime(), desired) >= 0) candidate = candidate.subtract({ minutes: 1 })
    }
    return candidate.epochMilliseconds
  })
  const due = runs.filter((at) => at <= now)
  return { previous: due[due.length - 2], latest: due[due.length - 1], next: runs.find((at) => at > now)! }
}

export class RSSDigestService {
  private readonly clock: RSSDigestClock
  private stopped = false
  constructor(private readonly deps: { store: RSSDigestStore; now(): number; timezone(): string; notify(): void; fetches?(): RSSDigestFetch[]; clock?: RSSDigestClock }) {
    this.clock = deps.clock || new RSSDigestClock({ now: deps.now })
  }
  private initialize(): void {
    const state = this.deps.store.schedule(), timezone = this.deps.timezone(), now = this.deps.now()
    if (!state || state.timezone !== timezone || state.error) {
      const settings = state || { enabled: true, localTime: '08:00' }, boundaries = digestBoundaries(now, timezone, settings.localTime)
      const last = this.deps.store.lastDailyEnd()
      this.deps.store.configureSchedule(settings, timezone, new Date(last !== null && last >= boundaries.latest ? boundaries.next : boundaries.latest).toISOString())
    }
  }
  private reconcile(): void {
    if (this.stopped) return
    this.clock.cancel()
    const state = this.deps.store.schedule()
    if (!state?.enabled) return
    const now = this.deps.now(), bounds = digestBoundaries(now, state.timezone, state.localTime)
    const due = state.nextRunAt !== null && Date.parse(state.nextRunAt) <= now
    const next = due ? new Date(bounds.next).toISOString() : state.nextRunAt
    if (due) this.deps.store.reconcileDaily(bounds.latest, bounds.previous, next, now, this.deps.fetches?.() || [])
    this.clock.schedule(next, () => this.reconcile())
    this.deps.notify()
  }
  async start(): Promise<void> { this.stopped = false; this.initialize(); this.reconcile() }
  stop(): void { this.stopped = true; this.clock.cancel() }
  async resume(): Promise<void> { this.initialize(); this.reconcile() }
  async configure(input: RSSDigestSettings): Promise<void> {
    const settings = RSSDigestSettingsSchema.parse(input), timezone = this.deps.timezone(), boundaries = digestBoundaries(this.deps.now(), timezone, settings.localTime)
    this.deps.store.configureSchedule(settings, timezone, new Date(boundaries.next).toISOString())
    this.reconcile(); this.deps.notify()
  }
}
