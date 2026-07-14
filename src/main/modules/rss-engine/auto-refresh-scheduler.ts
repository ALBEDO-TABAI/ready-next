import type { RSSAutoRefreshSnapshot } from '../../../shared/rss-auto-refresh'
import type { IpcMain } from 'electron'

export interface RSSAutoRefreshFetchResult {
  success: boolean
  data?: {
    fetched?: number
    message?: string
    running?: boolean
    errors?: string[]
  }
  error?: string
}

type TimerHandle = unknown

export interface RSSAutoRefreshSchedulerDeps {
  now(): number
  readIntervalMs(): number
  readLastCompletedAt(): number | null
  runFetchAll(): Promise<RSSAutoRefreshFetchResult>
  schedule(delayMs: number, callback: () => void | Promise<void>): TimerHandle
  cancel(handle: TimerHandle): void
  publish(snapshot: RSSAutoRefreshSnapshot): void
}

export class RSSAutoRefreshScheduler {
  private timer: TimerHandle | null = null
  private inFlight: Promise<void> | null = null
  private started = false
  private snapshot: RSSAutoRefreshSnapshot = {
    running: false,
    intervalMs: 0,
    nextRunAt: null,
    completedAt: null,
    success: null,
    fetched: 0,
    message: null,
    errors: [],
  }

  constructor(private readonly deps: RSSAutoRefreshSchedulerDeps) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleNext()
  }

  stop(): Promise<void> {
    this.started = false
    this.clearTimer()
    this.snapshot = { ...this.snapshot, running: false, nextRunAt: null }
    return this.inFlight ?? Promise.resolve()
  }

  onSettingChanged(): void {
    if (!this.started) return
    this.scheduleNext()
  }

  onFetchAllCompleted(completedAt: string, result: RSSAutoRefreshFetchResult): void {
    if (!this.started || this.snapshot.running) return
    const outcome = normalizeFetchResult(result)
    const completedAtMs = Date.parse(completedAt)
    const baseAt = Number.isFinite(completedAtMs) ? completedAtMs : this.deps.now()
    this.snapshot = {
      ...this.snapshot,
      running: false,
      completedAt: new Date(baseAt).toISOString(),
      success: outcome.success,
      fetched: outcome.fetched,
      message: outcome.message,
      errors: outcome.errors,
    }
    this.scheduleNext(baseAt)
  }

  getSnapshot(): RSSAutoRefreshSnapshot {
    return { ...this.snapshot, errors: [...this.snapshot.errors] }
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.deps.cancel(this.timer)
    this.timer = null
  }

  private scheduleNext(baseAt?: number): void {
    this.clearTimer()
    const intervalMs = this.deps.readIntervalMs()
    this.snapshot = { ...this.snapshot, intervalMs }

    if (!this.started || intervalMs <= 0) {
      this.snapshot = { ...this.snapshot, nextRunAt: null }
      return
    }

    const now = this.deps.now()
    const lastCompletedAt = baseAt ?? this.deps.readLastCompletedAt()
    const dueAt = lastCompletedAt === null ? now : lastCompletedAt + intervalMs
    const delayMs = Math.max(0, dueAt - now)
    this.snapshot = {
      ...this.snapshot,
      nextRunAt: new Date(now + delayMs).toISOString(),
    }
    this.timer = this.deps.schedule(delayMs, () => this.startDueFetch())
  }

  private startDueFetch(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const run = this.runDueFetch()
    const tracked = run.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null
    })
    this.inFlight = tracked
    return tracked
  }

  private async runDueFetch(): Promise<void> {
    this.timer = null
    if (!this.started || this.snapshot.running) return

    this.snapshot = { ...this.snapshot, running: true, nextRunAt: null }
    let fetched = 0
    let message: string | null = null
    let errors: string[] = []
    let success = false
    let skippedBecauseRunning = false

    try {
      const outcome = normalizeFetchResult(await this.deps.runFetchAll())
      fetched = outcome.fetched
      message = outcome.message
      errors = outcome.errors
      skippedBecauseRunning = outcome.skippedBecauseRunning
      success = outcome.success
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
      errors = [message]
    }

    const completedAtMs = this.deps.now()
    if (!this.started) {
      this.snapshot = { ...this.snapshot, running: false, nextRunAt: null }
      return
    }
    this.snapshot = {
      ...this.snapshot,
      running: false,
      completedAt: skippedBecauseRunning ? this.snapshot.completedAt : new Date(completedAtMs).toISOString(),
      success: skippedBecauseRunning ? this.snapshot.success : success,
      fetched,
      message,
      errors,
    }
    this.scheduleNext(completedAtMs)
    if (!skippedBecauseRunning) {
      this.deps.publish(this.getSnapshot())
    }
  }
}

function normalizeFetchResult(result: RSSAutoRefreshFetchResult): {
  fetched: number
  message: string | null
  errors: string[]
  skippedBecauseRunning: boolean
  success: boolean
} {
  const fetched = Number(result.data?.fetched) || 0
  const message = result.data?.message || result.error || null
  let errors = Array.isArray(result.data?.errors) ? [...result.data.errors] : []
  if (!result.success && result.error) errors.unshift(result.error)
  errors = [...new Set(errors.filter((entry) => entry.trim().length > 0))]
  const skippedBecauseRunning = result.success && result.data?.running === true
  return {
    fetched,
    message,
    errors,
    skippedBecauseRunning,
    success: result.success && errors.length === 0 && !skippedBecauseRunning,
  }
}

export function setupRSSAutoRefreshIPC(
  ipcMain: IpcMain,
  getSnapshot: () => RSSAutoRefreshSnapshot,
): { dispose(): void } {
  try { ipcMain.removeHandler('rss:autoRefreshStatus') } catch { /* handler may not exist */ }
  ipcMain.handle('rss:autoRefreshStatus', async () => ({
    success: true,
    mock: false,
    data: getSnapshot(),
  }))
  return {
    dispose(): void {
      try { ipcMain.removeHandler('rss:autoRefreshStatus') } catch { /* already removed */ }
    },
  }
}
