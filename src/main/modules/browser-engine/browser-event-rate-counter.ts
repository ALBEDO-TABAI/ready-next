export class BrowserEventRateCounter {
  private readonly events: Array<{ at: number; key: string }> = []

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  record(key: string): void {
    this.events.push({ at: this.now(), key })
    this.prune()
  }

  snapshot(): Record<string, number> {
    this.prune()
    const counts: Record<string, number> = {}
    for (const event of this.events) counts[event.key] = (counts[event.key] ?? 0) + 1
    return counts
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs
    let removeCount = 0
    while (removeCount < this.events.length && this.events[removeCount].at < cutoff) removeCount += 1
    if (removeCount > 0) this.events.splice(0, removeCount)
  }
}
