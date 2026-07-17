export interface RSSHubIdleLifecycleOptions {
  idleMs: number
  onIdle: () => void
  now?: () => number
}

export class RSSHubIdleLifecycle {
  private readonly idleMs: number
  private readonly onIdle: () => void
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private pendingRequests = 0
  private lastActivityAt = 0

  constructor(options: RSSHubIdleLifecycleOptions) {
    this.idleMs = options.idleMs
    this.onIdle = options.onIdle
    this.now = options.now ?? Date.now
  }

  setRunning(running: boolean): void {
    this.running = running
    if (!running) {
      this.clearTimer()
      return
    }
    this.noteActivity()
  }

  beginRequest(): () => void {
    this.pendingRequests += 1
    this.noteActivity()
    let released = false
    return () => {
      if (released) return
      released = true
      this.pendingRequests = Math.max(0, this.pendingRequests - 1)
      this.noteActivity()
    }
  }

  hasDemand(): boolean {
    return this.pendingRequests > 0 || this.now() - this.lastActivityAt < this.idleMs
  }

  dispose(): void {
    this.running = false
    this.clearTimer()
  }

  private noteActivity(): void {
    this.lastActivityAt = this.now()
    this.schedule()
  }

  private schedule(): void {
    this.clearTimer()
    if (!this.running || this.pendingRequests > 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.hasDemand()) {
        this.schedule()
        return
      }
      this.running = false
      this.onIdle()
    }, this.idleMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
