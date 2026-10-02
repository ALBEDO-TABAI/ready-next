import { useCallback, useEffect, useRef, useState } from 'react'

import type { AdblockState, BrowserDiagnosticsData } from './types'
import { extractBrowserDomain, LOGIN_DOMAINS } from './url-utils'
import type { BrowserTab } from '../../stores/useBrowserTabs'

const INITIAL_ADBLOCK_STATE: AdblockState = {
  enabled: true,
  whitelistDomains: [],
  rulesVersion: 'ready-basic-ads-v1',
  networkBlockedCount: 0,
  lastUpdatedAt: null,
}

export function useBrowserDiagnosticsState({
  isElectron,
  tabs,
  activeTabId,
  currentDomain,
}: {
  isElectron: boolean
  tabs: BrowserTab[]
  activeTabId: string | null
  currentDomain: string
}) {
  const [toastVisible, setToastVisible] = useState(false)
  const [adblockState, setAdblockState] = useState<AdblockState>(INITIAL_ADBLOCK_STATE)
  const [browserDiagnostics, setBrowserDiagnostics] = useState<BrowserDiagnosticsData | null>(null)
  const shownDomainsRef = useRef<Set<string>>(new Set())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevLoadingRef = useRef<Record<string, boolean>>({})

  const refreshBrowserDiagnostics = useCallback(async (includePerformance = false) => {
    if (!isElectron) return
    const result = await window.electronAPI?.browser?.getDiagnostics?.({ includePerformance })
    if (result?.success && result.data) {
      setBrowserDiagnostics(result.data as BrowserDiagnosticsData)
    }
  }, [isElectron])

  const refreshAdblockState = useCallback(async () => {
    if (!isElectron) return
    const [adblockResult, diagnosticsResult] = await Promise.all([
      window.electronAPI?.browser?.getAdblockState(),
      window.electronAPI?.browser?.getDiagnostics?.({ includePerformance: false }),
    ])
    if (adblockResult?.success && adblockResult.data) {
      setAdblockState(adblockResult.data as AdblockState)
    }
    if (diagnosticsResult?.success && diagnosticsResult.data) {
      setBrowserDiagnostics(diagnosticsResult.data as BrowserDiagnosticsData)
    }
  }, [isElectron])

  const handleToggleAdblock = useCallback(async () => {
    if (!isElectron) return
    const result = await window.electronAPI?.browser?.setAdblockEnabled(!adblockState.enabled)
    if (result?.success && result.data) {
      setAdblockState(result.data as AdblockState)
    }
  }, [adblockState.enabled, isElectron])

  const handleToggleCurrentSiteAdblock = useCallback(async () => {
    if (!isElectron || !currentDomain) return
    const result = await window.electronAPI?.browser?.toggleAdblockDomain(currentDomain)
    if (result?.success && result.data) {
      setAdblockState(result.data as AdblockState)
    }
  }, [currentDomain, isElectron])

  useEffect(() => {
    if (!isElectron) return
    void refreshAdblockState()
    const cleanup = window.electronAPI?.browser?.onAdblockUpdate((data: unknown) => {
      setAdblockState(data as AdblockState)
    })
    return () => { cleanup?.() }
  }, [isElectron, refreshAdblockState])

  useEffect(() => {
    if (!isElectron) return
    void refreshBrowserDiagnostics()
  }, [isElectron, activeTabId, tabs.length, adblockState.networkBlockedCount, refreshBrowserDiagnostics])

  const diagnosticsDockVisible = Boolean(
    browserDiagnostics?.currentTask
    || browserDiagnostics?.lastFailure
    || browserDiagnostics?.pageState
    || browserDiagnostics?.continuity,
  )
  useEffect(() => {
    if (!isElectron || !diagnosticsDockVisible) return
    void refreshBrowserDiagnostics(true)
    const timer = window.setInterval(() => {
      void refreshBrowserDiagnostics(true)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [diagnosticsDockVisible, isElectron, refreshBrowserDiagnostics])

  useEffect(() => {
    tabs.forEach((tab) => {
      const wasLoading = prevLoadingRef.current[tab.id]
      if (wasLoading && !tab.loading && !tab.error) {
        const domain = extractBrowserDomain(tab.url)
        if (
          domain &&
          LOGIN_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`)) &&
          !shownDomainsRef.current.has(domain)
        ) {
          shownDomainsRef.current.add(domain)
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
          setToastVisible(true)
          toastTimerRef.current = setTimeout(() => {
            setToastVisible(false)
            toastTimerRef.current = null
          }, 3000)
        }
      }
      prevLoadingRef.current[tab.id] = tab.loading
    })
  }, [tabs])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  return {
    toastVisible,
    adblockState,
    browserDiagnostics,
    refreshAdblockState,
    refreshBrowserDiagnostics,
    handleToggleAdblock,
    handleToggleCurrentSiteAdblock,
  }
}
