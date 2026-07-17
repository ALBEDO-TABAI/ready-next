import { totalmem } from 'node:os'

import type { BrowserHostView } from './host-types'
import { BrowserEventRateCounter } from './browser-event-rate-counter'
import { BrowserMetricsService } from './browser-metrics-service'
import { BrowserTabLoadGovernor } from './browser-tab-load-governor'
import { BrowserTabSuspensionService } from './browser-tab-suspension-service'
import { BrowserTabUpdateBatcher, type BrowserTabUpdateInput } from './tab-update-batcher'

export interface BrowserPerformanceTab {
  id: string
  url: string
  domain?: string
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  loading?: boolean
  view?: BrowserHostView
  restoreSnapshot?: { entries: Electron.NavigationEntry[]; index: number } | null
}

interface BrowserPerformanceRuntimeDeps<TTab extends BrowserPerformanceTab> {
  getTabs(): Iterable<TTab>
  getActiveTabId(): string | null
  getSplitTabId(): string | null
  shouldPresentHosts(): boolean
  getProtectionReasons(tabId: string): string[]
  detachHost(view: BrowserHostView): void
  disposeTabResources(tabId: string): void
  emitTabUpdate(update: BrowserTabUpdateInput): void
  log(message: string): void
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  queueMicrotask?: (callback: () => void) => void
  getTotalMemoryBytes?: () => number
  getAppMetrics(): Electron.ProcessMetric[]
  recentInteractionMs?: number
  recentInputFloorMs?: number
}

export class BrowserPerformanceRuntime<TTab extends BrowserPerformanceTab> {
  private readonly eventCounter = new BrowserEventRateCounter()
  private readonly updateBatcher: BrowserTabUpdateBatcher
  private readonly governor: BrowserTabLoadGovernor
  private readonly metrics: BrowserMetricsService
  private readonly suspension: BrowserTabSuspensionService
  private reclaimScheduled = false
  private reclaimTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(private readonly deps: BrowserPerformanceRuntimeDeps<TTab>) {
    this.updateBatcher = new BrowserTabUpdateBatcher({
      emit: (update) => this.deps.emitTabUpdate(update),
      counter: this.eventCounter,
    })
    this.governor = new BrowserTabLoadGovernor({
      readSnapshot: () => ({
        tabs: [...this.deps.getTabs()].map((tab) => ({
          ...tab,
          protectionReasons: this.deps.getProtectionReasons(tab.id),
        })),
        activeTabId: this.deps.getActiveTabId(),
        splitTabId: this.deps.getSplitTabId(),
        shouldPresentHosts: this.deps.shouldPresentHosts(),
      }),
      log: ({ tabId, previous, state, reason }) => {
        this.deps.log(`[browser_tab_load_state] tab=${tabId} previous=${previous || 'none'} state=${state} reason=${reason}`)
      },
      onStateChange: ({ state }) => {
        if (state === 'throttled') this.scheduleReclaim()
      },
      now: this.deps.now,
      setTimeout: this.deps.setTimeout,
      clearTimeout: this.deps.clearTimeout,
      recentInteractionMs: this.deps.recentInteractionMs,
    })
    this.metrics = new BrowserMetricsService({
      getAppMetrics: () => this.deps.getAppMetrics(),
      getTabs: () => this.deps.getTabs(),
      getLoadState: (tabId) => this.governor.getState(tabId),
    })
    this.suspension = new BrowserTabSuspensionService({
      getTabs: () => this.deps.getTabs(),
      getLoadState: (tabId) => this.governor.getState(tabId),
      getLastInteractionAt: (tabId) => this.governor.getLastInteractionAt(tabId),
      wasRecentlyInteracted: (tabId, withinMs) => this.governor.wasRecentlyInteracted(tabId, withinMs),
      getMaxLiveViews: () => this.getAdaptiveLiveViewBudget(),
      isMemoryPressure: () => this.isRendererUnderMemoryPressure(),
      detachHost: (view) => this.deps.detachHost(view as BrowserHostView),
      disposeTabResources: (tabId) => this.deps.disposeTabResources(tabId),
      onSuspended: (tabId) => {
        this.governor.reconcile()
        this.updateBatcher.enqueue({ type: 'loading', tabId, loading: false })
      },
      log: (message) => this.deps.log(message),
      now: this.deps.now,
      recentInputFloorMs: this.deps.recentInputFloorMs,
    })
  }

  queueTabUpdate(update: BrowserTabUpdateInput): void {
    this.updateBatcher.enqueue(update)
  }

  reconcile(): void {
    this.governor.reconcile()
  }

  noteInteraction(tabId: string): void {
    this.governor.noteInteraction(tabId)
    this.scheduleReclaim()
  }

  onLoadStateMayChange(tabId: string, reason: string): void {
    if (reason === 'user-input') this.governor.noteInteraction(tabId)
    else this.governor.reconcile()
    this.scheduleReclaim()
  }

  scheduleReclaim(): void {
    if (this.destroyed) return
    if (this.reclaimTimer) {
      (this.deps.clearTimeout ?? clearTimeout)(this.reclaimTimer)
      this.reclaimTimer = null
    }
    if (this.reclaimScheduled) return
    this.reclaimScheduled = true
    ;(this.deps.queueMicrotask ?? queueMicrotask)(() => {
      if (this.destroyed) return
      this.reclaimScheduled = false
      this.suspension.reclaimIfNeeded()
      const delayMs = this.suspension.getNextRecheckDelayMs()
      if (delayMs === null) return
      this.reclaimTimer = (this.deps.setTimeout ?? setTimeout)(() => {
        this.reclaimTimer = null
        this.scheduleReclaim()
      }, delayMs)
      this.reclaimTimer.unref?.()
    })
  }

  disposeTab(tabId: string): void {
    this.governor.disposeTab(tabId)
    this.reconcile()
  }

  recordIntent(kind: string): void {
    this.eventCounter.record(`intent:${kind}`)
  }

  getDiagnostics(includePerformance = false): {
    rendererProcesses: ReturnType<BrowserMetricsService['sample']>
    tabLoadStates: ReturnType<BrowserTabLoadGovernor['getSnapshot']>
    eventCounts60s: Record<string, number>
  } {
    return {
      rendererProcesses: includePerformance ? this.metrics.sample() : [],
      tabLoadStates: this.governor.getSnapshot(),
      eventCounts60s: this.eventCounter.snapshot(),
    }
  }

  destroy(): void {
    this.destroyed = true
    this.reclaimScheduled = false
    if (this.reclaimTimer) (this.deps.clearTimeout ?? clearTimeout)(this.reclaimTimer)
    this.reclaimTimer = null
    this.updateBatcher.flush()
    this.governor.destroy()
  }

  private getAdaptiveLiveViewBudget(): number {
    const gib = (this.deps.getTotalMemoryBytes?.() ?? totalmem()) / (1024 ** 3)
    if (gib < 8) return 4
    if (gib < 16) return 6
    if (gib < 32) return 10
    return 14
  }

  private isRendererUnderMemoryPressure(): boolean {
    const memoryKB = this.metrics.sample().reduce((sum, metric) => sum + metric.memoryKB, 0)
    const totalMemoryBytes = this.deps.getTotalMemoryBytes?.() ?? totalmem()
    const softLimitKB = Math.max(768 * 1024, Math.min(3 * 1024 * 1024, (totalMemoryBytes / 1024) * 0.15))
    return memoryKB > softLimitKB
  }
}
