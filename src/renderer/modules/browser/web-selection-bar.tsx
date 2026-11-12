import { useEffect, useRef, useState, type RefObject } from 'react'
import { Languages } from 'lucide-react'
import type { BrowserSelectionEvent } from '../../../shared/fastcard'
import { ReadyRefSchema } from '../../../shared/ready-ref'
import type { CaptureSelection } from '../workbench/capture'
import { announceHighlight } from '../workbench/capture-receipt'
import { closeSelectionBar, openSelectionBar } from '../workbench/selection-bar/open-selection-bar'

/** The page's selection as a capture: the web page by address (only http and https pages are references). */
export function webSelectionCapture(selection: Pick<BrowserSelectionEvent, 'text' | 'url' | 'title'>): CaptureSelection | null {
  const ref = ReadyRefSchema.safeParse({ kind: 'web', url: selection.url })
  const text = selection.text.trim()
  if (!ref.success || !text) return null
  return { ref: ref.data, title: selection.title.trim() || new URL(selection.url).hostname, text, pageUrl: selection.url }
}

/** 划线 on a web page: Main reads the live selection of the active tab into its source page, as before. */
export async function highlightWebSelection(selection: Pick<BrowserSelectionEvent, 'tabId' | 'text'>): Promise<void> {
  const result = await window.electronAPI.sourceAnnotations.web({ tabId: selection.tabId })
  if (!result.success) throw new Error(result.error)
  announceHighlight(result.data, selection.text)
}

/**
 * The reading scenes' selection bar for the web page (W6 §3.2). Nothing may cover the native page, so the bar sits in
 * the bottom band under it, centred on the page, while the active tab has selected words. Main reports the selection
 * when a pointer or keyboard selection ends.
 */
export function useWebSelectionBar({ active, activeTabId, page, translate }: {
  active: boolean
  activeTabId: string | null
  page: RefObject<HTMLElement | null>
  translate(selection: BrowserSelectionEvent): void
}) {
  const [selection, setSelection] = useState<BrowserSelectionEvent | null>(null)
  const latest = useRef(translate)
  latest.current = translate
  useEffect(() => window.electronAPI?.browser?.onSelectionChanged?.(event => setSelection(event.text ? event : null)), [])
  useEffect(() => {
    const by = {}
    const capture = selection && webSelectionCapture(selection)
    if (!active || !selection || selection.tabId !== activeTabId || !capture || !page.current) return
    const band = () => {
      const rect = page.current?.getBoundingClientRect()
      return { left: rect?.left ?? 0, right: rect?.right ?? window.innerWidth, top: window.innerHeight - 8, bottom: window.innerHeight - 8 }
    }
    openSelectionBar(band, {
      read: () => capture,
      highlight: () => highlightWebSelection(selection),
      extras: [{ id: 'translate', label: '翻译', icon: <Languages />, run: () => latest.current(selection) }],
      onDone: () => setSelection(null),
    }, by, 'top')
    return () => closeSelectionBar(by)
  }, [active, activeTabId, page, selection])
}
