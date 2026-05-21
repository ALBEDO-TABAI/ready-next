export class MapRequestCache {
  private readonly entries = new Map<string, unknown>()
  private hits = 0

  get<T>(key: string): T | null {
    if (!this.entries.has(key)) return null
    this.hits += 1
    return this.entries.get(key) as T
  }

  set<T>(key: string, value: T): T {
    this.entries.set(key, value)
    return value
  }

  get hitCount(): number {
    return this.hits
  }

  clear(): void {
    this.entries.clear()
  }
}
