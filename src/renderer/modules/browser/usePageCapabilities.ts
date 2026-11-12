import { useEffect, useRef, useState } from 'react'
import type { BrowserPageCapabilities } from '../../../shared/browser-shell'

type TabCapabilities = BrowserPageCapabilities & { tabId: string }

/**
 * What the page in a tab offers (W7 §4.10): whether it reads as an article, and the feeds it declares. Read when the
 * tab or its address changes and pushed by Main after a load; a reading for another tab or address is dropped.
 */
export function usePageCapabilities(tabId: string | null | undefined, url: string | null | undefined): BrowserPageCapabilities | null {
  const [capabilities, setCapabilities] = useState<TabCapabilities | null>(null)
  const current = useRef(tabId)
  current.current = tabId

  useEffect(() => {
    const browser = window.electronAPI?.browser
    if (!tabId || !browser?.getPageCapabilities) return
    let cancelled = false
    void browser.getPageCapabilities({ tabId }).then(result => {
      if (!cancelled && result) setCapabilities({ ...result, tabId })
    }).catch(error => console.warn('[page-capabilities] read failed:', error instanceof Error ? error.message : String(error)))
    return () => { cancelled = true }
  }, [tabId, url])

  useEffect(() => window.electronAPI?.browser?.onPageCapabilitiesChanged?.(event => {
    if (event.tabId === current.current) setCapabilities(event)
  }), [])

  if (!capabilities || capabilities.tabId !== tabId) return null
  if (url && capabilities.url && capabilities.url !== url) return null
  return capabilities
}
