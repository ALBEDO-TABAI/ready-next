import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import type { TabUpdateEvent } from './types'
import { browserTabActivationSequencer } from './browserTabActivationSequencer'
import { DEFAULT_BROWSER_URL, extractBrowserDomain } from './url-utils'
import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'

interface UseBrowserRuntimeEffectsParams {
  isElectron: boolean
  isActive: boolean
  isAddressEditingRef: RefObject<boolean>
  sendBoundsImmediate: (options?: { forceExact?: boolean }) => Promise<void>
  handleNewTab: () => void | Promise<void>
}

export function useBrowserRuntimeEffects({
  isElectron,
  isActive,
  isAddressEditingRef,
  sendBoundsImmediate,
  handleNewTab,
}: UseBrowserRuntimeEffectsParams) {
  const activationFrameRef = useRef<number | null>(null)
  const hasHydratedRuntimeRef = useRef(!isElectron)
  const hydrationPromiseRef = useRef<Promise<boolean> | null>(null)
  const [browserRuntimeReady, setBrowserRuntimeReady] = useState(!isElectron)

  const restoreExistingTabs = useCallback(async () => {
    if (!isElectron) return false
    const existingTabs = await window.electronAPI?.browser?.getTabs()
    const store = useBrowserTabs.getState()
    if (!Array.isArray(existingTabs) || existingTabs.length === 0) {
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
    store.setTabs(hydratedTabs)
    browserTabActivationSequencer.invalidate()
    store.setActiveTabId(activeTab?.id || hydratedTabs[hydratedTabs.length - 1]?.id || null)
    store.setUrlInput(activeTab?.url === DEFAULT_BROWSER_URL ? '' : activeTab?.url || '')
    return true
  }, [isElectron])

  const ensureBrowserRuntime = useCallback(async ({ allowNewTab }: { allowNewTab: boolean }) => {
    if (!isElectron) return true

    if (!hasHydratedRuntimeRef.current) {
      if (!hydrationPromiseRef.current) {
        hydrationPromiseRef.current = restoreExistingTabs()
      }

      const hydrationTask = hydrationPromiseRef.current
      try {
        const hasTabs = await hydrationTask
        if (hasTabs) {
          hasHydratedRuntimeRef.current = true
          return true
        }
      } finally {
        if (hydrationPromiseRef.current === hydrationTask) {
          hydrationPromiseRef.current = null
        }
      }
    }

    if (allowNewTab && !hasHydratedRuntimeRef.current) {
      await handleNewTab()
      hasHydratedRuntimeRef.current = true
      return true
    }

    return hasHydratedRuntimeRef.current
  }, [handleNewTab, isElectron, restoreExistingTabs])

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
      }
    })
    return () => { cleanup?.() }
  }, [isElectron, isAddressEditingRef])

  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onNewTabRequest(async (url: string) => {
      await sendBoundsImmediate({ forceExact: true })
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      const result = await window.electronAPI?.browser?.createTab(url) as { success: boolean; tabId?: string } | undefined
      if (result?.success && result.tabId) {
        const newTab: BrowserTab = {
          id: result.tabId,
          url,
          title: 'Loading...',
          loading: true,
          canGoBack: false,
          canGoForward: false,
          domain: extractBrowserDomain(url),
          owner: 'manual',
          required: false,
          activity: 'idle',
        }
        useBrowserTabs.getState().addTab(newTab)
        browserTabActivationSequencer.invalidate()
        useBrowserTabs.getState().setActiveTabId(result.tabId)
        useBrowserTabs.getState().setUrlInput(url === DEFAULT_BROWSER_URL ? '' : url)
        requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
      }
    })
    return () => { cleanup?.() }
  }, [isElectron, sendBoundsImmediate])

  useEffect(() => {
    if (!isElectron) return
    let cancelled = false

    void ensureBrowserRuntime({ allowNewTab: false }).then((hasTabs) => {
      if (cancelled || !hasTabs) return
      setBrowserRuntimeReady(true)
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
      if (!hasHydratedRuntimeRef.current) {
        setBrowserRuntimeReady(false)
      }
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
      const hasTabs = await ensureBrowserRuntime({ allowNewTab: true })
      if (cancelled || !hasTabs) return

      await sendBoundsImmediate({ forceExact: true })
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
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
  }, [ensureBrowserRuntime, isActive, isElectron, sendBoundsImmediate])

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
