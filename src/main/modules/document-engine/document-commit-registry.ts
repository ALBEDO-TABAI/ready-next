export interface DocumentWidgetCommitEvent {
  tabId: string
  widgetId: string
  requestId?: string
  committedAt: number
}

type Waiter = {
  resolve: (event: DocumentWidgetCommitEvent) => void
  reject: (error: Error) => void
  predicate: (event: DocumentWidgetCommitEvent) => boolean
  timer: ReturnType<typeof setTimeout>
}

class DocumentCommitRegistryImpl {
  private readonly lastByKey = new Map<string, DocumentWidgetCommitEvent>()
  private readonly waiters = new Set<Waiter>()

  private static buildKey(tabId: string, widgetId: string): string {
    return `${tabId}::${widgetId}`
  }

  record(event: DocumentWidgetCommitEvent): void {
    if (!event.tabId || !event.widgetId) return
    this.lastByKey.set(DocumentCommitRegistryImpl.buildKey(event.tabId, event.widgetId), event)
    for (const waiter of Array.from(this.waiters)) {
      if (!waiter.predicate(event)) continue
      this.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  }

  getLast(tabId: string | null | undefined, widgetId: string | null | undefined): DocumentWidgetCommitEvent | null {
    if (!tabId || !widgetId) return null
    return this.lastByKey.get(DocumentCommitRegistryImpl.buildKey(tabId, widgetId)) || null
  }

  async waitForCommitAfter(
    params: { tabId: string; widgetId: string; afterTimestamp: number; timeoutMs: number },
  ): Promise<DocumentWidgetCommitEvent | null> {
    const existing = this.getLast(params.tabId, params.widgetId)
    if (existing && existing.committedAt >= params.afterTimestamp) return existing
    return await new Promise<DocumentWidgetCommitEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(null)
      }, Math.max(100, params.timeoutMs))
      const waiter: Waiter = {
        predicate: (event) =>
          event.tabId === params.tabId
          && event.widgetId === params.widgetId
          && event.committedAt >= params.afterTimestamp,
        resolve: (event) => resolve(event),
        reject: () => resolve(null),
        timer,
      }
      this.waiters.add(waiter)
    })
  }

  clear(): void {
    this.lastByKey.clear()
    for (const waiter of Array.from(this.waiters)) {
      clearTimeout(waiter.timer)
    }
    this.waiters.clear()
  }
}

export const documentCommitRegistry = new DocumentCommitRegistryImpl()
