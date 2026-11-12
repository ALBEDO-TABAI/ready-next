import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BrowserFindBar, type BrowserFindResult } from '../../components/browser/BrowserFindBar'
import { resolveReadyAppShortcut, type ReadyShortcutInput } from '../../../shared/app-shortcuts'

/** The find bar's state for the visible tab, its keys (from the page and from the shell) and its calls to Main. */
export function useBrowserFind({ isActive, tabId }: { isActive: boolean; tabId: string | null }): { bar: ReactNode } {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [result, setResult] = useState<BrowserFindResult>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const latest = useRef({ tabId, text, requestId: 0, open })
  latest.current = { ...latest.current, tabId, text, open }

  const find = useCallback((query: string, options: { findNext: boolean; forward: boolean }) => {
    const target = latest.current.tabId
    if (!target || !query) { setResult(null); return }
    void window.electronAPI?.browser?.findInPage?.({ tabId: target, text: query, ...options }).then(response => {
      if (response?.success) latest.current.requestId = response.requestId
      else setResult({ matches: 0, active: 0 })
    }).catch(error => console.warn('[find] find failed:', error instanceof Error ? error.message : String(error)))
  }, [])

  const close = useCallback(() => {
    const target = latest.current.tabId
    if (target && latest.current.open) {
      void window.electronAPI?.browser?.stopFindInPage?.({ tabId: target, action: 'clearSelection' })
        .catch(error => console.warn('[find] stop failed:', error instanceof Error ? error.message : String(error)))
    }
    setOpen(false)
    setResult(null)
  }, [])

  const openBar = useCallback(() => {
    setOpen(true)
    window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
    if (latest.current.text) find(latest.current.text, { findNext: false, forward: true })
  }, [find])

  const step = useCallback((forward: boolean) => {
    if (!latest.current.open) { openBar(); return }
    find(latest.current.text, { findNext: true, forward })
  }, [find, openBar])

  // Matches for the current request of the visible tab only.
  useEffect(() => window.electronAPI?.browser?.onFoundInPage?.(event => {
    if (event.tabId !== latest.current.tabId || event.requestId !== latest.current.requestId) return
    setResult({ matches: event.matches, active: event.activeMatchOrdinal })
  }), [])

  // Typing searches anew (shortly after the last key).
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => find(text, { findNext: false, forward: true }), 120)
    return () => window.clearTimeout(timer)
  }, [find, open, text])

  // Another tab, or leaving the browser: the bar closes (Main clears the old page's find on switch).
  useEffect(() => { setOpen(false); setResult(null) }, [tabId])
  useEffect(() => { if (!isActive) close() }, [close, isActive])

  // ⌘F / ⌘G / ⇧⌘G: from the shell's DOM and, while the page has focus, forwarded by Main.
  useEffect(() => {
    if (!isActive) return
    const handle = (input: ReadyShortcutInput, prevent: () => void) => {
      const action = resolveReadyAppShortcut(input, 'browser')
      if (action === 'browser-find') { prevent(); openBar() }
      else if (action === 'browser-find-next') { prevent(); step(true) }
      else if (action === 'browser-find-previous') { prevent(); step(false) }
    }
    const onKey = (event: KeyboardEvent) => handle(event, () => event.preventDefault())
    window.addEventListener('keydown', onKey)
    const off = window.electronAPI?.app?.onShortcut?.(event => handle(event, () => {}))
    return () => { window.removeEventListener('keydown', onKey); off?.() }
  }, [isActive, openBar, step])

  return {
    bar: open && tabId
      ? <BrowserFindBar text={text} result={result} inputRef={inputRef} onText={setText} onStep={step} onClose={close} />
      : null,
  }
}
