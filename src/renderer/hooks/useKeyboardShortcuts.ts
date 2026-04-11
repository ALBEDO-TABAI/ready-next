import { useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMode, type WorkbenchMode } from '../stores/useMode'
import { useWorkspace } from '../stores/useWorkspace'
import { useDocTabs } from '../stores/useDocTabs'
import { requestWorkbenchModeChange } from '../modules/workbench/mode-transition'
import { shouldIgnoreGlobalKeyboardShortcut } from '../modules/keyboard/shortcut-guard'

type ShortcutLikeEvent = {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
  target?: EventTarget | null
  preventDefault?: () => void
}

/**
 * Global keyboard shortcuts for the Ready app.
 * Mount this hook once at the top of the component tree.
 */
export function useKeyboardShortcuts() {
  const navigate = useNavigate()
  const { appMode, setWorkbenchMode, setReadySubMode, setAppMode, toggleMode } = useMode()
  const { toggleSidebar } = useWorkspace()

  const saveActiveDocument = useCallback(async () => {
    const { activeTabId, tabs, setTabPath, renameTab, markTabSaved } = useDocTabs.getState()
    if (!activeTabId) return
    const tab = tabs.find((item) => item.id === activeTabId)
    if (!tab || !window.electronAPI?.document) return

    if (tab.path) {
      const result = await window.electronAPI.document.writeFile(tab.path, tab.content)
      if (result.success) {
        markTabSaved(activeTabId)
      }
      return
    }

    const saveResult = await window.electronAPI.document.saveFileAs({
      content: tab.content,
      suggestedName: `${tab.title || '新文档'}.md`,
    })
    if (!saveResult.success || !saveResult.path) return

    setTabPath(activeTabId, saveResult.path)
    renameTab(activeTabId, saveResult.path.split('/').pop() || tab.title)
    markTabSaved(activeTabId)
  }, [])

  const activateWorkbenchMode = useCallback((mode: WorkbenchMode) => {
    setReadySubMode(mode)
    setAppMode('workbench')
    navigate('/workbench')
    if (appMode === 'workbench') {
      requestWorkbenchModeChange(mode)
      return
    }
    setWorkbenchMode(mode)
  }, [appMode, navigate, setAppMode, setReadySubMode, setWorkbenchMode])

  const handleShortcut = useCallback((e: ShortcutLikeEvent) => {
    if (shouldIgnoreGlobalKeyboardShortcut({
      target: e.target,
      activeElement: typeof document !== 'undefined' ? document.activeElement : null,
      isComposing: e.isComposing,
      keyCode: e.keyCode,
    })) {
      return false
    }

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
        F3: 'rss',
        F4: 'calendar',
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
      void saveActiveDocument()
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
        '3': 'rss',
        '4': 'calendar',
      }
      if (modeMap[e.key]) {
        preventDefault()
        activateWorkbenchMode(modeMap[e.key])
        return true
      }
    }

    return false
  }, [activateWorkbenchMode, navigate, saveActiveDocument, setAppMode, setWorkbenchMode, toggleMode, toggleSidebar])

  useEffect(() => {
    const keydownHandler = (e: KeyboardEvent) => {
      void handleShortcut(e)
    }

    window.addEventListener('keydown', keydownHandler)
    const unsubscribeShortcut = window.electronAPI?.app?.onShortcut
      ? window.electronAPI.app.onShortcut((event) => {
        void handleShortcut({
          ...event,
          target: typeof document !== 'undefined' ? document.activeElement : null,
        })
      })
      : undefined

    return () => {
      window.removeEventListener('keydown', keydownHandler)
      unsubscribeShortcut?.()
    }
  }, [handleShortcut])
}
