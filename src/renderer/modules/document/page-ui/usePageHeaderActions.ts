import { useEffect, useRef } from 'react'
import { showToast } from '../../../components/ui'
import { exportDocument, isMarkdownExportableTab } from '../../../components/document/document-export'
import { useDocTabs, type DocTab } from '../../../stores/useDocTabs'
import type { InkPageMenuActions } from '../ink/InkTopbar'
import { useInkLayout } from '../ink/layout-state'
import { countMarkdownHeadings } from './heading-count'
import { isInLibrary, useLibraryRoot } from './library-membership'
import { adoptIntoLibrary } from '../navigator/adopt'
import { useWorkspace } from '../../../stores/useWorkspace'
import { useSieveExclusions } from '../../rss/sieve-exclusions'

/** The page header's outline toggle (three or more headings) and the “…” menu's page actions (W3 §4.1). */
export function usePageHeaderActions({ tab, outlineOpen, toggleOutline, marksOpen, toggleMarks, bookReading }: {
  tab: DocTab | null
  outlineOpen: boolean; toggleOutline(): void
  marksOpen: boolean; toggleMarks(): void
  bookReading: InkPageMenuActions['bookReading']
}): { outline?: { open: boolean; toggle(): void }; pageMenu?: InkPageMenuActions } {
  const libraryRoot = useLibraryRoot()
  const pinned = useWorkspace(state => state.pinnedFolders)
  const sieveHidden = useSieveExclusions(state => state.ids)
  useEffect(() => {
    if (!useSieveExclusions.getState().ids) void useSieveExclusions.getState().load().catch((error: unknown) => console.warn('[page-menu] sieve exclusions not read', error))
  }, [])
  if (!tab || tab.kind === 'library') return {}
  const path = tab.path
  const mounted = !!path && !!libraryRoot && !isInLibrary(path, libraryRoot) && pinned.some(folder => folder !== libraryRoot && isInLibrary(path, folder))
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
      adopt: mounted ? () => { void adoptIntoLibrary(path!) } : undefined,
      // Only library pages are ever listed for the sieve; a mounted folder's files never are.
      sieve: !mounted && tab.objectId && sieveHidden ? {
        hidden: sieveHidden.has(tab.objectId),
        toggle: () => {
          const objectId = tab.objectId!, hide = !sieveHidden.has(objectId)
          void useSieveExclusions.getState().setHidden(objectId, hide)
            .then(() => showToast(hide ? '这页的标题不会再随资讯判断发出' : '筛子又可以参考这页了'))
            .catch((error: unknown) => showToast(`没有改成：${error instanceof Error ? error.message : String(error)}`))
        },
      } : undefined,
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
