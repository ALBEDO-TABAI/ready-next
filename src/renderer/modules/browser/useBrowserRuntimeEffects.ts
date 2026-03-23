import { useEffect, useRef } from 'react'

import type { TabUpdateEvent } from './types'
import { DEFAULT_BROWSER_URL, extractBrowserDomain } from './url-utils'
import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'

interface UseBrowserRuntimeEffectsParams {
  isElectron: boolean
  isActive: boolean
  isAddressEditing: boolean
  sendBoundsImmediate: (options?: { forceExact?: boolean }) => void
  handleNewTab: () => void | Promise<void>
}

export function useBrowserRuntimeEffects({
  isElectron,
  isActive,
  isAddressEditing,
  sendBoundsImmediate,
  handleNewTab,
}: UseBrowserRuntimeEffectsParams) {
  const activationFrameRef = useRef<number | null>(null)

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
          if (store.activeTabId === event.tabId && event.url && !isAddressEditing) {
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
  }, [isElectron, isAddressEditing])

  useEffect(() => {
    if (!isElectron) return
    const cleanup = window.electronAPI?.browser?.onNewTabRequest(async (url: string) => {
      sendBoundsImmediate({ forceExact: true })
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
        useBrowserTabs.getState().setActiveTabId(result.tabId)
        useBrowserTabs.getState().setUrlInput(url === DEFAULT_BROWSER_URL ? '' : url)
        requestAnimationFrame(() => sendBoundsImmediate({ forceExact: true }))
      }
    })
    return () => { cleanup?.() }
  }, [isElectron, sendBoundsImmediate])

  useEffect(() => {
    if (!isElectron) return
    if (activationFrameRef.current) {
      cancelAnimationFrame(activationFrameRef.current)
      activationFrameRef.current = null
    }
    if (!isActive) {
      window.electronAPI?.browser?.hideAll()
      return
    }
    const { tabs: currentTabs } = useBrowserTabs.getState()
    if (currentTabs.length === 0) {
      void handleNewTab()
    } else {
      activationFrameRef.current = requestAnimationFrame(() => {
        activationFrameRef.current = null
        sendBoundsImmediate({ forceExact: true })
        window.electronAPI?.browser?.showActive()
      })
    }
    return () => {
      if (activationFrameRef.current) {
        cancelAnimationFrame(activationFrameRef.current)
        activationFrameRef.current = null
      }
    }
  }, [handleNewTab, isActive, isElectron, sendBoundsImmediate])

  useEffect(() => {
    return () => {
      if (activationFrameRef.current) {
        cancelAnimationFrame(activationFrameRef.current)
        activationFrameRef.current = null
      }
      window.electronAPI?.browser?.hideAll()
    }
  }, [])
}
