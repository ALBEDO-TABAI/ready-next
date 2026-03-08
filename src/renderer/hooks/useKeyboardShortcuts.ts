import { useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMode, type WorkbenchMode } from '../stores/useMode'
import { useWorkspace } from '../stores/useWorkspace'
import { useDocTabs } from '../stores/useDocTabs'

type ShortcutLikeEvent = {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  preventDefault?: () => void
}

/**
 * Global keyboard shortcuts for the Ready app.
 * Mount this hook once at the top of the component tree.
 */
export function useKeyboardShortcuts() {
  const navigate = useNavigate()
  const { setWorkbenchMode, setReadySubMode, setAppMode, toggleMode } = useMode()
  const { toggleSidebar } = useWorkspace()

  const activateWorkbenchMode = useCallback((mode: WorkbenchMode) => {
    setWorkbenchMode(mode)
    setReadySubMode(mode)
    setAppMode('workbench')
    navigate('/workbench')
  }, [navigate, setAppMode, setReadySubMode, setWorkbenchMode])

  const handleShortcut = useCallback((e: ShortcutLikeEvent) => {
    const meta = Boolean(e.metaKey) || Boolean(e.ctrlKey)
    const shift = Boolean(e.shiftKey)
    const preventDefault = () => e.preventDefault?.()

    if (!meta && !shift && e.key === 'Home') {
      preventDefault()
      setAppMode('ready')
      navigate('/ready')
      return true
    }

    if (!meta && !shift) {
      const functionModeMap: Record<string, WorkbenchMode> = {
        F1: 'browser',
        F2: 'document',
        F3: 'design',
        F4: 'video',
        F5: 'rss',
        F6: 'calendar',
      }
      const functionMode = functionModeMap[e.key]
      if (functionMode) {
        preventDefault()
        activateWorkbenchMode(functionMode)
        return true
      }
    }

    if (meta && e.key === ',') {
      preventDefault()
      navigate('/settings')
      return true
    }

    if (meta && e.key.toLowerCase() === 'b') {
      preventDefault()
      toggleSidebar()
      return true
    }

    if (meta && e.key.toLowerCase() === 's' && !shift) {
      preventDefault()
      const { workbenchMode } = useMode.getState()
      if (workbenchMode === 'design') {
        window.dispatchEvent(new CustomEvent('ready-design-save'))
        return true
      }
      const { activeTabId, markTabSaved } = useDocTabs.getState()
      if (activeTabId) {
        markTabSaved(activeTabId)
      }
      return true
    }

    if (meta && e.key.toLowerCase() === 'w' && !shift) {
      preventDefault()
      const { activeTabId, closeTab } = useDocTabs.getState()
      if (activeTabId) {
        closeTab(activeTabId)
      }
      return true
    }

    if (meta && e.key.toLowerCase() === 't' && !shift) {
      preventDefault()
      const { openTab } = useDocTabs.getState()
      openTab('')
      setWorkbenchMode('document')
      return true
    }

    if (meta && e.key === '\\') {
      preventDefault()
      toggleMode()
      return true
    }

    if (meta && !shift) {
      const modeMap: Record<string, WorkbenchMode> = {
        '1': 'browser',
        '2': 'document',
        '3': 'design',
        '4': 'video',
        '5': 'rss',
        '6': 'calendar',
      }
      if (modeMap[e.key]) {
        preventDefault()
        activateWorkbenchMode(modeMap[e.key])
        return true
      }
    }

    return false
  }, [activateWorkbenchMode, navigate, setAppMode, setWorkbenchMode, toggleMode, toggleSidebar])

  useEffect(() => {
    const keydownHandler = (e: KeyboardEvent) => {
      void handleShortcut(e)
    }

    window.addEventListener('keydown', keydownHandler)
    const unsubscribeShortcut = window.electronAPI?.app?.onShortcut
      ? window.electronAPI.app.onShortcut((event) => {
        void handleShortcut(event)
      })
      : undefined

    return () => {
      window.removeEventListener('keydown', keydownHandler)
      unsubscribeShortcut?.()
    }
  }, [handleShortcut])
}
