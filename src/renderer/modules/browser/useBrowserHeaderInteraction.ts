import { useCallback, useEffect, useRef, useState } from 'react'

export type ActiveTabMode = 'compact' | 'primed' | 'expanded' | 'editing'
export type RefreshDockMode = 'idle' | 'primed' | 'revealed'

export function useBrowserHeaderInteraction() {
  const headerRootRef = useRef<HTMLDivElement>(null)
  const activeTabSurfaceRef = useRef<HTMLDivElement>(null)
  const refreshDockRef = useRef<HTMLDivElement>(null)
  const refreshDockTimerRef = useRef<number | null>(null)
  const [activeTabMode, setActiveTabMode] = useState<ActiveTabMode>('compact')
  const [refreshDockMode, setRefreshDockMode] = useState<RefreshDockMode>('idle')

  const collapseActiveTab = useCallback(() => {
    setActiveTabMode('compact')
  }, [])

  const primeActiveTab = useCallback(() => {
    setActiveTabMode((current) => (current === 'compact' ? 'primed' : current))
  }, [])

  const expandActiveTab = useCallback(() => {
    setActiveTabMode('expanded')
  }, [])

  const beginEditing = useCallback(() => {
    setActiveTabMode('editing')
  }, [])

  const stopEditing = useCallback(() => {
    setActiveTabMode((current) => (current === 'editing' ? 'expanded' : current))
  }, [])

  const resetActiveTabPrime = useCallback(() => {
    setActiveTabMode((current) => (current === 'primed' ? 'compact' : current))
  }, [])

  const primeRefreshDock = useCallback(() => {
    setRefreshDockMode((current) => (current === 'idle' ? 'primed' : current))
  }, [])

  const revealRefreshDock = useCallback(() => {
    setRefreshDockMode('revealed')
  }, [])

  const resetRefreshDock = useCallback(() => {
    setRefreshDockMode('idle')
  }, [])

  const beginRefreshDockHover = useCallback(() => {
    if (refreshDockTimerRef.current) {
      window.clearTimeout(refreshDockTimerRef.current)
      refreshDockTimerRef.current = null
    }
    setRefreshDockMode('primed')
    refreshDockTimerRef.current = window.setTimeout(() => {
      setRefreshDockMode('revealed')
      refreshDockTimerRef.current = null
    }, 140)
  }, [])

  const endRefreshDockHover = useCallback(() => {
    if (refreshDockTimerRef.current) {
      window.clearTimeout(refreshDockTimerRef.current)
      refreshDockTimerRef.current = null
    }
    setRefreshDockMode('idle')
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (activeTabMode !== 'expanded' && activeTabMode !== 'editing') return
      const target = event.target as Node | null
      if (target && activeTabSurfaceRef.current?.contains(target)) {
        return
      }
      setActiveTabMode('compact')
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [activeTabMode])

  useEffect(() => {
    return () => {
      if (refreshDockTimerRef.current) {
        window.clearTimeout(refreshDockTimerRef.current)
        refreshDockTimerRef.current = null
      }
    }
  }, [])

  return {
    headerRootRef,
    activeTabSurfaceRef,
    refreshDockRef,
    activeTabMode,
    refreshDockMode,
    collapseActiveTab,
    primeActiveTab,
    resetActiveTabPrime,
    expandActiveTab,
    beginEditing,
    stopEditing,
    primeRefreshDock,
    revealRefreshDock,
    resetRefreshDock,
    beginRefreshDockHover,
    endRefreshDockHover,
  }
}
