import { BrowserEventRateCounter } from './browser-event-rate-counter'

export interface BrowserTabUpdateInput extends Record<string, unknown> {
  type: string
  tabId: string
}

export interface BrowserTabUpdatePatch extends Record<string, unknown> {
  type: 'patch'
  tabId: string
}

interface BrowserTabUpdateBatcherDeps {
  emit: (patch: BrowserTabUpdatePatch | BrowserTabUpdateInput) => void
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  delayMs?: number
  counter?: BrowserEventRateCounter
}

export class BrowserTabUpdateBatcher {
  private readonly pendingByTab = new Map<string, Record<string, unknown>>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: BrowserTabUpdateBatcherDeps) {}

  enqueue(update: BrowserTabUpdateInput): void {
    this.deps.counter?.record(`tabUpdate:input:${update.type}`)
    if (update.type === 'closed') {
      this.flushTab(update.tabId)
      this.deps.emit(update)
      this.deps.counter?.record('tabUpdate:output:closed')
      return
    }
    const { type: _type, tabId, ...fields } = update
    const previous = this.pendingByTab.get(tabId) ?? {}
    this.pendingByTab.set(tabId, { ...previous, ...fields })
    if (this.timer) return
    const setTimer = this.deps.setTimeout ?? setTimeout
    this.timer = setTimer(() => {
      this.timer = null
      this.flush()
    }, Math.max(0, this.deps.delayMs ?? 16))
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  flush(): void {
    if (this.timer) {
      const clearTimer = this.deps.clearTimeout ?? clearTimeout
      clearTimer(this.timer)
      this.timer = null
    }
    for (const tabId of [...this.pendingByTab.keys()]) this.flushTab(tabId)
  }

  hasPending(): boolean {
    return this.pendingByTab.size > 0 || this.timer !== null
  }

  private flushTab(tabId: string): void {
    const fields = this.pendingByTab.get(tabId)
    if (!fields) return
    this.pendingByTab.delete(tabId)
    this.deps.emit({ type: 'patch', tabId, ...fields })
    this.deps.counter?.record('tabUpdate:output:patch')
  }
}
