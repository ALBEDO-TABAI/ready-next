import { useEffect, useRef } from 'react'
import { showToast } from '../../../components/ui'
import { exportDocument, isMarkdownExportableTab } from '../../../components/document/document-export'
import { useDocTabs, type DocTab } from '../../../stores/useDocTabs'
import type { InkPageMenuActions } from '../ink/InkTopbar'
import { useInkLayout } from '../ink/layout-state'
import { countMarkdownHeadings } from './heading-count'

/** The page header's outline toggle (three or more headings) and the “…” menu's page actions (W3 §4.1). */
export function usePageHeaderActions({ tab, outlineOpen, toggleOutline, marksOpen, toggleMarks, bookReading }: {
  tab: DocTab | null
  outlineOpen: boolean; toggleOutline(): void
  marksOpen: boolean; toggleMarks(): void
  bookReading: InkPageMenuActions['bookReading']
}): { outline?: { open: boolean; toggle(): void }; pageMenu?: InkPageMenuActions } {
  if (!tab || tab.kind === 'library') return {}
  return {
    outline: countMarkdownHeadings(tab.content) >= 3 ? { open: outlineOpen, toggle: toggleOutline } : undefined,
    pageMenu: {
      exportable: isMarkdownExportableTab(tab),
      onExport: kind => {
        void exportDocument(kind, tab).then(outcome => {
          if (outcome.status === 'done') showToast(kind === 'pdf' ? '已导出 PDF' : '已导出 Markdown')
          else if (outcome.status === 'error') showToast(`导出失败：${outcome.error}`)
        })
      },
      bookReading,
      marks: { open: marksOpen, toggle: toggleMarks },
    },
  }
}

/** The first visit in a session that finds only a blank untitled tab opens 今日 instead (W3 §4.2). */
export function useHomeOnFirstVisit(isActive: boolean) {
  const done = useRef(false)
  useEffect(() => {
    if (!isActive || done.current) return
    done.current = true
    const { tabs, activeTabId } = useDocTabs.getState()
    const active = tabs.find(tab => tab.id === activeTabId)
    if (active && active.kind !== 'library' && !active.path && !active.content && !active.isDirty) useInkLayout.getState().setHome(true)
  }, [isActive])
}
