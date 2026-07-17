interface BrowserTabPersistenceWriterDeps<T> {
  write: (value: T) => void
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
  quietMs?: number
  maxMs?: number
}

export class BrowserTabPersistenceWriter<T> {
  private pending: T | null = null
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private idleHandle: number | null = null

  constructor(private readonly deps: BrowserTabPersistenceWriterDeps<T>) {}

  schedule(value: T): void {
    this.pending = value
    const setTimer = this.deps.setTimeout ?? setTimeout
    const clearTimer = this.deps.clearTimeout ?? clearTimeout
    if (this.quietTimer) clearTimer(this.quietTimer)
    this.quietTimer = setTimer(() => {
      this.quietTimer = null
      const requestIdle = this.deps.requestIdleCallback
      if (!requestIdle) {
        this.flush()
        return
      }
      if (this.idleHandle !== null) this.deps.cancelIdleCallback?.(this.idleHandle)
      this.idleHandle = requestIdle(() => {
        this.idleHandle = null
        this.flush()
      }, { timeout: Math.max(1, this.deps.maxMs ?? 500) })
    }, Math.max(0, this.deps.quietMs ?? 120))
    if (!this.maxTimer) {
      this.maxTimer = setTimer(() => {
        this.maxTimer = null
        this.flush()
      }, Math.max(1, this.deps.maxMs ?? 500))
    }
  }

  flush(): void {
    if (this.pending === null) return
    const clearTimer = this.deps.clearTimeout ?? clearTimeout
    if (this.quietTimer) clearTimer(this.quietTimer)
    if (this.maxTimer) clearTimer(this.maxTimer)
    if (this.idleHandle !== null) this.deps.cancelIdleCallback?.(this.idleHandle)
    this.quietTimer = null
    this.maxTimer = null
    this.idleHandle = null
    const value = this.pending
    this.pending = null
    this.deps.write(value)
  }

  hasPending(): boolean {
    return this.pending !== null
  }
}
