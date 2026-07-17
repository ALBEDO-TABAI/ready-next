export type BrowserTabLoadState = 'visible' | 'protected-background' | 'throttled' | 'dormant'

export interface GovernedBrowserWebContents {
  setBackgroundThrottling(allowed: boolean): void
  isCurrentlyAudible?: () => boolean
  isDestroyed?: () => boolean
}

export interface GovernedBrowserTab {
  id: string
  required?: boolean
  protectionReasons?: string[]
  activity?: 'idle' | 'running' | 'attention'
  view?: { webContents: GovernedBrowserWebContents }
}

export interface BrowserTabLoadSnapshot {
  tabs: Iterable<GovernedBrowserTab>
  activeTabId: string | null
  splitTabId: string | null
  shouldPresentHosts: boolean
}

export interface BrowserTabLoadStateChange {
  tabId: string
  previous: BrowserTabLoadState | null
  state: BrowserTabLoadState
  reason: string
}

interface BrowserTabLoadGovernorDeps {
  readSnapshot: () => BrowserTabLoadSnapshot
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  log?: (event: BrowserTabLoadStateChange) => void
  onStateChange?: (event: BrowserTabLoadStateChange) => void
  recentInteractionMs?: number
}

const DEFAULT_RECENT_INTERACTION_MS = 30_000

function timerUnref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}

