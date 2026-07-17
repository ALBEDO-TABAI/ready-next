import type { NavigationEntry } from 'electron'

import type { BrowserTabLoadState } from './browser-tab-load-governor'

interface SuspendableBrowserTab {
  id: string
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  loading?: boolean
  view?: {
    webContents: {
      isDestroyed?: () => boolean
      close?: () => void
      navigationHistory: {
        getAllEntries(): NavigationEntry[]
        getActiveIndex(): number
      }
    }
  }
  restoreSnapshot?: { entries: NavigationEntry[]; index: number } | null
}

interface BrowserTabSuspensionServiceDeps {
  getTabs: () => Iterable<SuspendableBrowserTab>
  getLoadState: (tabId: string) => BrowserTabLoadState | null
  getLastInteractionAt: (tabId: string) => number | null
  wasRecentlyInteracted: (tabId: string, withinMs: number) => boolean
  getMaxLiveViews: () => number
  isMemoryPressure: () => boolean
  detachHost: (view: NonNullable<SuspendableBrowserTab['view']>) => void
  disposeTabResources: (tabId: string) => void
  onSuspended?: (tabId: string) => void
  log?: (message: string) => void
  recentInputFloorMs?: number
  now?: () => number
}

const DEFAULT_RECENT_INPUT_FLOOR_MS = 5 * 60_000
const DEFAULT_PRESSURE_RECHECK_MS = 30_000

export class BrowserTabSuspensionService {
  constructor(private readonly deps: BrowserTabSuspensionServiceDeps) {}

  reclaimIfNeeded(): string[] {
    const tabs = [...this.deps.getTabs()]
    const liveTabs = tabs.filter((tab) => tab.view && !this.isDestroyed(tab))
    const overBudget = Math.max(0, liveTabs.length - Math.max(1, this.deps.getMaxLiveViews()))
    const memoryPressure = this.deps.isMemoryPressure()
    if (overBudget === 0 && !memoryPressure) return []

    const recentFloorMs = this.deps.recentInputFloorMs ?? DEFAULT_RECENT_INPUT_FLOOR_MS
    const candidates = liveTabs
      .filter((tab) => (
        this.deps.getLoadState(tab.id) === 'throttled'
        && !tab.required
        && tab.activity !== 'running'
        && !tab.loading
        && !this.deps.wasRecentlyInteracted(tab.id, recentFloorMs)
      ))
      .sort((left, right) => (
        (this.deps.getLastInteractionAt(left.id) ?? Number.NEGATIVE_INFINITY)
        - (this.deps.getLastInteractionAt(right.id) ?? Number.NEGATIVE_INFINITY)
      ))

    const targetCount = memoryPressure ? Math.max(1, overBudget) : overBudget
    const reclaimed: string[] = []
    for (const tab of candidates) {
      if (reclaimed.length >= targetCount) break
      const view = tab.view
      if (!view || this.isDestroyed(tab)) continue
      try {
        const entries = view.webContents.navigationHistory.getAllEntries()
        const index = view.webContents.navigationHistory.getActiveIndex()
        if (!Array.isArray(entries) || entries.length === 0 || index < 0 || index >= entries.length) {
          this.deps.log?.(`[browser-tab-suspend] skipped tab=${tab.id} reason=incomplete-history`)
          continue
        }
        tab.restoreSnapshot = { entries, index }
        this.deps.disposeTabResources(tab.id)
        this.deps.detachHost(view)
        view.webContents.close?.()
        tab.view = undefined
        tab.loading = false
        reclaimed.push(tab.id)
        this.deps.onSuspended?.(tab.id)
        this.deps.log?.(`[browser-tab-suspend] tab=${tab.id} entries=${entries.length} index=${index}`)
      } catch (error) {
        tab.restoreSnapshot = null
        this.deps.log?.(`[browser-tab-suspend] skipped tab=${tab.id} reason=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return reclaimed
  }

  getNextRecheckDelayMs(): number | null {
    const tabs = [...this.deps.getTabs()]
    const liveTabs = tabs.filter((tab) => tab.view && !this.isDestroyed(tab))
    const overBudget = liveTabs.length > Math.max(1, this.deps.getMaxLiveViews())
    const memoryPressure = this.deps.isMemoryPressure()
    const recentFloorMs = this.deps.recentInputFloorMs ?? DEFAULT_RECENT_INPUT_FLOOR_MS
    const now = this.deps.now?.() ?? Date.now()
    let nextDelay = Number.POSITIVE_INFINITY
    let hasEligibleColdTab = false
    let hasMonitorableBackgroundTab = false
    for (const tab of liveTabs) {
      if (
        this.deps.getLoadState(tab.id) !== 'throttled'
        || tab.required
        || tab.activity === 'running'
      ) continue
      hasMonitorableBackgroundTab = true
      if (tab.loading) continue
      const lastInteractionAt = this.deps.getLastInteractionAt(tab.id)
      if (lastInteractionAt === null) {
        hasEligibleColdTab = true
        continue
      }
      const delay = recentFloorMs - Math.max(0, now - lastInteractionAt)
      if (delay > 0) nextDelay = Math.min(nextDelay, delay)
      else hasEligibleColdTab = true
    }
    if (!overBudget && !memoryPressure && !hasMonitorableBackgroundTab) return null
    if (Number.isFinite(nextDelay)) return Math.max(1, nextDelay)
    return hasEligibleColdTab || hasMonitorableBackgroundTab ? DEFAULT_PRESSURE_RECHECK_MS : null
  }

  private isDestroyed(tab: SuspendableBrowserTab): boolean {
    try {
      return tab.view?.webContents.isDestroyed?.() === true
    } catch {
      return true
    }
  }
}
