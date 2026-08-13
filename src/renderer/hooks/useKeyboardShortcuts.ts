import { useEffect, useCallback, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMode, type WorkbenchMode } from '../stores/useMode'
import { useWorkspace } from '../stores/useWorkspace'
import { useDocTabs } from '../stores/useDocTabs'
import { requestWorkbenchModeChange } from '../modules/workbench/mode-transition'
import { shouldIgnoreGlobalKeyboardShortcut } from '../modules/keyboard/shortcut-guard'
import { resolveReadyAppShortcut, type ReadyAppShortcutAction } from '../../shared/app-shortcuts'
import { runRegisteredDocumentSave } from '../modules/document/documentSaveRegistry'
import { saveDocumentTabSnapshot } from '../modules/document/documentSaveRuntime'

const DIRECTLY_WRITABLE_DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'ts', 'tsx', 'js', 'css', 'html', 'docx'])

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

export function resolveDocumentSaveTarget(
  tabs: ReadonlyArray<{ id: string }>,
  activeTabId: string,
  splitTabId: string | null,
  focusedPaneTabId: string | null,
): string | null {
  const visibleTabIds = new Set([activeTabId, splitTabId].filter((id): id is string => Boolean(id)))
  if (focusedPaneTabId && visibleTabIds.has(focusedPaneTabId) && tabs.some((tab) => tab.id === focusedPaneTabId)) {
    return focusedPaneTabId
  }
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) return activeTabId
  if (splitTabId && tabs.some((tab) => tab.id === splitTabId)) return splitTabId
  return null
}

export function isDocumentSaveShortcutAvailable(input: {
  pathname: string
  appMode: string
  workbenchMode: WorkbenchMode
  splitMode: WorkbenchMode | null
}): boolean {
  return (input.pathname === '/' || input.pathname === '/workbench')
    && input.appMode === 'workbench'
    && (input.workbenchMode === 'document' || input.splitMode === 'document')
}

export function readyShortcutBypassesEditableGuard(
  action: ReadyAppShortcutAction | null,
  documentSaveAvailable = false,
): boolean {
  return action === 'capture-window' || (action === 'save-document' && documentSaveAvailable)
}

/**
 * Global keyboard shortcuts for the Ready app.
 * Mount this hook once at the top of the component tree.
 */
export function useKeyboardShortcuts() {
  const navigate = useNavigate()
  const location = useLocation()
  const { appMode, workbenchMode, splitMode, setWorkbenchMode, setReadySubMode, setAppMode, toggleMode } = useMode()
  const { toggleSidebar } = useWorkspace()
  const [captureFeedback, setCaptureFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const captureFeedbackTimerRef = useRef<number | null>(null)
  const documentSaveInFlightRef = useRef(false)

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
      // silent-catch: the failure is surfaced to the user through capture feedback.
      publishCaptureFeedback({
        kind: 'error',
        message: `截图失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }, [publishCaptureFeedback])

  const saveActiveDocument = useCallback(async () => {
    if (documentSaveInFlightRef.current) return
    documentSaveInFlightRef.current = true
    try {
      const {
        activeTabId,
        splitTabId,
        focusedPaneTabId,
        tabs,
        setTabPath,
        renameTab,
        commitTabSaveSnapshot,
      } = useDocTabs.getState()
      const targetTabId = resolveDocumentSaveTarget(tabs, activeTabId, splitTabId, focusedPaneTabId)
      if (!targetTabId) return
      const tab = tabs.find((item) => item.id === targetTabId)
      if (!tab || !window.electronAPI?.document) return
      if (await runRegisteredDocumentSave(targetTabId)) return
      const extension = tab.path?.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || ''
      if (tab.path && !DIRECTLY_WRITABLE_DOCUMENT_EXTENSIONS.has(extension)) return
      const outcome = await saveDocumentTabSnapshot({
        tab,
        api: window.electronAPI.document,
        setTabPath,
        renameTab,
        commitTabSaveSnapshot,
      })
      if (outcome.status === 'error') {
        publishCaptureFeedback({ kind: 'error', message: outcome.error })
      }
    } finally {
      documentSaveInFlightRef.current = false
    }
  }, [publishCaptureFeedback])

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
    const documentSaveAvailable = isDocumentSaveShortcutAvailable({
      pathname: location.pathname,
      appMode,
      workbenchMode,
      splitMode,
    })

    if (readyShortcutBypassesEditableGuard(action, documentSaveAvailable)) {
      preventDefault()
      if (action === 'capture-window') void captureCurrentWindow()
      else void saveActiveDocument()
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
  }, [activateWorkbenchMode, appMode, captureCurrentWindow, location.pathname, navigate, saveActiveDocument, setAppMode, splitMode, toggleMode, toggleSidebar, workbenchMode])

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
