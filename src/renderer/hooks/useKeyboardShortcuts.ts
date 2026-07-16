import { useEffect, useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMode, type WorkbenchMode } from '../stores/useMode'
import { useWorkspace } from '../stores/useWorkspace'
import { useDocTabs } from '../stores/useDocTabs'
import { requestWorkbenchModeChange } from '../modules/workbench/mode-transition'
import { shouldIgnoreGlobalKeyboardShortcut } from '../modules/keyboard/shortcut-guard'
import { resolveReadyAppShortcut, type ReadyAppShortcutAction } from '../../shared/app-shortcuts'

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
  const [captureFeedback, setCaptureFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const captureFeedbackTimerRef = useRef<number | null>(null)

  const publishCaptureFeedback = useCallback((feedback: { kind: 'success' | 'error'; message: string }) => {
    setCaptureFeedback(feedback)
    if (captureFeedbackTimerRef.current !== null) {
      window.clearTimeout(captureFeedbackTimerRef.current)
    }
    captureFeedbackTimerRef.current = window.setTimeout(() => {
      setCaptureFeedback(null)
      captureFeedbackTimerRef.current = null
    }, 3600)
  }, [])

  const captureCurrentWindow = useCallback(async () => {
    const capture = window.electronAPI?.app?.captureWindow
    if (!capture) {
      publishCaptureFeedback({ kind: 'error', message: '当前版本不支持窗口截图' })
      return
    }

    try {
      const result = await capture()
      if (!result.success || !result.path) {
        publishCaptureFeedback({ kind: 'error', message: result.error || '截图失败' })
        return
      }
      const filename = result.path.split(/[\\/]/).pop() || result.path
      publishCaptureFeedback({ kind: 'success', message: `已保存到桌面：${filename}` })
    } catch (error) {
      publishCaptureFeedback({
        kind: 'error',
        message: `截图失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }, [publishCaptureFeedback])

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
    const action = resolveReadyAppShortcut(e)
    const preventDefault = () => e.preventDefault?.()

    if (action === 'capture-window') {
      preventDefault()
      void captureCurrentWindow()
      return true
    }

    if (shouldIgnoreGlobalKeyboardShortcut({
      target: e.target,
      activeElement: typeof document !== 'undefined' ? document.activeElement : null,
      isComposing: e.isComposing,
      keyCode: e.keyCode,
    })) {
      return false
    }

    if (!action) return false

    if (action === 'open-ready') {
      preventDefault()
      setAppMode('ready')
      navigate('/ready')
      return true
    }

    const modeByAction: Partial<Record<ReadyAppShortcutAction, WorkbenchMode>> = {
      'switch-browser': 'browser',
      'switch-document': 'document',
      'switch-rss': 'rss',
      'switch-calendar': 'calendar',
    }
    const targetMode = modeByAction[action]
    if (targetMode) {
      preventDefault()
      activateWorkbenchMode(targetMode)
      return true
    }

    if (action === 'open-settings') {
      preventDefault()
      navigate('/settings')
      return true
    }

    if (action === 'toggle-sidebar') {
      preventDefault()
      toggleSidebar()
      return true
    }

    if (action === 'save-document') {
      preventDefault()
      void saveActiveDocument()
      return true
    }

    if (action === 'close-document') {
      preventDefault()
      const { activeTabId, closeTab } = useDocTabs.getState()
      if (activeTabId) {
        closeTab(activeTabId)
      }
      return true
    }

    if (action === 'new-document') {
      preventDefault()
      const { openTab } = useDocTabs.getState()
      openTab('')
      activateWorkbenchMode('document')
      return true
    }

    if (action === 'toggle-theme') {
      preventDefault()
      toggleMode()
      return true
    }

    return false
  }, [activateWorkbenchMode, captureCurrentWindow, navigate, saveActiveDocument, setAppMode, toggleMode, toggleSidebar])

  useEffect(() => () => {
    if (captureFeedbackTimerRef.current !== null) {
      window.clearTimeout(captureFeedbackTimerRef.current)
    }
  }, [])

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

  return { captureFeedback }
}
