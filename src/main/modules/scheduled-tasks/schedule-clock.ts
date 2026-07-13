export interface ScheduleClockHandle {
  cancel(): void
}
export interface ScheduleClockDeps {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
}

const MAX_TIMER_DELAY_MS = 2_147_000_000

export class ScheduleClock {
  private handle: NodeJS.Timeout | null = null

  constructor(private readonly deps: ScheduleClockDeps = {}) {}

  schedule(at: string | null, callback: () => void): ScheduleClockHandle | null {
    this.cancel()
    if (!at) return null
    const target = Date.parse(at)
    if (!Number.isFinite(target)) throw new Error(`Invalid schedule clock time: ${at}`)
    const now = this.deps.now?.() ?? Date.now()
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, target - now))
    const setTimer = this.deps.setTimer ?? setTimeout
    this.handle = setTimer(() => {
      this.handle = null
      callback()
    }, delay)
    return { cancel: () => this.cancel() }
  }

  cancel(): void {
    if (!this.handle) return
    const clearTimer = this.deps.clearTimer ?? clearTimeout
    clearTimer(this.handle)
    this.handle = null
  }
}