export class BrowserTabLoadGovernor {
  private readonly states = new Map<string, BrowserTabLoadState>()
  private readonly throttleAllowed = new Map<string, boolean>()
  private readonly lastInteractionAt = new Map<string, number>()
  private readonly protections = new Map<string, Map<string, number>>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: BrowserTabLoadGovernorDeps) {}

  reconcile(): ReadonlyMap<string, BrowserTabLoadState> {
    this.clearTimer()
    const now = this.deps.now?.() ?? Date.now()
    const graceMs = Math.max(0, this.deps.recentInteractionMs ?? DEFAULT_RECENT_INTERACTION_MS)
    const snapshot = this.deps.readSnapshot()
    const seen = new Set<string>()
    let nextExpiry = Number.POSITIVE_INFINITY

    for (const tab of snapshot.tabs) {
      seen.add(tab.id)
      const isVisible = snapshot.shouldPresentHosts
        && (tab.id === snapshot.activeTabId || tab.id === snapshot.splitTabId)
      const wasVisible = this.states.get(tab.id) === 'visible'
      if (isVisible || wasVisible) this.lastInteractionAt.set(tab.id, now)

      const lastInteraction = this.lastInteractionAt.get(tab.id) ?? Number.NEGATIVE_INFINITY
      const recentUntil = lastInteraction + graceMs
      const recent = recentUntil > now
      if (!isVisible && recent) nextExpiry = Math.min(nextExpiry, recentUntil)

      const externalProtection = (this.protections.get(tab.id)?.size ?? 0) > 0
        || (tab.protectionReasons?.length ?? 0) > 0
      const audible = this.readAudible(tab)
      const protectedBackground = Boolean(
        tab.required
        || tab.activity === 'running'
        || externalProtection
        || audible
        || recent
      )
      const state: BrowserTabLoadState = !tab.view
        ? 'dormant'
        : isVisible
          ? 'visible'
          : protectedBackground
            ? 'protected-background'
            : 'throttled'

      this.applyState(tab, state, this.reasonForState({ isVisible, audible, externalProtection, recent, tab }))
    }

    for (const tabId of [...this.states.keys()]) {
      if (!seen.has(tabId)) this.disposeTab(tabId)
    }

    if (Number.isFinite(nextExpiry)) {
      const setTimer = this.deps.setTimeout ?? setTimeout
      this.timer = setTimer(() => {
        this.timer = null
        this.reconcile()
      }, Math.max(1, nextExpiry - now))
      timerUnref(this.timer)
    }
    return this.states
  }

  noteInteraction(tabId: string): void {
    this.lastInteractionAt.set(tabId, this.deps.now?.() ?? Date.now())
    this.reconcile()
  }

  protect(tabId: string, reason: string): () => void {
    const normalizedReason = reason.trim() || 'runtime'
    const reasons = this.protections.get(tabId) ?? new Map<string, number>()
    reasons.set(normalizedReason, (reasons.get(normalizedReason) ?? 0) + 1)
    this.protections.set(tabId, reasons)
    this.reconcile()
    let released = false
    return () => {
      if (released) return
      released = true
      const latest = this.protections.get(tabId)
      if (!latest) return
      const next = Math.max(0, (latest.get(normalizedReason) ?? 0) - 1)
      if (next > 0) latest.set(normalizedReason, next)
      else latest.delete(normalizedReason)
      if (latest.size === 0) this.protections.delete(tabId)
      this.reconcile()
    }
  }

  getState(tabId: string): BrowserTabLoadState | null {
    return this.states.get(tabId) ?? null
  }

  getSnapshot(): Array<{ tabId: string; state: BrowserTabLoadState }> {
    return [...this.states.entries()].map(([tabId, state]) => ({ tabId, state }))
  }

  getLastInteractionAt(tabId: string): number | null {
    return this.lastInteractionAt.get(tabId) ?? null
  }

  wasRecentlyInteracted(tabId: string, withinMs: number): boolean {
    const timestamp = this.lastInteractionAt.get(tabId)
    if (timestamp === undefined) return false
    return (this.deps.now?.() ?? Date.now()) - timestamp < Math.max(0, withinMs)
  }

  disposeTab(tabId: string): void {
    this.states.delete(tabId)
    this.throttleAllowed.delete(tabId)
    this.lastInteractionAt.delete(tabId)
    this.protections.delete(tabId)
  }

  destroy(): void {
    this.clearTimer()
    this.states.clear()
    this.throttleAllowed.clear()
    this.lastInteractionAt.clear()
    this.protections.clear()
  }

  private readAudible(tab: GovernedBrowserTab): boolean {
    if (!tab.view) return false
    try {
      if (tab.view.webContents.isDestroyed?.()) return false
      return tab.view.webContents.isCurrentlyAudible?.() === true
    } catch {
      return false
    }
  }

  private applyState(tab: GovernedBrowserTab, state: BrowserTabLoadState, reason: string): void {
    const previous = this.states.get(tab.id) ?? null
    this.states.set(tab.id, state)
    if (tab.view) {
      const allowed = state === 'throttled'
      if (this.throttleAllowed.get(tab.id) !== allowed) {
        try {
          tab.view.webContents.setBackgroundThrottling(allowed)
          this.throttleAllowed.set(tab.id, allowed)
        } catch {
          // The view may have been destroyed between the lifecycle snapshot and apply.
        }
      }
    } else {
      this.throttleAllowed.delete(tab.id)
    }
    if (previous !== state) {
      const event = { tabId: tab.id, previous, state, reason }
      this.deps.log?.(event)
      this.deps.onStateChange?.(event)
    }
  }

  private reasonForState(input: {
    isVisible: boolean
    audible: boolean
    externalProtection: boolean
    recent: boolean
    tab: GovernedBrowserTab
  }): string {
    if (!input.tab.view) return 'no-live-view'
    if (input.isVisible) return 'visible-surface'
    if (input.audible) return 'audible'
    if (input.externalProtection) return input.tab.protectionReasons?.[0] || 'runtime-protection'
    if (input.tab.required) return 'required'
    if (input.tab.activity === 'running') return 'running-task'
    if (input.recent) return 'recent-interaction'
    return 'background'
  }

  private clearTimer(): void {
    if (!this.timer) return
    const clearTimer = this.deps.clearTimeout ?? clearTimeout
    clearTimer(this.timer)
    this.timer = null
  }
}
