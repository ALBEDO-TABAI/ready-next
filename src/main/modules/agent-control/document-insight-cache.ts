import type { DocumentInsight, DocumentInsightMetrics, DocumentInsightStageResult } from './document-task-pipeline'

interface CacheEntry {
  key: string
  value: DocumentInsightStageResult
  createdAtMs: number
}

export class DocumentInsightCache {
  private entries = new Map<string, CacheEntry>()

  constructor(private readonly options?: {
    now?: () => number
    ttlMs?: number
    maxEntries?: number
  }) {}

  private now(): number {
    return this.options?.now ? this.options.now() : Date.now()
  }

  private ttlMs(): number {
    return this.options?.ttlMs ?? 10 * 60 * 1000
  }

  private maxEntries(): number {
    return this.options?.maxEntries ?? 24
  }

  private pruneExpired(): void {
    const now = this.now()
    const ttlMs = this.ttlMs()
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAtMs > ttlMs) {
        this.entries.delete(key)
      }
    }
  }

  private pruneOverflow(): void {
    const overflow = this.entries.size - this.maxEntries()
    if (overflow <= 0) return
    const oldest = Array.from(this.entries.values())
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .slice(0, overflow)
    oldest.forEach((entry) => this.entries.delete(entry.key))
  }

  get(key: string): DocumentInsightStageResult | null {
    this.pruneExpired()
    const hit = this.entries.get(key)
    return hit ? hit.value : null
  }

  set(key: string, value: {
    insight: DocumentInsight
    metrics?: DocumentInsightMetrics
  }): void {
    this.pruneExpired()
    this.entries.set(key, {
      key,
      value,
      createdAtMs: this.now(),
    })
    this.pruneOverflow()
  }
}
