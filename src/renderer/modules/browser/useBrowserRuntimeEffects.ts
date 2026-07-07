import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import type { TabUpdateEvent } from './types'
import { browserTabActivationSequencer } from './browserTabActivationSequencer'
import { clearFitted, shouldClearFittedForTabUpdate } from './browserTabFitRegistry'
import { DEFAULT_BROWSER_URL, extractBrowserDomain } from './url-utils'
import { mergeBackendTabsPreservingGroups, useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'

interface UseBrowserRuntimeEffectsParams {
  isElectron: boolean
  isActive: boolean
  isAddressEditingRef: RefObject<boolean>
  sendBoundsImmediate: (options?: { forceExact?: boolean }) => Promise<void>
}

interface BrowserTabOpenedEvent {
  id: string
  url: string
  title?: string
  domain?: string
  favicon?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  error?: string | null
  /** false = background/agent tab: list it without preempting focus (D1). */
  activate?: boolean
}

export function useBrowserRuntimeEffects({
  isElectron,
  isActive,
  isAddressEditingRef,
  sendBoundsImmediate,
}: UseBrowserRuntimeEffectsParams) {
  const activationFrameRef = useRef<number | null>(null)
  const hasHydratedRuntimeRef = useRef(!isElectron)
  const startupDefaultTabBootstrapRef = useRef(!isElectron)
  const hydrationPromiseRef = useRef<Promise<boolean> | null>(null)
  const [browserRuntimeReady, setBrowserRuntimeReady] = useState(!isElectron)

  const rebuildRuntimeFromPersistedTabs = useCallback(async (store: ReturnType<typeof useBrowserTabs.getState>) => {
    const persistedTabs = store.tabs
      .filter((tab) => tab.url)
      .map((tab) => ({ ...tab, loading: true, error: undefined }))
    if (persistedTabs.length === 0) return false

    const recoveredTabs: BrowserTab[] = []
    const previousActiveTabId = store.activeTabId
    let recoveredActiveTabId: string | null = null

    for (const tab of persistedTabs) {
      const result = await window.electronAPI?.browser?.createTab(tab.url) as { success?: boolean; tabId?: string } | undefined
      if (!result?.success || !result.tabId) continue

      const recoveredTab: BrowserTab = {
        ...tab,
        id: result.tabId,
        title: tab.title || 'Loading...',
        domain: tab.domain || extractBrowserDomain(tab.url),
      }
      recoveredTabs.push(recoveredTab)
      if (tab.id === previousActiveTabId) {
        recoveredActiveTabId = result.tabId
      }
    }

    if (recoveredTabs.length === 0) return false

    const nextActiveTabId = recoveredActiveTabId || recoveredTabs[recoveredTabs.length - 1]?.id || null
    // Group preservation here rides on the `{ ...tab }` spread above: the backend
    // ids are freshly minted on restart, so the id-matching merge helper does NOT
    // apply — instead each recovered tab keeps the persisted tab's groupId (a stable
    // grp-* id), and store.tabGroups (hydrated from localStorage) still matches. The
    // group definitions survive the restart via setTabs preserving state.tabGroups.
    store.setTabs(recoveredTabs)
    browserTabActivationSequencer.invalidate()
    store.setActiveTabId(nextActiveTabId)
    const activeTab = recoveredTabs.find((tab) => tab.id === nextActiveTabId) || null
    store.setUrlInput(activeTab?.url === DEFAULT_BROWSER_URL ? '' : activeTab?.url || '')

    if (nextActiveTabId && nextActiveTabId !== recoveredTabs[recoveredTabs.length - 1]?.id) {
      await window.electronAPI?.browser?.switchTab(nextActiveTabId).catch(() => undefined)
    }

    return true
  }, [])

  const restoreExistingTabs = useCallback(async () => {
    if (!isElectron) return false
    const existingTabs = await window.electronAPI?.browser?.getTabs()
    const store = useBrowserTabs.getState()
    if (!Array.isArray(existingTabs) || existingTabs.length === 0) {
      const rebuilt = await rebuildRuntimeFromPersistedTabs(store)
      if (rebuilt) return true
      store.setTabs([])
      store.setActiveTabId(null)
      store.setUrlInput('')
      return false
    }

    const hydratedTabs: BrowserTab[] = existingTabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title || 'New Tab',
      loading: Boolean(tab.loading),
      canGoBack: Boolean(tab.canGoBack),
      canGoForward: Boolean(tab.canGoForward),
      domain: tab.domain || extractBrowserDomain(tab.url),
      favicon: tab.favicon || undefined,
      owner: tab.owner,
      required: tab.required,
      activity: tab.activity,
      lastAuditedAt: tab.lastAuditedAt,
      error: tab.error || undefined,
    }))

    const activeTab = existingTabs.find((tab) => tab.active) || existingTabs[existingTabs.length - 1]
    // Preserve renderer-only grouping across this reconcile. Backend ids match the
    // local store ids here (same session — e.g. split-toggle remounts BrowserMode
    // while the native BrowserViews stay alive), so merge by id keeps local groupId.
    store.setTabs(mergeBackendTabsPreservingGroups(store.tabs, hydratedTabs))
    browserTabActivationSequencer.invalidate()
    store.setActiveTabId(activeTab?.id || hydratedTabs[hydratedTabs.length - 1]?.id || null)
    store.setUrlInput(activeTab?.url === DEFAULT_BROWSER_URL ? '' : activeTab?.url || '')
    return true
  }, [isElectron, rebuildRuntimeFromPersistedTabs])

  const ensureBrowserRuntime = useCallback(async () => {
    if (!isElectron) return true

    if (!hydrationPromiseRef.current) {
      hydrationPromiseRef.current = restoreExistingTabs()
    }

    const hydrationTask = hydrationPromiseRef.current
    try {
      const hasTabs = await hydrationTask
      hasHydratedRuntimeRef.current = hasTabs
      if (hasTabs) {
        return true
      }
    } finally {
      if (hydrationPromiseRef.current === hydrationTask) {
        hydrationPromiseRef.current = null
      }
    }
    return hasHydratedRuntimeRef.current
  }, [isElectron, restoreExistingTabs])

  const bootstrapDefaultStartupTab = useCallback(async () => {
    if (!isElectron) return false

    await sendBoundsImmediate({ forceExact: true })
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

    const result = await window.electronAPI?.browser?.createTab(DEFAULT_BROWSER_URL) as { success: boolean; tabId?: string } | undefined
    if (!result?.success || !result.tabId) {
      return false
    }

    const newTab: BrowserTab = {
      id: result.tabId,
      url: DEFAULT_BROWSER_URL,
      title: 'Loading...',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      domain: extractBrowserDomain(DEFAULT_BROWSER_URL),
      owner: 'manual',
      required: false,
      activity: 'idle',
    }

    const store = useBrowserTabs.getState()
    store.addTab(newTab)
    browserTabActivationSequencer.invalidate()
    store.setActiveTabId(result.tabId)
    store.setUrlInput('')
    hasHydratedRuntimeRef.current = true

    requestAnimationFrame(() => {
      void sendBoundsImmediate({ forceExact: true })
    })

    return true
  }, [isElectron, sendBoundsImmediate])

  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onTabUpdate((data: unknown) => {
      const event = data as TabUpdateEvent
      const store = useBrowserTabs.getState()
      switch (event.type) {
        case 'title':
          store.updateTab(event.tabId, { title: event.title || '' })
          break
        case 'navigate':
          if (shouldClearFittedForTabUpdate(event)) {
            clearFitted(event.tabId)
          }
          store.updateTab(event.tabId, {
            url: event.url || '',
            domain: event.domain,
            canGoBack: event.canGoBack || false,
            canGoForward: event.canGoForward || false,
            error: undefined,
          })
          if (store.activeTabId === event.tabId && event.url && !isAddressEditingRef.current) {
            store.setUrlInput(event.url === DEFAULT_BROWSER_URL ? '' : event.url)
          }
          break
        case 'loading':
          if (shouldClearFittedForTabUpdate(event)) {
            clearFitted(event.tabId)
          }
          store.updateTab(event.tabId, { loading: event.loading || false })
          break
        case 'error':
          store.updateTab(event.tabId, {
            loading: false,
            error: event.error || 'Page failed to load',
          })
          break
        case 'meta':
          store.updateTab(event.tabId, {
            domain: event.domain,
            favicon: event.favicon || undefined,
            owner: event.owner,
            required: event.required,
            activity: event.activity,
            lastAuditedAt: event.lastAuditedAt,
          })
          break
        case 'closed': {
          if (shouldClearFittedForTabUpdate(event)) {
            clearFitted(event.tabId)
          }
          const nextActiveTabId = typeof event.activeTabId === 'string' ? event.activeTabId : null
          store.removeTab(event.tabId)
          const nextStore = useBrowserTabs.getState()
          if (nextActiveTabId && nextStore.tabs.some((tab) => tab.id === nextActiveTabId)) {
            nextStore.setActiveTabId(nextActiveTabId)
          }
          const finalStore = useBrowserTabs.getState()
          const activeTab = finalStore.tabs.find((tab) => tab.id === finalStore.activeTabId) || null
          finalStore.setUrlInput(activeTab?.url === DEFAULT_BROWSER_URL ? '' : activeTab?.url || '')
          break
        }
      }
    })
    return () => { cleanup?.() }
  }, [isElectron, isAddressEditingRef])

  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onTabOpened((tab: BrowserTabOpenedEvent) => {
      const openedTab: BrowserTab = {
        id: tab.id,
        url: tab.url,
        title: tab.title || 'Loading...',
        loading: Boolean(tab.loading),
        canGoBack: Boolean(tab.canGoBack),
        canGoForward: Boolean(tab.canGoForward),
        domain: tab.domain || extractBrowserDomain(tab.url),
        favicon: tab.favicon || undefined,
        owner: tab.owner,
        required: tab.required,
        activity: tab.activity,
        lastAuditedAt: tab.lastAuditedAt,
        error: tab.error || undefined,
      }
      const store = useBrowserTabs.getState()
      const existing = store.tabs.some((item) => item.id === openedTab.id)
      if (existing) {
        store.updateTab(openedTab.id, openedTab)
      } else {
        store.addTab(openedTab)
      }
      // D1: background/agent tabs are listed but must never preempt the user's
      // active tab or address bar (activate:false comes from tab-lifecycle-service).
      if (tab.activate === false) return
      browserTabActivationSequencer.invalidate()
      store.setActiveTabId(openedTab.id)
      store.setUrlInput(openedTab.url === DEFAULT_BROWSER_URL ? '' : openedTab.url)
      hasHydratedRuntimeRef.current = true
      setBrowserRuntimeReady(true)
      requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
    })
    return () => { cleanup?.() }
  }, [isElectron, sendBoundsImmediate])

  useEffect(() => {
    if (!isElectron) return
    let cancelled = false

    // fire-and-forget: browser-runtime warmup; if it fails, BrowserView simply won't be ready and the user sees the empty-state UI, which has its own retry affordance.
    void ensureBrowserRuntime().then((hasTabs) => {
      if (cancelled) return
      setBrowserRuntimeReady(hasTabs)
    }).catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [ensureBrowserRuntime, isElectron])

  useEffect(() => {
    if (!isElectron) return
    if (activationFrameRef.current) {
      cancelAnimationFrame(activationFrameRef.current)
      activationFrameRef.current = null
    }
    if (!isActive) {
      setBrowserRuntimeReady(Boolean(hasHydratedRuntimeRef.current))
      return
    }

    if (hasHydratedRuntimeRef.current) {
      setBrowserRuntimeReady(true)
      void sendBoundsImmediate({ forceExact: true })
      return
    }

    setBrowserRuntimeReady(false)
    let cancelled = false
    activationFrameRef.current = requestAnimationFrame(async () => {
      activationFrameRef.current = null
      let hasTabs = await ensureBrowserRuntime()
      if (!hasTabs && !startupDefaultTabBootstrapRef.current) {
        startupDefaultTabBootstrapRef.current = true
        hasTabs = await bootstrapDefaultStartupTab()
      }
      if (cancelled) return

      if (hasTabs) {
        await sendBoundsImmediate({ forceExact: true })
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      }
      if (!cancelled) {
        setBrowserRuntimeReady(true)
      }
    })
    return () => {
      cancelled = true
      if (activationFrameRef.current) {
        cancelAnimationFrame(activationFrameRef.current)
        activationFrameRef.current = null
      }
    }
  }, [bootstrapDefaultStartupTab, ensureBrowserRuntime, isActive, isElectron, sendBoundsImmediate])

  useEffect(() => {
    return () => {
      if (activationFrameRef.current) {
        cancelAnimationFrame(activationFrameRef.current)
        activationFrameRef.current = null
      }
    }
  }, [])

  return {
    browserRuntimeReady,
  }
}
